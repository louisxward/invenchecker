'use strict';

const { setAccounts } = require('./helpers/accounts');

jest.mock('../src/steam', () => ({
  fetchInventory: jest.fn(),
  fetchPrice: jest.fn(),
  isNetworkError: jest.requireActual('../src/steam').isNetworkError,
  isServerError: jest.requireActual('../src/steam').isServerError,
  sleep: jest.fn().mockResolvedValue(undefined),
}));

// Prevent queue workers from starting during tests
jest.mock('../src/queue', () => ({
  enqueueInventory: jest.fn(),
  enqueueInventoryIfDue: jest.fn(),
  enqueuePrice: jest.fn(),
  enqueuePriceIfDue: jest.fn(),
  startQueues: jest.fn(),
  getQueueState: jest.fn().mockReturnValue({ inventoryQueueSize: 0, priceQueueSize: 0 }),
}));

describe('Scanner', () => {
  let db;
  let itemNames;
  let badEntries;
  let runScan;
  let scanState;
  let processInventoryForSteamId;
  let processPriceForItem;
  let steam;
  let queue;

  const UID = 'testuid1';
  const STEAM_ID = '76561198000000000';
  const ITEM_NAME = 'AK-47 | Redline (Field-Tested)';

  function insertSnapshot(itemName, price, daysAgo = 0) {
    const itemId = itemNames.getOrCreateItemId(itemName);
    const capturedAt = Math.floor(Date.now() / 1000) - daysAgo * 24 * 60 * 60;
    db.prepare(
      'INSERT INTO price_snapshots (item_id, lowest_price, median_price, volume, captured_at) VALUES (?, ?, ?, ?, ?)'
    ).run(itemId, price, price, 50, capturedAt);
    return itemId;
  }

  beforeAll(() => {
    const database = require('../src/database');
    database.init();
    db = database.getDb();
    itemNames = require('../src/repositories/itemNames');
    badEntries = require('../src/repositories/badEntries');
    ({ runScan, scanState, processInventoryForSteamId, processPriceForItem } = require('../src/scanner'));
    steam = require('../src/steam');
    queue = require('../src/queue');
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

  describe('runScan', () => {
    it('does nothing when no accounts are configured', async () => {
      setAccounts([]);
      await runScan();
      expect(queue.enqueueInventoryIfDue).not.toHaveBeenCalled();
      expect(queue.enqueuePriceIfDue).not.toHaveBeenCalled();
    });

    it('enqueues steam64ids and customItems that are due for all accounts', async () => {
      setAccounts([{ uid: UID, steam64ids: [STEAM_ID], customItems: [ITEM_NAME] }]);
      await runScan();
      expect(queue.enqueueInventoryIfDue).toHaveBeenCalledWith(STEAM_ID);
      expect(queue.enqueuePriceIfDue).toHaveBeenCalledWith(ITEM_NAME);
      expect(queue.enqueueInventory).not.toHaveBeenCalled();
      expect(queue.enqueuePrice).not.toHaveBeenCalled();
    });

    it('enqueues everything regardless of recency when forced', async () => {
      setAccounts([{ uid: UID, steam64ids: [STEAM_ID], customItems: [ITEM_NAME] }]);
      await runScan(true);
      expect(queue.enqueueInventory).toHaveBeenCalledWith(STEAM_ID);
      expect(queue.enqueuePrice).toHaveBeenCalledWith(ITEM_NAME);
      expect(queue.enqueueInventoryIfDue).not.toHaveBeenCalled();
      expect(queue.enqueuePriceIfDue).not.toHaveBeenCalled();
    });

    it('updates lastScannedAt on completion', async () => {
      setAccounts([{ uid: UID, steam64ids: [], customItems: [ITEM_NAME] }]);
      await runScan();
      expect(typeof scanState.lastScannedAt).toBe('number');
    });
  });

  describe('inventory processing', () => {
    it('upserts inventory items and calls enqueuePrice for each item', async () => {
      steam.fetchInventory.mockResolvedValue([{ market_hash_name: ITEM_NAME }]);
      const mockEnqueuePrice = jest.fn();
      await processInventoryForSteamId(STEAM_ID, mockEnqueuePrice);
      expect(mockEnqueuePrice).toHaveBeenCalledWith(ITEM_NAME);
      const row = db
        .prepare('SELECT ii.* FROM inventory_items ii JOIN item_names n ON n.id = ii.item_id WHERE n.name = ?')
        .get(ITEM_NAME);
      expect(row).not.toBeNull();
    });

    it('records a price snapshot for inventory items (end-to-end)', async () => {
      setAccounts([{ uid: UID, steam64ids: [STEAM_ID], customItems: [] }]);
      steam.fetchInventory.mockResolvedValue([{ market_hash_name: ITEM_NAME }]);
      steam.fetchPrice.mockResolvedValue({ lowest_price: 15.0, median_price: 16.0, volume: 30 });

      const mockEnqueuePrice = jest.fn();
      await processInventoryForSteamId(STEAM_ID, mockEnqueuePrice);
      expect(mockEnqueuePrice).toHaveBeenCalledWith(ITEM_NAME);

      await processPriceForItem(ITEM_NAME);
      const snapshot = db
        .prepare('SELECT ps.* FROM price_snapshots ps JOIN item_names n ON n.id = ps.item_id WHERE n.name = ?')
        .get(ITEM_NAME);
      expect(snapshot.lowest_price).toBe(15.0);
    });
  });

  describe('bad steam64ids', () => {
    it('marks a steam64id as bad on access error (400/403)', async () => {
      steam.fetchInventory.mockRejectedValue(new Error(`Cannot access inventory for ${STEAM_ID}`));
      await processInventoryForSteamId(STEAM_ID, jest.fn());
      expect(badEntries.isBad('steam64id', STEAM_ID)).toBe(true);
    });

    it('does not mark a steam64id as bad on rate limit', async () => {
      steam.fetchInventory.mockRejectedValue(new Error(`Rate limited fetching inventory for ${STEAM_ID}`));
      await processInventoryForSteamId(STEAM_ID, jest.fn());
      expect(badEntries.isBad('steam64id', STEAM_ID)).toBe(false);
    });

    it('returns rate_limited when inventory fetch is rate limited', async () => {
      steam.fetchInventory.mockRejectedValue(new Error(`Rate limited fetching inventory for ${STEAM_ID}`));
      const result = await processInventoryForSteamId(STEAM_ID, jest.fn());
      expect(result).toBe('rate_limited');
    });

    it.each([
      ['connection failure', Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNRESET') })],
      ['timeout', new DOMException('The operation was aborted due to timeout', 'TimeoutError')],
    ])('does not mark a steam64id as bad on a %s, and asks for a retry', async (_label, error) => {
      steam.fetchInventory.mockRejectedValue(error);
      const result = await processInventoryForSteamId(STEAM_ID, jest.fn());
      expect(result).toBe('retry');
      expect(badEntries.isBad('steam64id', STEAM_ID)).toBe(false);
    });

    it('skips previously bad steam64ids', async () => {
      badEntries.markBad('steam64id', STEAM_ID, 'manual');
      await processInventoryForSteamId(STEAM_ID, jest.fn());
      expect(steam.fetchInventory).not.toHaveBeenCalled();
    });
  });

  describe('price snapshots', () => {
    it('records a price snapshot for an item', async () => {
      steam.fetchPrice.mockResolvedValue({ lowest_price: 10.0, median_price: 11.0, volume: 50 });
      await processPriceForItem(ITEM_NAME);
      const snapshot = db
        .prepare('SELECT ps.* FROM price_snapshots ps JOIN item_names n ON n.id = ps.item_id WHERE n.name = ?')
        .get(ITEM_NAME);
      expect(snapshot).not.toBeNull();
      expect(snapshot.lowest_price).toBe(10.0);
    });
  });

  describe('bad items', () => {
    it('marks item as bad when Steam returns no price data', async () => {
      steam.fetchPrice.mockResolvedValue(null);
      await processPriceForItem(ITEM_NAME);
      expect(badEntries.isBad('item', ITEM_NAME)).toBe(true);
    });

    it('marks item as bad on non-rate-limit fetch error', async () => {
      steam.fetchPrice.mockRejectedValue(new Error(`Failed to fetch price for "${ITEM_NAME}": HTTP 404`));
      await processPriceForItem(ITEM_NAME);
      expect(badEntries.isBad('item', ITEM_NAME)).toBe(true);
    });

    it('does not mark item as bad on rate limit', async () => {
      steam.fetchPrice.mockRejectedValue(new Error(`Rate limited fetching price for "${ITEM_NAME}"`));
      await processPriceForItem(ITEM_NAME);
      expect(badEntries.isBad('item', ITEM_NAME)).toBe(false);
    });

    it('returns rate_limited when price fetch is rate limited', async () => {
      steam.fetchPrice.mockRejectedValue(new Error(`Rate limited fetching price for "${ITEM_NAME}"`));
      const result = await processPriceForItem(ITEM_NAME);
      expect(result).toBe('rate_limited');
    });

    it.each([
      ['connection failure', new TypeError('fetch failed')],
      ['timeout', new DOMException('The operation was aborted due to timeout', 'TimeoutError')],
    ])('does not mark an item as bad on a %s, and asks for a retry', async (_label, error) => {
      steam.fetchPrice.mockRejectedValue(error);
      const result = await processPriceForItem(ITEM_NAME);
      expect(result).toBe('retry');
      expect(badEntries.isBad('item', ITEM_NAME)).toBe(false);
    });

    it('skips previously bad items', async () => {
      badEntries.markBad('item', ITEM_NAME, 'manual');
      await processPriceForItem(ITEM_NAME);
      expect(steam.fetchPrice).not.toHaveBeenCalled();
    });
  });

  // With no rules.json the built-in rules apply. Prices from £10 to £50 use alert +20% and
  // re-alert +35%, so over a £10 7-day low: alert from £12.00, re-alert from £13.50.
  describe('price spike alerts', () => {
    it('creates an alert when price reaches the alert threshold', async () => {
      setAccounts([{ uid: UID, steam64ids: [], customItems: [ITEM_NAME] }]);
      insertSnapshot(ITEM_NAME, 10.0, 3);
      steam.fetchPrice.mockResolvedValue({ lowest_price: 12.0, median_price: 13.0, volume: 30 });

      await processPriceForItem(ITEM_NAME);

      const alert = db
        .prepare('SELECT a.* FROM alerts a JOIN item_names n ON n.id = a.item_id WHERE n.name = ?')
        .get(ITEM_NAME);
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

      await processPriceForItem(ITEM_NAME);

      const recipients = db.prepare('SELECT * FROM alert_recipients').all();
      expect(recipients).toHaveLength(2);
      expect(recipients.map((r) => r.uid)).toContain(UID);
      expect(recipients.map((r) => r.uid)).toContain(UID2);
    });

    it('alerts every account that lists the steam64id holding the item', async () => {
      const UID2 = 'testuid2';
      const UID3 = 'testuid3';
      setAccounts([
        { uid: UID, steam64ids: [STEAM_ID], customItems: [] },
        { uid: UID2, steam64ids: ['76561198000000005', STEAM_ID], customItems: [] },
        { uid: UID3, steam64ids: ['76561198000000006'], customItems: [] },
      ]);
      steam.fetchInventory.mockResolvedValue([{ market_hash_name: ITEM_NAME }]);
      await processInventoryForSteamId(STEAM_ID, jest.fn());
      insertSnapshot(ITEM_NAME, 10.0, 3);
      steam.fetchPrice.mockResolvedValue({ lowest_price: 12.0, median_price: 13.0, volume: 30 });

      await processPriceForItem(ITEM_NAME);

      const uids = db
        .prepare('SELECT uid FROM alert_recipients ORDER BY uid')
        .all()
        .map((r) => r.uid);
      expect(uids).toEqual([UID, UID2]);
    });

    it('does not create an alert when price is below spike threshold', async () => {
      setAccounts([{ uid: UID, steam64ids: [], customItems: [ITEM_NAME] }]);
      insertSnapshot(ITEM_NAME, 10.0, 3);
      steam.fetchPrice.mockResolvedValue({ lowest_price: 11.0, median_price: 11.5, volume: 30 });

      await processPriceForItem(ITEM_NAME);

      const alert = db
        .prepare('SELECT a.* FROM alerts a JOIN item_names n ON n.id = a.item_id WHERE n.name = ?')
        .get(ITEM_NAME);
      expect(alert).toBeUndefined();
    });

    it('suppresses a re-alert while the spike is still below the re-alert threshold', async () => {
      setAccounts([{ uid: UID, steam64ids: [], customItems: [ITEM_NAME] }]);
      const itemId = insertSnapshot(ITEM_NAME, 10.0, 3);
      // A prior alert at £12.00
      db.prepare(
        'INSERT INTO alerts (item_id, spike_pct, price_at_alert, seven_day_low, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(itemId, 20.0, 12.0, 10.0, Math.floor(Date.now() / 1000) - 60);
      // Current price £13.00: above the alert threshold (£12.00) but below re-alert (£13.50)
      steam.fetchPrice.mockResolvedValue({ lowest_price: 13.0, median_price: 13.0, volume: 30 });

      await processPriceForItem(ITEM_NAME);

      const allAlerts = db
        .prepare('SELECT a.* FROM alerts a JOIN item_names n ON n.id = a.item_id WHERE n.name = ?')
        .all(ITEM_NAME);
      expect(allAlerts).toHaveLength(1); // no new alert created
    });

    it('fires a new alert when price reaches the re-alert threshold', async () => {
      setAccounts([{ uid: UID, steam64ids: [], customItems: [ITEM_NAME] }]);
      const itemId = insertSnapshot(ITEM_NAME, 10.0, 3);
      // A prior alert at £12.00
      db.prepare(
        'INSERT INTO alerts (item_id, spike_pct, price_at_alert, seven_day_low, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(itemId, 20.0, 12.0, 10.0, Math.floor(Date.now() / 1000) - 60);
      // Current price £13.50: at the re-alert threshold (7-day low * 1.35)
      steam.fetchPrice.mockResolvedValue({ lowest_price: 13.5, median_price: 13.0, volume: 30 });

      await processPriceForItem(ITEM_NAME);

      const allAlerts = db
        .prepare('SELECT a.* FROM alerts a JOIN item_names n ON n.id = a.item_id WHERE n.name = ?')
        .all(ITEM_NAME);
      expect(allAlerts).toHaveLength(2); // new alert created
    });

    it('re-alerts after spike reset when price dipped below threshold since last alert', async () => {
      setAccounts([{ uid: UID, steam64ids: [], customItems: [ITEM_NAME] }]);
      const itemId = insertSnapshot(ITEM_NAME, 10.0, 3);
      const alertTime = Math.floor(Date.now() / 1000) - 120;
      // A prior alert at £12.00
      db.prepare(
        'INSERT INTO alerts (item_id, spike_pct, price_at_alert, seven_day_low, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(itemId, 20.0, 12.0, 10.0, alertTime);
      // A snapshot after the alert where the price dropped below the alert threshold (£12.00)
      db.prepare(
        'INSERT INTO price_snapshots (item_id, lowest_price, median_price, volume, captured_at) VALUES (?, ?, ?, ?, ?)'
      ).run(itemId, 11.0, 11.0, 50, alertTime + 60);
      // Current price £13.00: below re-alert (£13.50), but the spike reset since the last alert
      steam.fetchPrice.mockResolvedValue({ lowest_price: 13.0, median_price: 12.5, volume: 30 });

      await processPriceForItem(ITEM_NAME);

      const allAlerts = db
        .prepare('SELECT a.* FROM alerts a JOIN item_names n ON n.id = a.item_id WHERE n.name = ?')
        .all(ITEM_NAME);
      expect(allAlerts).toHaveLength(2); // new alert fired because spike reset
    });

    it('does not create an alert when there is no 7-day price history', async () => {
      setAccounts([{ uid: UID, steam64ids: [], customItems: [ITEM_NAME] }]);
      steam.fetchPrice.mockResolvedValue({ lowest_price: 50.0, median_price: 51.0, volume: 5 });

      await processPriceForItem(ITEM_NAME);

      const alert = db
        .prepare('SELECT a.* FROM alerts a JOIN item_names n ON n.id = a.item_id WHERE n.name = ?')
        .get(ITEM_NAME);
      expect(alert).toBeUndefined();
    });
  });

  describe('Steam server errors (5xx)', () => {
    const serverError = (status = 500) => Object.assign(new Error(`HTTP ${status}`), { status });
    const ok = { lowest_price: 1.0, median_price: 1.0, volume: 1 };

    // Fails `name` once, with a successful request for another item in between when `othersSucceed`
    async function failPrice(name, othersSucceed) {
      if (othersSucceed) {
        steam.fetchPrice.mockResolvedValueOnce(ok);
        await processPriceForItem(`${name} (other)`);
      }
      steam.fetchPrice.mockRejectedValueOnce(serverError());
      return processPriceForItem(name);
    }

    it('retries an item instead of marking it bad', async () => {
      expect(await failPrice('5xx once', true)).toBe('retry');
      expect(badEntries.isBad('item', '5xx once')).toBe(false);
    });

    it('marks an item bad after 3 server errors while other requests succeed', async () => {
      expect(await failPrice('5xx item', true)).toBe('retry');
      expect(await failPrice('5xx item', true)).toBe('retry');
      expect(await failPrice('5xx item', true)).toBeUndefined();
      expect(badEntries.isBad('item', '5xx item')).toBe(true);
    });

    it('never marks items bad while every request fails (an outage)', async () => {
      for (let i = 0; i < 5; i++) {
        expect(await failPrice('outage A', false)).toBe('retry');
        expect(await failPrice('outage B', false)).toBe('retry');
      }
      expect(badEntries.isBad('item', 'outage A')).toBe(false);
      expect(badEntries.isBad('item', 'outage B')).toBe(false);
    });

    it('starts counting again after the item succeeds', async () => {
      await failPrice('5xx flaky', true);
      await failPrice('5xx flaky', true);
      steam.fetchPrice.mockResolvedValueOnce(ok);
      await processPriceForItem('5xx flaky');
      expect(await failPrice('5xx flaky', true)).toBe('retry');
      expect(await failPrice('5xx flaky', true)).toBe('retry');
      expect(badEntries.isBad('item', '5xx flaky')).toBe(false);
    });

    it('marks a steam64id bad after 3 server errors while other inventories load', async () => {
      const id = '76561198000000050';
      for (let i = 0; i < 3; i++) {
        steam.fetchInventory.mockResolvedValueOnce([]);
        await processInventoryForSteamId('76561198000000051', jest.fn());
        steam.fetchInventory.mockRejectedValueOnce(serverError(502));
        const result = await processInventoryForSteamId(id, jest.fn());
        expect(result).toBe(i < 2 ? 'retry' : undefined);
      }
      expect(badEntries.isBad('steam64id', id)).toBe(true);
    });

    it('still marks an item bad straight away on a 4xx', async () => {
      steam.fetchPrice.mockRejectedValueOnce(serverError(404));
      expect(await processPriceForItem('4xx item')).toBeUndefined();
      expect(badEntries.isBad('item', '4xx item')).toBe(true);
    });
  });
});
