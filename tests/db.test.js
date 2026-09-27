'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

// Fresh instances of the database module and repositories, with config's DB_PATH set to dbPath
// (and CONFIG_PATH, the accounts.json to import, to accountsPath when given)
function loadModules(dbPath, accountsPath) {
  const saved = { DB_PATH: process.env.DB_PATH, CONFIG_PATH: process.env.CONFIG_PATH };
  process.env.DB_PATH = dbPath;
  if (accountsPath) process.env.CONFIG_PATH = accountsPath;
  const modules = {};
  try {
    jest.isolateModules(() => {
      modules.database = require('../src/database');
      modules.itemNames = require('../src/repositories/itemNames');
      modules.badEntries = require('../src/repositories/badEntries');
      modules.accounts = require('../src/repositories/accounts');
    });
  } finally {
    Object.assign(process.env, saved);
  }
  return modules;
}

// Runs init() against a real file, as on startup. Returns the connection, with the repositories
// from the same module instance attached for convenience.
function openDb(dbPath) {
  const { database, itemNames, badEntries } = loadModules(dbPath);
  database.init();
  return Object.assign(database.getDb(), { itemNames, badEntries });
}

function columns(db, table) {
  return db.pragma(`table_info(${table})`).map((c) => c.name);
}

function tables(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name)
    .sort();
}

// The schema before item_names existed: TEXT item names and resolved columns on alerts
function createLegacyDb(dbPath) {
  const raw = new Database(dbPath);
  raw.exec(`
    CREATE TABLE price_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, market_hash_name TEXT NOT NULL,
      lowest_price REAL, median_price REAL, volume INTEGER, captured_at INTEGER NOT NULL
    );
    CREATE TABLE alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, market_hash_name TEXT NOT NULL, spike_pct REAL NOT NULL,
      price_at_alert REAL NOT NULL, seven_day_low REAL NOT NULL, created_at INTEGER NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0, resolved_at INTEGER
    );
    INSERT INTO price_snapshots (market_hash_name, lowest_price, median_price, volume, captured_at)
      VALUES ('Item A', 1.5, 1.6, 10, 100), ('Item A', 2.0, 2.1, 11, 200), ('Item B', 5.0, 5.5, 3, 150);
    INSERT INTO alerts (market_hash_name, spike_pct, price_at_alert, seven_day_low, created_at, resolved)
      VALUES ('Item A', 33.3, 2.0, 1.5, 200, 1);
  `);
  return raw;
}

describe('database module', () => {
  it('getDb throws before init', () => {
    jest.isolateModules(() => {
      expect(() => require('../src/database').getDb()).toThrow('not initialised');
    });
  });

  it('drops cached item ids when the connection changes', () => {
    const { database, itemNames } = loadModules(':memory:');
    database.init();
    expect(itemNames.getOrCreateItemId('A')).toBe(1);
    database.close();
    database.init(); // a fresh in-memory database
    expect(itemNames.getOrCreateItemId('B')).toBe(1);
    expect(itemNames.getOrCreateItemId('A')).toBe(2);
    database.close();
  });
});

describe('database migrations', () => {
  let dir;
  let dbPath;
  let db;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invenchecker-db-'));
    dbPath = path.join(dir, 'test.db');
  });

  afterEach(() => {
    if (db?.open) db.close();
    db = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates the full schema on a fresh database', () => {
    db = openDb(dbPath);
    expect(tables(db)).toEqual([
      'account_custom_items',
      'account_steam64ids',
      'accounts',
      'alert_recipients',
      'alerts',
      'bad_entries',
      'inventory_fetches',
      'inventory_items',
      'item_names',
      'price_snapshots',
    ]);
    expect(db.pragma('user_version', { simple: true })).toBe(2);
    expect(columns(db, 'price_snapshots')).toContain('item_id');
    expect(columns(db, 'alerts')).not.toContain('resolved');
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
  });

  it('is safe to run twice and keeps existing data', () => {
    db = openDb(dbPath);
    const itemId = db.itemNames.getOrCreateItemId('Item A');
    db.prepare('INSERT INTO price_snapshots (item_id, lowest_price, captured_at) VALUES (?, ?, ?)').run(itemId, 1, 1);
    db.badEntries.markBad('item', 'Bad', 'reason');
    db.close();

    db = openDb(dbPath);
    expect(db.prepare('SELECT COUNT(*) AS c FROM price_snapshots').get().c).toBe(1);
    expect(db.badEntries.isBad('item', 'Bad')).toBe(true);
    // The name cache follows the connection, so ids still match the reopened database
    expect(db.itemNames.getOrCreateItemId('Item A')).toBe(itemId);
  });

  it('migrates the legacy TEXT schema to item_names ids', () => {
    createLegacyDb(dbPath).close();

    db = openDb(dbPath);
    expect(columns(db, 'price_snapshots')).not.toContain('market_hash_name');
    expect(columns(db, 'alerts')).not.toContain('resolved');
    const snapshots = db
      .prepare(
        'SELECT n.name, ps.lowest_price FROM price_snapshots ps JOIN item_names n ON n.id = ps.item_id ORDER BY ps.id'
      )
      .all();
    expect(snapshots).toEqual([
      { name: 'Item A', lowest_price: 1.5 },
      { name: 'Item A', lowest_price: 2.0 },
      { name: 'Item B', lowest_price: 5.0 },
    ]);
    const alert = db
      .prepare('SELECT n.name, a.price_at_alert FROM alerts a JOIN item_names n ON n.id = a.item_id')
      .get();
    expect(alert).toEqual({ name: 'Item A', price_at_alert: 2.0 });
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
  });

  it('rolls back everything when a migration step fails', () => {
    const raw = createLegacyDb(dbPath);
    // A leftover table makes the alerts step fail after price_snapshots has been migrated
    raw.exec('CREATE TABLE alerts_new (x INTEGER)');
    raw.close();

    const { database } = loadModules(dbPath);
    expect(() => database.init()).toThrow(/alerts_new already exists/);
    expect(() => database.getDb()).toThrow('not initialised');

    const check = new Database(dbPath, { readonly: true });
    try {
      expect(columns(check, 'price_snapshots')).toContain('market_hash_name');
      expect(check.prepare('SELECT COUNT(*) AS c FROM price_snapshots').get().c).toBe(3);
      expect(tables(check)).not.toContain('item_names');
    } finally {
      check.close();
    }
  });
});

