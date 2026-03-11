'use strict';

const logger = require('./logger');
const { readConfig } = require('./config');
const { sleep } = require('./steam');
const { WORKER_IDLE_SLEEP_MS, REENQUEUE_DELAY_MS, PRICE_RATE_LIMIT_MS, INVENTORY_RATE_LIMIT_MS, QUEUE_WARN_SIZE, RATE_LIMIT_RETRY_MS } = require('./appConfig');
const { processInventoryForSteamId, processPriceForItem } = require('./scanner');
const db = require('./db');

// Two FIFO queues keyed by their natural identifier (steam64id / itemName).
// Using Map preserves insertion order, giving FIFO semantics.
// A key present in the map means that item is pending — deduplication is free.
const inventoryQueue = new Map(); // steam64id -> true
const priceQueue = new Map();     // itemName  -> true
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
      result = await processInventoryForSteamId(steam64id, enqueuePrice);
    } catch (err) {
      logger.error({ err, steam64id }, 'Unexpected error in inventory worker');
    } finally {
      processingInventory.delete(steam64id);
    }

    if (result === 'rate_limited') {
      logger.info({ steam64id, retryInMs: RATE_LIMIT_RETRY_MS }, 'Inventory rate limited, pausing before retry');
      await sleep(RATE_LIMIT_RETRY_MS);
      enqueueInventory(steam64id);
    } else {
      await sleep(INVENTORY_RATE_LIMIT_MS);
      setTimeout(() => enqueueInventory(steam64id), REENQUEUE_DELAY_MS);
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

    if (result === 'rate_limited') {
      logger.info({ itemName, retryInMs: RATE_LIMIT_RETRY_MS }, 'Price rate limited, pausing before retry');
      await sleep(RATE_LIMIT_RETRY_MS);
      enqueuePrice(itemName);
    } else {
      await sleep(PRICE_RATE_LIMIT_MS);
      setTimeout(() => enqueuePrice(itemName), REENQUEUE_DELAY_MS);
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
    for (const steam64id of (account.steam64ids || [])) {
      const row = db.prepare('SELECT MAX(fetched_at) AS last FROM inventory_fetches WHERE steam64id = ?').get(steam64id);
      const elapsedMs = (nowSec - (row?.last ?? 0)) * 1000;
      if (elapsedMs >= REENQUEUE_DELAY_MS) {
        enqueueInventory(steam64id);
      } else {
        const resumeInMs = REENQUEUE_DELAY_MS - elapsedMs;
        setTimeout(() => enqueueInventory(steam64id), resumeInMs);
        logger.info({ steam64id, resumeInMs }, 'Inventory scan not yet due, scheduling');
      }
    }

    for (const item of (account.customItems || [])) {
      const itemId = db.prepare('SELECT id FROM item_names WHERE name = ?').get(item)?.id;
      const row = itemId
        ? db.prepare('SELECT MAX(captured_at) AS last FROM price_snapshots WHERE item_id = ?').get(itemId)
        : null;
      const elapsedMs = (nowSec - (row?.last ?? 0)) * 1000;
      if (elapsedMs >= REENQUEUE_DELAY_MS) {
        enqueuePrice(item);
      } else {
        const resumeInMs = REENQUEUE_DELAY_MS - elapsedMs;
        setTimeout(() => enqueuePrice(item), resumeInMs);
        logger.info({ item, resumeInMs }, 'Price scan not yet due, scheduling');
      }
    }
  }

  logger.info(
    { inventoryQueue: inventoryQueue.size, priceQueue: priceQueue.size },
    'Queue workers started'
  );

  inventoryWorker().catch((err) => logger.fatal({ err }, 'Inventory worker crashed'));
  priceWorker().catch((err) => logger.fatal({ err }, 'Price worker crashed'));
}

function getQueueState() {
  return {
    inventoryQueueSize: inventoryQueue.size + processingInventory.size,
    priceQueueSize: priceQueue.size,
  };
}

function isInventoryQueued(steam64id) { return inventoryQueue.has(steam64id) || processingInventory.has(steam64id); }
function isPriceQueued(itemName) { return priceQueue.has(itemName); }

module.exports = { enqueueInventory, enqueuePrice, startQueues, getQueueState, isInventoryQueued, isPriceQueued };
