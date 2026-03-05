'use strict';

const fs = require('fs');

jest.mock('../src/steam', () => ({
  fetchInventory: jest.fn(),
  fetchPrice: jest.fn(),
  sleep: jest.fn().mockResolvedValue(undefined),
}));

describe('Scanner', () => {
  let db;
  let runScan;
  let scanState;
  let steam;

  const UID = 'testuid1';
  const STEAM_ID = '76561198000000000';
  const ITEM_NAME = 'AK-47 | Redline (Field-Tested)';
  const CONFIG_PATH = process.env.CONFIG_PATH;

  function setAccounts(accounts) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(accounts), 'utf8');
  }

  function insertSnapshot(itemName, price, daysAgo = 0) {
    const itemId = db.getOrCreateItemId(itemName);
    const capturedAt = Math.floor(Date.now() / 1000) - daysAgo * 24 * 60 * 60;
    db.prepare('INSERT INTO price_snapshots (item_id, lowest_price, median_price, volume, captured_at) VALUES (?, ?, ?, ?, ?)')
      .run(itemId, price, price, 50, capturedAt);
    return itemId;
  }

  beforeAll(() => {
    db = require('../src/db');
    ({ runScan, scanState } = require('../src/scanner'));
    steam = require('../src/steam');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    setAccounts([]);
    db.prepare('DELETE FROM bad_entries').run();
    db.prepare('DELETE FROM alert_recipients').run();
    db.prepare('DELETE FROM alerts').run();
    db.prepare('DELETE FROM price_snapshots').run();
    db.prepare('DELETE FROM inventory_items').run();
  });

  describe('early exits', () => {
    it('does nothing when no accounts are configured', async () => {
      setAccounts([]);
      await runScan();
      expect(steam.fetchInventory).not.toHaveBeenCalled();
      expect(steam.fetchPrice).not.toHaveBeenCalled();
    });

    it('does nothing when account has no items and no steam64ids', async () => {
      setAccounts([{ uid: UID, steam64ids: [], customItems: [] }]);
      await runScan();
      expect(steam.fetchPrice).not.toHaveBeenCalled();
    });
  });

  describe('price snapshots', () => {
    it('records a price snapshot for a custom item', async () => {
      setAccounts([{ uid: UID, steam64ids: [], customItems: [ITEM_NAME] }]);
      steam.fetchPrice.mockResolvedValue({ lowest_price: 10.0, median_price: 11.0, volume: 50 });

      await runScan();

      const snapshot = db.prepare(
        'SELECT ps.* FROM price_snapshots ps JOIN item_names n ON n.id = ps.item_id WHERE n.name = ?'
      ).get(ITEM_NAME);
      expect(snapshot).not.toBeNull();
      expect(snapshot.lowest_price).toBe(10.0);
    });

    it('records a price snapshot for inventory items', async () => {
      setAccounts([{ uid: UID, steam64ids: [STEAM_ID], customItems: [] }]);
      steam.fetchInventory.mockResolvedValue([{ market_hash_name: ITEM_NAME }]);
      steam.fetchPrice.mockResolvedValue({ lowest_price: 15.0, median_price: 16.0, volume: 30 });

      await runScan();

      expect(steam.fetchInventory).toHaveBeenCalledWith(STEAM_ID);
      expect(steam.fetchPrice).toHaveBeenCalledWith(ITEM_NAME);
      const snapshot = db.prepare(
        'SELECT ps.* FROM price_snapshots ps JOIN item_names n ON n.id = ps.item_id WHERE n.name = ?'
      ).get(ITEM_NAME);
      expect(snapshot.lowest_price).toBe(15.0);
    });

    it('updates scanState on completion', async () => {
      setAccounts([{ uid: UID, steam64ids: [], customItems: [ITEM_NAME] }]);
      steam.fetchPrice.mockResolvedValue({ lowest_price: 10.0, median_price: 11.0, volume: 50 });

      await runScan();

      expect(typeof scanState.lastScannedAt).toBe('number');
      expect(typeof scanState.lastScanMs).toBe('number');
      expect(scanState.lastScanMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('bad steam64ids', () => {
    it('marks a steam64id as bad on access error (400/403)', async () => {
      setAccounts([{ uid: UID, steam64ids: [STEAM_ID], customItems: [] }]);
      steam.fetchInventory.mockRejectedValue(new Error(`Cannot access inventory for ${STEAM_ID}`));

      await runScan();

      expect(db.isBad('steam64id', STEAM_ID)).toBe(true);
    });

    it('does not mark a steam64id as bad on rate limit', async () => {
      setAccounts([{ uid: UID, steam64ids: [STEAM_ID], customItems: [] }]);
      steam.fetchInventory.mockRejectedValue(new Error(`Rate limited fetching inventory for ${STEAM_ID}`));

      await runScan();

      expect(db.isBad('steam64id', STEAM_ID)).toBe(false);
    });

    it('skips previously bad steam64ids', async () => {
      setAccounts([{ uid: UID, steam64ids: [STEAM_ID], customItems: [] }]);
      db.markBad('steam64id', STEAM_ID, 'manual');

      await runScan();

      expect(steam.fetchInventory).not.toHaveBeenCalled();
    });
  });

  describe('bad items', () => {
    it('marks item as bad when Steam returns no price data', async () => {
      setAccounts([{ uid: UID, steam64ids: [], customItems: [ITEM_NAME] }]);
      steam.fetchPrice.mockResolvedValue(null);

      await runScan();

      expect(db.isBad('item', ITEM_NAME)).toBe(true);
    });

    it('marks item as bad on non-rate-limit fetch error', async () => {
      setAccounts([{ uid: UID, steam64ids: [], customItems: [ITEM_NAME] }]);
      steam.fetchPrice.mockRejectedValue(new Error(`Failed to fetch price for "${ITEM_NAME}": HTTP 404`));

      await runScan();

      expect(db.isBad('item', ITEM_NAME)).toBe(true);
    });

    it('does not mark item as bad on rate limit', async () => {
      setAccounts([{ uid: UID, steam64ids: [], customItems: [ITEM_NAME] }]);
      steam.fetchPrice.mockRejectedValue(new Error(`Rate limited fetching price for "${ITEM_NAME}"`));

      await runScan();

      expect(db.isBad('item', ITEM_NAME)).toBe(false);
    });

    it('skips previously bad items', async () => {
      setAccounts([{ uid: UID, steam64ids: [], customItems: [ITEM_NAME] }]);
      db.markBad('item', ITEM_NAME, 'manual');

      await runScan();

      expect(steam.fetchPrice).not.toHaveBeenCalled();
    });
  });

  describe('price spike alerts', () => {
    it('creates an alert when price is 15%+ above 7-day low', async () => {
      setAccounts([{ uid: UID, steam64ids: [], customItems: [ITEM_NAME] }]);

      // Historical low of 10.0 recorded 3 days ago
      insertSnapshot(ITEM_NAME, 10.0, 3);

      // Current price 20% above the low (10 * 1.15 = 11.5, so 12.0 triggers it)
      steam.fetchPrice.mockResolvedValue({ lowest_price: 12.0, median_price: 13.0, volume: 30 });

      await runScan();

      const alert = db.prepare(
        'SELECT a.* FROM alerts a JOIN item_names n ON n.id = a.item_id WHERE n.name = ?'
      ).get(ITEM_NAME);
      expect(alert).not.toBeNull();
      expect(alert.price_at_alert).toBe(12.0);
      expect(alert.seven_day_low).toBe(10.0);
    });

    it('creates a recipient row for each uid tracking the item', async () => {
      const UID2 = 'testuid2';
      setAccounts([
        { uid: UID, steam64ids: [], customItems: [ITEM_NAME] },
        { uid: UID2, steam64ids: [], customItems: [ITEM_NAME] },
      ]);
      insertSnapshot(ITEM_NAME, 10.0, 3);
      steam.fetchPrice.mockResolvedValue({ lowest_price: 12.0, median_price: 13.0, volume: 30 });

      await runScan();

      const recipients = db.prepare('SELECT * FROM alert_recipients').all();
      expect(recipients).toHaveLength(2);
      expect(recipients.map(r => r.uid)).toContain(UID);
      expect(recipients.map(r => r.uid)).toContain(UID2);
    });

    it('does not create an alert when price is below spike threshold', async () => {
      setAccounts([{ uid: UID, steam64ids: [], customItems: [ITEM_NAME] }]);
      insertSnapshot(ITEM_NAME, 10.0, 3);

      // 10% rise — below the 15% threshold
      steam.fetchPrice.mockResolvedValue({ lowest_price: 11.0, median_price: 11.5, volume: 30 });

      await runScan();

      const alert = db.prepare(
        'SELECT a.* FROM alerts a JOIN item_names n ON n.id = a.item_id WHERE n.name = ?'
      ).get(ITEM_NAME);
      expect(alert).toBeUndefined();
    });

    it('does not create an alert when there is no 7-day price history', async () => {
      setAccounts([{ uid: UID, steam64ids: [], customItems: [ITEM_NAME] }]);
      steam.fetchPrice.mockResolvedValue({ lowest_price: 50.0, median_price: 51.0, volume: 5 });

      await runScan();

      const alert = db.prepare(
        'SELECT a.* FROM alerts a JOIN item_names n ON n.id = a.item_id WHERE n.name = ?'
      ).get(ITEM_NAME);
      expect(alert).toBeUndefined();
    });
  });
});
