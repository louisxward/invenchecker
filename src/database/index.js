'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { DB_PATH } = require('../config');
const logger = require('../logger');
const { migrate } = require('./migrations');

let db = null;

// Opens the shared connection and brings the schema up to date
function init() {
  if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const conn = new Database(DB_PATH);
  try {
    conn.pragma('journal_mode = WAL');
    conn.pragma('foreign_keys = ON');
    conn.transaction(() => migrate(conn))();
  } catch (err) {
    conn.close();
    throw err;
  }
  db = conn;
  logger.info({ dbPath: DB_PATH }, 'database - ready');
}

function getDb() {
  if (!db) throw new Error('database not initialised, call init() first');
  return db;
}

function close() {
  db?.close();
  db = null;
}

module.exports = { init, getDb, close };
