'use strict';

const logger = require('./logger');
const { readConfig } = require('./config');
const { sleep } = require('./steam');
const { WORKER_IDLE_SLEEP_MS, REENQUEUE_DELAY_MS, PRICE_RATE_LIMIT_MS, INVENTORY_RATE_LIMIT_MS, QUEUE_WARN_SIZE } = require('./appConfig');
const { processInventoryForSteamId, processPriceForItem } = require('./scanner');

// Two FIFO queues keyed by their natural identifier (steam64id / itemName).
// Using Map preserves insertion order, giving FIFO semantics.
// A key present in the map means that item is pending — deduplication is free.
const inventoryQueue = new Map(); // steam64id -> true
const priceQueue = new Map();     // itemName  -> true

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
  while (true) {
    if (inventoryQueue.size === 0) {
      await sleep(WORKER_IDLE_SLEEP_MS);
      continue;
    }

    const [steam64id] = inventoryQueue.keys();
    inventoryQueue.delete(steam64id);

    try {
      await processInventoryForSteamId(steam64id, enqueuePrice);
    } catch (err) {
      logger.error({ err, steam64id }, 'Unexpected error in inventory worker');
    }

    await sleep(INVENTORY_RATE_LIMIT_MS);
    setTimeout(() => enqueueInventory(steam64id), REENQUEUE_DELAY_MS);
  }
}

async function priceWorker() {
  while (true) {
    if (priceQueue.size === 0) {
      await sleep(WORKER_IDLE_SLEEP_MS);
      continue;
    }

    const [itemName] = priceQueue.keys();
    priceQueue.delete(itemName);

    try {
      await processPriceForItem(itemName);
    } catch (err) {
      logger.error({ err, itemName }, 'Unexpected error in price worker');
    }

    await sleep(PRICE_RATE_LIMIT_MS);
    setTimeout(() => enqueuePrice(itemName), REENQUEUE_DELAY_MS);
  }
}

function startQueues() {
  if (workersStarted) return;
  workersStarted = true;

  // Seed queues with all existing accounts
  const accounts = readConfig();
  for (const account of accounts) {
    for (const id of (account.steam64ids || [])) enqueueInventory(id);
    for (const item of (account.customItems || [])) enqueuePrice(item);
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
    inventoryQueueSize: inventoryQueue.size,
    priceQueueSize: priceQueue.size,
  };
}

function isInventoryQueued(steam64id) { return inventoryQueue.has(steam64id); }
function isPriceQueued(itemName) { return priceQueue.has(itemName); }

module.exports = { enqueueInventory, enqueuePrice, startQueues, getQueueState, isInventoryQueued, isPriceQueued };
