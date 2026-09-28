'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOUR_MS = 60 * 60 * 1000;

// A fresh rules module reading rulesPath (or the missing file tests/setup.js points at)
function loadRules(rulesPath) {
  const saved = process.env.RULES_PATH;
  if (rulesPath) process.env.RULES_PATH = rulesPath;
  let rules;
  try {
    jest.isolateModules(() => {
      rules = require('../src/rules');
    });
  } finally {
    process.env.RULES_PATH = saved;
  }
  return rules;
}

const rule = (scanHours, alertPct, realertPct) => ({
  scanMs: scanHours * HOUR_MS,
  alertThreshold: 1 + alertPct / 100,
  realertThreshold: 1 + realertPct / 100,
});

describe('built-in rules (no rules.json)', () => {
  it.each([
    [0.03, rule(24, 50, 100)],
    [0.99, rule(24, 50, 100)],
    [1, rule(12, 30, 50)],
    [9.99, rule(12, 30, 50)],
    [10, rule(6, 20, 35)],
    [49.99, rule(6, 20, 35)],
    [50, rule(3, 15, 25)],
    [1200, rule(3, 15, 25)],
  ])('£%s gets the matching tier', (price, expected) => {
    expect(loadRules().getRuleForPrice(price)).toEqual(expected);
  });

  it('is also used when rules.json is invalid', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invenchecker-rules-'));
    try {
      for (const content of ['{not json', '[]', '{}']) {
        const file = path.join(dir, 'rules.json');
        fs.writeFileSync(file, content);
        expect(loadRules(file).getRuleForPrice(0.5)).toEqual(rule(24, 50, 100));
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('rules.json', () => {
  it('replaces the built-in rules, tested highest minPrice first', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invenchecker-rules-'));
    const file = path.join(dir, 'rules.json');
    try {
      fs.writeFileSync(
        file,
        JSON.stringify([
          { minPrice: 0, scanHours: 1, alertPct: 10, realertPct: 20 },
          { minPrice: 5, scanHours: 2, alertPct: 30, realertPct: 40 },
        ])
      );
      const rules = loadRules(file);
      expect(rules.getRuleForPrice(4.99)).toEqual(rule(1, 10, 20));
      expect(rules.getRuleForPrice(5)).toEqual(rule(2, 30, 40));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
