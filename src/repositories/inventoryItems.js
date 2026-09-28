'use strict';

const logger = require('../logger');
const { getDb } = require('../database');

// Records the item as present in the inventory now, clearing any missing flag
function upsertSeen(steam64id, itemId, seenAt) {
  logger.debug('repository - upsertSeen');
  getDb()
    .prepare(
      `INSERT INTO inventory_items (steam64id, item_id, first_seen, last_seen)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(steam64id, item_id) DO UPDATE SET last_seen = excluded.last_seen, missing = 0, missing_at = NULL`
    )
    .run(steam64id, itemId, seenAt, seenAt);
}

// Flags every item of the inventory that isn't in presentItemIds as missing
function markMissingExcept(steam64id, presentItemIds, missingAt) {
  logger.debug('repository - markMissingExcept');
  getDb()
    .prepare(
      `UPDATE inventory_items
       SET missing = 1, missing_at = ?
       WHERE steam64id = ? AND missing = 0 AND item_id NOT IN (SELECT value FROM json_each(?))`
    )
    .run(missingAt, steam64id, JSON.stringify(presentItemIds));
}

// steam64ids whose inventory currently has the item (not missing)
function listHolders(itemId) {
  logger.debug('repository - listHolders');
  return getDb()
    .prepare('SELECT DISTINCT steam64id FROM inventory_items WHERE item_id = ? AND missing = 0')
    .all(itemId)
    .map((row) => row.steam64id);
}

// Every item seen in the inventory, by name
function listForSteam64id(steam64id) {
  logger.debug('repository - listForSteam64id');
  return getDb()
    .prepare(
      `SELECT n.name AS market_hash_name, ii.first_seen, ii.last_seen, ii.missing
       FROM inventory_items ii
       JOIN item_names n ON n.id = ii.item_id
       WHERE ii.steam64id = ?
       ORDER BY n.name`
    )
    .all(steam64id);
}

module.exports = { upsertSeen, markMissingExcept, listHolders, listForSteam64id };
