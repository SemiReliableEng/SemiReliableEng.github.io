// Shared op-log sync module.
// See shared/CLAUDE.md for API and invariants.

const APP_NAME_RE = /^[a-z][a-z0-9-]*$/;
const DEVICE_ID_RE = /^[a-zA-Z0-9_-]+$/;

// ── Path safety ────────────────────────────────────────────────────────────

export function buildPath(appName, rel) {
  if (typeof appName !== 'string' || !APP_NAME_RE.test(appName)) {
    throw new Error(`invalid appName: ${JSON.stringify(appName)}`);
  }
  if (typeof rel !== 'string' || rel === '') {
    throw new Error(`invalid relative path: ${JSON.stringify(rel)}`);
  }
  if (rel.startsWith('/')) {
    throw new Error(`absolute path not allowed: ${rel}`);
  }
  if (rel.includes('\x00')) {
    throw new Error('NUL byte in path');
  }
  if (rel.endsWith('/')) {
    throw new Error(`trailing slash not allowed: ${rel}`);
  }
  const parts = rel.split('/');
  for (const p of parts) {
    if (p === '' || p === '.' || p === '..') {
      throw new Error(`invalid path segment in ${JSON.stringify(rel)}`);
    }
  }
  return `apps/${appName}/${rel}`;
}

// ── Base64 (works in Node and browser) ─────────────────────────────────────

function encodeBase64Utf8(str) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(str, 'utf-8').toString('base64');
  }
  // browser: utf-8 safe
  return btoa(unescape(encodeURIComponent(str)));
}

function decodeBase64Utf8(b64) {
  const cleaned = String(b64).replace(/\n/g, '');
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(cleaned, 'base64').toString('utf-8');
  }
  return decodeURIComponent(escape(atob(cleaned)));
}

// ── Storage fallback ───────────────────────────────────────────────────────

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

// ── Main factory ───────────────────────────────────────────────────────────

export const PersonalSync = {
  create(opts) {
    if (!opts || typeof opts !== 'object') {
      throw new Error('PersonalSync.create: options required');
    }
    const { appName, deviceId, getSettings, getDeviceOps } = opts;

    if (typeof appName !== 'string' || !APP_NAME_RE.test(appName)) {
      throw new Error(`invalid appName: ${JSON.stringify(appName)}`);
    }
    if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) {
      throw new Error(`invalid deviceId: ${JSON.stringify(deviceId)}`);
    }
    if (typeof getSettings !== 'function') {
      throw new Error('getSettings function required');
    }
    if (typeof getDeviceOps !== 'function') {
      throw new Error('getDeviceOps function required');
    }

    return new Sync(opts);
  },
};

class Sync {
  constructor(opts) {
    this.appName = opts.appName;
    this.deviceId = opts.deviceId;
    this.getSettings = opts.getSettings;
    this.getDeviceOps = opts.getDeviceOps;
    this.onOpsMerged = opts.onOpsMerged || (() => {});
    this.fetch = opts.fetch || globalThis.fetch?.bind(globalThis);
    this.storage = opts.storage
      || (typeof localStorage !== 'undefined' ? localStorage : memoryStorage());
    this.debounceMs = opts.debounceMs ?? 1500;

    this._listeners = { log: [], status: [] };
    this._debounceTimer = null;
    this._batchDepth = 0;
    this._batchMessage = null;
    this._shaKey = `${this.appName}_device_ops_sha`;
  }

  // ── Events ──────────────────────────────────────────────────────────────

