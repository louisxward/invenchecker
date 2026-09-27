'use strict';

const logger = require('./logger');
const { readConfig } = require('./config');
const { sleep } = require('./steam');
const {
  WORKER_IDLE_SLEEP_MS,
  REENQUEUE_DELAY_MS,
  PRICE_RATE_LIMIT_MS,
  INVENTORY_RATE_LIMIT_MS,
  QUEUE_WARN_SIZE,
  RATE_LIMIT_RETRY_MS,
} = require('./appConfig');
const { processInventoryForSteamId, processPriceForItem, isSteam64idTracked, isItemTracked } = require('./scanner');
const { getRuleForPrice } = require('./rules');
const db = require('./db');

// Two FIFO queues keyed by their natural identifier (steam64id / itemName).
// Using Map preserves insertion order, giving FIFO semantics.
// A key present in the map means that item is pending — deduplication is free.
const inventoryQueue = new Map(); // steam64id -> true
const priceQueue = new Map(); // itemName  -> true
const processingInventory = new Set(); // steam64ids currently being fetched

let workersStarted = false;

function warnIfPressured(queue, rateLimitMs, label) {
  const size = queue.size;
  if (size < QUEUE_WARN_SIZE) return;
  const etaSecs = Math.round((size * rateLimitMs) / 1000);
  logger.warn({ queueSize: size, etaSecs }, `${label} queue is backed up`);
}

function enqueueInventory(steam64id) {
  if (inventoryQueue.has(steam64id)) return;
  inventoryQueue.set(steam64id, true);
  warnIfPressured(inventoryQueue, INVENTORY_RATE_LIMIT_MS, 'Inventory');
  logger.debug({ steam64id }, 'Enqueued inventory fetch');
}

function enqueuePrice(itemName) {
  if (priceQueue.has(itemName)) return;
  priceQueue.set(itemName, true);
  warnIfPressured(priceQueue, PRICE_RATE_LIMIT_MS, 'Price');
  logger.debug({ itemName }, 'Enqueued price fetch');
}

function enqueuePriceIfDue(itemName) {
  if (priceQueue.has(itemName)) return;
  const itemId = db.prepare('SELECT id FROM item_names WHERE name = ?').get(itemName)?.id;
  if (itemId) {
    const row = db
      .prepare(
        'SELECT captured_at AS last, lowest_price FROM price_snapshots WHERE item_id = ? ORDER BY captured_at DESC LIMIT 1'
      )
      .get(itemId);
    if (row) {
      const scanMs = getRuleForPrice(row.lowest_price).scanMs;
      const elapsedMs = (Math.floor(Date.now() / 1000) - row.last) * 1000;
      if (elapsedMs < scanMs) {
        logger.debug({ itemName, elapsedMs, scanMs }, 'Price scan not yet due, skipping');
        return;
      }
    }
  }
  enqueuePrice(itemName);
}

function enqueueInventoryIfDue(steam64id) {
  if (inventoryQueue.has(steam64id) || processingInventory.has(steam64id)) return;
  const row = db.prepare('SELECT MAX(fetched_at) AS last FROM inventory_fetches WHERE steam64id = ?').get(steam64id);
  const elapsedMs = (Math.floor(Date.now() / 1000) - (row?.last ?? 0)) * 1000;
  if (elapsedMs < REENQUEUE_DELAY_MS) {
    logger.debug({ steam64id, elapsedMs }, 'Inventory scan not yet due, skipping');
    return;
  }
  enqueueInventory(steam64id);
}

// Retries and scheduled re-scans only continue while an account still tracks the entry, so a
// deleted account or a sold item drops out of rotation, as it would on a restart
function requeueInventory(steam64id, enqueue = enqueueInventory) {
  if (!isSteam64idTracked(steam64id)) {
    logger.info({ steam64id }, 'steam64id no longer tracked, dropping from rotation');
    return;
  }
  enqueue(steam64id);
}

function requeuePrice(itemName) {
  if (!isItemTracked(itemName)) {
    logger.info({ itemName }, 'Item no longer tracked, dropping from rotation');
    return;
  }
  enqueuePrice(itemName);
}

