// Pure geometry, GPX parsing, popup quadrant placement, Bay Area Ridge Trail
// matching/coverage, and slippy-map tile target math for Cairn.

// ── Constants ────────────────────────────────────────────────────────────────

export const RIDGE_BUCKET = 0.0005;      // ~56 m of latitude, ~44 m of longitude at 37.8°N
export const ANCHOR_SNAP_M = 30;         // tight radius that seeds an anchor
export const ANCHOR_MIN_M = 60;          // minimum seed run length in metres
export const GROW_SNAP_M = 120;          // widened radius once an anchor is vouching
export const GROW_SLACK_PTS = 8;         // bad projections a flood may step over before giving up
export const BACKTRACK_TOL_M = 20;       // tolerance for small arc noise against run direction
export const SPIKE_NEIGHBOR_M = 20;      // neighbor agreement tolerance in spike repair
export const ARC_SLACK_M = 50;           // tolerance when testing arc advance against ground advance
export const BRIDGE_MAX_M = 1000;        // longest ridge gap two anchors may bridge over
export const BRIDGE_DETOUR = 1.6;        // max detour ratio between raw track and ridge gap
export const JUNCTION_M = 60;            // ridge segments this close are treated as joined
export const MIN_RUN_M = 150;            // reference run threshold in metres
export const RIDGE_RUN_MIN_M = 40;       // minimum smoothed run length before collapsing into neighbors
export const COVERAGE_M = 30;            // max distance (m) to credit ridge trail coverage
export const COVERAGE_SAMPLE_M = 25;     // max sub-segment sample spacing (m) for coverage
export const COVERAGE_STEP_KM = 0.025;   // max sub-segment sample spacing (km) for coverage
export const RIDGE_TOTAL_KM = 820.8;     // nominal Bay Area Ridge Trail total length (km)
export const BEAK_INSET = 12;            // popup corner beak inset (px)
export const TILE_PREFETCH_ZOOMS = [10, 11, 12, 13, 14, 15];

// ── 1. Distance & Basic Geo Helpers ──────────────────────────────────────────

export function haversine(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

export function distM(a, b) {
  const latM = 111320;
  const lonM = 111320 * Math.cos(a.lat * Math.PI / 180);
  return Math.hypot((b.lat - a.lat) * latM, (b.lon - a.lon) * lonM);
}

// ── 2. Trailing Vehicle Auto-Trim ────────────────────────────────────────────

export function trimTrailingVehicle(pts) {
  const n = Array.isArray(pts) ? pts.length : 0;
  if (n < 15) return { coords: pts || [], trimmedKm: 0 };
  if (!Number.isFinite(pts[0]?.timeMs) || !Number.isFinite(pts[n - 1]?.timeMs)) {
    return { coords: pts, trimmedKm: 0 };
  }

  const V_CAR_MPS = 18.0 / 3.6;                 // 18 km/h = 5.0 m/s (~11.2 mph)
  const V_STATIONARY_MPS = 2.5 / 3.6;           // 2.5 km/h = ~0.694 m/s (~1.5 mph)
  const MAX_START_PROXIMITY_M = 300.0;          // 300 m radius from start
  const MAX_SEARCH_TIME_MS = 3600 * 1000;       // 1 hour
  const MAX_BOARDING_WINDOW_MS = 10 * 60 * 1000;// 10 minutes boarding search window
  const MIN_CAR_DIST_M = 200.0;                 // at least 200 m driving in tail

  const stepDists = new Float64Array(n);
  const stepDts = new Float64Array(n);
  const stepSpeeds = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const d = distM(pts[i - 1], pts[i]);
    stepDists[i] = d;
    if (Number.isFinite(pts[i].timeMs) && Number.isFinite(pts[i - 1].timeMs)) {
      const dt = Math.max(0.1, (pts[i].timeMs - pts[i - 1].timeMs) / 1000);
      stepDts[i] = dt;
      stepSpeeds[i] = d / dt;
    } else {
      stepDts[i] = 1.0;
      stepSpeeds[i] = d;
    }
  }

  const smoothedCache = new Float64Array(n).fill(-1);
  function smoothedSpeed(i) {
    if (smoothedCache[i] >= 0) return smoothedCache[i];
    const t0 = pts[i].timeMs;
    if (!Number.isFinite(t0)) {
      smoothedCache[i] = stepSpeeds[i];
      return stepSpeeds[i];
    }
    let wDist = 0;
    let wDt = 0;
    const lo = Math.max(1, i - 20);
    const hi = Math.min(n - 1, i + 20);
    for (let j = lo; j <= hi; j++) {
      const tj = pts[j].timeMs;
      if (Number.isFinite(tj) && Math.abs(tj - t0) <= 7500) {
        wDist += stepDists[j];
        wDt += stepDts[j];
      }
    }
    const s = wDt > 0 ? (wDist / wDt) : stepSpeeds[i];
    smoothedCache[i] = s;
    return s;
  }

  const tEnd = pts[n - 1].timeMs;
  let accumTailDist = 0;
  let highSpeedDist = 0;
  let onsetIdx = -1;

  for (let i = n - 1; i >= 1; i--) {
    const ti = pts[i].timeMs;
    if (Number.isFinite(ti) && (tEnd - ti) > MAX_SEARCH_TIME_MS) break;
    accumTailDist += stepDists[i];
    const speed = smoothedSpeed(i);
    if (speed >= V_CAR_MPS) {
      highSpeedDist += stepDists[i];
      onsetIdx = i;
    } else {
      if (onsetIdx !== -1 && highSpeedDist >= MIN_CAR_DIST_M) {
        break;
      } else if (onsetIdx === -1 && accumTailDist > 500) {
        return { coords: pts, trimmedKm: 0 };
      }
    }
  }

  if (onsetIdx === -1 || highSpeedDist < MIN_CAR_DIST_M) {
    return { coords: pts, trimmedKm: 0 };
  }

  const startPt = pts[0];
  const tOnset = pts[onsetIdx].timeMs;
  const isLoopNearStart = distM(startPt, pts[onsetIdx]) <= 1000;
  let firstDwellIdx = -1;
  let startProxDwellIdx = -1;

  for (let i = onsetIdx; i >= 1; i--) {
    const ti = pts[i].timeMs;
    if (Number.isFinite(ti) && Number.isFinite(tOnset) && (tOnset - ti) > MAX_BOARDING_WINDOW_MS) {
      break;
    }
    const speed = stepSpeeds[i];
    const isStationary = speed <= V_STATIONARY_MPS || smoothedSpeed(i) <= V_STATIONARY_MPS;
    if (isStationary) {
      if (firstDwellIdx === -1) firstDwellIdx = i;
      if (distM(startPt, pts[i]) <= MAX_START_PROXIMITY_M) {
        startProxDwellIdx = i;
        break;
      }
      if (!isLoopNearStart) {
        break;
      }
    }
  }

  const cutIdx = startProxDwellIdx !== -1
    ? startProxDwellIdx
    : (firstDwellIdx !== -1 ? firstDwellIdx : onsetIdx);
  if (cutIdx <= 5 || cutIdx >= n - 1) {
    return { coords: pts, trimmedKm: 0 };
  }

  let trimmedMeters = 0;
  for (let i = cutIdx + 1; i < n; i++) {
    trimmedMeters += stepDists[i];
  }

  return {
    coords: pts.slice(0, cutIdx + 1),
    trimmedKm: trimmedMeters / 1000,
  };
}

