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
// Payload shape: ops carry `{ points, meta }`. `points` is the immutable
// [[lat,lon,ele], …] track geometry that entityId hashes; `meta` holds
// editable fields (name, date, distKm, elevGain, …). Keeping the two
// cleanly split now makes future metadata edits via `update-hike` and a
// potential move of points into a separate blob backend local changes
// rather than data migrations.

// Return an op's payload in `{ points, meta }` form regardless of which
// shape it was written in. Pre-migration ops used a flat
// `{ name, date, distKm, elevGain, coords }` object; readers may encounter
// both shapes until all devices have compacted at least once.
export function readOpPayload(op) {
  const d = (op && op.data) || {};
  if (d.points !== undefined || d.meta !== undefined) {
    return {
      points: Array.isArray(d.points) ? d.points : [],
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
  const live = { ...((base && base.live) || {}) };
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
          points: payload.points,
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
