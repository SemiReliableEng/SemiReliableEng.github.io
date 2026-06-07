// Audio transcription helpers for Marginalia's "record a quote" feature.
//
// This module is deliberately transformers.js-agnostic: it never imports the
// library itself. The browser passes in the `pipeline` fn from the pinned
// jsDelivr CDN build; the node test passes in the one from the dev-only
// `@huggingface/transformers` package. That injection is what lets the same
// offline-transcription code run under `node --test` against a real local
// model without node needing to resolve a https: CDN import.
//
// The browser-only glue (getUserMedia, MediaRecorder, and decoding the
// recorded blob to mono 16 kHz PCM via WebAudio) stays in index.html — it
// can't run headless in node — but everything below (model wiring, the
// transcription call, text cleanup, and WAV encoding for the Gemini path) is
// pure and testable.

// Quantized whisper-tiny.en: ~40 MB of ONNX weights, English-only, runs in
// WASM on a phone. Chosen over base.en (~145 MB) to keep the offline download
// closer to the Tesseract footprint. If accuracy proves too low, bumping this
// to 'Xenova/whisper-base.en' is the one-line lever.
export const WHISPER_MODEL = 'Xenova/whisper-tiny.en';

// Whisper's fixed input rate. The browser must resample the recording to this
// before calling transcribeSamples; the model assumes a Float32Array is
// already at 16 kHz (it does no resampling of raw sample arrays).
export const TARGET_SAMPLE_RATE = 16000;

// Normalize a raw Whisper transcript for storage as a quote. Whisper already
// emits punctuated, cased text, so this is light: strip the leading space the
// model often prepends, collapse runs of whitespace, and drop spaces that
// landed in front of punctuation. We intentionally do NOT reflow newlines the
// way OCR cleanup does — speech has no source line wrapping to undo.
export function cleanTranscript(raw) {
  if (!raw) return '';
  return raw
    .replace(/\s+/g, ' ')        // collapse all whitespace runs to single spaces
    .replace(/\s+([,.!?;:])/g, '$1') // no space before punctuation
    .trim();
}

// Build an automatic-speech-recognition pipeline from an injected
// transformers.js `pipeline` fn. `dtype: 'q8'` selects the quantized weights
// (the ~40 MB variant). Extra options (e.g. `progress_callback`, `device`)
// flow through so the browser can show a model-download progress bar.
export async function createTranscriber(pipelineFn, opts = {}) {
  return pipelineFn('automatic-speech-recognition', WHISPER_MODEL, {
    dtype: 'q8',
    ...opts,
  });
}

// Transcribe mono 16 kHz PCM (Float32Array) to a cleaned string.
// chunk_length_s/stride_length_s let whisper handle recordings longer than its
// 30 s receptive field by sliding a window — without them, audio past 30 s is
// silently dropped, which would truncate a long dictated quote.
export async function transcribeSamples(transcriber, samples, opts = {}) {
  const result = await transcriber(samples, {
    chunk_length_s: 30,
    stride_length_s: 5,
    ...opts,
  });
  return cleanTranscript(result?.text ?? '');
}

// Resample mono Float32 PCM to TARGET_SAMPLE_RATE by linear interpolation.
// The browser prefers WebAudio's OfflineAudioContext (better quality) to get
// to 16 kHz, but this dependency-free fallback covers environments without it
// and is what the node test uses to bring a 44.1 kHz fixture down to whisper's
// rate. Linear is crude but whisper is robust to it for speech.
export function resampleTo16k(samples, fromRate) {
  if (fromRate === TARGET_SAMPLE_RATE) return samples;
  const ratio = fromRate / TARGET_SAMPLE_RATE;
  const outLen = Math.round(samples.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const frac = srcPos - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}

// Encode mono Float32 PCM as a 16-bit little-endian WAV (RIFF) byte array.
// Used for the Gemini path: Gemini accepts wav/mp3/ogg/flac/aac but NOT the
// webm/opus that Chrome's MediaRecorder produces by default, so we hand it a
// freshly-encoded WAV of the same 16 kHz mono samples we feed Whisper. Small
// and dependency-free; fine for quote-length recordings.
export function encodeWav(samples, sampleRate = TARGET_SAMPLE_RATE) {
  const numSamples = samples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true); // file size - 8
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);            // fmt chunk size
  view.setUint16(20, 1, true);             // PCM
  view.setUint16(22, 1, true);             // mono
  view.setUint32(24, sampleRate, true);    // sample rate
  view.setUint32(28, sampleRate * 2, true);// byte rate (sampleRate * blockAlign)
  view.setUint16(32, 2, true);             // block align (channels * bytesPerSample)
  view.setUint16(34, 16, true);            // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, numSamples * 2, true);// data chunk size

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i])); // clamp
    // Round (setInt16 would truncate toward zero, doubling quantization error).
    view.setInt16(offset, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

// Inverse of encodeWav: parse a 16-bit PCM WAV byte array back to a mono
// Float32Array (averaging channels if stereo). Exists mainly so the node test
// can load a .wav fixture without pulling in an audio-decoding dependency; the
// browser uses WebAudio's decodeAudioData instead.
export function decodeWav(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Walk RIFF chunks to find fmt and data (don't assume a canonical 44-byte
  // header — some encoders insert LIST/fact chunks before data).
  let channels = 1, sampleRate = TARGET_SAMPLE_RATE, bits = 16;
  let dataOffset = -1, dataLen = 0;
  let p = 12; // skip 'RIFF' + size + 'WAVE'
  while (p + 8 <= view.byteLength) {
    const id = String.fromCharCode(
      view.getUint8(p), view.getUint8(p + 1), view.getUint8(p + 2), view.getUint8(p + 3));
    const size = view.getUint32(p + 4, true);
    const body = p + 8;
    if (id === 'fmt ') {
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      dataOffset = body;
      dataLen = size;
      break;
    }
    p = body + size + (size & 1); // chunks are word-aligned
  }
  if (dataOffset < 0) throw new Error('WAV: no data chunk');
  if (bits !== 16) throw new Error(`WAV: expected 16-bit PCM, got ${bits}-bit`);

  const frameCount = Math.floor(dataLen / 2 / channels);
  const out = new Float32Array(frameCount);
  let o = dataOffset;
  for (let i = 0; i < frameCount; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      sum += view.getInt16(o, true) / 0x8000;
      o += 2;
    }
    out[i] = sum / channels;
  }
  return { samples: out, sampleRate };
}