// ── 3. GPX Parser ────────────────────────────────────────────────────────────

export function parseGPX(text, filename = '', domParser = null) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const parser = domParser || (typeof globalThis.DOMParser === 'function' ? new globalThis.DOMParser() : null);
  if (!parser) throw new Error('DOMParser is required to parse GPX');

  const xml = typeof parser.parseFromString === 'function'
    ? parser.parseFromString(text, 'text/xml')
    : parser(text, 'text/xml');
  if (!xml || xml.querySelector?.('parsererror')) return null;

  const nameNode =
    xml.querySelector?.('trk > name') ||
    xml.querySelector?.('metadata > name') ||
    xml.querySelector?.('rte > name') ||
    xml.querySelector?.('trk > name, metadata > name, rte > name, name') ||
    xml.querySelector?.('name');
  const rawName = nameNode?.textContent?.trim() || String(filename || '').replace(/\.gpx$/i, '');
  const name = rawName.slice(0, 200);

  let date = '';
  let dateMs = 0;
  const te = xml.querySelector?.('metadata time') || xml.querySelector?.('time');
  if (te && te.textContent) {
    const d = new Date(te.textContent.trim());
    if (Number.isFinite(d.getTime())) {
      date = d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
      dateMs = new Date(date).getTime() || d.getTime();
    }
  }

  let pts = Array.from(xml.querySelectorAll?.('trkpt') || []);
  if (!pts.length) pts = Array.from(xml.querySelectorAll?.('rtept') || []);
  if (!pts.length) return null;

  const rawCoords = pts.map((p) => {
    const rawLat = parseFloat(p.getAttribute('lat'));
    const rawLon = parseFloat(p.getAttribute('lon'));
    const rawEle = parseFloat(p.querySelector?.('ele')?.textContent);
    const ele = Number.isFinite(rawEle) ? rawEle : 0;
    const rawTime = p.querySelector?.('time')?.textContent;
    const parsedTime = rawTime ? new Date(rawTime).getTime() : NaN;
    const timeMs = Number.isFinite(parsedTime) ? parsedTime : null;
    return { lat: rawLat, lon: rawLon, ele, timeMs };
  }).filter((c) =>
    Number.isFinite(c.lat) && Math.abs(c.lat) <= 90 &&
    Number.isFinite(c.lon) && Math.abs(c.lon) <= 180
  );

  if (rawCoords.length < 2) return null;

  const { coords, trimmedKm } = trimTrailingVehicle(rawCoords);
  if (coords.length < 2) return null;

  let distKm = 0;
  for (let i = 1; i < coords.length; i++) {
    distKm += haversine(coords[i - 1], coords[i]);
  }
  let elevGain = 0;
  for (let i = 1; i < coords.length; i++) {
    const d = coords[i].ele - coords[i - 1].ele;
    if (d > 0) elevGain += d;
  }

  return {
    name,
    date,
    dateMs,
    coords: coords.map((c) => ({ lat: c.lat, lon: c.lon, ele: c.ele })),
    distKm: Math.round(distKm * 10) / 10,
    elevGain: Math.round(elevGain),
    trimmedKm: trimmedKm > 0 ? Math.round(trimmedKm * 10) / 10 : 0,
  };
}

// ── 4. Popup Quadrant & Dynamic Offset Math ──────────────────────────────────

export function getClearestQuadrant(anchorLatLng, coords) {
  if (!coords?.length || !anchorLatLng) return 'ne';
  const isPixel = anchorLatLng.lat === undefined &&
    typeof anchorLatLng.x === 'number' &&
    typeof anchorLatLng.y === 'number';
  const lat0 = isPixel ? 0 : anchorLatLng.lat;
  const lon0 = isPixel ? 0 : (anchorLatLng.lng !== undefined ? anchorLatLng.lng : anchorLatLng.lon);
  const kx = isPixel ? 1 : Math.cos(lat0 * Math.PI / 180) * 111320;
  const ky = isPixel ? 1 : 111320;
  let wNE = 0, wNW = 0, wSE = 0, wSW = 0;

  for (let i = 0; i < coords.length; i++) {
    const c = coords[i];
    if (!c) continue;
    let dx, dy;
    if (isPixel || (c.lat === undefined && typeof c.x === 'number')) {
      dx = c.x - anchorLatLng.x;
      dy = anchorLatLng.y - c.y;
      if (Math.abs(dx) < 1e-7 && Math.abs(dy) < 1e-7) continue;
    } else {
      const cLat = Array.isArray(c) ? c[0] : c.lat;
      const cLon = Array.isArray(c) ? c[1] : (c.lng !== undefined ? c.lng : c.lon);
      const dLat = cLat - lat0;
      const dLon = cLon - lon0;
      if (Math.abs(dLat) < 1e-7 && Math.abs(dLon) < 1e-7) continue;
      dx = dLon * kx;
      dy = dLat * ky;
    }

    const dist = Math.hypot(dx, dy);
    const w = 1.0 / (dist + 50.0);

    if (dy >= 0) {
      if (dx >= 0) wNE += w;
      else wNW += w;
    } else {
      if (dx >= 0) wSE += w;
      else wSW += w;
    }
  }

  const weights = { ne: wNE, nw: wNW, se: wSE, sw: wSW };
  const quadOrder = ['ne', 'nw', 'sw', 'se'];

  let heaviest = 'ne';
  for (const q of quadOrder) {
    if (weights[q] > weights[heaviest]) heaviest = q;
  }
  if (weights[heaviest] === 0) return 'ne';

  const idx = quadOrder.indexOf(heaviest);
  const flank1 = quadOrder[(idx + 3) % 4];
  const flank2 = quadOrder[(idx + 1) % 4];
  const opposite = quadOrder[(idx + 2) % 4];

  if (weights[flank1] < weights[flank2]) {
    return flank1;
  } else if (weights[flank2] < weights[flank1]) {
    return flank2;
  } else {
    return weights[opposite] < weights[flank1] ? opposite : flank1;
  }
}

