'use strict';

const logger = require('../logger');
const { getDb } = require('../database');

// An alert as one recipient sees it
const RECIPIENT_SELECT = `
  SELECT a.id, n.name AS market_hash_name, a.spike_pct, a.price_at_alert, a.seven_day_low,
         a.created_at, r.id AS recipient_id, r.resolved, r.resolved_at
  FROM alert_recipients r
  JOIN alerts a ON a.id = r.alert_id
  JOIN item_names n ON n.id = a.item_id
`;

function addRecipient(alertId, uid) {
  logger.debug('repository - addRecipient');
  getDb().prepare('INSERT OR IGNORE INTO alert_recipients (alert_id, uid) VALUES (?, ?)').run(alertId, uid);
}

function listUnresolvedForUid(uid) {
  logger.debug('repository - listUnresolvedForUid');
  return getDb().prepare(`${RECIPIENT_SELECT} WHERE r.uid = ? AND r.resolved = 0 ORDER BY a.created_at DESC`).all(uid);
}

function getRecipient(id) {
  logger.debug('repository - getRecipient');
  return getDb().prepare(`${RECIPIENT_SELECT} WHERE r.id = ?`).get(id);
}

function resolveRecipient(id, resolvedAt) {
  logger.debug('repository - resolveRecipient');
  getDb().prepare('UPDATE alert_recipients SET resolved = 1, resolved_at = ? WHERE id = ?').run(resolvedAt, id);
}

// Returns how many were resolved
function resolveAllForUid(uid, resolvedAt) {
  logger.debug('repository - resolveAllForUid');
  return getDb()
    .prepare('UPDATE alert_recipients SET resolved = 1, resolved_at = ? WHERE uid = ? AND resolved = 0')
    .run(resolvedAt, uid).changes;
}

module.exports = { addRecipient, listUnresolvedForUid, getRecipient, resolveRecipient, resolveAllForUid };