async function inventoryWorker() {
  let wasActive = false;
  while (true) {
    if (inventoryQueue.size === 0) {
      if (wasActive) {
        logger.info('Inventory queue drained');
        wasActive = false;
      }
      await sleep(WORKER_IDLE_SLEEP_MS);
      continue;
    }
    wasActive = true;

    const [steam64id] = inventoryQueue.keys();
    inventoryQueue.delete(steam64id);

    let result;
    processingInventory.add(steam64id);
    try {
      result = await processInventoryForSteamId(steam64id, enqueuePriceIfDue);
    } catch (err) {
      logger.error({ err, steam64id }, 'Unexpected error in inventory worker');
    } finally {
      processingInventory.delete(steam64id);
    }

    if (result === 'rate_limited' || result === 'retry') {
      logger.info(
        { steam64id, result, retryInMs: RATE_LIMIT_RETRY_MS },
        'Inventory fetch failed, pausing before retry'
      );
      await sleep(RATE_LIMIT_RETRY_MS);
      requeueInventory(steam64id, enqueueInventoryIfDue);
    } else {
      await sleep(INVENTORY_RATE_LIMIT_MS);
      setTimeout(() => requeueInventory(steam64id), REENQUEUE_DELAY_MS);
    }
  }
}

async function priceWorker() {
  let wasActive = false;
  while (true) {
    if (priceQueue.size === 0) {
      if (wasActive) {
        logger.info('Price queue drained');
        wasActive = false;
      }
      await sleep(WORKER_IDLE_SLEEP_MS);
      continue;
    }
    wasActive = true;

    const [itemName] = priceQueue.keys();
    priceQueue.delete(itemName);

    let result;
    try {
      result = await processPriceForItem(itemName);
    } catch (err) {
      logger.error({ err, itemName }, 'Unexpected error in price worker');
    }

    if (result === 'rate_limited' || result === 'retry') {
      logger.info({ itemName, result, retryInMs: RATE_LIMIT_RETRY_MS }, 'Price fetch failed, pausing before retry');
      await sleep(RATE_LIMIT_RETRY_MS);
      requeuePrice(itemName);
    } else {
      const delayMs = result?.scanMs ?? REENQUEUE_DELAY_MS;
      await sleep(PRICE_RATE_LIMIT_MS);
      setTimeout(() => requeuePrice(itemName), delayMs);
    }
  }
}

function startQueues() {
  if (workersStarted) return;
  workersStarted = true;

  // Seed queues, respecting last scan time to avoid redundant scans on restart
  const accounts = readConfig();
  const nowSec = Math.floor(Date.now() / 1000);

  for (const account of accounts) {
    for (const steam64id of account.steam64ids || []) {
      const row = db
        .prepare('SELECT MAX(fetched_at) AS last FROM inventory_fetches WHERE steam64id = ?')
        .get(steam64id);
      const elapsedMs = (nowSec - (row?.last ?? 0)) * 1000;
      if (elapsedMs >= REENQUEUE_DELAY_MS) {
        enqueueInventory(steam64id);
      } else {
        const resumeInMs = REENQUEUE_DELAY_MS - elapsedMs;
        setTimeout(() => requeueInventory(steam64id), resumeInMs);
        logger.info({ steam64id, resumeInMs }, 'Inventory scan not yet due, scheduling');
      }
    }

    for (const item of account.customItems || []) {
      const itemId = db.prepare('SELECT id FROM item_names WHERE name = ?').get(item)?.id;
      const row = itemId
        ? db
            .prepare(
              'SELECT captured_at AS last, lowest_price FROM price_snapshots WHERE item_id = ? ORDER BY captured_at DESC LIMIT 1'
            )
            .get(itemId)
        : null;
      const scanMs = row?.lowest_price != null ? getRuleForPrice(row.lowest_price).scanMs : REENQUEUE_DELAY_MS;
      const elapsedMs = (nowSec - (row?.last ?? 0)) * 1000;
      if (elapsedMs >= scanMs) {
        enqueuePrice(item);
      } else {
        const resumeInMs = scanMs - elapsedMs;
        setTimeout(() => requeuePrice(item), resumeInMs);
        logger.info({ item, resumeInMs }, 'Price scan not yet due, scheduling');
      }
    }
  }

  logger.info({ inventoryQueue: inventoryQueue.size, priceQueue: priceQueue.size }, 'Queue workers started');

  inventoryWorker().catch((err) => logger.fatal({ err }, 'Inventory worker crashed'));
  priceWorker().catch((err) => logger.fatal({ err }, 'Price worker crashed'));
}

function getQueueState() {
  return {
    inventoryQueueSize: inventoryQueue.size + processingInventory.size,
    priceQueueSize: priceQueue.size,
  };
}

function isInventoryQueued(steam64id) {
  return inventoryQueue.has(steam64id) || processingInventory.has(steam64id);
}
function isPriceQueued(itemName) {
  return priceQueue.has(itemName);
}

module.exports = {
  requeueInventory,
  requeuePrice,
  enqueueInventory,
  enqueueInventoryIfDue,
  enqueuePrice,
  enqueuePriceIfDue,
  startQueues,
  getQueueState,
  isInventoryQueued,
  isPriceQueued,
};