export function computeDynamicOffset(quad, containerOrW = null, maybeH = undefined) {
  let w = 240;
  let h = 190;
  if (typeof containerOrW === 'number' && Number.isFinite(containerOrW) && containerOrW > 0) {
    w = containerOrW;
    if (typeof maybeH === 'number' && Number.isFinite(maybeH) && maybeH > 0) {
      h = maybeH;
    }
  } else if (containerOrW && typeof containerOrW === 'object') {
    if (containerOrW.offsetWidth) w = containerOrW.offsetWidth;
    else if (containerOrW.width) w = containerOrW.width;
    if (containerOrW.offsetHeight) h = containerOrW.offsetHeight;
    else if (containerOrW.height) h = containerOrW.height;
  }
  const hShift = Math.round(w / 2) + BEAK_INSET;
  if (quad === 'ne') return [hShift, -BEAK_INSET];
  if (quad === 'nw') return [-hShift, -BEAK_INSET];
  if (quad === 'se') return [hShift, h + BEAK_INSET];
  if (quad === 'sw') return [-hShift, h + BEAK_INSET];
  return [0, 0];
}

export function getQuadrantPopupOptions(anchorLatLng, coords, container) {
  const quad = getClearestQuadrant(anchorLatLng, coords);
  const offset = computeDynamicOffset(quad, container);
  return {
    quadrant: quad,
    offset,
    className: 'cairn-hike-popup cairn-popup-' + quad,
  };
}

// ── 5. Optimized Bay Area Ridge Trail Engine ─────────────────────────────────

let lastRidgeSegments = null;
let lastRidgeArcs = null;

function normalizeSegments(ridgeSegments) {
  if (!Array.isArray(ridgeSegments)) return [];
  if (!ridgeSegments.length) return [];
  const firstPt = ridgeSegments[0]?.[0];
  if (firstPt && !Array.isArray(firstPt) && typeof firstPt.lat === 'number') {
    return ridgeSegments;
  }
  return ridgeSegments.map((seg) =>
    seg.map((p) => (Array.isArray(p) ? { lat: p[0], lon: p[1] } : p))
  );
}

export function buildRidgeArcs(ridgeSegments = lastRidgeSegments) {
  const segs = normalizeSegments(ridgeSegments);
  lastRidgeSegments = segs;
  const arcs = segs.map((seg) => {
    const arc = [0];
    for (let i = 1; i < seg.length; i++) {
      arc[i] = arc[i - 1] + distM(seg[i - 1], seg[i]);
    }
    return arc;
  });
  Object.defineProperty(arcs, '_segments', { value: segs, enumerable: false, configurable: true });
  lastRidgeArcs = arcs;
  return arcs;
}

export const buildRidgeArc = buildRidgeArcs;

export function buildRidgeEdgeIndex(ridgeSegments = lastRidgeSegments) {
  const segs = normalizeSegments(ridgeSegments);
  lastRidgeSegments = segs;
  const grid = new Map();
  const edges = [];

  for (let segIdx = 0; segIdx < segs.length; segIdx++) {
    const seg = segs[segIdx];
    for (let i = 1; i < seg.length; i++) {
      const a = seg[i - 1];
      const b = seg[i];
      const idx = edges.length;
      edges.push({ segIdx, vi: i - 1, a, b });
      const span = Math.max(Math.abs(b.lat - a.lat), Math.abs(b.lon - a.lon));
      const steps = Math.max(1, Math.ceil(span / (RIDGE_BUCKET / 2)));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const bLat = Math.round((a.lat + (b.lat - a.lat) * t) / RIDGE_BUCKET);
        const bLon = Math.round((a.lon + (b.lon - a.lon) * t) / RIDGE_BUCKET);
        const key = ((bLat & 0xFFFF) << 16) | (bLon & 0xFFFF);
        let bucket = grid.get(key);
        if (!bucket) {
          bucket = [];
          grid.set(key, bucket);
        }
        if (bucket[bucket.length - 1] !== idx) bucket.push(idx);
      }
    }
  }

  return {
    grid,
    edges,
    segments: segs,
    seenStamp: new Uint32Array(edges.length),
    queryId: 0,
  };
}

export function projectToSeg(p, a, b) {
  const latM = 111320;
  const lonM = 111320 * Math.cos(p.lat * Math.PI / 180);
  const px = (p.lon - a.lon) * lonM;
  const py = (p.lat - a.lat) * latM;
  const bx = (b.lon - a.lon) * lonM;
  const by = (b.lat - a.lat) * latM;
  const len2 = bx * bx + by * by;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  return {
    t,
    d: Math.hypot(px - t * bx, py - t * by),
    lat: a.lat + (b.lat - a.lat) * t,
    lon: a.lon + (b.lon - a.lon) * t,
  };
}

