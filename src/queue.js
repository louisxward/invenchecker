'use strict';

const {
  WORKER_IDLE_SLEEP_MS,
  REENQUEUE_DELAY_MS,
  PRICE_RATE_LIMIT_MS,
  INVENTORY_RATE_LIMIT_MS,
  QUEUE_WARN_SIZE,
  RATE_LIMIT_RETRY_MS,
} = require('./config');
const logger = require('./logger');
const { readAccounts } = require('./accountStore');
const inventoryFetches = require('./repositories/inventoryFetches');
const priceSnapshots = require('./repositories/priceSnapshots');
const { getRuleForPrice } = require('./rules');
const {
  processInventoryForSteamId,
  processPriceForItem,
  isSteam64idTracked,
  isItemTracked,
  scanState,
} = require('./scanner');
const { sleep } = require('./steam');

// Unix seconds of the last successful inventory fetch, or 0 if there has been none
function lastFetchedAt(steam64id) {
  return inventoryFetches.getLastFetch(steam64id)?.fetched_at ?? 0;
}

// Two FIFO queues keyed by their natural identifier (steam64id / itemName).
// Using Map preserves insertion order, giving FIFO semantics.
// A key present in the map means that item is pending — deduplication is free.
const inventoryQueue = new Map(); // steam64id -> true
const priceQueue = new Map(); // itemName  -> true
const processingInventory = new Set(); // steam64ids currently being fetched

let workersStarted = false;

function warnIfPressured(queue, rateLimitMs, area) {
  const size = queue.size;
  if (size < QUEUE_WARN_SIZE) return;
  const etaSecs = Math.round((size * rateLimitMs) / 1000);
  logger.warn({ queueSize: size, etaSecs }, `${area} - queue is backed up`);
}

function enqueueInventory(steam64id) {
  if (inventoryQueue.has(steam64id)) return;
  inventoryQueue.set(steam64id, true);
  warnIfPressured(inventoryQueue, INVENTORY_RATE_LIMIT_MS, 'inventory');
  logger.debug({ steam64id }, 'inventory - enqueued');
}

function enqueuePrice(itemName) {
  if (priceQueue.has(itemName)) return;
  priceQueue.set(itemName, true);
  warnIfPressured(priceQueue, PRICE_RATE_LIMIT_MS, 'price');
  logger.debug({ itemName }, 'price - enqueued');
}

function enqueuePriceIfDue(itemName) {
  if (priceQueue.has(itemName)) return;
  const last = priceSnapshots.getLatestSnapshot(itemName);
  if (last) {
    const scanMs = getRuleForPrice(last.lowest_price).scanMs;
    const elapsedMs = (Math.floor(Date.now() / 1000) - last.captured_at) * 1000;
    if (elapsedMs < scanMs) {
      logger.debug({ itemName, elapsedMs, scanMs }, 'price - not yet due, skipping');
      return;
    }
  }
  enqueuePrice(itemName);
}

function enqueueInventoryIfDue(steam64id) {
  if (inventoryQueue.has(steam64id) || processingInventory.has(steam64id)) return;
  const elapsedMs = (Math.floor(Date.now() / 1000) - lastFetchedAt(steam64id)) * 1000;
  if (elapsedMs < REENQUEUE_DELAY_MS) {
    logger.debug({ steam64id, elapsedMs }, 'inventory - not yet due, skipping');
    return;
  }
  enqueueInventory(steam64id);
}

// Retries and scheduled re-scans only continue while an account still tracks the entry, so a
// deleted account or a sold item drops out of rotation, as it would on a restart
function requeueInventory(steam64id, enqueue = enqueueInventory) {
  if (!isSteam64idTracked(steam64id)) {
    logger.info({ steam64id }, 'inventory - steam64id no longer tracked, dropping from rotation');
    return;
  }
  enqueue(steam64id);
}

function requeuePrice(itemName) {
  if (!isItemTracked(itemName)) {
    logger.info({ itemName }, 'price - item no longer tracked, dropping from rotation');
    return;
  }
  enqueuePrice(itemName);
}

// Entries taken off a queue whose processing, including any retry pause, hasn't finished yet
let inFlight = 0;

// Once a scan has been triggered (runScan), the first time both queues are empty with nothing in
// flight marks it finished: lastScanMs is the time from the trigger to then
function checkScanComplete() {
  if (scanState.startedAt === null) return;
  if (inventoryQueue.size > 0 || priceQueue.size > 0 || processingInventory.size > 0 || inFlight > 0) return;
  scanState.lastScanMs = Date.now() - scanState.startedAt;
  scanState.startedAt = null;
  logger.info({ durationMs: scanState.lastScanMs }, 'scan - complete');
}

