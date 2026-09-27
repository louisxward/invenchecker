'use strict';

const logger = require('../logger');
const { getDb } = require('../database');

// type is 'steam64id' or 'item'
function isBad(type, value) {
  logger.debug('repository - isBad');
  return !!getDb().prepare('SELECT 1 FROM bad_entries WHERE type = ? AND value = ?').get(type, value);
}

function markBad(type, value, reason) {
  logger.debug('repository - markBad');
  getDb()
    .prepare('INSERT OR REPLACE INTO bad_entries (type, value, reason, added_at) VALUES (?, ?, ?, ?)')
    .run(type, value, reason, Math.floor(Date.now() / 1000));
}

// The stored reason, or null if the entry isn't bad (or has no reason)
function getBadReason(type, value) {
  logger.debug('repository - getBadReason');
  return (
    getDb().prepare('SELECT reason FROM bad_entries WHERE type = ? AND value = ?').get(type, value)?.reason ?? null
  );
}

module.exports = { isBad, markBad, getBadReason };