  on(event, fn) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(fn);
  }

  _emit(event, ...args) {
    for (const fn of this._listeners[event] || []) {
      try { fn(...args); } catch { /* never let a listener crash sync */ }
    }
  }

  _log(msg) { this._emit('log', msg); }
  _status(state, label) { this._emit('status', state, label); }

  // ── URL building & guardrails ───────────────────────────────────────────

  _settingsOrNull() {
    const s = this.getSettings() || {};
    if (!s.username || !s.repo || !s.token) return null;
    return s;
  }

  _contentsUrl(settings, relInApp) {
    const path = buildPath(this.appName, relInApp);
    const url = `https://api.github.com/repos/${settings.username}/${settings.repo}/contents/${path}`;
    this._assertSafeUrl(url, settings);
    return url;
  }

  // Git blob API fallback for files > 1MB (Contents API returns empty content
  // with encoding:"none" for those). The sha is only ever derived from a
  // listing response already scoped under apps/{appName}/, so the blob fetch
  // can't escape the app subtree.
  _blobUrl(settings, sha) {
    if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)) {
      throw new Error(`invalid blob sha: ${JSON.stringify(sha)}`);
    }
    const url = `https://api.github.com/repos/${settings.username}/${settings.repo}/git/blobs/${sha}`;
    this._assertSafeBlobUrl(url, settings);
    return url;
  }

  _assertSafeUrl(url, settings) {
    const expectedPrefix =
      `https://api.github.com/repos/${settings.username}/${settings.repo}/contents/apps/${this.appName}/`;
    const dirExact =
      `https://api.github.com/repos/${settings.username}/${settings.repo}/contents/apps/${this.appName}`;
    if (url !== dirExact && !url.startsWith(expectedPrefix)) {
      throw new Error(`URL outside app scope: ${url}`);
    }
  }

  _assertSafeBlobUrl(url, settings) {
    const expectedPrefix =
      `https://api.github.com/repos/${settings.username}/${settings.repo}/git/blobs/`;
    if (!url.startsWith(expectedPrefix)) {
      throw new Error(`blob URL outside repo: ${url}`);
    }
  }

  _headers(token) {
    return {
      'Authorization': `token ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.github.v3+json',
    };
  }

  _timestamp() {
    return new Date().toISOString().substring(0, 16).replace('T', ' ');
  }

  _defaultMessage() {
    return `apps/${this.appName}/ops/${this.deviceId}: ${this._timestamp()}`;
  }

  // ── Push ────────────────────────────────────────────────────────────────

  schedulePush() {
    if (this._batchDepth > 0) return;
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      this.pushNow().catch(() => {});
    }, this.debounceMs);
  }

  async pushNow(opts = {}) {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }

    const settings = this._settingsOrNull();
    if (!settings) {
      this._status('error', '✗ not configured');
      this._log('✗ GitHub settings not configured');
      return;
    }

    const deviceOps = this.getDeviceOps() || [];
    if (deviceOps.length === 0) return;

    this._status('syncing', '⟳ syncing');
    const message = opts.message || this._defaultMessage();
    const content = encodeBase64Utf8(JSON.stringify(deviceOps, null, 2));

    try {
      const newSha = await this._putWithRetry(settings, content, message);
      if (newSha) {
        this.storage.setItem(this._shaKey, newSha);
      }
      this._status('ok', '✓ synced');
      this._log('✓ Pushed ops to GitHub');
    } catch (e) {
      this._status('error', '✗ offline');
      this._log(`✗ Push error: ${e.message}`);
    }
  }

  async _putWithRetry(settings, content, message) {
    const url = this._contentsUrl(settings, `ops/${this.deviceId}.json`);
    const storedSha = this.storage.getItem(this._shaKey);

    const res = await this._put(url, settings.token, {
      message,
      content,
      ...(storedSha ? { sha: storedSha } : {}),
    });

    if (res.ok) {
      const data = await res.json();
      return data?.content?.sha;
    }

    if (res.status === 409) {
      this._log('⚠ SHA conflict on push, re-fetching…');
      const getRes = await this.fetch(url, { method: 'GET', headers: this._headers(settings.token) });
      let freshSha = null;
      if (getRes.ok) {
        const getData = await getRes.json();
        freshSha = getData?.sha || null;
        if (freshSha) this.storage.setItem(this._shaKey, freshSha);
      }
      const retryRes = await this._put(url, settings.token, {
        message, content,
        ...(freshSha ? { sha: freshSha } : {}),
      });
      if (retryRes.ok) {
        const data = await retryRes.json();
        return data?.content?.sha;
      }
      throw new Error(`push retry failed: ${retryRes.status}`);
    }

    if (res.status === 422) {
      this._log('⚠ 422 on push, retrying without sha…');
      const retryRes = await this._put(url, settings.token, { message, content });
      if (retryRes.ok) {
        const data = await retryRes.json();
        return data?.content?.sha;
      }
      throw new Error(`push fallback failed: ${retryRes.status}`);
    }

    const errData = await res.json().catch(() => ({}));
    throw new Error(`push failed: ${res.status} ${errData?.message || ''}`.trim());
  }

  async _put(url, token, body) {
    return this.fetch(url, {
      method: 'PUT',
      headers: this._headers(token),
      body: JSON.stringify(body),
    });
  }

  // ── Pull ────────────────────────────────────────────────────────────────

  async pull() {
    const settings = this._settingsOrNull();
    if (!settings) {
      this._status('error', '✗ not configured');
      return;
    }

    this._status('syncing', '⟳ pulling');
    try {
      const dirUrl = this._contentsUrl(settings, 'ops');
      const dirRes = await this.fetch(dirUrl, { method: 'GET', headers: this._headers(settings.token) });
      if (!dirRes.ok) {
        if (dirRes.status === 404) {
          // First boot against a fresh app subtree: no ops/ dir yet. Not an
          // error — the next push will create it. Clear any stale device-ops
          // SHA so the push PUTs without a sha (create, not update).
          this.storage.removeItem(this._shaKey);
          this._status('ok', '✓ empty');
          this._log('↳ No remote ops yet — will seed on first push');
          return { initialized: false };
        }
        throw new Error(`pull list failed: ${dirRes.status}`);
      }

      const listing = await dirRes.json();
      const opFiles = (Array.isArray(listing) ? listing : [])
        .filter((f) => f && f.type === 'file' && typeof f.name === 'string' && f.name.endsWith('.json'));

      const ourFile = opFiles.find((f) => f.name === `${this.deviceId}.json`);
      if (ourFile) {
        this.storage.setItem(this._shaKey, ourFile.sha);
      } else {
        this.storage.removeItem(this._shaKey);
      }

      const arrays = await Promise.all(opFiles.map(async (f) => {
        const fileUrl = this._contentsUrl(settings, `ops/${f.name}`);
        const fileRes = await this.fetch(fileUrl, {
          method: 'GET', headers: this._headers(settings.token),
        });
        if (!fileRes.ok) return [];
        const fileData = await fileRes.json();
        let b64 = fileData?.content;
        // Contents API returns empty content (encoding:"none") for files > 1MB.
        // Fall back to the git blob API, which handles up to 100MB.
        if (!b64 && fileData?.sha) {
          try {
            const blobUrl = this._blobUrl(settings, fileData.sha);
            const blobRes = await this.fetch(blobUrl, {
              method: 'GET', headers: this._headers(settings.token),
            });
            if (blobRes.ok) {
              const blobData = await blobRes.json();
              if (blobData?.encoding === 'base64') b64 = blobData.content;
            }
          } catch {
            return [];
          }
        }
        if (!b64) return [];
        try {
          const parsed = JSON.parse(decodeBase64Utf8(b64));
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      }));

      let allOps = arrays.flat();

      // dedupe by opId
      const seen = new Set();
      allOps = allOps.filter((op) => {
        if (!op || typeof op.opId !== 'string') return false;
        if (seen.has(op.opId)) return false;
        seen.add(op.opId);
        return true;
      });

      // merge local-only ops
      const localOps = this.getDeviceOps() || [];
      for (const op of localOps) {
        if (op && typeof op.opId === 'string' && !seen.has(op.opId)) {
          allOps.push(op);
          seen.add(op.opId);
        }
      }

      this.onOpsMerged(allOps);
      this._status('ok', '✓ synced');
      this._log(`✓ Pulled ${allOps.length} op(s) from ${opFiles.length} file(s)`);
      return { initialized: true, ops: allOps };
    } catch (e) {
      this._status('error', '✗ offline');
      this._log(`✗ Pull error: ${e.message}`);
    }
  }

  async syncNow() {
    await this.pull();
    await this.pushNow();
  }

  // ── Batch ───────────────────────────────────────────────────────────────

  async batch(fn, opts = {}) {
    this._batchDepth++;
    if (opts.message && !this._batchMessage) this._batchMessage = opts.message;
    try {
      await fn();
    } finally {
      this._batchDepth--;
      if (this._batchDepth === 0) {
        const message = this._batchMessage;
        this._batchMessage = null;
        await this.pushNow(message ? { message } : {});
      }
    }
  }

  // ── Blob stubs (Phase 2) ────────────────────────────────────────────────

  async putBlob(_bytes, _opts) {
    throw new Error('putBlob: not implemented in v1');
  }

  async getBlob(_ref) {
    throw new Error('getBlob: not implemented in v1');
  }
}