export function projectOntoRidge(p, maxDist, index, arcs = lastRidgeArcs) {
  if (!p || !index || !index.grid || !index.edges) return null;
  const latM = 111320;
  const lonM = 111320 * Math.cos(p.lat * Math.PI / 180);
  const lonMPerBucket = RIDGE_BUCKET * lonM;
  const r = Math.ceil(maxDist / Math.max(lonMPerBucket, 1)) + 1;
  const bLat = Math.round(p.lat / RIDGE_BUCKET);
  const bLon = Math.round(p.lon / RIDGE_BUCKET);

  let seenStamp = index.seenStamp;
  if (!seenStamp || seenStamp.length < index.edges.length) {
    seenStamp = index.seenStamp = new Uint32Array(index.edges.length);
    index.queryId = 0;
  }
  let queryId = (index.queryId = (index.queryId + 1) | 0);
  if (queryId <= 0) {
    seenStamp.fill(0);
    queryId = index.queryId = 1;
  }

  let bestD2 = maxDist * maxDist;
  let bestEdge = null;
  let bestT = 0;
  let bestLat = 0;
  let bestLon = 0;

  const edges = index.edges;
  const grid = index.grid;
  const pLat = p.lat;
  const pLon = p.lon;

  for (let dlat = -r; dlat <= r; dlat++) {
    const latPart = ((bLat + dlat) & 0xFFFF) << 16;
    for (let dlon = -r; dlon <= r; dlon++) {
      const bucket = grid.get(latPart | ((bLon + dlon) & 0xFFFF));
      if (!bucket) continue;
      for (let k = 0; k < bucket.length; k++) {
        const ei = bucket[k];
        if (seenStamp[ei] === queryId) continue;
        seenStamp[ei] = queryId;

        const e = edges[ei];
        const a = e.a;
        const b = e.b;
        const px = (pLon - a.lon) * lonM;
        const py = (pLat - a.lat) * latM;
        const bx = (b.lon - a.lon) * lonM;
        const by = (b.lat - a.lat) * latM;
        const len2 = bx * bx + by * by;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / len2));
        const dx = px - t * bx;
        const dy = py - t * by;
        const d2 = dx * dx + dy * dy;
        if (d2 > bestD2 || (bestEdge !== null && d2 >= bestD2)) continue;
        bestD2 = d2;
        bestEdge = e;
        bestT = t;
        bestLat = a.lat + (b.lat - a.lat) * t;
        bestLon = a.lon + (b.lon - a.lon) * t;
      }
    }
  }

  if (!bestEdge) return null;
  const segArcs = arcs ? arcs[bestEdge.segIdx] : null;
  const edgeLen = segArcs
    ? (segArcs[bestEdge.vi + 1] - segArcs[bestEdge.vi])
    : distM(bestEdge.a, bestEdge.b);
  const baseArc = segArcs ? segArcs[bestEdge.vi] : 0;

  return {
    d: Math.sqrt(bestD2),
    segIdx: bestEdge.segIdx,
    lat: bestLat,
    lon: bestLon,
    arc: baseArc + bestT * edgeLen,
  };
}

export function pointAtArc(segIdx, arc, ridgeSegmentsOrArcs = null, maybeArcs = null) {
  let segs = lastRidgeSegments;
  let arcs = lastRidgeArcs;
  if (maybeArcs) {
    segs = normalizeSegments(ridgeSegmentsOrArcs);
    arcs = maybeArcs;
  } else if (Array.isArray(ridgeSegmentsOrArcs)) {
    if (typeof ridgeSegmentsOrArcs[0]?.[0] === 'number') {
      arcs = ridgeSegmentsOrArcs;
      segs = arcs._segments || lastRidgeSegments;
    } else {
      segs = normalizeSegments(ridgeSegmentsOrArcs);
    }
  }
  const seg = segs[segIdx];
  const a = arcs[segIdx];
  let lo = 0;
  let hi = a.length - 1;
  if (arc <= 0) return { lat: seg[0].lat, lon: seg[0].lon };
  if (arc >= a[hi]) return { lat: seg[hi].lat, lon: seg[hi].lon };
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (a[mid] <= arc) lo = mid;
    else hi = mid;
  }
  const span = a[hi] - a[lo];
  const t = span === 0 ? 0 : (arc - a[lo]) / span;
  return {
    lat: seg[lo].lat + (seg[hi].lat - seg[lo].lat) * t,
    lon: seg[lo].lon + (seg[hi].lon - seg[lo].lon) * t,
  };
}

export function repairArcSpikes(coords, projs) {
  let repaired = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < projs.length - 1; i++) {
      const a = projs[i - 1];
      const b = projs[i];
      const c = projs[i + 1];
      if (!a || !b || !c) continue;
      if (a.segIdx !== b.segIdx || b.segIdx !== c.segIdx) continue;
      const step = distM(coords[i - 1], coords[i]) + distM(coords[i], coords[i + 1]) + ARC_SLACK_M;
      if (Math.abs(b.arc - a.arc) <= step || Math.abs(b.arc - c.arc) <= step) continue;
      if (Math.abs(c.arc - a.arc) > Math.max(step, SPIKE_NEIGHBOR_M)) continue;
      b.arc = (a.arc + c.arc) / 2;
      repaired++;
    }
  }
  return repaired;
}

export function seedRuns(projs) {
  const runs = [];
  let cur = null;
  for (let i = 0; i < projs.length; i++) {
    const pr = projs[i];
    if (!pr) {
      cur = null;
      continue;
    }
    if (cur && cur.segIdx === pr.segIdx) {
      const delta = pr.arc - cur.lastArc;
      if (cur.dir === 0) {
        if (delta !== 0) cur.dir = Math.sign(delta);
        cur.end = i;
        cur.lastArc = pr.arc;
        continue;
      }
      if (Math.sign(delta) === cur.dir || Math.abs(delta) < ANCHOR_SNAP_M) {
        cur.end = i;
        cur.lastArc = pr.arc;
        continue;
      }
    }
    cur = {
      segIdx: pr.segIdx,
      start: i,
      end: i,
      dir: 0,
      startArc: pr.arc,
      lastArc: pr.arc,
    };
    runs.push(cur);
  }
  return runs;
}

