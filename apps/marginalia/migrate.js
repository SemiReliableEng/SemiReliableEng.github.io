#!/usr/bin/env node
//
// migrate.js — Convert Marginalia data.json to WAL ops format
//
// Usage:
//   GH_TOKEN=ghp_xxx GH_USERNAME=user GH_REPO=book-quotes node migrate.js
//
// Reads data.json from the GitHub repo, converts all books and entries
// into WAL ops, writes ops/migration.json and snapshot.json.
// Does NOT modify or delete the original data.json.
//

const DEVICE_ID = 'migration';

// ── GitHub API helpers ──────────────────────────────────────────────

function getConfig() {
  const token = process.env.GH_TOKEN;
  const username = process.env.GH_USERNAME;
  const repo = process.env.GH_REPO || 'book-quotes';
  if (!token || !username) {
    console.error('Required env vars: GH_TOKEN, GH_USERNAME (optional: GH_REPO, default "book-quotes")');
    process.exit(1);
  }
  return { token, username, repo };
}

async function ghRequest(method, path, body) {
  const { token, username, repo } = getConfig();
  const url = `https://api.github.com/repos/${username}/${repo}/contents/${path}`;
  const opts = {
    method,
    headers: {
      'Authorization': `token ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'marginalia-migrate'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

async function readFile(path) {
  const res = await ghRequest('GET', path);
  if (!res.ok) return { content: null, sha: null, status: res.status };
  const content = JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf-8'));
  return { content, sha: res.data.sha, status: res.status };
}

async function writeFile(path, content, message, existingSha) {
  const encoded = Buffer.from(JSON.stringify(content, null, 2), 'utf-8').toString('base64');
  const body = {
    message,
    content: encoded,
    ...(existingSha ? { sha: existingSha } : {})
  };
  const res = await ghRequest('PUT', path, body);
  if (!res.ok) {
    throw new Error(`Failed to write ${path}: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return res.data.content.sha;
}

// ── Materialize ops into snapshot ───────────────────────────────────

function materialize(ops) {
  const sorted = [...ops].sort((a, b) => a.ts - b.ts || a.opId.localeCompare(b.opId));
  const books = {};
  const entries = {};

  for (const op of sorted) {
    switch (op.op) {
      case 'add-book':
        books[op.entityId] = { id: op.entityId, ...op.data };
        break;
      case 'update-book':
        if (books[op.entityId]) {
          Object.assign(books[op.entityId], op.data);
        }
        break;
      case 'delete-book':
        delete books[op.entityId];
        break;
      case 'add-entry':
        entries[op.entityId] = { id: op.entityId, ...op.data };
        break;
      case 'update-entry':
        if (entries[op.entityId]) {
          Object.assign(entries[op.entityId], op.data);
        }
        break;
      case 'delete-entry':
        delete entries[op.entityId];
        break;
    }
  }

  return {
    books: Object.values(books),
    entries: Object.values(entries)
  };
}

// ── Migration logic ─────────────────────────────────────────────────

function convertToOps(data) {
  const ops = [];
  let seq = 0;

  for (const book of (data.books || [])) {
    const ts = book.addedAt || 0;
    const { id, lastAccessed, ...fields } = book;
    ops.push({
      opId: `${DEVICE_ID}_${String(ts).padStart(13, '0')}_${String(seq).padStart(4, '0')}`,
      op: 'add-book',
      entityId: id,
      data: fields,
      ts,
      deviceId: DEVICE_ID
    });
    seq++;
  }

  for (const entry of (data.entries || [])) {
    const ts = entry.createdAt || 0;
    const { id, ...fields } = entry;
    ops.push({
      opId: `${DEVICE_ID}_${String(ts).padStart(13, '0')}_${String(seq).padStart(4, '0')}`,
      op: 'add-entry',
      entityId: id,
      data: fields,
      ts,
      deviceId: DEVICE_ID
    });
    seq++;
  }

  ops.sort((a, b) => a.ts - b.ts || a.opId.localeCompare(b.opId));
  return ops;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log('Marginalia WAL Migration');
  console.log('========================\n');

  // 1. Read data.json
  console.log('Reading data.json from GitHub...');
  const { content: data, status } = await readFile('data.json');
  if (!data) {
    console.error(`Failed to read data.json (HTTP ${status}). Is the repo configured correctly?`);
    process.exit(1);
  }
  console.log(`  Found ${(data.books || []).length} books, ${(data.entries || []).length} entries\n`);

  // 2. Convert to ops
  console.log('Converting to WAL ops...');
  const ops = convertToOps(data);
  console.log(`  Generated ${ops.length} ops\n`);

  // 3. Check if ops/migration.json already exists
  console.log('Checking for existing migration file...');
  const existing = await ghRequest('GET', 'ops/migration.json');
  let migrationSha = null;
  if (existing.ok) {
    console.log('  WARNING: ops/migration.json already exists. Will overwrite.\n');
    migrationSha = existing.data.sha;
  } else {
    console.log('  No existing migration file. Creating new.\n');
  }

  // 4. Write ops/migration.json
  console.log('Writing ops/migration.json...');
  await writeFile('ops/migration.json', ops, 'migration: convert data.json to WAL ops', migrationSha);
  console.log('  Done.\n');

  // 5. Materialize and write snapshot.json
  console.log('Materializing snapshot...');
  const snapshot = materialize(ops);
  console.log(`  Snapshot: ${snapshot.books.length} books, ${snapshot.entries.length} entries`);

  console.log('Checking for existing snapshot.json...');
  const existingSnap = await ghRequest('GET', 'snapshot.json');
  let snapSha = existingSnap.ok ? existingSnap.data.sha : null;

  console.log('Writing snapshot.json...');
  await writeFile('snapshot.json', snapshot, 'migration: write materialized snapshot', snapSha);
  console.log('  Done.\n');

  // 6. Summary
  console.log('Migration complete!');
  console.log('========================');
  console.log(`  Books:   ${(data.books || []).length}`);
  console.log(`  Entries: ${(data.entries || []).length}`);
  console.log(`  Ops:     ${ops.length}`);
  console.log('\nFiles created:');
  console.log('  ops/migration.json  — WAL operation log');
  console.log('  snapshot.json       — materialized state');
  console.log('\nOriginal data.json is untouched.');
  console.log('Run `node verify.js` to confirm the migration is correct.');
}

main().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
