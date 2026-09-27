'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { DB_PATH: dbPath } = require('./config');

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Schema setup and migrations run in one transaction, so a failure part-way leaves the
// database as it was instead of half-migrated (which the checks below would then skip).
const migrate = db.transaction(() => {
  // item_names: one row per unique market_hash_name string
  db.exec(`
    CREATE TABLE IF NOT EXISTS item_names (
      id   INTEGER PRIMARY KEY,
      name TEXT    NOT NULL UNIQUE
    );
  `);

  // ── Phase 1: price_snapshots + alerts base migration ─────────────────────────

  const psColumns = db.pragma('table_info(price_snapshots)').map((c) => c.name);

  if (psColumns.length === 0) {
    // Fresh database — create tables with normalized schema (no resolved on alerts)
    db.exec(`
      CREATE TABLE price_snapshots (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id      INTEGER NOT NULL REFERENCES item_names(id),
        lowest_price REAL,
        median_price REAL,
        volume       INTEGER,
        captured_at  INTEGER NOT NULL
      );

      CREATE INDEX idx_snapshots ON price_snapshots(item_id, captured_at);

      CREATE TABLE alerts (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id        INTEGER NOT NULL REFERENCES item_names(id),
        spike_pct      REAL NOT NULL,
        price_at_alert REAL NOT NULL,
        seven_day_low  REAL NOT NULL,
        created_at     INTEGER NOT NULL
      );

      CREATE INDEX idx_alerts_created ON alerts(created_at);
    `);
  } else if (psColumns.includes('market_hash_name')) {
    // Existing database with old TEXT schema — migrate to item_id FK
    db.exec(`INSERT OR IGNORE INTO item_names (name) SELECT DISTINCT market_hash_name FROM price_snapshots`);
    db.exec(`INSERT OR IGNORE INTO item_names (name) SELECT DISTINCT market_hash_name FROM alerts`);

    db.exec(`
      CREATE TABLE price_snapshots_new (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id      INTEGER NOT NULL REFERENCES item_names(id),
        lowest_price REAL,
        median_price REAL,
        volume       INTEGER,
        captured_at  INTEGER NOT NULL
      )
    `);
    db.exec(`
      INSERT INTO price_snapshots_new (id, item_id, lowest_price, median_price, volume, captured_at)
        SELECT ps.id, n.id, ps.lowest_price, ps.median_price, ps.volume, ps.captured_at
        FROM price_snapshots ps
        JOIN item_names n ON n.name = ps.market_hash_name
    `);
    db.exec(`DROP TABLE price_snapshots`);
    db.exec(`ALTER TABLE price_snapshots_new RENAME TO price_snapshots`);
    db.exec(`CREATE INDEX idx_snapshots ON price_snapshots(item_id, captured_at)`);

    // alerts: migrate TEXT → item_id, drop resolved columns
    db.exec(`
      CREATE TABLE alerts_new (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id        INTEGER NOT NULL REFERENCES item_names(id),
        spike_pct      REAL NOT NULL,
        price_at_alert REAL NOT NULL,
        seven_day_low  REAL NOT NULL,
        created_at     INTEGER NOT NULL
      )
    `);
    db.exec(`
      INSERT INTO alerts_new (id, item_id, spike_pct, price_at_alert, seven_day_low, created_at)
        SELECT a.id, n.id, a.spike_pct, a.price_at_alert, a.seven_day_low, a.created_at
        FROM alerts a
        JOIN item_names n ON n.name = a.market_hash_name
    `);
    db.exec(`DROP TABLE alerts`);
    db.exec(`ALTER TABLE alerts_new RENAME TO alerts`);
    db.exec(`CREATE INDEX idx_alerts_created ON alerts(created_at)`);
  }

  // ── Phase 2: remove resolved/resolved_at from alerts if still present ────────

  const alertColumns = db.pragma('table_info(alerts)').map((c) => c.name);
  if (alertColumns.includes('resolved')) {
    db.exec(`
      CREATE TABLE alerts_new (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id        INTEGER NOT NULL REFERENCES item_names(id),
        spike_pct      REAL NOT NULL,
        price_at_alert REAL NOT NULL,
        seven_day_low  REAL NOT NULL,
        created_at     INTEGER NOT NULL
      )
    `);
    db.exec(`
      INSERT INTO alerts_new (id, item_id, spike_pct, price_at_alert, seven_day_low, created_at)
        SELECT id, item_id, spike_pct, price_at_alert, seven_day_low, created_at FROM alerts
    `);
    db.exec(`DROP TABLE alerts`);
    db.exec(`ALTER TABLE alerts_new RENAME TO alerts`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at)`);
  }

  // ── Phase 3: new tables (idempotent) ─────────────────────────────────────────

  db.exec(`
    CREATE TABLE IF NOT EXISTS inventory_items (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      steam64id  TEXT NOT NULL,
      item_id    INTEGER NOT NULL REFERENCES item_names(id),
      first_seen INTEGER NOT NULL,
      last_seen  INTEGER NOT NULL,
      missing    INTEGER NOT NULL DEFAULT 0,
      missing_at INTEGER,
      UNIQUE(steam64id, item_id)
    );

    CREATE INDEX IF NOT EXISTS idx_inv_items ON inventory_items(steam64id, item_id);

    CREATE TABLE IF NOT EXISTS alert_recipients (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_id    INTEGER NOT NULL REFERENCES alerts(id),
      uid         TEXT NOT NULL,
      resolved    INTEGER NOT NULL DEFAULT 0,
      resolved_at INTEGER,
      UNIQUE(alert_id, uid)
    );

    CREATE INDEX IF NOT EXISTS idx_recipients ON alert_recipients(uid, resolved);

    CREATE TABLE IF NOT EXISTS bad_entries (
      type     TEXT    NOT NULL,
      value    TEXT    NOT NULL,
      reason   TEXT,
      added_at INTEGER NOT NULL,
      PRIMARY KEY (type, value)
    );

    CREATE TABLE IF NOT EXISTS inventory_fetches (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      steam64id   TEXT    NOT NULL,
      item_count  INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      fetched_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_inv_fetches ON inventory_fetches(steam64id, fetched_at);
  `);
});

migrate();

// ── In-memory name→id cache ───────────────────────────────────────────────────

const nameCache = new Map();

function getOrCreateItemId(name) {
  if (nameCache.has(name)) return nameCache.get(name);
  db.prepare('INSERT OR IGNORE INTO item_names (name) VALUES (?)').run(name);
  const { id } = db.prepare('SELECT id FROM item_names WHERE name = ?').get(name);
  nameCache.set(name, id);
  return id;
}

function isBad(type, value) {
  return !!db.prepare('SELECT 1 FROM bad_entries WHERE type = ? AND value = ?').get(type, value);
}

function markBad(type, value, reason) {
  db.prepare('INSERT OR REPLACE INTO bad_entries (type, value, reason, added_at) VALUES (?, ?, ?, ?)').run(
    type,
    value,
    reason,
    Math.floor(Date.now() / 1000)
  );
}

function getBadReason(type, value) {
  return db.prepare('SELECT reason FROM bad_entries WHERE type = ? AND value = ?').get(type, value)?.reason ?? null;
}

// Most recent price snapshot for an item name: { last, lowest_price }, or undefined if never priced
function getLastPriceSnapshot(itemName) {
  return db
    .prepare(
      `SELECT ps.captured_at AS last, ps.lowest_price
       FROM price_snapshots ps
       WHERE ps.item_id = (SELECT id FROM item_names WHERE name = ?)
       ORDER BY ps.captured_at DESC
       LIMIT 1`
    )
    .get(itemName);
}

// Unix seconds of the last successful inventory fetch, or 0 if there has been none
function getLastInventoryFetchAt(steam64id) {
  return (
    db.prepare('SELECT MAX(fetched_at) AS last FROM inventory_fetches WHERE steam64id = ?').get(steam64id)?.last ?? 0
  );
}

// Attach helpers so existing `const db = require('./db')` imports keep working
db.getOrCreateItemId = getOrCreateItemId;
db.isBad = isBad;
db.markBad = markBad;
db.getBadReason = getBadReason;
db.getLastPriceSnapshot = getLastPriceSnapshot;
db.getLastInventoryFetchAt = getLastInventoryFetchAt;

module.exports = db;
