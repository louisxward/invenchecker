'use strict';

const logger = require('../logger');
const { getDb } = require('../database');

// name -> id. Ids never change, so the cache only has to be dropped when the connection changes.
const cache = new Map();
let cacheDb = null;

function getOrCreateItemId(name) {
  logger.debug('repository - getOrCreateItemId');
  const db = getDb();
  if (cacheDb !== db) {
    cache.clear();
    cacheDb = db;
  }
  if (cache.has(name)) return cache.get(name);
  db.prepare('INSERT OR IGNORE INTO item_names (name) VALUES (?)').run(name);
  const { id } = db.prepare('SELECT id FROM item_names WHERE name = ?').get(name);
  cache.set(name, id);
  return id;
}

// undefined if the name has never been seen
function getItemId(name) {
  logger.debug('repository - getItemId');
  return getDb().prepare('SELECT id FROM item_names WHERE name = ?').get(name)?.id;
}

function getItemName(id) {
  logger.debug('repository - getItemName');
  return getDb().prepare('SELECT name FROM item_names WHERE id = ?').get(id)?.name;
}

module.exports = { getOrCreateItemId, getItemId, getItemName };
