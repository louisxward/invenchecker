'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { MAX_STEAM64IDS, MAX_CUSTOM_ITEMS, REENQUEUE_DELAY_MS } = require('../config');
const logger = require('../logger');
const accounts = require('../repositories/accounts');
const badEntries = require('../repositories/badEntries');
const inventoryFetches = require('../repositories/inventoryFetches');
const inventoryItems = require('../repositories/inventoryItems');
const priceSnapshots = require('../repositories/priceSnapshots');
const { enqueueInventoryIfDue, enqueuePrice, isInventoryQueued, isPriceQueued, getQueueState } = require('../queue');
const { getRuleForPrice } = require('../rules');
const { fetchInventory } = require('../steam');

const router = express.Router();

// Express 5 leaves req.body undefined when there is no JSON body; handlers expect an object
router.use((req, _res, next) => {
  req.body ??= {};
  next();
});

function isValidSteam64id(id) {
  return typeof id === 'string' && /^7656119\d{10}$/.test(id);
}

function isStringList(value) {
  return Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0);
}

// Checks the lists a request sets; undefined means the request leaves that list alone.
// Returns the error message for the first problem found, or null.
function validateLists(steam64ids, customItems) {
  if (steam64ids !== undefined) {
    if (!Array.isArray(steam64ids)) return 'steam64ids must be an array';
    if (steam64ids.length > MAX_STEAM64IDS) return `Too many steam64ids (max ${MAX_STEAM64IDS})`;
    const invalidId = steam64ids.find((id) => !isValidSteam64id(id));
    if (invalidId) return `Invalid steam64id: ${invalidId}`;
  }
  if (customItems !== undefined) {
    if (!isStringList(customItems)) return 'customItems must be an array of item names';
    if (customItems.length > MAX_CUSTOM_ITEMS) return `Too many customItems (max ${MAX_CUSTOM_ITEMS})`;
  }
  for (const id of steam64ids ?? []) {
    const reason = badEntries.getBadReason('steam64id', id);
    if (reason) return `steam64id ${id} was previously rejected: ${reason}`;
  }
  for (const item of customItems ?? []) {
    const reason = badEntries.getBadReason('item', item);
    if (reason) return `item "${item}" was previously rejected: ${reason}`;
  }
  return null;
}

// GET /accounts
router.get('/', (req, res) => {
  res.json(accounts.listAccounts());
});

// POST /accounts
router.post('/', (req, res) => {
  const { friendlyName, discordId, steam64ids, customItems = [] } = req.body;

  if (!friendlyName || !discordId || !Array.isArray(steam64ids) || steam64ids.length === 0) {
    return res.status(400).json({ error: 'friendlyName, discordId, and steam64ids[] are required' });
  }
  if (typeof friendlyName !== 'string' || typeof discordId !== 'string') {
    return res.status(400).json({ error: 'friendlyName and discordId must be strings' });
  }
  const listError = validateLists(steam64ids, customItems);
  if (listError) return res.status(400).json({ error: listError });

  if (accounts.isDiscordIdTaken(discordId)) {
    return res.status(409).json({ error: 'Account with this discordId already exists' });
  }

  const uid = crypto.randomBytes(8).toString('hex');
  const account = { uid, friendlyName, discordId, steam64ids, customItems };
  accounts.createAccount(account);

  for (const id of steam64ids) enqueueInventoryIfDue(id);
  for (const item of customItems) enqueuePrice(item);

  logger.info({ uid, friendlyName, discordId }, 'accounts - added');
  res.status(201).json(account);
});

// POST /accounts/discord — create account via Discord, return uid
// If discordId already exists, returns 409
router.post('/discord', (req, res) => {
  const { discordId, friendlyName } = req.body;

  if (!discordId) {
    return res.status(400).json({ error: 'discordId is required' });
  }
  if (typeof discordId !== 'string' || (friendlyName && typeof friendlyName !== 'string')) {
    return res.status(400).json({ error: 'friendlyName and discordId must be strings' });
  }

  if (accounts.isDiscordIdTaken(discordId)) {
    return res.status(409).json({ error: 'Account with this discordId already exists' });
  }

  const uid = crypto.randomBytes(8).toString('hex');
  accounts.createAccount({ uid, friendlyName: friendlyName || null, discordId, steam64ids: [], customItems: [] });

  logger.info({ uid, discordId }, 'accounts - created via Discord');
  res.status(201).json({ uid });
});