describe('accounts.json import (migration 2)', () => {
  let dir;
  let dbPath;
  let accountsPath;
  let modules;

  const writeAccountsFile = (content) =>
    fs.writeFileSync(accountsPath, typeof content === 'string' ? content : JSON.stringify(content));

  function open() {
    modules = loadModules(dbPath, accountsPath);
    modules.database.init();
    return modules;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invenchecker-import-'));
    dbPath = path.join(dir, 'test.db');
    accountsPath = path.join(dir, 'accounts.json');
  });

  afterEach(() => {
    modules?.database.close();
    modules = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('imports every account, keeping order, list order and repeats', () => {
    writeAccountsFile([
      { uid: 'b', friendlyName: 'Bee', discordId: '2', steam64ids: ['76561198000000002', '76561198000000001'] },
      { uid: 'a', discordId: '1', customItems: ['Z', 'A', 'Z'] },
      { uid: 'bare' },
    ]);
    const { accounts } = open();
    expect(accounts.listAccounts()).toEqual([
      {
        uid: 'b',
        friendlyName: 'Bee',
        discordId: '2',
        steam64ids: ['76561198000000002', '76561198000000001'],
        customItems: [],
      },
      { uid: 'a', friendlyName: null, discordId: '1', steam64ids: [], customItems: ['Z', 'A', 'Z'] },
      { uid: 'bare', friendlyName: null, discordId: null, steam64ids: [], customItems: [] },
    ]);
  });

  it('imports into a database created before accounts moved (user_version 0)', () => {
    const raw = createLegacyDb(dbPath);
    raw.close();
    writeAccountsFile([{ uid: 'a', steam64ids: ['76561198000000001'] }]);
    const { accounts, database } = open();
    expect(accounts.getAccount('a').steam64ids).toEqual(['76561198000000001']);
    expect(database.getDb().prepare('SELECT COUNT(*) AS c FROM price_snapshots').get().c).toBe(3);
  });

  it('only imports once', () => {
    writeAccountsFile([{ uid: 'a' }]);
    open().database.close();
    writeAccountsFile([{ uid: 'a' }, { uid: 'b' }]);
    expect(
      open()
        .accounts.listAccounts()
        .map((a) => a.uid)
    ).toEqual(['a']);
  });

  it('starts with no accounts when there is no accounts.json', () => {
    expect(open().accounts.listAccounts()).toEqual([]);
  });

  it.each([
    ['invalid JSON', '[{', /Failed to import/],
    ['not an array', '{}', /not a JSON array/],
    ['an entry without a uid', [{ friendlyName: 'x' }], /entry 0 has no uid/],
    ['a repeated uid', [{ uid: 'a' }, { uid: 'a' }], /entry 1 repeats uid a/],
    ['a non-string list entry', [{ uid: 'a', steam64ids: [12345] }], /steam64ids must be an array of strings/],
  ])('refuses to start on %s, leaving the database untouched', (_label, content, message) => {
    writeAccountsFile(content);
    const { database } = loadModules(dbPath, accountsPath);
    expect(() => database.init()).toThrow(message);
    const check = new Database(dbPath, { readonly: true });
    try {
      expect(check.pragma('user_version', { simple: true })).toBe(0);
      expect(tables(check)).toEqual([]);
    } finally {
      check.close();
    }
  });
});
