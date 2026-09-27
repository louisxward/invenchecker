'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const express = require('express');
const { setAccounts } = require('../helpers/accounts');

// Rules with scan intervals that differ from REENQUEUE_DELAY_MS (6h), set before src/ is loaded
const RULES_PATH = path.join(os.tmpdir(), `invenchecker-test-progress-rules-${process.pid}.json`);
fs.writeFileSync(
  RULES_PATH,
  JSON.stringify([
    { minPrice: 10, scanHours: 24, alertPct: 30, realertPct: 50 },
    { minPrice: 0, scanHours: 2, alertPct: 15, realertPct: 20 },
  ])
);
process.env.RULES_PATH = RULES_PATH;

const HOUR = 60 * 60;

describe('GET /accounts/:uid/progress', () => {
  let app;
  let db;
  let itemNames;

  beforeAll(() => {
    const database = require('../../src/database');
    database.init();
    db = database.getDb();
    itemNames = require('../../src/repositories/itemNames');
    app = express();
    app.use(express.json());
    app.use('/accounts', require('../../src/routes/accounts'));
  });

  afterAll(() => {
    fs.rmSync(RULES_PATH, { force: true });
  });

  function snapshot(name, price, capturedAt) {
    db.prepare('INSERT INTO price_snapshots (item_id, lowest_price, captured_at) VALUES (?, ?, ?)').run(
      itemNames.getOrCreateItemId(name),
      price,
      capturedAt
    );
  }

  it("gives each custom item's next scan from its price rule, and inventories from the re-enqueue delay", async () => {
    const steam64id = '76561198000000030';
    setAccounts([{ uid: 'p1', discordId: '1', steam64ids: [steam64id], customItems: ['Cheap', 'Pricey', 'New'] }]);
    snapshot('Cheap', 1.5, 1000);
    snapshot('Pricey', 50, 2000);
    db.prepare(
      'INSERT INTO inventory_fetches (steam64id, item_count, duration_ms, fetched_at) VALUES (?, ?, ?, ?)'
    ).run(steam64id, 1, 1, 3000);

    const res = await request(app).get('/accounts/p1/progress');
    expect(res.status).toBe(200);
    expect(res.body.customItems.Cheap.nextScanAt).toBe(1000 + 2 * HOUR);
    expect(res.body.customItems.Pricey.nextScanAt).toBe(2000 + 24 * HOUR);
    expect(res.body.customItems.New.nextScanAt).toBeNull();
    expect(res.body.steam64ids[steam64id].nextScanAt).toBe(3000 + 6 * HOUR);
  });
});