// Fetches the next steam64id's inventory. Returns false if the queue was empty.
async function processNextInventory() {
  if (inventoryQueue.size === 0) return false;
  const [steam64id] = inventoryQueue.keys();
  inventoryQueue.delete(steam64id);
  inFlight++;
  try {
    let result;
    processingInventory.add(steam64id);
    try {
      result = await processInventoryForSteamId(steam64id, enqueuePriceIfDue);
    } catch (err) {
      logger.error({ err, steam64id }, 'inventory - unexpected error in worker');
    } finally {
      processingInventory.delete(steam64id);
    }

    if (result === 'rate_limited' || result === 'retry') {
      logger.info(
        { steam64id, result, retryInMs: RATE_LIMIT_RETRY_MS },
        'inventory - fetch failed, pausing before retry'
      );
      await sleep(RATE_LIMIT_RETRY_MS);
      requeueInventory(steam64id, enqueueInventoryIfDue);
    } else {
      await sleep(INVENTORY_RATE_LIMIT_MS);
      setTimeout(() => requeueInventory(steam64id), REENQUEUE_DELAY_MS).unref();
    }
  } finally {
    inFlight--;
  }
  return true;
}

// Fetches the next item's price. Returns false if the queue was empty.
async function processNextPrice() {
  if (priceQueue.size === 0) return false;
  const [itemName] = priceQueue.keys();
  priceQueue.delete(itemName);
  inFlight++;
  try {
    let result;
    try {
      result = await processPriceForItem(itemName);
    } catch (err) {
      logger.error({ err, itemName }, 'price - unexpected error in worker');
    }

    if (result === 'rate_limited' || result === 'retry') {
      logger.info({ itemName, result, retryInMs: RATE_LIMIT_RETRY_MS }, 'price - fetch failed, pausing before retry');
      await sleep(RATE_LIMIT_RETRY_MS);
      requeuePrice(itemName);
    } else {
      const delayMs = result?.scanMs ?? REENQUEUE_DELAY_MS;
      await sleep(PRICE_RATE_LIMIT_MS);
      setTimeout(() => requeuePrice(itemName), delayMs).unref();
    }
  } finally {
    inFlight--;
  }
  return true;
}

async function runWorker(processNext, area) {
  let wasActive = false;
  while (true) {
    if (await processNext()) {
      wasActive = true;
      continue;
    }
    if (wasActive) {
      logger.info(`${area} - queue drained`);
      wasActive = false;
    }
    checkScanComplete();
    await sleep(WORKER_IDLE_SLEEP_MS);
  }
}

function startQueues() {
  if (workersStarted) return;
  workersStarted = true;

  // Seed queues, respecting last scan time to avoid redundant scans on restart
  const accounts = readAccounts();
  const nowSec = Math.floor(Date.now() / 1000);

  for (const account of accounts) {
    for (const steam64id of account.steam64ids || []) {
      const elapsedMs = (nowSec - lastFetchedAt(steam64id)) * 1000;
      if (elapsedMs >= REENQUEUE_DELAY_MS) {
        enqueueInventory(steam64id);
      } else {
        const resumeInMs = REENQUEUE_DELAY_MS - elapsedMs;
        setTimeout(() => requeueInventory(steam64id), resumeInMs);
        logger.info({ steam64id, resumeInMs }, 'inventory - not yet due, scheduling');
      }
    }

    for (const item of account.customItems || []) {
      const last = priceSnapshots.getLatestSnapshot(item);
      const scanMs = last?.lowest_price != null ? getRuleForPrice(last.lowest_price).scanMs : REENQUEUE_DELAY_MS;
      const elapsedMs = (nowSec - (last?.captured_at ?? 0)) * 1000;
      if (elapsedMs >= scanMs) {
        enqueuePrice(item);
      } else {
        const resumeInMs = scanMs - elapsedMs;
        setTimeout(() => requeuePrice(item), resumeInMs);
        logger.info({ item, resumeInMs }, 'price - not yet due, scheduling');
      }
    }
  }

  logger.info({ inventoryQueue: inventoryQueue.size, priceQueue: priceQueue.size }, 'queue - workers started');

  runWorker(processNextInventory, 'inventory').catch((err) => logger.fatal({ err }, 'inventory - worker crashed'));
  runWorker(processNextPrice, 'price').catch((err) => logger.fatal({ err }, 'price - worker crashed'));
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
  processNextInventory,
  processNextPrice,
  checkScanComplete,
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
