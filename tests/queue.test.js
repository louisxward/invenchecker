'use strict';

const fs = require('fs');

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

  function setAccounts(accounts) {
    fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify(accounts), 'utf8');
  }

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
