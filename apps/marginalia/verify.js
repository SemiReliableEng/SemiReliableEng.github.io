#!/usr/bin/env node
//
// verify.js — Verify WAL migration by comparing materialized ops to original data.json
//
// Usage:
//   GH_TOKEN=ghp_xxx GH_USERNAME=user GH_REPO=book-quotes node verify.js
//
// Loads data.json and all ops from ops/, materializes the ops,
// and compares the two datasets field-by-field.
// Exit code 0 = match, 1 = differences found.
//

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

async function ghRequest(method, path) {
  const { token, username, repo } = getConfig();
  const url = `https://api.github.com/repos/${username}/${repo}/contents/${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `token ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'marginalia-verify'
    }
  });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

async function readFile(path) {
  const res = await ghRequest('GET', path);
  if (!res.ok) return null;
  return JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf-8'));
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

// ── Comparison logic ────────────────────────────────────────────────

function normalize(val) {
  if (val === undefined || val === null || val === '') return '';
  return val;
}

function compareObjects(a, b, label) {
  const diffs = [];
  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of allKeys) {
    if (key === 'lastAccessed') continue; // local-only field, skip
    const va = normalize(a[key]);
    const vb = normalize(b[key]);
    if (typeof va === 'object' || typeof vb === 'object') {
      if (JSON.stringify(va) !== JSON.stringify(vb)) {
        diffs.push(`  ${label}.${key}: original=${JSON.stringify(va)} vs materialized=${JSON.stringify(vb)}`);
      }
    } else if (String(va) !== String(vb)) {
      diffs.push(`  ${label}.${key}: original=${JSON.stringify(va)} vs materialized=${JSON.stringify(vb)}`);
    }
  }
  return diffs;
}

function compareDatasets(original, materialized) {
  const issues = [];

  // Compare books
  const origBooksById = {};
  for (const b of (original.books || [])) origBooksById[b.id] = b;
  const matBooksById = {};
  for (const b of (materialized.books || [])) matBooksById[b.id] = b;

  const allBookIds = new Set([...Object.keys(origBooksById), ...Object.keys(matBooksById)]);
  let booksMatch = 0;
  for (const id of allBookIds) {
    if (!origBooksById[id]) {
      issues.push(`EXTRA BOOK in materialized: ${id} "${matBooksById[id].title}"`);
    } else if (!matBooksById[id]) {
      issues.push(`MISSING BOOK in materialized: ${id} "${origBooksById[id].title}"`);
    } else {
      const diffs = compareObjects(origBooksById[id], matBooksById[id], `book[${id}]`);
      if (diffs.length) {
        issues.push(`BOOK MISMATCH: ${id} "${origBooksById[id].title}"`);
        issues.push(...diffs);
      } else {
        booksMatch++;
      }
    }
  }

  // Compare entries
  const origEntriesById = {};
  for (const e of (original.entries || [])) origEntriesById[e.id] = e;
  const matEntriesById = {};
  for (const e of (materialized.entries || [])) matEntriesById[e.id] = e;

  const allEntryIds = new Set([...Object.keys(origEntriesById), ...Object.keys(matEntriesById)]);
  let entriesMatch = 0;
  for (const id of allEntryIds) {
    if (!origEntriesById[id]) {
      issues.push(`EXTRA ENTRY in materialized: ${id}`);
    } else if (!matEntriesById[id]) {
      issues.push(`MISSING ENTRY in materialized: ${id}`);
    } else {
      const diffs = compareObjects(origEntriesById[id], matEntriesById[id], `entry[${id}]`);
      if (diffs.length) {
        issues.push(`ENTRY MISMATCH: ${id}`);
        issues.push(...diffs);
      } else {
        entriesMatch++;
      }
    }
  }

  return { issues, booksMatch, entriesMatch, totalBooks: allBookIds.size, totalEntries: allEntryIds.size };
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log('Marginalia WAL Verification');
  console.log('===========================\n');

  // 1. Read original data.json
  console.log('Reading data.json...');
  const original = await readFile('data.json');
  if (!original) {
    console.error('Failed to read data.json');
    process.exit(1);
  }
  console.log(`  ${(original.books || []).length} books, ${(original.entries || []).length} entries\n`);

  // 2. List and fetch all op files
  console.log('Reading ops/ directory...');
  const dirRes = await ghRequest('GET', 'ops');
  if (!dirRes.ok) {
    console.error(`Failed to list ops/ directory (HTTP ${dirRes.status}). Has the migration been run?`);
    process.exit(1);
  }

  const opFiles = dirRes.data.filter(f => f.name.endsWith('.json'));
  console.log(`  Found ${opFiles.length} op file(s): ${opFiles.map(f => f.name).join(', ')}\n`);

  console.log('Fetching op files...');
  let allOps = [];
  for (const file of opFiles) {
    const ops = await readFile(`ops/${file.name}`);
    if (!ops) {
      console.error(`  Failed to read ops/${file.name}`);
      process.exit(1);
    }
    console.log(`  ops/${file.name}: ${ops.length} ops`);
    allOps = allOps.concat(ops);
  }

  // Dedupe by opId
  const seen = new Set();
  allOps = allOps.filter(op => {
    if (seen.has(op.opId)) return false;
    seen.add(op.opId);
    return true;
  });
  console.log(`  Total unique ops: ${allOps.length}\n`);

  // 3. Materialize
  console.log('Materializing ops...');
  const materialized = materialize(allOps);
  console.log(`  ${materialized.books.length} books, ${materialized.entries.length} entries\n`);

  // 4. Compare
  console.log('Comparing datasets...');
  const result = compareDatasets(original, materialized);

  console.log('\nResults');
  console.log('=======');
  console.log(`  Books:   ${result.booksMatch}/${result.totalBooks} match`);
  console.log(`  Entries: ${result.entriesMatch}/${result.totalEntries} match`);

  if (result.issues.length === 0) {
    console.log('\n  ALL DATA MATCHES. Migration is correct.\n');
    process.exit(0);
  } else {
    console.log(`\n  ${result.issues.length} issue(s) found:\n`);
    for (const issue of result.issues) {
      console.log(`  ${issue}`);
    }
    console.log('');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Verification failed:', err.message);
  process.exit(1);
});