export function growAnchor(run, coords, projsWide) {
  const dir = run.dir || 1;
  const fits = (pr, from, sense) =>
    pr && pr.segIdx === run.segIdx && (pr.arc - from) * dir * sense > -ANCHOR_SNAP_M;

  let misses = 0;
  for (let i = run.start - 1; i >= 0; i--) {
    const pr = projsWide[i];
    if (fits(pr, run.startArc, -1)) {
      run.start = i;
      run.startArc = pr.arc;
      misses = 0;
    } else if (++misses > GROW_SLACK_PTS) {
      break;
    }
  }
  misses = 0;
  for (let i = run.end + 1; i < coords.length; i++) {
    const pr = projsWide[i];
    if (fits(pr, run.lastArc, 1)) {
      run.end = i;
      run.lastArc = pr.arc;
      misses = 0;
    } else if (++misses > GROW_SLACK_PTS) {
      break;
    }
  }
  return run;
}

export function canBridge(a, b, cum, ridgeSegments = lastRidgeSegments, arcs = lastRidgeArcs) {
  const trackGap = cum[b.start] - cum[a.end];
  if (a.segIdx === b.segIdx) {
    const ridgeGap = Math.abs(b.startArc - a.lastArc);
    if (ridgeGap > BRIDGE_MAX_M) return false;
    return trackGap <= Math.max(BRIDGE_DETOUR * Math.max(ridgeGap, ANCHOR_SNAP_M), 100) &&
      ridgeGap <= Math.max(BRIDGE_DETOUR * Math.max(trackGap, ANCHOR_SNAP_M), 100);
  }

  const segs = ridgeSegments ? normalizeSegments(ridgeSegments) : lastRidgeSegments;
  if (!segs || !segs[a.segIdx] || !segs[b.segIdx]) return false;
  const segA = segs[a.segIdx];
  const segB = segs[b.segIdx];

  const endAIdx = a.dir < 0 ? 0 : segA.length - 1;
  const endBIdx = b.dir < 0 ? segB.length - 1 : 0;
  const endA = segA[endAIdx];
  const endB = segB[endBIdx];
  if (distM(endA, endB) > JUNCTION_M) return false;
  if (trackGap > BRIDGE_MAX_M) return false;

  const resolvedArcs = arcs || lastRidgeArcs;
  const arcsA = resolvedArcs?.[a.segIdx];
  const arcsB = resolvedArcs?.[b.segIdx];
  if (arcsA && arcsB) {
    const endAArc = endAIdx === 0 ? 0 : arcsA[arcsA.length - 1];
    const endBArc = endBIdx === 0 ? 0 : arcsB[arcsB.length - 1];
    const ridgeGap = Math.abs(endAArc - a.lastArc) + Math.abs(b.startArc - endBArc);
    if (ridgeGap > BRIDGE_MAX_M) return false;
    return trackGap <= Math.max(ridgeGap * BRIDGE_DETOUR, 100);
  }

  return trackGap <= BRIDGE_MAX_M;
}

export function smoothRuns(coords, flags, cum = null) {
  if (!coords?.length || !flags?.length) return [];
  if (!cum) {
    cum = [0];
    for (let i = 1; i < coords.length; i++) {
      cum[i] = cum[i - 1] + distM(coords[i - 1], coords[i]);
    }
  }

  let first = { onRidge: flags[0], start: 0, end: 0, prev: null, next: null, dead: false };
  let tail = first;
  const queue = [first];
  for (let i = 1; i < flags.length; i++) {
    if (flags[i] === tail.onRidge) {
      tail.end = i;
      continue;
    }
    tail.next = { onRidge: flags[i], start: i, end: i, prev: tail, next: null, dead: false };
    tail = tail.next;
    queue.push(tail);
  }

  const lenOf = (r) => cum[r.end] - cum[r.start];
  while (queue.length) {
    const r = queue.pop();
    if (r.dead || lenOf(r) >= RIDGE_RUN_MIN_M) continue;
    const p = r.prev;
    const n = r.next;
    if (!p && !n) break;
    const merged = {
      onRidge: (p || n).onRidge,
      start: (p || r).start,
      end: (n || r).end,
      prev: p ? p.prev : null,
      next: n ? n.next : null,
      dead: false,
    };
    r.dead = true;
    if (p) p.dead = true;
    if (n) n.dead = true;
    if (merged.prev) merged.prev.next = merged;
    else first = merged;
    if (merged.next) merged.next.prev = merged;
    queue.push(merged);
  }

  const runs = [];
  for (let node = first; node; node = node.next) {
    runs.push({ onRidge: node.onRidge, start: node.start, end: node.end });
  }
  return runs;
}

