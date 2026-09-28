'use strict';

const fs = require('node:fs');

// Migration 1: the schema as it was before user_version was used. Each step detects what it needs
// from the tables and columns that exist, so it also brings any older database up to date.
function baseSchema(db) {
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
}

// Throws unless every entry is an account the API could have written
function validateImportedAccounts(accounts, accountsPath) {
  if (!Array.isArray(accounts)) throw new Error(`${accountsPath} is not a JSON array`);
  const isStringOrMissing = (v) => v === undefined || v === null || typeof v === 'string';
  const isStringList = (v) => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
  const uids = new Set();
  accounts.forEach((a, i) => {
    const where = `${accountsPath} entry ${i}`;
    if (typeof a !== 'object' || a === null) throw new Error(`${where} is not an object`);
    if (typeof a.uid !== 'string' || !a.uid) throw new Error(`${where} has no uid`);
    if (uids.has(a.uid)) throw new Error(`${where} repeats uid ${a.uid}`);
    uids.add(a.uid);
    if (!isStringOrMissing(a.friendlyName)) throw new Error(`${where}: friendlyName must be a string`);
    if (!isStringOrMissing(a.discordId)) throw new Error(`${where}: discordId must be a string`);
    if (!isStringList(a.steam64ids)) throw new Error(`${where}: steam64ids must be an array of strings`);
    if (!isStringList(a.customItems)) throw new Error(`${where}: customItems must be an array of strings`);
  });
}

// Migration 2: accounts move from accounts.json into the database. List order is kept (the API
// returns lists as stored) and so are repeated entries, which the file allowed.
function accountTables(db, { accountsPath }) {
  db.exec(`
    CREATE TABLE accounts (
      uid           TEXT PRIMARY KEY,
      friendly_name TEXT,
      discord_id    TEXT
    );
    CREATE INDEX idx_accounts_discord ON accounts(discord_id);

    CREATE TABLE account_steam64ids (
      uid       TEXT    NOT NULL REFERENCES accounts(uid) ON DELETE CASCADE,
      position  INTEGER NOT NULL,
      steam64id TEXT    NOT NULL,
      PRIMARY KEY (uid, position)
    );
    CREATE INDEX idx_account_steam64ids ON account_steam64ids(steam64id);

    CREATE TABLE account_custom_items (
      uid      TEXT    NOT NULL REFERENCES accounts(uid) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      item     TEXT    NOT NULL,
      PRIMARY KEY (uid, position)
    );
    CREATE INDEX idx_account_custom_items ON account_custom_items(item);
  `);

  let accounts;
  try {
    accounts = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw new Error(`Failed to import ${accountsPath}: ${err.message}`, { cause: err });
  }
  validateImportedAccounts(accounts, accountsPath);

  const insertAccount = db.prepare('INSERT INTO accounts (uid, friendly_name, discord_id) VALUES (?, ?, ?)');
  const insertId = db.prepare('INSERT INTO account_steam64ids (uid, position, steam64id) VALUES (?, ?, ?)');
  const insertItem = db.prepare('INSERT INTO account_custom_items (uid, position, item) VALUES (?, ?, ?)');
  for (const a of accounts) {
    insertAccount.run(a.uid, a.friendlyName ?? null, a.discordId ?? null);
    (a.steam64ids ?? []).forEach((id, i) => insertId.run(a.uid, i, id));
    (a.customItems ?? []).forEach((item, i) => insertItem.run(a.uid, i, item));
  }
}

// Migration 3: bad_entries rows that older versions wrote for failures that say nothing about the
// entry (network errors, timeouts, 5xx, invalid responses, success=false while throttled) are
// removed, so those steam64ids and items are scanned again. Invalid steam64ids (4xx) stay.
function clearTransientBadEntries(db) {
  db.prepare(
    `DELETE FROM bad_entries
     WHERE reason IN ('fetch failed', 'The operation was aborted due to timeout',
                      'Steam returned no price data (success=false)')
        OR reason LIKE '%: HTTP 5__'
        OR reason LIKE 'Unexpected token%'
        OR reason LIKE '%is not valid JSON%'
        OR reason LIKE 'Cannot read properties of null%'`
  ).run();
}

const MIGRATIONS = [baseSchema, accountTables, clearTransientBadEntries];

// Applies the migrations after the database's user_version. init() runs this in one transaction,
// so a failure part-way leaves the database as it was.
function migrate(db, options) {
  const version = db.pragma('user_version', { simple: true });
  for (let i = version; i < MIGRATIONS.length; i++) {
    MIGRATIONS[i](db, options);
    db.pragma(`user_version = ${i + 1}`);
  }
}

module.exports = { migrate, MIGRATIONS };
