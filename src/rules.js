'use strict';

const fs = require('fs');
const logger = require('./logger');
const { RULES_PATH, REENQUEUE_DELAY_MS } = require('./appConfig');

const DEFAULT_RULES = [
  { minPrice: 0, scanHours: 6, alertPct: 15, realertPct: 20 }
];

let cachedRules = null;

function loadRules() {
  if (cachedRules) return cachedRules;

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      logger.warn({ RULES_PATH }, 'rules.json not found, using hardcoded defaults');
    } else {
      logger.error({ err, RULES_PATH }, 'Failed to parse rules.json, using hardcoded defaults');
    }
    raw = DEFAULT_RULES;
  }

  if (!Array.isArray(raw) || raw.length === 0) {
    logger.error({ RULES_PATH }, 'rules.json is empty or not an array, using hardcoded defaults');
    raw = DEFAULT_RULES;
  }

  // Sort descending so highest price tier is tested first
  cachedRules = [...raw].sort((a, b) => b.minPrice - a.minPrice);
  logger.info({ ruleCount: cachedRules.length }, 'Rules loaded');
  return cachedRules;
}

function getRuleForPrice(price) {
  const rules = loadRules();
  const rule = rules.find(r => price >= r.minPrice) ?? rules[rules.length - 1];
  return {
    scanMs:           rule.scanHours * 60 * 60 * 1000,
    alertThreshold:   1 + rule.alertPct   / 100,
    realertThreshold: 1 + rule.realertPct / 100,
  };
}

module.exports = { getRuleForPrice };
