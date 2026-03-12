'use strict';

const db = require('./db');
const logger = require('./logger');
const { readConfig } = require('./config');
const { fetchInventory, fetchPrice } = require('./steam');
const { SEVEN_DAYS_SECS } = require('./appConfig');
const { getRuleForPrice } = require('./rules');

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

// Returns the set of uids that track a given item (via inventory or customItems)
function getUidsForItem(itemId) {
  const uids = new Set();
  const accounts = readConfig();

  const invRows = db.prepare(
    'SELECT DISTINCT steam64id FROM inventory_items WHERE item_id = ? AND missing = 0'
  ).all(itemId);

  const steam64idToUid = new Map();
  for (const account of accounts) {
    for (const id of (account.steam64ids || [])) {
      steam64idToUid.set(id, account.uid);
    }
  }
  for (const row of invRows) {
    const uid = steam64idToUid.get(row.steam64id);
    if (uid) uids.add(uid);
  }

  const itemName = db.prepare('SELECT name FROM item_names WHERE id = ?').get(itemId)?.name;
  if (itemName) {
    for (const account of accounts) {
      if ((account.customItems || []).includes(itemName)) {
        uids.add(account.uid);
      }
    }
  }

  return uids;
}

// Fetch inventory for one steam64id, upsert to DB, enqueue found items for pricing
async function processInventoryForSteamId(steam64id, enqueuePrice) {
  if (db.getBadEntries('steam64id').includes(steam64id)) {
    logger.warn({ steam64id }, 'Skipping bad steam64id');
    return;
  }

  let descriptions;
  const fetchStart = Date.now();
  try {
    logger.info({ steam64id }, 'Fetching inventory');
    descriptions = await fetchInventory(steam64id);
    const durationMs = Date.now() - fetchStart;
    logger.info({ steam64id, itemCount: descriptions.length, durationMs }, 'Inventory fetched');
    db.prepare(
      'INSERT INTO inventory_fetches (steam64id, item_count, duration_ms, fetched_at) VALUES (?, ?, ?, ?)'
    ).run(steam64id, descriptions.length, durationMs, Math.floor(Date.now() / 1000));
  } catch (err) {
    const isRateLimit = err.message.includes('Rate limited');
    if (!isRateLimit) {
      db.markBad('steam64id', steam64id, err.message);
      logger.warn({ steam64id, reason: err.message }, 'Marked steam64id as bad');
    } else {
      logger.error({ err, steam64id }, 'Failed to fetch inventory (rate limited), skipping');
    }
    return isRateLimit ? 'rate_limited' : undefined;
  }

  const now = Math.floor(Date.now() / 1000);
  const foundItemIds = [];

  for (const d of descriptions) {
    if (!d.market_hash_name) continue;
    const itemId = db.getOrCreateItemId(d.market_hash_name);
    upsertInvItem.run(steam64id, itemId, now, now);
    foundItemIds.push(itemId);
    enqueuePrice(d.market_hash_name);
  }

  markMissing.run(now, steam64id, JSON.stringify(foundItemIds));
}

// Fetch price for one item, insert snapshot, detect spikes
async function processPriceForItem(itemName) {
  if (db.getBadEntries('item').includes(itemName)) {
    logger.warn({ itemName }, 'Skipping bad item');
    return;
  }

  let priceData;
  try {
    priceData = await fetchPrice(itemName);
  } catch (err) {
    const isRateLimit = err.message.includes('Rate limited');
    if (!isRateLimit) {
      db.markBad('item', itemName, err.message);
      logger.warn({ itemName, reason: err.message }, 'Marked item as bad');
    } else {
      logger.error({ err, itemName }, 'Failed to fetch price (rate limited), skipping');
    }
    return isRateLimit ? 'rate_limited' : undefined;
  }

  if (!priceData || priceData.lowest_price === null) {
    db.markBad('item', itemName, 'Steam returned no price data (success=false)');
    logger.warn({ itemName }, 'Marked item as bad: no price data from Steam');
    return;
  }

  const { scanMs, alertThreshold, realertThreshold } = getRuleForPrice(priceData.lowest_price);

  const scanTime = Math.floor(Date.now() / 1000);
  const itemId = db.getOrCreateItemId(itemName);
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

  if (sevenDayLow && sevenDayLow > 0 && priceData.lowest_price >= sevenDayLow * alertThreshold) {
    const lastAlert = db.prepare(
      'SELECT price_at_alert, created_at FROM alerts WHERE item_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(itemId);

    let shouldAlert = true;
    if (lastAlert && priceData.lowest_price < sevenDayLow * realertThreshold) {
      const spikeReset = db.prepare(`
        SELECT 1 FROM price_snapshots
        WHERE item_id = ? AND captured_at > ? AND lowest_price < ? * ?
        LIMIT 1
      `).get(itemId, lastAlert.created_at, sevenDayLow, alertThreshold);

      if (!spikeReset) {
        shouldAlert = false;
        logger.info(
          { itemName, currentPrice: priceData.lowest_price, lastAlertPrice: lastAlert.price_at_alert },
          'Price spike still active but below re-alert threshold, skipping'
        );
      }
    }

    if (shouldAlert) {
      const spikePct = ((priceData.lowest_price - sevenDayLow) / sevenDayLow) * 100;

      const alertId = db.prepare(`
        INSERT INTO alerts (item_id, spike_pct, price_at_alert, seven_day_low, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(itemId, spikePct, priceData.lowest_price, sevenDayLow, scanTime).lastInsertRowid;

      const insertRecipient = db.prepare(
        'INSERT OR IGNORE INTO alert_recipients (alert_id, uid) VALUES (?, ?)'
      );
      for (const uid of getUidsForItem(itemId)) {
        insertRecipient.run(alertId, uid);
      }

      logger.warn(
        { itemName, spikePct: spikePct.toFixed(2), currentPrice: priceData.lowest_price, sevenDayLow },
        'Price spike alert: item price has spiked significantly'
      );
    }
  }

  return { scanMs };
}

// Enqueue all accounts' steam64ids and customItems for scanning (used by POST /alerts/scan)
async function runScan() {
  const { enqueueInventory, enqueuePrice } = require('./queue');
  const accounts = readConfig();

  if (accounts.length === 0) {
    logger.info('No accounts configured, skipping scan');
    return;
  }

  for (const account of accounts) {
    for (const id of (account.steam64ids || [])) enqueueInventory(id);
    for (const item of (account.customItems || [])) enqueuePrice(item);
  }

  scanState.lastScannedAt = Math.floor(Date.now() / 1000);
  logger.info('Manual scan triggered: all items enqueued');
}

module.exports = { runScan, scanState, processInventoryForSteamId, processPriceForItem };
