'use strict';

const { setAccounts } = require('./helpers/accounts');

jest.mock('../src/steam', () => ({
  fetchInventory: jest.fn(),
  fetchPrice: jest.fn(),
  isNetworkError: jest.requireActual('../src/steam').isNetworkError,
  isServerError: jest.requireActual('../src/steam').isServerError,
  sleep: jest.fn().mockResolvedValue(undefined),
}));

describe('queue re-enqueueing', () => {
  let db;
  let itemNames;
  let queue;

  const STEAM_ID = '76561198000000040';
  const OTHER_ID = '76561198000000041';

  function holdItem(steam64id, name, missing = 0) {
    db.prepare(
      'INSERT INTO inventory_items (steam64id, item_id, first_seen, last_seen, missing) VALUES (?, ?, 1, 1, ?)'
    ).run(steam64id, itemNames.getOrCreateItemId(name), missing);
  }

  beforeAll(() => {
    const database = require('../src/database');
    database.init();
    db = database.getDb();
    itemNames = require('../src/repositories/itemNames');
    queue = require('../src/queue');
  });

  beforeEach(() => {
    db.prepare('DELETE FROM inventory_items').run();
  });

  describe('requeueInventory', () => {
    it('re-enqueues a steam64id an account still lists', () => {
      setAccounts([{ uid: 'a', steam64ids: [STEAM_ID] }]);
      queue.requeueInventory(STEAM_ID);
      expect(queue.isInventoryQueued(STEAM_ID)).toBe(true);
    });

    it('drops a steam64id no account lists any more', () => {
      setAccounts([{ uid: 'a', steam64ids: [] }]);
      queue.requeueInventory(OTHER_ID);
      expect(queue.isInventoryQueued(OTHER_ID)).toBe(false);
    });
  });

  describe('requeuePrice', () => {
    it('re-enqueues a custom item', () => {
      setAccounts([{ uid: 'a', steam64ids: [], customItems: ['Custom A'] }]);
      queue.requeuePrice('Custom A');
      expect(queue.isPriceQueued('Custom A')).toBe(true);
    });

    it('re-enqueues an item in a tracked inventory', () => {
      setAccounts([{ uid: 'a', steam64ids: [STEAM_ID], customItems: [] }]);
      holdItem(STEAM_ID, 'Held');
      queue.requeuePrice('Held');
      expect(queue.isPriceQueued('Held')).toBe(true);
    });

    it('drops an item that has gone missing from the inventory', () => {
      setAccounts([{ uid: 'a', steam64ids: [STEAM_ID], customItems: [] }]);
      holdItem(STEAM_ID, 'Sold', 1);
      queue.requeuePrice('Sold');
      expect(queue.isPriceQueued('Sold')).toBe(false);
    });

    it('drops an item whose only holder was removed from its account', () => {
      setAccounts([{ uid: 'a', steam64ids: [], customItems: [] }]);
      holdItem(STEAM_ID, 'Orphan');
      queue.requeuePrice('Orphan');
      expect(queue.isPriceQueued('Orphan')).toBe(false);
    });

    it('drops a custom item removed from every account', () => {
      setAccounts([{ uid: 'a', steam64ids: [], customItems: [] }]);
      queue.requeuePrice('Removed');
      expect(queue.isPriceQueued('Removed')).toBe(false);
    });
  });
});

describe('scan duration (lastScanMs)', () => {
  let queue;
  let scanner;
  let steam;
  let now;

  const STEAM_ID = '76561198000000060';

  async function drain() {
    while ((await queue.processNextInventory()) || (await queue.processNextPrice()));
  }

  beforeAll(() => {
    require('../src/database').init();
    queue = require('../src/queue');
    scanner = require('../src/scanner');
    steam = require('../src/steam');
  });

  beforeEach(async () => {
    now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    steam.fetchInventory.mockResolvedValue([{ market_hash_name: 'Scan Inv Item' }]);
    steam.fetchPrice.mockResolvedValue({ lowest_price: 1, median_price: 1, volume: 1 });
    setAccounts([{ uid: 's', steam64ids: [STEAM_ID], customItems: ['Scan Custom'] }]);
    await drain(); // entries left over from other tests
    queue.checkScanComplete();
    scanner.scanState.lastScanMs = null;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('is the time from the scan being triggered until the queues have finished it', async () => {
    await scanner.runScan(true);
    queue.checkScanComplete();
    expect(scanner.scanState.lastScanMs).toBeNull(); // still queued

    now += 1500;
    await queue.processNextInventory(); // feeds Scan Inv Item to the price queue
    queue.checkScanComplete();
    expect(scanner.scanState.lastScanMs).toBeNull();

    now += 2000;
    await drain();
    queue.checkScanComplete();
    expect(scanner.scanState.lastScanMs).toBe(3500);

    // Only the first idle check after the scan records it
    now += 9000;
    queue.checkScanComplete();
    expect(scanner.scanState.lastScanMs).toBe(3500);
  });

  it('waits for an entry paused for a retry', async () => {
    await scanner.runScan(true);
    await queue.processNextInventory();

    let release;
    steam.fetchPrice.mockRejectedValueOnce(new Error('Rate limited fetching price for "x"'));
    steam.sleep.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const pending = queue.processNextPrice(); // Scan Custom is rate limited and pauses before its retry
    await new Promise((resolve) => setImmediate(resolve));
    expect(release).toBeDefined();

    now += 60_000;
    queue.checkScanComplete();
    expect(scanner.scanState.lastScanMs).toBeNull();

    release();
    await pending;
    await drain(); // the retried item
    queue.checkScanComplete();
    expect(scanner.scanState.lastScanMs).toBe(60_000);
  });

  it('stays null until a scan has been triggered', () => {
    queue.checkScanComplete();
    expect(scanner.scanState.lastScanMs).toBeNull();
  });
});