// GET /accounts/:uid
router.get('/:uid', (req, res) => {
  const account = accounts.getAccount(req.params.uid);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  res.json(account);
});

// PUT /accounts/:uid
router.put('/:uid', (req, res) => {
  const { uid } = req.params;
  if (!accounts.getAccount(uid)) return res.status(404).json({ error: 'Account not found' });

  const { friendlyName, discordId, steam64ids, customItems } = req.body;
  if (friendlyName !== undefined && friendlyName !== null && typeof friendlyName !== 'string') {
    return res.status(400).json({ error: 'friendlyName must be a string' });
  }
  if (discordId !== undefined && (typeof discordId !== 'string' || !discordId)) {
    return res.status(400).json({ error: 'discordId must be a non-empty string' });
  }
  const listError = validateLists(steam64ids, customItems);
  if (listError) return res.status(400).json({ error: listError });
  if (discordId !== undefined && accounts.isDiscordIdTaken(discordId, uid)) {
    return res.status(409).json({ error: 'Account with this discordId already exists' });
  }

  accounts.updateAccount(uid, { friendlyName, discordId, steam64ids, customItems });

  for (const id of steam64ids ?? []) enqueueInventoryIfDue(id);
  for (const item of customItems ?? []) enqueuePrice(item);

  res.json(accounts.getAccount(uid));
});

// DELETE /accounts/:uid
router.delete('/:uid', (req, res) => {
  const account = accounts.getAccount(req.params.uid);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  accounts.deleteAccount(account.uid);

  logger.info({ uid: account.uid, friendlyName: account.friendlyName }, 'accounts - deleted');
  res.status(204).send();
});

// POST /accounts/:uid/steam64ids — add a steam64id (no-op if already present)
router.post('/:uid/steam64ids', (req, res) => {
  const account = accounts.getAccount(req.params.uid);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  const { steam64id } = req.body;
  if (!steam64id) return res.status(400).json({ error: 'steam64id is required' });
  if (!isValidSteam64id(steam64id)) return res.status(400).json({ error: `Invalid steam64id: ${steam64id}` });
  const badIdReason = badEntries.getBadReason('steam64id', steam64id);
  if (badIdReason)
    return res.status(400).json({ error: `steam64id ${steam64id} was previously rejected: ${badIdReason}` });

  if (!account.steam64ids.includes(steam64id)) {
    if (account.steam64ids.length >= MAX_STEAM64IDS) {
      return res.status(400).json({ error: `Too many steam64ids (max ${MAX_STEAM64IDS})` });
    }
    accounts.addSteam64id(account.uid, steam64id);
  }
  enqueueInventoryIfDue(steam64id);
  res.json(accounts.getAccount(account.uid));
});

// DELETE /accounts/:uid/steam64ids/:id — remove a steam64id
router.delete('/:uid/steam64ids/:id', (req, res) => {
  const account = accounts.getAccount(req.params.uid);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  if (!accounts.removeSteam64id(account.uid, req.params.id)) {
    return res.status(404).json({ error: 'steam64id not found on account' });
  }
  res.json(accounts.getAccount(account.uid));
});

// POST /accounts/:uid/customItems — add a custom item (no-op if already present)
router.post('/:uid/customItems', (req, res) => {
  const account = accounts.getAccount(req.params.uid);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  const { item } = req.body;
  if (typeof item !== 'string' || !item) return res.status(400).json({ error: 'item is required' });
  const badItemReason = badEntries.getBadReason('item', item);
  if (badItemReason) return res.status(400).json({ error: `item "${item}" was previously rejected: ${badItemReason}` });

  if (!account.customItems.includes(item)) {
    if (account.customItems.length >= MAX_CUSTOM_ITEMS) {
      return res.status(400).json({ error: `Too many customItems (max ${MAX_CUSTOM_ITEMS})` });
    }
    accounts.addCustomItem(account.uid, item);
  }
  enqueuePrice(item);
  res.json(accounts.getAccount(account.uid));
});

