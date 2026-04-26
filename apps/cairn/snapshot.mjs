// Pure snapshot primitives for cairn's WAL+snapshot sync pattern. Imported
// by apps/cairn/index.html and covered by apps/cairn/snapshot.test.mjs.
//
// Key divergence from marginalia's pattern: cairn entityIds are
// content-addressed (sha-256 of normalized coords in computeHikeId), so the
// same entityId can recur after a delete → re-import cycle. A naive
// `ts <= lastCompactedTs` rule would flag a post-delete re-add as covered
// by a snapshot whose live state reflects the deleted version. The
// tombstone-outcome rule below additionally requires that the snapshot's
// live/tombstone state for the entityId matches what the op's outcome
// would produce.
//
// Payload shape: ops carry `{ pointsPacked, meta }` (current) or
// `{ points, meta }` (legacy split) or a flat
// `{ name, date, distKm, elevGain, coords }` (pre-split legacy). Readers
// may encounter all three until all devices have compacted at least once.
// `points` is the immutable [[lat,lon,ele], …] track geometry that
// entityId hashes; `meta` holds editable fields (name, date, distKm,
// elevGain, …). Keeping the two cleanly split now makes future metadata
// edits via `update-hike` and a potential move of points into a separate
// blob backend local changes rather than data migrations.
//
// `pointsPacked` is an integer-domain delta encoding of the same track at
// PACKED_SCALE precision (1e5 → ~1.1m horizontal, integer metres vertical).
// See packPoints/unpackPoints below. The format is chunk-aware (nested
// arrays) so chunk size becomes tunable later without a schema bump,
// though packPoints encodes a single chunk by default since integer
// prefix-sum reconstruction has no error accumulation to defend against.

const PACKED_SCALE = 1e5;
const PACKED_VERSION = 1;

// Pack a [[lat, lon, ele], …] track into delta-encoded integer chunks.
// `chunkSize` defaults to a single chunk; smaller K trades a small size
// hit (one absolute base per chunk) for chunk-local random access if a
// future caller wants to decode partially. Encoding is lossy at the
// quantization step (Math.round to PACKED_SCALE) but reconstruction
// across deltas is exact integer arithmetic — no drift with chunk length.
export function packPoints(coords, chunkSize) {
  const out = { v: PACKED_VERSION, scale: PACKED_SCALE, lats: [], lons: [], eles: [] };
  if (!Array.isArray(coords) || coords.length === 0) return out;
  const N = coords.length;
  const K = (chunkSize === undefined || chunkSize === Infinity || chunkSize <= 0)
    ? N
    : Math.min(chunkSize, N);
  for (let start = 0; start < N; start += K) {
    const end = Math.min(start + K, N);
    const lats = new Array(end - start);
    const lons = new Array(end - start);
    const eles = new Array(end - start);
    let prevLat = 0, prevLon = 0, prevEle = 0;
    for (let i = start; i < end; i++) {
      const c = coords[i];
      const lat = Math.round(c[0] * PACKED_SCALE);
      const lon = Math.round(c[1] * PACKED_SCALE);
      const ele = Math.round(c[2]);
      const local = i - start;
      if (local === 0) {
        lats[0] = lat; lons[0] = lon; eles[0] = ele;
      } else {
        lats[local] = lat - prevLat;
        lons[local] = lon - prevLon;
        eles[local] = ele - prevEle;
      }
      prevLat = lat; prevLon = lon; prevEle = ele;
    }
    out.lats.push(lats);
    out.lons.push(lons);
    out.eles.push(eles);
  }
  return out;
}

// Reconstruct a [[lat, lon, ele], …] track from the packed shape. Iterates
// arbitrary chunk counts (each chunk's first entry is absolute, the rest
// are deltas) so an encoder change to non-default chunk size needs no
// decoder change.
export function unpackPoints(packed) {
  if (!packed || !Array.isArray(packed.lats)) return [];
  const scale = packed.scale || PACKED_SCALE;
  const out = [];
  for (let c = 0; c < packed.lats.length; c++) {
    const lats = packed.lats[c] || [];
    const lons = packed.lons?.[c] || [];
    const eles = packed.eles?.[c] || [];
    let lat = 0, lon = 0, ele = 0;
    for (let i = 0; i < lats.length; i++) {
      lat = i === 0 ? lats[i] : lat + lats[i];
      lon = i === 0 ? lons[i] : lon + lons[i];
      ele = i === 0 ? eles[i] : ele + eles[i];
      out.push([lat / scale, lon / scale, ele]);
    }
  }
  return out;
}

