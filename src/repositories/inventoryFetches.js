'use strict';

const logger = require('../logger');
const { getDb } = require('../database');

function createFetch(steam64id, itemCount, durationMs, fetchedAt) {
  logger.debug('repository - createFetch');
  getDb()
    .prepare('INSERT INTO inventory_fetches (steam64id, item_count, duration_ms, fetched_at) VALUES (?, ?, ?, ?)')
    .run(steam64id, itemCount, durationMs, fetchedAt);
}

// { item_count, duration_ms, fetched_at } of the last successful fetch, or undefined
function getLastFetch(steam64id) {
  logger.debug('repository - getLastFetch');
  return getDb()
    .prepare(
      `SELECT item_count, duration_ms, fetched_at
       FROM inventory_fetches
       WHERE steam64id = ?
       ORDER BY fetched_at DESC
       LIMIT 1`
    )
    .get(steam64id);
}

module.exports = { createFetch, getLastFetch };
