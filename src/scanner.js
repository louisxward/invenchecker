'use strict';

const { SEVEN_DAYS_SECS } = require('./config');
const logger = require('./logger');
const accounts = require('./repositories/accounts');
const alertRecipients = require('./repositories/alertRecipients');
const alerts = require('./repositories/alerts');
const badEntries = require('./repositories/badEntries');
const inventoryFetches = require('./repositories/inventoryFetches');
const inventoryItems = require('./repositories/inventoryItems');
const itemNames = require('./repositories/itemNames');
const priceSnapshots = require('./repositories/priceSnapshots');
const { getRuleForPrice } = require('./rules');
const { fetchInventory, fetchPrice, isNetworkError, isServerError, isInvalidResponse } = require('./steam');

// Failures that might be Steam's fault (a 5xx; for items also success=false) are retried. One only
// counts towards giving up on the entry when Steam has answered another request of the same kind
// since the entry last failed, so an outage or throttling can't blacklist everything, while an entry
// that fails on its own is given up on after FAILURE_LIMIT.
const FAILURE_LIMIT = 3;
const failures = { steam64id: new Map(), item: new Map() }; // value -> { count, successSeq }
const successSeq = { steam64id: 0, item: 0 };

function recordSteamSuccess(type, value) {
  successSeq[type]++;
  failures[type].delete(value);
}

// Returns the number of failures that count against the entry
function recordFailure(type, value) {
  const prev = failures[type].get(value);
  const count = !prev ? 1 : successSeq[type] > prev.successSeq ? prev.count + 1 : prev.count;
  failures[type].set(value, { count, successSeq: successSeq[type] });
  return count;
}

// lastScannedAt: Unix seconds of the last POST /alerts/scan. startedAt: ms of a scan the queues
// haven't finished yet, or null. lastScanMs: how long the last finished scan took (see queue.js).
const scanState = {
  lastScannedAt: null,
  startedAt: null,
  lastScanMs: null,
};

// Returns the set of uids that track a given item (via inventory or customItems)
function getUidsForItem(itemId) {
  const uids = new Set();
  const allAccounts = accounts.listAccounts();

  const holders = new Set(inventoryItems.listHolders(itemId));

  // Several accounts can list the same steam64id, and each of them tracks its items
  for (const account of allAccounts) {
    if (account.steam64ids.some((id) => holders.has(id))) uids.add(account.uid);
  }

  const itemName = itemNames.getItemName(itemId);
  if (itemName) {
    for (const account of allAccounts) {
      if (account.customItems.includes(itemName)) {
        uids.add(account.uid);
      }
    }
  }

  return uids;
}

function isSteam64idTracked(steam64id) {
  return accounts.isSteam64idTracked(steam64id);
}

// An item is tracked while an account lists it as a custom item, or it is in (not missing from)
// the inventory of a steam64id an account lists
function isItemTracked(itemName) {
  const itemId = itemNames.getItemId(itemName);
  if (itemId) return getUidsForItem(itemId).size > 0;
  return accounts.isCustomItemTracked(itemName);
}

