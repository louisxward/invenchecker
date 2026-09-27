'use strict';

const logger = require('../logger');
const { getDb } = require('../database');

function createSnapshot(itemId, lowestPrice, medianPrice, volume, capturedAt) {
  logger.debug('repository - createSnapshot');
  getDb()
    .prepare(
      'INSERT INTO price_snapshots (item_id, lowest_price, median_price, volume, captured_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(itemId, lowestPrice, medianPrice, volume, capturedAt);
}

// Lowest price captured at or after `since`, or null if there is none
function getLowestPriceSince(itemId, since) {
  logger.debug('repository - getLowestPriceSince');
  return getDb()
    .prepare(
      `SELECT MIN(lowest_price) AS seven_day_low
       FROM price_snapshots
       WHERE item_id = ? AND captured_at >= ? AND lowest_price IS NOT NULL`
    )
    .get(itemId, since).seven_day_low;
}

// Whether any price after `since` was under base * factor (multiplied in SQL, as it always was)
function hasPriceBelowSince(itemId, since, base, factor) {
  logger.debug('repository - hasPriceBelowSince');
  return !!getDb()
    .prepare('SELECT 1 FROM price_snapshots WHERE item_id = ? AND captured_at > ? AND lowest_price < ? * ? LIMIT 1')
    .get(itemId, since, base, factor);
}

// Most recent snapshot for an item name: { lowest_price, median_price, volume, captured_at }, or undefined
function getLatestSnapshot(itemName) {
  logger.debug('repository - getLatestSnapshot');
  return getDb()
    .prepare(
      `SELECT ps.lowest_price, ps.median_price, ps.volume, ps.captured_at
       FROM price_snapshots ps
       WHERE ps.item_id = (SELECT id FROM item_names WHERE name = ?)
       ORDER BY ps.captured_at DESC
       LIMIT 1`
    )
    .get(itemName);
}

// Snapshots for the named items captured at or after `since`, by name then newest first
function listSnapshotsSince(itemNames, since) {
  logger.debug('repository - listSnapshotsSince');
  const placeholders = itemNames.map(() => '?').join(', ');
  return getDb()
    .prepare(
      `SELECT n.name AS market_hash_name, ps.lowest_price, ps.median_price, ps.volume, ps.captured_at
       FROM price_snapshots ps
       JOIN item_names n ON n.id = ps.item_id
       WHERE ps.item_id IN (SELECT id FROM item_names WHERE name IN (${placeholders})) AND ps.captured_at >= ?
       ORDER BY n.name, ps.captured_at DESC`
    )
    .all(...itemNames, since);
}

module.exports = { createSnapshot, getLowestPriceSince, hasPriceBelowSince, getLatestSnapshot, listSnapshotsSince };
