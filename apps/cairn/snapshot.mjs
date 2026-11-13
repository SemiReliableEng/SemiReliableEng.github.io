// Pure snapshot and CRDT state primitives for cairn's WAL+snapshot sync pattern.
// Imported by apps/cairn/index.html and covered by apps/cairn/snapshot.test.mjs.
//
// Key divergence from marginalia's pattern: cairn entityIds are
// content-addressed (sha-256 of normalized coords in computeHikeId), so the
// same entityId can recur after a delete → re-import cycle. A naive
// `ts <= lastCompactedTs` rule would flag a post-delete re-add as covered
// by a snapshot whose live state reflects the deleted version, or leave a
// pre-re-add delete uncovered after compaction clears the tombstone. The
// timestamped tombstone-outcome rules below require that the snapshot's
// live/tombstone state and timestamps for the entityId cover the op.

const PACKED_SCALE = 1e5;
const PACKED_VERSION = 1;
const FORBIDDEN_ENTITY_IDS = new Set(['__proto__', 'constructor', 'prototype']);

function isValidEntityId(id) {
  return typeof id === 'string' && id.length > 0 && !FORBIDDEN_ENTITY_IDS.has(id);
}

function pickAllowedMeta(m, baseMeta = null, isUpdate = false) {
  const out = baseMeta ? { ...baseMeta } : {};
  if (!m || typeof m !== 'object') return out;
  if (typeof m.name === 'string') out.name = m.name;
  if (typeof m.date === 'string') out.date = m.date;
  if (typeof m.distKm === 'number' && Number.isFinite(m.distKm)) out.distKm = m.distKm;
  if (typeof m.elevGain === 'number' && Number.isFinite(m.elevGain)) out.elevGain = m.elevGain;
  if (isUpdate) {
    if (m.snapped !== undefined) out.snapped = !!m.snapped;
    if (typeof m.notes === 'string') {
      if (m.notes === '') delete out.notes;
      else out.notes = m.notes.slice(0, 4000);
    }
  } else {
    if (m.snapped) out.snapped = true;
    if (typeof m.notes === 'string' && m.notes) out.notes = m.notes.slice(0, 4000);
  }
  return out;
}

