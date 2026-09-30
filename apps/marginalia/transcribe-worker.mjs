// Web Worker for off-thread Whisper speech recognition in Marginalia.
// Runs Transformers.js Whisper WASM pipeline off the main thread to prevent UI freezing.

import { createTranscriber, transcribeSamples } from './transcribe.mjs';

const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/+esm';

let _transformers = null;
let _whisper = null;

async function loadTransformers() {
  if (!_transformers) {
    _transformers = await import(TRANSFORMERS_URL);
    _transformers.env.allowLocalModels = false;
    // Single-threaded WASM for compatibility with Pages environment (no COOP/COEP)
    _transformers.env.backends.onnx.wasm.numThreads = 1;
  }
  return _transformers;
}

async function getWhisper(onProgress) {
  if (!_whisper) {
    const t = await loadTransformers();
    _whisper = await createTranscriber(t.pipeline, {
      progress_callback: onProgress,
      device: 'wasm',
    });
  }
  return _whisper;
}

self.onmessage = async (e) => {
  const { id, type, samples } = e.data || {};
  if (type === 'transcribe') {
    try {
      const asr = await getWhisper((p) => {
        if (p.status === 'progress' && typeof p.progress === 'number') {
          self.postMessage({ id, type: 'progress', progress: p.progress });
        }
      });
      self.postMessage({ id, type: 'status', status: 'transcribing' });
      const text = await transcribeSamples(asr, samples);
      self.postMessage({ id, type: 'result', text });
    } catch (err) {
      self.postMessage({ id, type: 'error', error: (err && err.message) || String(err) });
    }
  }
};