// DELETE /accounts/:uid/customItems/:item — remove a custom item
router.delete('/:uid/customItems/:item', (req, res) => {
  const account = accounts.getAccount(req.params.uid);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  // Express has already decoded the param; decoding again breaks names containing '%'
  if (!accounts.removeCustomItem(account.uid, req.params.item)) {
    return res.status(404).json({ error: 'item not found on account' });
  }
  res.json(accounts.getAccount(account.uid));
});

// GET /accounts/:uid/inventory — live passthrough to Steam, all steam64ids merged
router.get('/:uid/inventory', async (req, res) => {
  const account = accounts.getAccount(req.params.uid);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  try {
    const results = await Promise.all(account.steam64ids.map((id) => fetchInventory(id)));
    const items = results.flat();
    res.json({ uid: account.uid, count: items.length, items });
  } catch (err) {
    logger.error({ err, uid: account.uid }, 'accounts - failed to fetch live inventory');
    res.status(502).json({ error: err.message });
  }
});

// GET /accounts/:uid/summary — inventory items per steam64id + custom items, each with latest price
router.get('/:uid/summary', (req, res) => {
  const account = accounts.getAccount(req.params.uid);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  // Inventory items per steam64id
  const steam64ids = {};
  for (const id of account.steam64ids) {
    const rows = inventoryItems.listForSteam64id(id);
    steam64ids[id] = rows.map((r) => ({
      market_hash_name: r.market_hash_name,
      first_seen: r.first_seen,
      last_seen: r.last_seen,
      missing: r.missing === 1,
      price: priceSnapshots.getLatestSnapshot(r.market_hash_name) ?? null,
    }));
  }

  // Custom items with latest price
  const customItems = account.customItems.map((name) => ({
    market_hash_name: name,
    price: priceSnapshots.getLatestSnapshot(name) ?? null,
  }));

  res.json({ uid: account.uid, friendlyName: account.friendlyName, steam64ids, customItems });
});

// GET /accounts/:uid/progress — scan state per steam64id and custom item
router.get('/:uid/progress', (req, res) => {
  const account = accounts.getAccount(req.params.uid);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const reenqueueDelaySecs = Math.floor(REENQUEUE_DELAY_MS / 1000);

  const steam64ids = {};
  for (const id of account.steam64ids) {
    const queued = isInventoryQueued(id);
    const lastFetch = inventoryFetches.getLastFetch(id) ?? null;
    steam64ids[id] = {
      queued,
      lastFetch,
      nextScanAt: !queued && lastFetch ? lastFetch.fetched_at + reenqueueDelaySecs : null,
    };
  }

  const customItems = {};
  for (const name of account.customItems) {
    const queued = isPriceQueued(name);
    const latest = priceSnapshots.getLatestSnapshot(name);
    const lastPrice = latest ? { lowest_price: latest.lowest_price, captured_at: latest.captured_at } : null;
    customItems[name] = {
      queued,
      lastPrice,
      // Price scans repeat on the interval of the rule for the last price, as the price worker does
      nextScanAt:
        !queued && lastPrice
          ? lastPrice.captured_at + Math.floor(getRuleForPrice(lastPrice.lowest_price).scanMs / 1000)
          : null,
    };
  }

  const { inventoryQueueSize, priceQueueSize } = getQueueState();
  res.json({ uid: account.uid, inventoryQueueSize, priceQueueSize, steam64ids, customItems });
});

// GET /accounts/:uid/prices
router.get('/:uid/prices', (req, res) => {
  const account = accounts.getAccount(req.params.uid);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const days = parseInt(req.query.days ?? '7', 10);
  const since = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
  const itemFilter = req.query.item;

  const items = itemFilter ? [itemFilter] : account.customItems;

  if (items.length === 0) return res.json({});

  const snapshots = priceSnapshots.listSnapshotsSince(items, since);

  const grouped = {};
  for (const s of snapshots) {
    if (!grouped[s.market_hash_name]) grouped[s.market_hash_name] = [];
    grouped[s.market_hash_name].push({
      lowest_price: s.lowest_price,
      median_price: s.median_price,
      volume: s.volume,
      captured_at: s.captured_at,
    });
  }

  res.json(grouped);
});

module.exports = router;