// Read a snapshot live entry's track regardless of which on-disk shape it
// was written in (pointsPacked or legacy points). Returned as the
// flat-pair [[lat, lon, ele], …] form that hydrateHike expects.
export function readSnapshotPoints(entry) {
  if (entry && entry.pointsPacked) return unpackPoints(entry.pointsPacked);
  if (entry && Array.isArray(entry.points)) return entry.points;
  return [];
}

// Return an op's payload in `{ points, meta }` form regardless of which
// shape it was written in. Three shapes are accepted:
//   1. `{ pointsPacked, meta }` — current packed format
//   2. `{ points, meta }` — legacy split shape
//   3. `{ name, date, distKm, elevGain, coords }` — pre-split flat shape
// `points` in the returned object is always the unpacked
// [[lat,lon,ele], …] form.
export function readOpPayload(op) {
  const d = (op && op.data) || {};
  if (d.pointsPacked !== undefined || d.meta !== undefined || d.points !== undefined) {
    let points;
    if (d.pointsPacked) points = unpackPoints(d.pointsPacked);
    else if (Array.isArray(d.points)) points = d.points;
    else points = [];
    return {
      points,
      meta: d.meta && typeof d.meta === 'object' ? d.meta : {},
    };
  }
  const { coords, ...meta } = d;
  return {
    points: Array.isArray(coords) ? coords : [],
    meta,
  };
}

// Is `op`'s effect already absorbed into `snap`?
//
// Covered iff BOTH:
//   1. op.ts <= snap.lastCompactedTs (compactor had the chance to fold it in), AND
//   2. the snapshot's live/tombstone state for op.entityId is consistent
//      with this op's outcome.
//
// `update-hike` is never covered: its meta-diff payload is per-device and
// the snapshot only stores the accumulated meta, so we can't tell from the
// snapshot alone whether a specific update-hike was absorbed. Keeping all
// update-hike ops preserves CRDT correctness across divergent per-device
// edits.
export function isOpCoveredBySnapshot(op, snap) {
  if (!snap) return false;
  if (!op || typeof op.ts !== 'number') return false;
  if (op.ts > (snap.lastCompactedTs || 0)) return false;
  const live = snap.live || {};
  const tomb = snap.tombstones || {};
  switch (op.op) {
    case 'add-hike':
      return Object.prototype.hasOwnProperty.call(live, op.entityId);
    case 'delete-hike':
      return Object.prototype.hasOwnProperty.call(tomb, op.entityId);
    case 'update-hike':
      return false;
    default:
      return false;
  }
}

// Fold `ops` into `base` and return a new snapshot. Ops are sorted by
// (ts, opId) so add-then-delete (or delete-then-readd) pairs in the same
// batch resolve to the final state. Callers decide eligibility
// (lastCompactedTs < op.ts <= grace cutoff) upstream; this function trusts
// its input.
export function absorbIntoSnapshot(base, ops) {
  // Carry forward existing live entries. Opportunistically rewrite any
  // legacy `{points, meta}` entries to the packed shape on the way through
  // — this is the cheapest way to actually shrink the snapshot file once
  // the new code starts compacting (entries that no op touches would
  // otherwise stay in their old shape forever).
  const live = {};
  for (const [id, entry] of Object.entries((base && base.live) || {})) {
    if (entry && !entry.pointsPacked && Array.isArray(entry.points)) {
      live[id] = { pointsPacked: packPoints(entry.points), meta: entry.meta || {} };
    } else {
      live[id] = entry;
    }
  }
  const tombstones = { ...((base && base.tombstones) || {}) };
  let maxTs = (base && base.lastCompactedTs) || 0;
  const sorted = [...ops].sort((a, b) =>
    (a.ts - b.ts) || (a.opId < b.opId ? -1 : 1));
  for (const op of sorted) {
    if (op.ts > maxTs) maxTs = op.ts;
    const payload = readOpPayload(op);
    switch (op.op) {
      case 'add-hike':
        live[op.entityId] = {
          pointsPacked: packPoints(payload.points),
          meta: { ...payload.meta },
        };
        delete tombstones[op.entityId];
        break;
      case 'update-hike':
        if (live[op.entityId]) {
          live[op.entityId] = {
            ...live[op.entityId],
            meta: { ...(live[op.entityId].meta || {}), ...(payload.meta || {}) },
          };
        }
        break;
      case 'delete-hike':
        delete live[op.entityId];
        tombstones[op.entityId] = op.ts;
        break;
      default:
        break;
    }
  }
  return { version: 1, lastCompactedTs: maxTs, live, tombstones };
}
