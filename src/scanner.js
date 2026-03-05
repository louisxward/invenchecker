'use strict';

const db = require('./db');
const logger = require('./logger');
const { readConfig } = require('./config');
const { fetchInventory, fetchPrice, sleep } = require('./steam');
const { PRICE_RATE_LIMIT_MS, SPIKE_THRESHOLD, SEVEN_DAYS_SECS } = require('./appConfig');

const upsertInvItem = db.prepare(`
  INSERT INTO inventory_items (steam64id, item_id, first_seen, last_seen)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(steam64id, item_id) DO UPDATE SET last_seen = excluded.last_seen, missing = 0, missing_at = NULL
`);

const markMissing = db.prepare(`
  UPDATE inventory_items
  SET missing = 1, missing_at = ?
  WHERE steam64id = ? AND missing = 0 AND item_id NOT IN (SELECT value FROM json_each(?))
`);

const scanState = {
  lastScannedAt: null,
  lastScanMs: null,
};

async function runScan() {
  const startTime = Date.now();
  logger.info('Starting inventory scan');

  const accounts = readConfig();

  if (accounts.length === 0) {
    logger.info('No accounts configured, skipping scan');
    return;
  }

  const now = Math.floor(Date.now() / 1000);

  // Step 1: collect all unique steam64ids, fetch each inventory once
  const allSteam64ids = new Set(accounts.flatMap(a => a.steam64ids || []));
  const inventoryMap = new Map(); // steam64id -> descriptions[]
  const badSteam64ids = new Set(db.getBadEntries('steam64id'));

  for (const steam64id of allSteam64ids) {
    if (badSteam64ids.has(steam64id)) {
      logger.warn({ steam64id }, 'Skipping bad steam64id');
      inventoryMap.set(steam64id, []);
      continue;
    }
    try {
      logger.info({ steam64id }, 'Fetching inventory');
      const descriptions = await fetchInventory(steam64id);
      logger.info({ steam64id, itemCount: descriptions.length }, 'Inventory fetched');
      inventoryMap.set(steam64id, descriptions);
    } catch (err) {
      const isRateLimit = err.message.includes('Rate limited');
      if (!isRateLimit) {
        db.markBad('steam64id', steam64id, err.message);
        logger.warn({ steam64id, reason: err.message }, 'Marked steam64id as bad');
      } else {
        logger.error({ err, steam64id }, 'Failed to fetch inventory, skipping');
      }
      inventoryMap.set(steam64id, []);
    }
  }

  // Step 2: upsert inventory_items and mark missing items
  for (const [steam64id, descriptions] of inventoryMap) {
    const foundItemIds = [];
    for (const d of descriptions) {
      if (!d.market_hash_name) continue;
      const itemId = db.getOrCreateItemId(d.market_hash_name);
      upsertInvItem.run(steam64id, itemId, now, now);
      foundItemIds.push(itemId);
    }
    // Mark items previously seen but not in this scan as missing
    markMissing.run(now, steam64id, JSON.stringify(foundItemIds));
  }

  // Step 3: build itemsToPrice Set and itemId→uids map
  const itemsToPrice = new Set();
  const itemIdToUids = new Map(); // item_id -> Set<uid>

  const addUidForItem = (itemId, uid) => {
    if (!itemIdToUids.has(itemId)) itemIdToUids.set(itemId, new Set());
    itemIdToUids.get(itemId).add(uid);
  };

  for (const account of accounts) {
    for (const steam64id of (account.steam64ids || [])) {
      for (const d of (inventoryMap.get(steam64id) || [])) {
        if (!d.market_hash_name) continue;
        itemsToPrice.add(d.market_hash_name);
        const itemId = db.getOrCreateItemId(d.market_hash_name);
        addUidForItem(itemId, account.uid);
      }
    }
    for (const itemName of (account.customItems || [])) {
      itemsToPrice.add(itemName);
      const itemId = db.getOrCreateItemId(itemName);
      addUidForItem(itemId, account.uid);
    }
  }

  if (itemsToPrice.size === 0) {
    logger.info('No items to price, skipping scan');
    return;
  }

  logger.info({ itemCount: itemsToPrice.size }, 'Fetching prices');

  const badItems = new Set(db.getBadEntries('item'));

  // Step 4: fetch price once per unique item, detect spikes
  for (const itemName of itemsToPrice) {
    if (badItems.has(itemName)) {
      logger.warn({ itemName }, 'Skipping bad item');
      continue;
    }

    let priceData;
    try {
      priceData = await fetchPrice(itemName);
      await sleep(PRICE_RATE_LIMIT_MS);
    } catch (err) {
      const isRateLimit = err.message.includes('Rate limited');
      if (!isRateLimit) {
        db.markBad('item', itemName, err.message);
        logger.warn({ itemName, reason: err.message }, 'Marked item as bad');
      } else {
        logger.error({ err, itemName }, 'Failed to fetch price, skipping item');
      }
      await sleep(PRICE_RATE_LIMIT_MS);
      continue;
    }

    if (!priceData || priceData.lowest_price === null) {
      db.markBad('item', itemName, 'Steam returned no price data (success=false)');
      logger.warn({ itemName }, 'Marked item as bad: no price data from Steam');
      continue;
    }

    const scanTime = Math.floor(Date.now() / 1000);
    const itemId = db.getOrCreateItemId(itemName);

    // Query 7-day low BEFORE inserting so the new price doesn't pollute the historical minimum
    const sevenDayAgo = scanTime - SEVEN_DAYS_SECS;
    const row = db.prepare(`
      SELECT MIN(lowest_price) AS seven_day_low
      FROM price_snapshots
      WHERE item_id = ? AND captured_at >= ? AND lowest_price IS NOT NULL
    `).get(itemId, sevenDayAgo);

    db.prepare(`
      INSERT INTO price_snapshots (item_id, lowest_price, median_price, volume, captured_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(itemId, priceData.lowest_price, priceData.median_price, priceData.volume, scanTime);

    logger.info({ itemName, lowest_price: priceData.lowest_price }, 'Price snapshot recorded');

    const sevenDayLow = row && row.seven_day_low;

    if (sevenDayLow && sevenDayLow > 0 && priceData.lowest_price >= sevenDayLow * SPIKE_THRESHOLD) {
      const spikePct = ((priceData.lowest_price - sevenDayLow) / sevenDayLow) * 100;

      const alertId = db.prepare(`
        INSERT INTO alerts (item_id, spike_pct, price_at_alert, seven_day_low, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(itemId, spikePct, priceData.lowest_price, sevenDayLow, scanTime).lastInsertRowid;

      // Create a recipient row for each uid that tracks this item
      const insertRecipient = db.prepare(
        'INSERT OR IGNORE INTO alert_recipients (alert_id, uid) VALUES (?, ?)'
      );
      for (const uid of (itemIdToUids.get(itemId) || [])) {
        insertRecipient.run(alertId, uid);
      }

      logger.warn(
        { itemName, spikePct: spikePct.toFixed(2), currentPrice: priceData.lowest_price, sevenDayLow },
        'Price spike alert: item price has spiked significantly'
      );
    }
  }

  const duration = Date.now() - startTime;
  scanState.lastScannedAt = Math.floor(Date.now() / 1000);
  scanState.lastScanMs = duration;
  logger.info({ durationMs: duration }, 'Inventory scan complete');
}

module.exports = { runScan, scanState };
