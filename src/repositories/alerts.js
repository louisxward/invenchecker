'use strict';

const logger = require('../logger');
const { getDb } = require('../database');

function createAlert(itemId, spikePct, priceAtAlert, sevenDayLow, createdAt) {
  logger.debug('repository - createAlert');
  return getDb()
    .prepare(
      'INSERT INTO alerts (item_id, spike_pct, price_at_alert, seven_day_low, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(itemId, spikePct, priceAtAlert, sevenDayLow, createdAt).lastInsertRowid;
}

// { price_at_alert, created_at } of the item's most recent alert, or undefined
function getLastAlert(itemId) {
  logger.debug('repository - getLastAlert');
  return getDb()
    .prepare('SELECT price_at_alert, created_at FROM alerts WHERE item_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(itemId);
}

// Every alert, newest first
function listAlerts() {
  logger.debug('repository - listAlerts');
  return getDb()
    .prepare(
      `SELECT a.id, n.name AS market_hash_name, a.spike_pct, a.price_at_alert, a.seven_day_low, a.created_at
       FROM alerts a
       JOIN item_names n ON n.id = a.item_id
       ORDER BY a.created_at DESC`
    )
    .all();
}

module.exports = { createAlert, getLastAlert, listAlerts };
