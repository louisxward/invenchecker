'use strict';

// Every deployment was at schema version 3 when the earlier migrations were removed, so a new
// database is created at that version in one step, and an existing one must already be at it.
// Commit 65bea69 is the last version that can upgrade anything older.
const BASELINE_VERSION = 3;

function createSchema(db) {
  db.exec(`
    CREATE TABLE item_names (
      id   INTEGER PRIMARY KEY,
      name TEXT    NOT NULL UNIQUE
    );

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

    CREATE TABLE inventory_items (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      steam64id  TEXT NOT NULL,
      item_id    INTEGER NOT NULL REFERENCES item_names(id),
      first_seen INTEGER NOT NULL,
      last_seen  INTEGER NOT NULL,
      missing    INTEGER NOT NULL DEFAULT 0,
      missing_at INTEGER,
      UNIQUE(steam64id, item_id)
    );
    CREATE INDEX idx_inv_items ON inventory_items(steam64id, item_id);

    CREATE TABLE alert_recipients (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_id    INTEGER NOT NULL REFERENCES alerts(id),
      uid         TEXT NOT NULL,
      resolved    INTEGER NOT NULL DEFAULT 0,
      resolved_at INTEGER,
      UNIQUE(alert_id, uid)
    );
    CREATE INDEX idx_recipients ON alert_recipients(uid, resolved);

    CREATE TABLE bad_entries (
      type     TEXT    NOT NULL,
      value    TEXT    NOT NULL,
      reason   TEXT,
      added_at INTEGER NOT NULL,
      PRIMARY KEY (type, value)
    );

    CREATE TABLE inventory_fetches (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      steam64id   TEXT    NOT NULL,
      item_count  INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      fetched_at  INTEGER NOT NULL
    );
    CREATE INDEX idx_inv_fetches ON inventory_fetches(steam64id, fetched_at);

    -- List order is kept, and so are repeated entries, since the API returns lists as stored
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
}

// Schema changes after the baseline: MIGRATIONS[0] takes a database to version 4, and so on.
// Each is a function of the connection; append new ones, never edit or reorder old ones.
const MIGRATIONS = [];

// Brings the database up to the latest version. init() runs this in one transaction, so a failure
// part-way leaves the database as it was.
function migrate(db) {
  let version = db.pragma('user_version', { simple: true });
  if (version === 0) {
    const tables = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n;
    if (tables > 0) {
      throw new Error('This database predates schema versioning; upgrade it with commit 65bea69 first');
    }
    createSchema(db);
    version = BASELINE_VERSION;
    db.pragma(`user_version = ${version}`);
  } else if (version < BASELINE_VERSION) {
    throw new Error(`This database is at schema version ${version}; upgrade it with commit 65bea69 first`);
  }
  for (; version < BASELINE_VERSION + MIGRATIONS.length; version++) {
    MIGRATIONS[version - BASELINE_VERSION](db);
    db.pragma(`user_version = ${version + 1}`);
  }
}

module.exports = { migrate, MIGRATIONS, BASELINE_VERSION };