// Fetch inventory for one steam64id, upsert to DB, enqueue found items for pricing
async function processInventoryForSteamId(steam64id, enqueuePrice) {
  if (badEntries.isBad('steam64id', steam64id)) {
    logger.debug({ steam64id }, 'inventory - skipping bad steam64id');
    return;
  }

  let descriptions;
  const fetchStart = Date.now();
  try {
    logger.info({ steam64id }, 'inventory - fetching');
    descriptions = await fetchInventory(steam64id);
    recordSteamSuccess('steam64id', steam64id);
    const durationMs = Date.now() - fetchStart;
    logger.info({ steam64id, itemCount: descriptions.length, durationMs }, 'inventory - fetched');
    inventoryFetches.createFetch(steam64id, descriptions.length, durationMs, Math.floor(Date.now() / 1000));
  } catch (err) {
    const isRateLimit = err.message.includes('Rate limited');
    if (isRateLimit) {
      logger.error({ err, steam64id }, 'inventory - rate limited, skipping');
      return 'rate_limited';
    }
    if (isNetworkError(err) || isInvalidResponse(err)) {
      logger.error({ err, steam64id }, 'inventory - network error or invalid response, will retry');
      return 'retry';
    }
    if (isServerError(err)) {
      const count = recordFailure('steam64id', steam64id);
      if (count < FAILURE_LIMIT) {
        logger.error({ err, steam64id, count }, 'inventory - Steam server error, will retry');
        return 'retry';
      }
    }
    badEntries.markBad('steam64id', steam64id, err.message);
    logger.warn({ steam64id, reason: err.message }, 'inventory - marked steam64id as bad');
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const foundItemIds = [];

  for (const d of descriptions) {
    if (!d.market_hash_name) continue;
    const itemId = itemNames.getOrCreateItemId(d.market_hash_name);
    inventoryItems.upsertSeen(steam64id, itemId, now);
    foundItemIds.push(itemId);
    // Non-marketable items (medals, coins, untradeable graffiti...) have no market price
    if (d.marketable !== 0) enqueuePrice(d.market_hash_name);
  }

  inventoryItems.markMissingExcept(steam64id, foundItemIds, now);
}

// Gives up on an item's price. A name seen in an inventory is a real item, so it's only skipped until
// its next scan; any other (a custom item) is marked bad.
function giveUpOnItem(itemName, reason) {
  if (inventoryItems.hasBeenSeen(itemName)) {
    logger.warn({ itemName, reason }, 'price - no price this time, will try again at the next scan');
    return;
  }
  badEntries.markBad('item', itemName, reason);
  logger.warn({ itemName, reason }, 'price - marked item as bad');
}

// Fetch price for one item, insert snapshot, detect spikes
async function processPriceForItem(itemName) {
  if (badEntries.isBad('item', itemName)) {
    logger.debug({ itemName }, 'price - skipping bad item');
    return;
  }

  let priceData;
  try {
    priceData = await fetchPrice(itemName);
  } catch (err) {
    const isRateLimit = err.message.includes('Rate limited');
    if (isRateLimit) {
      logger.error({ err, itemName }, 'price - rate limited, skipping');
      return 'rate_limited';
    }
    if (isNetworkError(err) || isInvalidResponse(err)) {
      logger.error({ err, itemName }, 'price - network error or invalid response, will retry');
      return 'retry';
    }
    if (isServerError(err)) {
      const count = recordFailure('item', itemName);
      if (count < FAILURE_LIMIT) {
        logger.error({ err, itemName, count }, 'price - Steam server error, will retry');
        return 'retry';
      }
      failures.item.delete(itemName);
    }
    giveUpOnItem(itemName, err.message);
    return;
  }

  if (!priceData) {
    const count = recordFailure('item', itemName);
    if (count < FAILURE_LIMIT) {
      logger.warn({ itemName, count }, 'price - Steam gave no price (success=false), will retry');
      return 'retry';
    }
    failures.item.delete(itemName);
    giveUpOnItem(itemName, 'Steam returned success=false (unknown market_hash_name?)');
    return;
  }

  recordSteamSuccess('item', itemName);

  if (priceData.lowest_price === null) {
    logger.info({ itemName }, 'price - no listings right now, will try again at the next scan');
    return;
  }

  const { scanMs, alertThreshold, realertThreshold } = getRuleForPrice(priceData.lowest_price);

  const scanTime = Math.floor(Date.now() / 1000);
  const itemId = itemNames.getOrCreateItemId(itemName);
  // Read before this snapshot is added, so the current price isn't part of its own baseline
  const sevenDayLow = priceSnapshots.getLowestPriceSince(itemId, scanTime - SEVEN_DAYS_SECS);
  priceSnapshots.createSnapshot(itemId, priceData.lowest_price, priceData.median_price, priceData.volume, scanTime);

  // queue requires this module, so it is loaded lazily here and in runScan
  const { priceQueueSize } = require('./queue').getQueueState();
  logger.info({ itemName, lowest_price: priceData.lowest_price, priceQueueSize }, 'price - snapshot recorded');

  if (sevenDayLow && sevenDayLow > 0 && priceData.lowest_price >= sevenDayLow * alertThreshold) {
    const lastAlert = alerts.getLastAlert(itemId);

    let shouldAlert = true;
    if (lastAlert && priceData.lowest_price < sevenDayLow * realertThreshold) {
      const spikeReset = priceSnapshots.hasPriceBelowSince(itemId, lastAlert.created_at, sevenDayLow, alertThreshold);

      if (!spikeReset) {
        shouldAlert = false;
        logger.info(
          { itemName, currentPrice: priceData.lowest_price, lastAlertPrice: lastAlert.price_at_alert },
          'alert - spike still active but below re-alert threshold, skipping'
        );
      }
    }

    if (shouldAlert) {
      const spikePct = ((priceData.lowest_price - sevenDayLow) / sevenDayLow) * 100;

      const alertId = alerts.createAlert(itemId, spikePct, priceData.lowest_price, sevenDayLow, scanTime);
      for (const uid of getUidsForItem(itemId)) {
        alertRecipients.addRecipient(alertId, uid);
      }

      logger.warn(
        { itemName, spikePct: spikePct.toFixed(2), currentPrice: priceData.lowest_price, sevenDayLow },
        'alert - price spike'
      );
    }
  }

  return { scanMs };
}

// Enqueue all accounts' steam64ids and customItems for scanning (used by POST /alerts/scan)
async function runScan(force = false) {
  const { enqueueInventory, enqueueInventoryIfDue, enqueuePrice, enqueuePriceIfDue } = require('./queue');
  const allAccounts = accounts.listAccounts();

  if (allAccounts.length === 0) {
    logger.info('scan - no accounts configured, skipping');
    return;
  }

  const queueInv = force ? enqueueInventory : enqueueInventoryIfDue;
  const queuePrice = force ? enqueuePrice : enqueuePriceIfDue;

  for (const account of allAccounts) {
    for (const id of account.steam64ids) queueInv(id);
    for (const item of account.customItems) queuePrice(item);
  }

  scanState.lastScannedAt = Math.floor(Date.now() / 1000);
  scanState.startedAt = Date.now();
  logger.info({ force }, 'scan - items enqueued');
}

module.exports = {
  runScan,
  scanState,
  processInventoryForSteamId,
  processPriceForItem,
  isSteam64idTracked,
  isItemTracked,
};
