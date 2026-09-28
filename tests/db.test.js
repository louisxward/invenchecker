'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

// Fresh instances of the database module, migrations and repositories, with config's DB_PATH set to dbPath
function loadModules(dbPath) {
  const saved = process.env.DB_PATH;
  process.env.DB_PATH = dbPath;
  const modules = {};
  try {
    jest.isolateModules(() => {
      modules.database = require('../src/database');
      modules.migrations = require('../src/database/migrations');
      modules.itemNames = require('../src/repositories/itemNames');
      modules.badEntries = require('../src/repositories/badEntries');
    });
  } finally {
    process.env.DB_PATH = saved;
  }
  return modules;
}

function tables(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name)
    .sort();
}

const version = (db) => db.pragma('user_version', { simple: true });

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
  let modules;

  function open() {
    modules = loadModules(dbPath);
    modules.database.init();
    return modules;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invenchecker-db-'));
    dbPath = path.join(dir, 'test.db');
  });

  afterEach(() => {
    modules?.database.close();
    modules = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates the full schema on a fresh database, at the baseline version', () => {
    const { database, migrations } = open();
    const db = database.getDb();
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
    expect(version(db)).toBe(migrations.BASELINE_VERSION + migrations.MIGRATIONS.length);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
  });

  it('is safe to run twice and keeps existing data', () => {
    const first = open();
    const itemId = first.itemNames.getOrCreateItemId('Item A');
    first.database
      .getDb()
      .prepare('INSERT INTO price_snapshots (item_id, lowest_price, captured_at) VALUES (?, ?, ?)')
      .run(itemId, 1, 1);
    first.badEntries.markBad('item', 'Bad', 'reason');
    first.database.close();

    const { database, badEntries, itemNames } = open();
    expect(database.getDb().prepare('SELECT COUNT(*) AS c FROM price_snapshots').get().c).toBe(1);
    expect(badEntries.isBad('item', 'Bad')).toBe(true);
    // The name cache follows the connection, so ids still match the reopened database
    expect(itemNames.getOrCreateItemId('Item A')).toBe(itemId);
  });

  it('applies migrations added after the baseline, in order', () => {
    open().database.close();
    const { database, migrations } = loadModules(dbPath);
    const applied = [];
    migrations.MIGRATIONS.push(
      () => applied.push('a'),
      (db) => {
        applied.push('b');
        db.exec('CREATE TABLE extra (x INTEGER)');
      }
    );
    modules = { database };
    database.init();
    expect(applied).toEqual(['a', 'b']);
    expect(version(database.getDb())).toBe(migrations.BASELINE_VERSION + 2);
    expect(tables(database.getDb())).toContain('extra');
  });

  it('rolls back a migration that fails, leaving the version unchanged', () => {
    open().database.close();
    const { database, migrations } = loadModules(dbPath);
    migrations.MIGRATIONS.push((db) => {
      db.exec('CREATE TABLE half_done (x INTEGER)');
      throw new Error('migration failed');
    });
    expect(() => database.init()).toThrow('migration failed');
    expect(() => database.getDb()).toThrow('not initialised');

    const check = new Database(dbPath, { readonly: true });
    try {
      expect(version(check)).toBe(migrations.BASELINE_VERSION);
      expect(tables(check)).not.toContain('half_done');
    } finally {
      check.close();
    }
  });

  it('rolls back a schema creation that fails part-way', () => {
    // A view named like one of the later tables makes CREATE TABLE accounts fail after earlier tables exist
    const raw = new Database(dbPath);
    raw.exec('CREATE VIEW accounts AS SELECT 1 AS x');
    raw.close();

    const { database } = loadModules(dbPath);
    expect(() => database.init()).toThrow(/accounts/);

    const check = new Database(dbPath, { readonly: true });
    try {
      expect(version(check)).toBe(0);
      expect(tables(check)).toEqual([]);
    } finally {
      check.close();
    }
  });

  it.each([
    ['a database with tables but no version (from before versioning)', 'CREATE TABLE price_snapshots (id INTEGER)'],
    ['a database at an older version', 'PRAGMA user_version = 2'],
  ])('refuses to open %s, pointing at the commit that can upgrade it', (_label, sql) => {
    const raw = new Database(dbPath);
    raw.exec(sql);
    raw.close();

    const { database } = loadModules(dbPath);
    expect(() => database.init()).toThrow(/upgrade it with commit 65bea69/);
  });
});
