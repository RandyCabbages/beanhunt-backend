const fs = require('fs');
const path = require('path');

const HUNTS_FILE   = path.join(__dirname, '..', 'hunts_data.json');
const ARCHIVE_FILE = path.join(__dirname, '..', 'hunts_archive.json');

// Shared mutable singletons — owned here, imported by reference elsewhere. Never reassign.
const hunts   = {};
const archive = []; // completed hunts, newest first

let pgPool = null;
let normalizeSlot = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
let huntsTableReady = Promise.resolve();

async function initPersistence(deps) {
  pgPool = deps.pgPool;
  if (deps.normalizeSlot) normalizeSlot = deps.normalizeSlot;
  // Initialize Postgres tables for hunts and archive
  if (pgPool) {
    huntsTableReady = pgPool.query(`
      CREATE TABLE IF NOT EXISTS hunts_kv (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL
      )
    `).then(() => console.log('[persist] Postgres hunts_kv table ready'))
      .catch(e => { console.error('[persist] hunts_kv init failed:', e.message); });
  }
  await loadPersistedState();
}

// Load persisted hunts on startup — try Postgres first, fall back to file
async function loadPersistedState() {
  let loadedFromPg = false;
  if (pgPool) {
    try {
      await huntsTableReady;
      const huntsRow = await pgPool.query("SELECT value FROM hunts_kv WHERE key='hunts'");
      if (huntsRow.rows[0]) {
        Object.assign(hunts, huntsRow.rows[0].value || {});
        loadedFromPg = true;
      }
      const archiveRow = await pgPool.query("SELECT value FROM hunts_kv WHERE key='archive'");
      if (archiveRow.rows[0]) {
        archive.push(...(archiveRow.rows[0].value || []));
      }
      if (loadedFromPg) console.log(`[persist] Loaded ${Object.keys(hunts).length} hunts and ${archive.length} archived from Postgres`);
    } catch(e) { console.error('[persist] PG load failed:', e.message); }
  }
  // Fallback: load from file if Postgres was empty/unavailable
  if (!loadedFromPg) {
    try {
      if (fs.existsSync(HUNTS_FILE)) {
        const saved = JSON.parse(fs.readFileSync(HUNTS_FILE, 'utf8'));
        Object.assign(hunts, saved);
        console.log(`[persist] Loaded ${Object.keys(hunts).length} hunts from file`);
      }
    } catch(e) { console.error('[persist] File load failed:', e.message); }
    try {
      if (fs.existsSync(ARCHIVE_FILE)) {
        const saved = JSON.parse(fs.readFileSync(ARCHIVE_FILE, 'utf8'));
        archive.push(...saved);
        console.log(`[persist] Loaded ${archive.length} archived hunts from file`);
      }
    } catch(e) { console.error('[persist] Archive file load failed:', e.message); }
  }

  // Dedup calls one-time on load (cleanup from before normalization was added)
  let totalRemoved = 0;
  for (const id in hunts) {
    const h = hunts[id];
    if (h?.calls?.length) {
      const seen = new Set();
      const before = h.calls.length;
      h.calls = h.calls.filter(c => {
        const key = (c.slot || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      totalRemoved += before - h.calls.length;
    }
  }
  if (totalRemoved > 0) console.log(`[persist] Removed ${totalRemoved} duplicate calls on startup`);
}

function persistHunts() {
  // Bulletproof: dedupe call arrays before persisting. Keeps first occurrence of each slot.
  for (const id in hunts) {
    const h = hunts[id];
    if (h?.calls?.length) {
      const seen = new Set();
      h.calls = h.calls.filter(c => {
        const key = normalizeSlot(c.slot);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
  }
  // Write to Postgres (durable across redeploys) AND file (local-dev fallback)
  if (pgPool) {
    pgPool.query(
      "INSERT INTO hunts_kv(key,value) VALUES('hunts',$1) ON CONFLICT(key) DO UPDATE SET value=$1",
      [JSON.stringify(hunts)]
    ).catch(e => console.error('[persist] PG save hunts failed:', e.message));
  }
  try { fs.writeFileSync(HUNTS_FILE, JSON.stringify(hunts), 'utf8'); }
  catch(e) { /* file write may fail on ephemeral disk; that's OK if PG works */ }
}
function persistArchive() {
  if (pgPool) {
    pgPool.query(
      "INSERT INTO hunts_kv(key,value) VALUES('archive',$1) ON CONFLICT(key) DO UPDATE SET value=$1",
      [JSON.stringify(archive)]
    ).catch(e => console.error('[persist] PG save archive failed:', e.message));
  }
  try { fs.writeFileSync(ARCHIVE_FILE, JSON.stringify(archive), 'utf8'); }
  catch(e) { /* file write may fail on ephemeral disk */ }
}
function archiveHunt(hunt) {
  if (!hunt || !hunt.user) return;
  // Don't archive empty hunts — no bonuses means there's nothing to analyze,
  // and it keeps the archive/history from filling up with blank entries.
  if (!Array.isArray(hunt.bonuses) || hunt.bonuses.length === 0) return;
  // Save full hunt snapshot to archive (keep last 100)
  archive.unshift({ ...hunt, archivedAt: hunt.archivedAt || new Date().toISOString() });
  if (archive.length > 100) archive.splice(100);
  persistArchive();
}

module.exports = { hunts, archive, initPersistence, persistHunts, persistArchive, archiveHunt };