export function matchHikeToRidge(coords, index, arcs = lastRidgeArcs, ridgeSegments = null) {
  const segs = ridgeSegments
    ? normalizeSegments(ridgeSegments)
    : (index?.segments || arcs?._segments || lastRidgeSegments);
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    cum[i] = cum[i - 1] + distM(coords[i - 1], coords[i]);
  }

  const projTight = coords.map((c) => projectOntoRidge(c, ANCHOR_SNAP_M, index, arcs));
  const spikes = repairArcSpikes(coords, projTight);
  const anchors = seedRuns(projTight)
    .filter((r) => cum[r.end] - cum[r.start] >= ANCHOR_MIN_M);
  const anchoredM = anchors.reduce((s, r) => s + (cum[r.end] - cum[r.start]), 0);

  let grownM = 0;
  let bridgedM = 0;
  const matched = new Array(coords.length).fill(false);
  const projs = new Array(coords.length).fill(null);

  if (anchors.length) {
    const projWide = coords.map((c) => projectOntoRidge(c, GROW_SNAP_M, index, arcs));
    repairArcSpikes(coords, projWide);
    const seeds = anchors.map((r) => ({ start: r.start, end: r.end }));
    for (const r of anchors) growAnchor(r, coords, projWide);

    const reface = (r) => {
      r.dir = Math.sign(r.lastArc - r.startArc) || r.dir || 1;
    };
    anchors.forEach(reface);
    anchors.sort((x, y) => x.start - y.start || x.end - y.end);

    const merged = [anchors[0]];
    for (let i = 1; i < anchors.length; i++) {
      const prev = merged[merged.length - 1];
      const r = anchors[i];
      if (r.start <= prev.end + 1 && r.segIdx === prev.segIdx) {
        if (r.end > prev.end) {
          prev.end = r.end;
          prev.lastArc = r.lastArc;
        }
      } else {
        merged.push(r);
      }
    }
    merged.forEach(reface);

    const grownMask = new Array(coords.length).fill(false);
    for (const r of merged) {
      for (let j = r.start; j <= r.end; j++) grownMask[j] = true;
    }
    for (let i = 0; i < merged.length; i++) {
      const r = merged[i];
      for (let j = r.start; j <= r.end; j++) {
        matched[j] = true;
        const cand = projWide[j] || projTight[j];
        if (cand && cand.segIdx === r.segIdx) {
          projs[j] = cand;
        }
      }
      const next = merged[i + 1];
      if (next && canBridge(r, next, cum, segs, arcs)) {
        for (let j = r.end + 1; j < next.start; j++) matched[j] = true;
      }
    }

    const covered = (mask) => {
      let m = 0;
      for (let i = 1; i < coords.length; i++) {
        if (mask[i - 1] && mask[i]) m += cum[i] - cum[i - 1];
      }
      return m;
    };
    const seedMask = new Array(coords.length).fill(false);
    for (const r of seeds) {
      for (let j = r.start; j <= r.end; j++) seedMask[j] = true;
    }
    grownM = covered(grownMask) - covered(seedMask);
    bridgedM = covered(matched) - covered(grownMask);
  }

  return {
    projs,
    matched,
    runs: smoothRuns(coords, matched, cum),
    stats: {
      anchors: anchors.length,
      anchoredM,
      grownM,
      bridgedM,
      spikes,
      matchedM: anchoredM + grownM + bridgedM,
      totalM: cum[cum.length - 1] || 0,
    },
  };
}

export function ridgePathBetween(segIdx, arcFrom, arcTo, ridgeSegments = lastRidgeSegments, arcs = lastRidgeArcs) {
  const segs = ridgeSegments ? normalizeSegments(ridgeSegments) : lastRidgeSegments;
  const resolvedArcs = arcs || lastRidgeArcs;
  const seg = segs?.[segIdx];
  const a = resolvedArcs?.[segIdx];
  if (!seg || !a) return [];
  const lo = Math.min(arcFrom, arcTo);
  const hi = Math.max(arcFrom, arcTo);
  const out = [];
  for (let i = 0; i < seg.length; i++) {
    if (a[i] > lo && a[i] < hi) out.push({ lat: seg[i].lat, lon: seg[i].lon });
  }
  if (arcTo < arcFrom) out.reverse();
  return out;
}

export function buildSnappedView(coordsOrHike, match = null, ridgeSegments = lastRidgeSegments, arcs = lastRidgeArcs) {
  const src = Array.isArray(coordsOrHike) ? coordsOrHike : (coordsOrHike?.coords || []);
  if (!src.length) return { coords: [], runs: [] };

  const segs = ridgeSegments ? normalizeSegments(ridgeSegments) : (arcs?._segments || lastRidgeSegments);
  const resolvedArcs = arcs || lastRidgeArcs;
  const { projs, matched } = match || { projs: [], matched: [] };

  const coords = [];
  const onRidge = [];
  let prev = null;
  const emit = (pt, on) => {
    coords.push(pt);
    onRidge.push(on);
  };

  for (let i = 0; i < src.length; i++) {
    const pr = matched[i] ? projs[i] : null;
    if (pr) {
      if (prev && prev.segIdx === pr.segIdx) {
        for (const v of ridgePathBetween(prev.segIdx, prev.arc, pr.arc, segs, resolvedArcs)) {
          emit({ lat: v.lat, lon: v.lon, ele: src[i].ele }, true);
        }
      } else if (prev && prev.segIdx !== pr.segIdx && segs && resolvedArcs) {
        const segA = segs[prev.segIdx];
        const segB = segs[pr.segIdx];
        const arcsA = resolvedArcs[prev.segIdx];
        const arcsB = resolvedArcs[pr.segIdx];
        if (segA && segB && arcsA && arcsB) {
          let bestDist = Infinity;
          let endAArc = 0;
          let startBArc = 0;
          let endAPt = null;
          let startBPt = null;
          for (const ia of [0, segA.length - 1]) {
            for (const ib of [0, segB.length - 1]) {
              const d = distM(segA[ia], segB[ib]);
              if (d < bestDist) {
                bestDist = d;
                endAArc = ia === 0 ? 0 : arcsA[arcsA.length - 1];
                startBArc = ib === 0 ? 0 : arcsB[arcsB.length - 1];
                endAPt = segA[ia];
                startBPt = segB[ib];
              }
            }
          }
          if (bestDist <= JUNCTION_M) {
            for (const v of ridgePathBetween(prev.segIdx, prev.arc, endAArc, segs, resolvedArcs)) {
              emit({ lat: v.lat, lon: v.lon, ele: src[i].ele }, true);
            }
            if (endAPt) emit({ lat: endAPt.lat, lon: endAPt.lon, ele: src[i].ele }, true);
            if (startBPt && distM(endAPt, startBPt) > 0.5) {
              emit({ lat: startBPt.lat, lon: startBPt.lon, ele: src[i].ele }, true);
            }
            for (const v of ridgePathBetween(pr.segIdx, startBArc, pr.arc, segs, resolvedArcs)) {
              emit({ lat: v.lat, lon: v.lon, ele: src[i].ele }, true);
            }
          }
        }
      }
      const pt = pointAtArc(pr.segIdx, pr.arc, segs, resolvedArcs);
      emit({ lat: pt.lat, lon: pt.lon, ele: src[i].ele }, true);
      prev = { segIdx: pr.segIdx, arc: pr.arc };
    } else if (!matched[i]) {
      emit(src[i], false);
      prev = null;
    }
  }

  if (!coords.length) {
    return {
      coords: src.slice(),
      runs: [{ onRidge: false, start: 0, end: src.length - 1 }],
    };
  }

  const runs = [];
  for (let i = 0; i < onRidge.length; i++) {
    const last = runs[runs.length - 1];
    if (last && last.onRidge === onRidge[i]) last.end = i;
    else runs.push({ onRidge: onRidge[i], start: i, end: i });
  }
  return { coords, runs };
}