// Pack a [[lat, lon, ele], …] track into delta-encoded integer chunks.
// `chunkSize` defaults to a single chunk; smaller K trades a small size
// hit (one absolute base per chunk) for chunk-local random access if a
// future caller wants to decode partially. Encoding is lossy at the
// quantization step (Math.round to scale) but reconstruction across
// deltas is exact integer arithmetic — no drift with chunk length.
export function packPoints(coords, chunkSize, scale = PACKED_SCALE) {
  if (chunkSize && typeof chunkSize === 'object') {
    scale = chunkSize.scale;
    chunkSize = chunkSize.chunkSize;
  }
  const safeScale = (typeof scale === 'number' && Number.isFinite(scale) && scale > 0)
    ? scale
    : PACKED_SCALE;
  const out = { v: PACKED_VERSION, scale: safeScale, lats: [], lons: [], eles: [] };
  if (!Array.isArray(coords) || coords.length === 0) return out;
  const valid = [];
  for (let i = 0; i < coords.length; i++) {
    const c = coords[i];
    if (Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1])) {
      valid.push(c);
    }
  }
  const N = valid.length;
  if (N === 0) return out;
  const K = (typeof chunkSize === 'number' && Number.isFinite(chunkSize) && chunkSize > 0)
    ? Math.min(Math.floor(chunkSize), N)
    : N;
  for (let start = 0; start < N; start += K) {
    const end = Math.min(start + K, N);
    const lats = new Array(end - start);
    const lons = new Array(end - start);
    const eles = new Array(end - start);
    let prevLat = 0, prevLon = 0, prevEle = 0;
    for (let i = start; i < end; i++) {
      const c = valid[i];
      const lat = Math.round(c[0] * safeScale);
      const lon = Math.round(c[1] * safeScale);
      const ele = Number.isFinite(c[2]) ? Math.round(c[2]) : prevEle;
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
  const scale = (typeof packed.scale === 'number' && Number.isFinite(packed.scale) && packed.scale > 0)
    ? packed.scale
    : PACKED_SCALE;
  const out = [];
  for (let c = 0; c < packed.lats.length; c++) {
    const lats = packed.lats[c] || [];
    const lons = packed.lons?.[c] || [];
    const eles = packed.eles?.[c];
    const hasEle = Array.isArray(eles);
    let lat = 0, lon = 0, ele = 0;
    for (let i = 0; i < lats.length; i++) {
      const dLat = Number.isFinite(lats[i]) ? lats[i] : 0;
      const dLon = Number.isFinite(lons[i]) ? lons[i] : 0;
      const dEle = (hasEle && Number.isFinite(eles[i])) ? eles[i] : 0;
      lat = i === 0 ? dLat : lat + dLat;
      lon = i === 0 ? dLon : lon + dLon;
      ele = i === 0 ? dEle : ele + dEle;
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

// Replay order. Every place that folds ops must agree on this, or a "later op
// wins" argument made in one place can be false in another.
export function replayOrder(a, b) {
  const tsA = (a && typeof a.ts === 'number') ? a.ts : 0;
  const tsB = (b && typeof b.ts === 'number') ? b.ts : 0;
  if (tsA !== tsB) return tsA - tsB;
  const idA = (a && a.opId) || '';
  const idB = (b && b.opId) || '';
  return idA < idB ? -1 : (idA > idB ? 1 : 0);
}

// Is `op`'s effect already absorbed into `snap`?
//
// Covered iff BOTH:
//   1. op.ts <= snap.lastCompactedTs (compactor had the chance to fold it in), AND
//   2. the snapshot's live/tombstone state and timestamp for op.entityId cover
//      this op's outcome.
export function isOpCoveredBySnapshot(op, snap) {
  if (!op || typeof op.ts !== 'number' || !snap || typeof snap.lastCompactedTs !== 'number') {
    return false;
  }
  if (!isValidEntityId(op.entityId)) return false;
  if ((op.ts || 0) > snap.lastCompactedTs) return false;
  const live = snap.live || {};
  const tomb = snap.tombstones || {};
  switch (op.op) {
    case 'add-hike':
    case 'delete-hike': {
      if (Object.hasOwn(live, op.entityId)) {
        const liveTs = typeof live[op.entityId]?.ts === 'number'
          ? live[op.entityId].ts
          : snap.lastCompactedTs;
        return (op.ts || 0) <= liveTs;
      }
      if (Object.hasOwn(tomb, op.entityId)) {
        return (op.ts || 0) <= tomb[op.entityId];
      }
      return false;
    }
    case 'update-hike': {
      if (Object.hasOwn(tomb, op.entityId)) {
        return (op.ts || 0) <= tomb[op.entityId];
      }
      if (Object.hasOwn(live, op.entityId)) {
        const entry = live[op.entityId];
        if (typeof entry?.ts === 'number' && (op.ts || 0) <= entry.ts) {
          return true;
        }
        if (typeof entry?.metaTs === 'number' && (op.ts || 0) <= entry.metaTs) {
          return true;
        }
        return false;
      }
      return false;
    }
    default:
      return false;
  }
}

// Fold `ops` into `base` and return a new snapshot. Ops are sorted by
// (ts, opId) so add-then-delete (or delete-then-readd) pairs in the same
// batch resolve to the final state.
export function absorbIntoSnapshot(base, ops) {
  const live = {};
  for (const [id, entry] of Object.entries((base && base.live) || {})) {
    if (!isValidEntityId(id)) continue;
    if (entry && !entry.pointsPacked && Array.isArray(entry.points)) {
      const migrated = {
        pointsPacked: packPoints(entry.points),
        meta: pickAllowedMeta(entry.meta, null, false),
      };
      if (typeof entry.ts === 'number') migrated.ts = entry.ts;
      if (typeof entry.metaTs === 'number') migrated.metaTs = entry.metaTs;
      live[id] = migrated;
    } else {
      live[id] = entry;
    }
  }
  const tombstones = {};
  for (const [id, ts] of Object.entries((base && base.tombstones) || {})) {
    if (isValidEntityId(id)) tombstones[id] = ts;
  }
  let maxTs = (base && base.lastCompactedTs) || 0;
  const sorted = [...(ops || [])].filter(Boolean).sort(replayOrder);
  for (const op of sorted) {
    if (typeof op.ts === 'number' && op.ts > maxTs) maxTs = op.ts;
    if (!isValidEntityId(op.entityId)) continue;
    switch (op.op) {
      case 'add-hike': {
        const d = (op && op.data) || {};
        const pp = d.pointsPacked;
        let pointsPacked;
        let rawMeta;
        if (pp && pp.v === PACKED_VERSION && Array.isArray(pp.lats) && Array.isArray(pp.lons)) {
          pointsPacked = pp;
          rawMeta = d.meta && typeof d.meta === 'object' ? d.meta : {};
        } else {
          const payload = readOpPayload(op);
          pointsPacked = packPoints(payload.points);
          rawMeta = payload.meta;
        }
        live[op.entityId] = {
          pointsPacked,
          meta: pickAllowedMeta(rawMeta, null, false),
          ts: op.ts,
          metaTs: op.ts,
        };
        delete tombstones[op.entityId];
        break;
      }
      case 'update-hike': {
        if (Object.hasOwn(live, op.entityId)) {
          const d = (op && op.data) || {};
          const rawMeta = (d.meta && typeof d.meta === 'object') ? d.meta : readOpPayload(op).meta;
          const prev = live[op.entityId];
          const nextMetaTs = Math.max(prev.metaTs || prev.ts || 0, op.ts || 0);
          live[op.entityId] = {
            ...prev,
            meta: pickAllowedMeta(rawMeta, prev.meta, true),
            metaTs: nextMetaTs,
          };
        }
        break;
      }
      case 'delete-hike': {
        delete live[op.entityId];
        tombstones[op.entityId] = op.ts;
        break;
      }
      default:
        break;
    }
  }
  return { version: 1, lastCompactedTs: maxTs, live, tombstones };
}

// Our own repeated update-hike ops touching the *same field set* on the same
// hike: only the last survives replay, so the earlier ones are pure storage
// waste. Returns the key they collapse on, or null when the op must be kept.
export function updateCollapseKey(op, deviceId) {
  if (!op || op.op !== 'update-hike' || !isValidEntityId(op.entityId)) return null;
  if (deviceId !== undefined && op.deviceId !== deviceId) return null;
  const keys = Object.keys(op.data?.meta || {}).sort().join(',');
  return keys ? `${op.entityId}:${keys}` : null;
}

export function collapseOwnUpdates(opsList, deviceId) {
  if (!Array.isArray(opsList)) return [];
  const kept = new Map();
  const out = [];
  for (const op of opsList) {
    const key = (deviceId !== undefined ? (deviceId !== null && op?.deviceId === deviceId) : true)
      ? updateCollapseKey(op, deviceId)
      : null;
    if (!key) {
      out.push(op);
      continue;
    }
    const existing = kept.get(key);
    if (!existing || replayOrder(existing, op) < 0) kept.set(key, op);
  }
  return [...out, ...kept.values()];
}

export function minimalOpsForStorage(opsList, deviceId) {
  if (!Array.isArray(opsList)) return [];
  const keptAddDel = new Map(); // `${op}:${entityId}` → chosen op
  const rest = [];
  for (const op of opsList) {
    if (!op) continue;
    if (deviceId && op.deviceId === deviceId) {
      rest.push(op);
      continue;
    }
    if (op.op === 'add-hike' || op.op === 'delete-hike') {
      const key = `${op.op}:${op.entityId}`;
      const existing = keptAddDel.get(key);
      const prefer = !existing || replayOrder(existing, op) < 0;
      if (prefer) keptAddDel.set(key, op);
      continue;
    }
    rest.push(op);
  }
  return [...keptAddDel.values(), ...collapseOwnUpdates(rest, deviceId)].sort(replayOrder);
}

export function normalizeCoords(coordsObjArray) {
  if (!Array.isArray(coordsObjArray)) return [];
  return coordsObjArray.map(c => [
    +(c.lat.toFixed(5)),
    +(c.lon.toFixed(5)),
    Number.isFinite(c.ele) ? Math.round(c.ele) : 0,
  ]);
}

export function denormalizeCoords(pairs) {
  if (!Array.isArray(pairs)) return [];
  return pairs.map(c => ({ lat: c[0], lon: c[1], ele: c[2] }));
}

// Stable, content-addressed ID for a hike. Two uploads of the same GPX produce
// the same hikeId → importer skips the re-upload without creating an op.
export async function computeHikeId(coordsObjArray) {
  const normalized = normalizeCoords(coordsObjArray);
  const bytes = new TextEncoder().encode(JSON.stringify(normalized));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .slice(0, 8)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// Flatten a snapshot live entry or op payload into the { id, name, date,
// dateMs, distKm, elevGain, snapped, notes, coords } shape that the render layer
// expects. Optional `existingCoordsMap` reuses already-decoded `{lat,lon,ele}`
// arrays for `id` so metadata edits / deletes don't re-unpack immutable tracks.
export function hydrateHike(id, points, meta = {}, existingCoordsMap = null) {
  const m = meta || {};
  const t = m.date ? Date.parse(m.date) : NaN;
  let coords = null;
  if (existingCoordsMap) {
    const cached = existingCoordsMap instanceof Map
      ? existingCoordsMap.get(id)
      : (Object.hasOwn(existingCoordsMap, id) ? existingCoordsMap[id] : null);
    if (
      Array.isArray(cached) &&
      cached.length > 0 &&
      (!Array.isArray(points) || points.length === 0 || cached.length === points.length)
    ) {
      coords = cached;
    }
  }
  if (!coords) {
    coords = denormalizeCoords(points || []);
  }
  return {
    id,
    name: m.name,
    date: m.date,
    dateMs: Number.isNaN(t) ? -Infinity : t,
    distKm: m.distKm,
    elevGain: m.elevGain,
    snapped: !!m.snapped,
    notes: typeof m.notes === 'string' ? m.notes : '',
    coords,
  };
}

// Replay ops in ts order into the target hikes array, seeded from the
// snapshot's live map. Supports both `materializeInto(target, snapshot, ops)`
// and `materializeInto(target, { snapshot, ops, existingCoords })`.
export function materializeInto(target, snapshotOrOpts = null, opsArg = []) {
  if (!Array.isArray(target)) return [];
  let snapshot = null;
  let ops = [];
  let existingCoords = null;
  if (
    snapshotOrOpts &&
    typeof snapshotOrOpts === 'object' &&
    !Array.isArray(snapshotOrOpts) &&
    ('snapshot' in snapshotOrOpts || 'ops' in snapshotOrOpts || 'existingCoords' in snapshotOrOpts) &&
    !('live' in snapshotOrOpts) &&
    !('lastCompactedTs' in snapshotOrOpts)
  ) {
    snapshot = snapshotOrOpts.snapshot || null;
    ops = Array.isArray(snapshotOrOpts.ops) ? snapshotOrOpts.ops : [];
    existingCoords = snapshotOrOpts.existingCoords || null;
  } else {
    snapshot = snapshotOrOpts;
    ops = Array.isArray(opsArg) ? opsArg : [];
  }

  const coordsMap = new Map();
  if (existingCoords instanceof Map) {
    for (const [k, v] of existingCoords.entries()) {
      if (Array.isArray(v) && v.length > 0) coordsMap.set(k, v);
    }
  } else if (existingCoords && typeof existingCoords === 'object') {
    for (const [k, v] of Object.entries(existingCoords)) {
      if (Array.isArray(v) && v.length > 0) coordsMap.set(k, v);
    }
  }
  for (const h of target) {
    if (h && typeof h.id === 'string' && Array.isArray(h.coords) && h.coords.length > 0) {
      if (!coordsMap.has(h.id)) coordsMap.set(h.id, h.coords);
    }
  }

  const byId = new Map();
  const entityTs = new Map();
  const live = (snapshot && snapshot.live) || {};
  const tomb = (snapshot && snapshot.tombstones) || {};

  for (const [id, tombTs] of Object.entries(tomb)) {
    if (!isValidEntityId(id)) continue;
    if (typeof tombTs === 'number') entityTs.set(id, tombTs);
  }

  for (const [id, state] of Object.entries(live)) {
    if (!isValidEntityId(id) || !state) continue;
    const expectedLen = state.pointsPacked
      ? state.pointsPacked.lats?.reduce((s, c) => s + (c?.length || 0), 0)
      : (Array.isArray(state.points) ? state.points.length : -1);
    const cached = coordsMap.get(id);
    const canReuse = Array.isArray(cached) && cached.length > 0 && (expectedLen < 0 || cached.length === expectedLen);
    const pts = canReuse ? null : readSnapshotPoints(state);
    const hydrated = hydrateHike(id, pts, state.meta || {}, canReuse ? coordsMap : null);
    if (hydrated.coords.length > 0 && !coordsMap.has(id)) {
      coordsMap.set(id, hydrated.coords);
    }
    byId.set(id, hydrated);
    if (typeof state.ts === 'number') {
      entityTs.set(id, Math.max(entityTs.get(id) || 0, state.ts));
    }
  }

  const sorted = ops.slice().filter(Boolean).sort(replayOrder);
  for (const op of sorted) {
    if (!isValidEntityId(op.entityId)) continue;
    const opTs = op.ts || 0;
    const snapTombTs = (Object.hasOwn(tomb, op.entityId) && typeof tomb[op.entityId] === 'number')
      ? tomb[op.entityId]
      : -Infinity;
    const snapLiveTs = (Object.hasOwn(live, op.entityId) && typeof live[op.entityId]?.ts === 'number')
      ? live[op.entityId].ts
      : -Infinity;
    if (opTs < snapTombTs || opTs < snapLiveTs) continue;

    if (op.op === 'add-hike') {
      const d = (op && op.data) || {};
      const expectedLen = d.pointsPacked
        ? d.pointsPacked.lats?.reduce((s, c) => s + (c?.length || 0), 0)
        : (Array.isArray(d.points) ? d.points.length : (Array.isArray(d.coords) ? d.coords.length : -1));
      const cached = coordsMap.get(op.entityId);
      const canReuse = Array.isArray(cached) && cached.length > 0 && (expectedLen < 0 || cached.length === expectedLen);
      let pts = null;
      let meta = {};
      if (canReuse) {
        if (d.pointsPacked !== undefined || d.meta !== undefined || d.points !== undefined) {
          meta = d.meta && typeof d.meta === 'object' ? d.meta : {};
        } else {
          const { coords: _c, ...restMeta } = d;
          meta = restMeta;
        }
      } else {
        const payload = readOpPayload(op);
        pts = payload.points;
        meta = payload.meta;
      }
      const hydrated = hydrateHike(op.entityId, pts, meta, canReuse ? coordsMap : null);
      if (hydrated.coords.length > 0 && !coordsMap.has(op.entityId)) {
        coordsMap.set(op.entityId, hydrated.coords);
      }
      byId.set(op.entityId, hydrated);
      entityTs.set(op.entityId, opTs);
    } else if (op.op === 'update-hike') {
      const existing = byId.get(op.entityId);
      if (existing && opTs >= (entityTs.get(op.entityId) || 0)) {
        const d = (op && op.data) || {};
        const m = (d.meta && typeof d.meta === 'object') ? d.meta : (readOpPayload(op).meta || {});
        if (typeof m.name === 'string') existing.name = m.name;
        if (typeof m.date === 'string') {
          existing.date = m.date;
          existing.dateMs = m.date ? (new Date(m.date).getTime() || 0) : 0;
        }
        if (typeof m.distKm === 'number' && Number.isFinite(m.distKm)) existing.distKm = m.distKm;
        if (typeof m.elevGain === 'number' && Number.isFinite(m.elevGain)) existing.elevGain = m.elevGain;
        if (m.snapped !== undefined) existing.snapped = !!m.snapped;
        if (typeof m.notes === 'string') existing.notes = m.notes.slice(0, 4000);
      }
    } else if (op.op === 'delete-hike') {
      byId.delete(op.entityId);
      entityTs.set(op.entityId, opTs);
    }
  }

  target.length = 0;
  for (const h of byId.values()) target.push(h);
  for (const h of target) {
    const t = h.date ? Date.parse(h.date) : NaN;
    h.dateMs = Number.isNaN(t) ? -Infinity : t;
  }
  target.sort((a, b) => (b.dateMs === a.dateMs ? 0 : (b.dateMs > a.dateMs ? 1 : -1)));
  return target;
}
