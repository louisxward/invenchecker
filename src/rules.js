'use strict';

const fs = require('node:fs');
const { RULES_PATH } = require('./config');
const logger = require('./logger');

// Used when rules.json is missing or invalid. Cheap items move in big percentage steps (1p on a
// 5p item is +20%) and are most of an inventory, so they alert least readily and are scanned least
// often; valuable items the other way round.
const DEFAULT_RULES = [
  { minPrice: 50, scanHours: 3, alertPct: 15, realertPct: 25 },
  { minPrice: 10, scanHours: 6, alertPct: 20, realertPct: 35 },
  { minPrice: 1, scanHours: 12, alertPct: 30, realertPct: 50 },
  { minPrice: 0, scanHours: 24, alertPct: 50, realertPct: 100 },
];

let cachedRules = null;

function loadRules() {
  if (cachedRules) return cachedRules;

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      logger.warn({ RULES_PATH }, 'rules - rules.json not found, using hardcoded defaults');
    } else {
      logger.error({ err, RULES_PATH }, 'rules - failed to parse rules.json, using hardcoded defaults');
    }
    raw = DEFAULT_RULES;
  }

  if (!Array.isArray(raw) || raw.length === 0) {
    logger.error({ RULES_PATH }, 'rules - rules.json is empty or not an array, using hardcoded defaults');
    raw = DEFAULT_RULES;
  }

  // Sort descending so highest price tier is tested first
  cachedRules = [...raw].sort((a, b) => b.minPrice - a.minPrice);
  logger.info({ ruleCount: cachedRules.length }, 'rules - loaded');
  return cachedRules;
}

function getRuleForPrice(price) {
  const rules = loadRules();
  const rule = rules.find((r) => price >= r.minPrice) ?? rules[rules.length - 1];
  return {
    scanMs: rule.scanHours * 60 * 60 * 1000,
    alertThreshold: 1 + rule.alertPct / 100,
    realertThreshold: 1 + rule.realertPct / 100,
  };
}

module.exports = { getRuleForPrice };