// ── Coverage Precomputation & Fast SMI Grid Evaluation ───────────────────────

const coverageSamplesCache = new WeakMap();

export function buildRidgeCoverageSamples(ridgeSegments) {
  if (!Array.isArray(ridgeSegments) || !ridgeSegments.length) {
    return {
      lats: new Float64Array(0),
      lons: new Float64Array(0),
      bLats: new Int32Array(0),
      bLons: new Int32Array(0),
      lonMs: new Float64Array(0),
      pieceKms: new Float64Array(0),
      count: 0,
      totalKm: 0,
    };
  }

  const BUCKET = RIDGE_BUCKET;
  const edgeKms = [];
  const edgeCounts = [];
  let totalSamples = 0;
  let totalKm = 0;

  for (let sIdx = 0; sIdx < ridgeSegments.length; sIdx++) {
    const seg = ridgeSegments[sIdx];
    for (let i = 1; i < seg.length; i++) {
      const rawA = seg[i - 1];
      const rawB = seg[i];
      const a = Array.isArray(rawA) ? { lat: rawA[0], lon: rawA[1] } : rawA;
      const b = Array.isArray(rawB) ? { lat: rawB[0], lon: rawB[1] } : rawB;
      const edgeKm = haversine(a, b);
      const n = Math.max(1, Math.ceil(edgeKm * 1000 / COVERAGE_SAMPLE_M));
      edgeKms.push(edgeKm);
      edgeCounts.push(n);
      totalSamples += n;
      totalKm += edgeKm;
    }
  }

  const lats = new Float64Array(totalSamples);
  const lons = new Float64Array(totalSamples);
  const bLats = new Int32Array(totalSamples);
  const bLons = new Int32Array(totalSamples);
  const lonMs = new Float64Array(totalSamples);
  const pieceKms = new Float64Array(totalSamples);

  let idx = 0;
  let edgeIdx = 0;
  for (let sIdx = 0; sIdx < ridgeSegments.length; sIdx++) {
    const seg = ridgeSegments[sIdx];
    for (let i = 1; i < seg.length; i++) {
      const rawA = seg[i - 1];
      const rawB = seg[i];
      const aLat = Array.isArray(rawA) ? rawA[0] : rawA.lat;
      const aLon = Array.isArray(rawA) ? rawA[1] : rawA.lon;
      const bLatVal = Array.isArray(rawB) ? rawB[0] : rawB.lat;
      const bLonVal = Array.isArray(rawB) ? rawB[1] : rawB.lon;
      const edgeKm = edgeKms[edgeIdx];
      const n = edgeCounts[edgeIdx];
      edgeIdx++;
      const pieceKm = edgeKm / n;
      const dLat = bLatVal - aLat;
      const dLon = bLonVal - aLon;
      for (let s = 0; s < n; s++) {
        const t = (s + 0.5) / n;
        const lat = aLat + dLat * t;
        const lon = aLon + dLon * t;
        lats[idx] = lat;
        lons[idx] = lon;
        bLats[idx] = Math.round(lat / BUCKET);
        bLons[idx] = Math.round(lon / BUCKET);
        lonMs[idx] = 111320 * Math.cos(lat * Math.PI / 180);
        pieceKms[idx] = pieceKm;
        idx++;
      }
    }
  }

  const samples = { lats, lons, bLats, bLons, lonMs, pieceKms, count: totalSamples, totalKm };
  coverageSamplesCache.set(ridgeSegments, samples);
  return samples;
}

export function recomputeCoverageKm(hikes, ridgeSegments = lastRidgeSegments, coverageSamples = null, hikePointsFn = null) {
  if (!Array.isArray(hikes) || !hikes.length) return 0;

  let samples = coverageSamples;
  if (!samples || typeof samples.count !== 'number') {
    if (ridgeSegments && typeof ridgeSegments.count === 'number') {
      samples = ridgeSegments;
    } else if (Array.isArray(ridgeSegments)) {
      samples = coverageSamplesCache.get(ridgeSegments) || buildRidgeCoverageSamples(ridgeSegments);
    }
  }
  if (!samples || !samples.count) return 0;

  const BUCKET = RIDGE_BUCKET;
  const grid = new Map();

  for (let i = 0; i < hikes.length; i++) {
    const h = hikes[i];
    const pts = typeof hikePointsFn === 'function'
      ? hikePointsFn(h)
      : (Array.isArray(h) ? h : (h?.snappedCoords || h?.coords || []));
    for (let j = 0; j < pts.length; j++) {
      const c = pts[j];
      const lat = Array.isArray(c) ? c[0] : c.lat;
      const lon = Array.isArray(c) ? c[1] : c.lon;
      const key = ((Math.round(lat / BUCKET) & 0xFFFF) << 16) | (Math.round(lon / BUCKET) & 0xFFFF);
      let cell = grid.get(key);
      if (!cell) {
        cell = [];
        grid.set(key, cell);
      }
      cell.push(c);
    }
  }

  if (grid.size === 0) return 0;

  const latM = 111320;
  const maxD2 = COVERAGE_M * COVERAGE_M;
  const { lats, lons, bLats, bLons, lonMs, pieceKms, count } = samples;
  let covered = 0;

  for (let i = 0; i < count; i++) {
    const rpLat = lats[i];
    const rpLon = lons[i];
    const bLat = bLats[i];
    const bLon = bLons[i];
    const lonM = lonMs[i];
    let hit = false;

    for (let dlat = -2; dlat <= 2 && !hit; dlat++) {
      const latPart = ((bLat + dlat) & 0xFFFF) << 16;
      for (let dlon = -2; dlon <= 2; dlon++) {
        const pts = grid.get(latPart | ((bLon + dlon) & 0xFFFF));
        if (!pts) continue;
        for (let k = 0; k < pts.length; k++) {
          const p = pts[k];
          const pLat = Array.isArray(p) ? p[0] : p.lat;
          const pLon = Array.isArray(p) ? p[1] : p.lon;
          const dy = (pLat - rpLat) * latM;
          const dx = (pLon - rpLon) * lonM;
          if (dx * dx + dy * dy <= maxD2) {
            hit = true;
            break;
          }
        }
        if (hit) break;
      }
    }

    if (hit) covered += pieceKms[i];
  }

  return covered;
}

// ── 6. Optimized Slippy Map Tile Math ────────────────────────────────────────

export function lonToX(lon, z) {
  return Math.floor((lon + 180) / 360 * (1 << z));
}
export const lonToTileX = lonToX;

export function latToY(lat, z) {
  const r = lat * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * (1 << z));
}
export const latToTileY = latToY;

export function tileWidthM(z) {
  return 40075016.686 / (1 << z);
}

export function metersBetween(aLatOrPt, aLonOrPt, bLat, bLon) {
  if (typeof aLatOrPt === 'object' && aLatOrPt !== null && typeof aLonOrPt === 'object' && aLonOrPt !== null) {
    const a = Array.isArray(aLatOrPt) ? { lat: aLatOrPt[0], lon: aLatOrPt[1] } : aLatOrPt;
    const b = Array.isArray(aLonOrPt) ? { lat: aLonOrPt[0], lon: aLonOrPt[1] } : aLonOrPt;
    return haversine(a, b) * 1000;
  }
  return haversine({ lat: aLatOrPt, lon: aLonOrPt }, { lat: bLat, lon: bLon }) * 1000;
}

export function sampleSegmentTiles(points, z, stepMOrOut = null, maybeOut = null) {
  const stepM = typeof stepMOrOut === 'number' ? stepMOrOut : tileWidthM(z) / 4;
  const tileSet = (stepMOrOut instanceof Set ? stepMOrOut : maybeOut) || new Set();
  if (!Array.isArray(points) || !points.length) return tileSet;

  const getLat = (pt) => (Array.isArray(pt) ? pt[0] : pt.lat);
  const getLon = (pt) => (Array.isArray(pt) ? pt[1] : pt.lon);
  const add = (lat, lon) => tileSet.add(`${z}/${lonToX(lon, z)}/${latToY(lat, z)}`);

  add(getLat(points[0]), getLon(points[0]));
  for (let i = 1; i < points.length; i++) {
    const aLat = getLat(points[i - 1]);
    const aLon = getLon(points[i - 1]);
    const bLat = getLat(points[i]);
    const bLon = getLon(points[i]);
    const dM = metersBetween(aLat, aLon, bLat, bLon);
    const steps = Math.max(1, Math.ceil(dM / stepM));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      add(aLat + (bLat - aLat) * t, aLon + (bLon - aLon) * t);
    }
  }
  return tileSet;
}
export const sampleSegmentToTiles = sampleSegmentTiles;

const ridgeTileZ15Cache = new WeakMap();

function sampleSegmentZ15Packed(points, stepM, z15Set) {
  if (!Array.isArray(points) || !points.length) return;
  const maxZ = 15;
  const getLat = (pt) => (Array.isArray(pt) ? pt[0] : pt.lat);
  const getLon = (pt) => (Array.isArray(pt) ? pt[1] : pt.lon);
  const add = (lat, lon) => {
    const x = lonToX(lon, maxZ);
    const y = latToY(lat, maxZ);
    z15Set.add(((x & 0xFFFF) << 16) | (y & 0xFFFF));
  };

  add(getLat(points[0]), getLon(points[0]));
  for (let i = 1; i < points.length; i++) {
    const aLat = getLat(points[i - 1]);
    const aLon = getLon(points[i - 1]);
    const bLat = getLat(points[i]);
    const bLon = getLon(points[i]);
    const dM = distM({ lat: aLat, lon: aLon }, { lat: bLat, lon: bLon });
    const steps = Math.max(1, Math.ceil(dM / stepM));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      add(aLat + (bLat - aLat) * t, aLon + (bLon - aLon) * t);
    }
  }
}

export function computeTileTargetSet(ridgeStatic = null, hikes = [], tileUrlFn = null) {
  const maxZ = 15;
  const stepM = tileWidthM(maxZ) / 4;
  let z15Set;

  if (Array.isArray(ridgeStatic) && ridgeStatic.length) {
    let cachedRidge = ridgeTileZ15Cache.get(ridgeStatic);
    if (!cachedRidge) {
      cachedRidge = new Set();
      for (let i = 0; i < ridgeStatic.length; i++) {
        sampleSegmentZ15Packed(ridgeStatic[i], stepM, cachedRidge);
      }
      ridgeTileZ15Cache.set(ridgeStatic, cachedRidge);
    }
    z15Set = new Set(cachedRidge);
  } else {
    z15Set = new Set();
  }

  if (Array.isArray(hikes)) {
    for (let i = 0; i < hikes.length; i++) {
      const h = hikes[i];
      const pts = Array.isArray(h) ? h : (h?.coords || []);
      if (pts.length) sampleSegmentZ15Packed(pts, stepM, z15Set);
    }
  }

  const expanded = new Set();
  const useUrlFn = typeof tileUrlFn === 'function';

  for (const z of TILE_PREFETCH_ZOOMS) {
    const shift = maxZ - z;
    let baseZ;
    if (shift === 0) {
      baseZ = z15Set;
    } else {
      baseZ = new Set();
      for (const packed of z15Set) {
        const x = (packed >>> 16) >> shift;
        const y = (packed & 0xFFFF) >> shift;
        baseZ.add((x << 16) | y);
      }
    }

    const max = (1 << z) - 1;
    for (const packed of baseZ) {
      const x = packed >>> 16;
      const y = packed & 0xFFFF;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        if (nx < 0 || nx > max) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny > max) continue;
          expanded.add(useUrlFn ? tileUrlFn(z, nx, ny) : `${z}/${nx}/${ny}`);
        }
      }
    }
  }

  return expanded;
}
