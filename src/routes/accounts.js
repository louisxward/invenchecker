'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { MAX_STEAM64IDS, MAX_CUSTOM_ITEMS, REENQUEUE_DELAY_MS } = require('../config');
const logger = require('../logger');
const { readAccounts, writeAccounts } = require('../accountStore');
const db = require('../db');
const { enqueueInventoryIfDue, enqueuePrice, isInventoryQueued, isPriceQueued, getQueueState } = require('../queue');
const { getRuleForPrice } = require('../rules');
const { fetchInventory } = require('../steam');

const router = express.Router();

// Express 5 leaves req.body undefined when there is no JSON body; handlers expect an object
router.use((req, _res, next) => {
  req.body ??= {};
  next();
});

function getAccount(uid) {
  const accounts = readAccounts();
  const account = accounts.find((a) => a.uid === uid);
  // Both lists are optional in a hand-edited accounts.json
  if (account) {
    account.steam64ids ??= [];
    account.customItems ??= [];
  }
  return { accounts, account };
}

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
    const reason = db.getBadReason('steam64id', id);
    if (reason) return `steam64id ${id} was previously rejected: ${reason}`;
  }
  for (const item of customItems ?? []) {
    const reason = db.getBadReason('item', item);
    if (reason) return `item "${item}" was previously rejected: ${reason}`;
  }
  return null;
}

// GET /accounts
router.get('/', (req, res) => {
  const accounts = readAccounts();
  res.json(accounts);
});

// POST /accounts
router.post('/', (req, res) => {
  const { friendlyName, discordId, steam64ids, customItems = [] } = req.body;

  if (!friendlyName || !discordId || !Array.isArray(steam64ids) || steam64ids.length === 0) {
    return res.status(400).json({ error: 'friendlyName, discordId, and steam64ids[] are required' });
  }
  const listError = validateLists(steam64ids, customItems);
  if (listError) return res.status(400).json({ error: listError });

  const accounts = readAccounts();
  if (accounts.find((a) => a.discordId === discordId)) {
    return res.status(409).json({ error: 'Account with this discordId already exists' });
  }

  const uid = crypto.randomBytes(8).toString('hex');
  const account = { uid, friendlyName, discordId, steam64ids, customItems };
  accounts.push(account);
  writeAccounts(accounts);

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

  const accounts = readAccounts();
  const existing = accounts.find((a) => a.discordId === discordId);
  if (existing) {
    return res.status(409).json({ error: 'Account with this discordId already exists' });
  }

  const uid = crypto.randomBytes(8).toString('hex');
  const account = { uid, friendlyName: friendlyName || null, discordId, steam64ids: [], customItems: [] };
  accounts.push(account);
  writeAccounts(accounts);

  logger.info({ uid, discordId }, 'accounts - created via Discord');
  res.status(201).json({ uid });
});

// GET /accounts/:uid
router.get('/:uid', (req, res) => {
  const { account } = getAccount(req.params.uid);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  res.json(account);
});

// PUT /accounts/:uid
router.put('/:uid', (req, res) => {
  const { accounts, account } = getAccount(req.params.uid);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const { friendlyName, discordId, steam64ids, customItems } = req.body;
  const listError = validateLists(steam64ids, customItems);
  if (listError) return res.status(400).json({ error: listError });
  if (discordId !== undefined && accounts.some((a) => a.uid !== account.uid && a.discordId === discordId)) {
    return res.status(409).json({ error: 'Account with this discordId already exists' });
  }

  if (friendlyName !== undefined) account.friendlyName = friendlyName;
  if (discordId !== undefined) account.discordId = discordId;
  if (steam64ids !== undefined) account.steam64ids = steam64ids;
  if (customItems !== undefined) account.customItems = customItems;
  writeAccounts(accounts);

  for (const id of steam64ids ?? []) enqueueInventoryIfDue(id);
  for (const item of customItems ?? []) enqueuePrice(item);

  res.json(account);
});

// DELETE /accounts/:uid
router.delete('/:uid', (req, res) => {
  const { accounts, account } = getAccount(req.params.uid);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const idx = accounts.findIndex((a) => a.uid === req.params.uid);
  accounts.splice(idx, 1);
  writeAccounts(accounts);

  logger.info({ uid: account.uid, friendlyName: account.friendlyName }, 'accounts - deleted');
  res.status(204).send();
});

// POST /accounts/:uid/steam64ids — add a steam64id (no-op if already present)
router.post('/:uid/steam64ids', (req, res) => {
  const { accounts, account } = getAccount(req.params.uid);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  const { steam64id } = req.body;
  if (!steam64id) return res.status(400).json({ error: 'steam64id is required' });
  if (!isValidSteam64id(steam64id)) return res.status(400).json({ error: `Invalid steam64id: ${steam64id}` });
  const badIdReason = db.getBadReason('steam64id', steam64id);
  if (badIdReason)
    return res.status(400).json({ error: `steam64id ${steam64id} was previously rejected: ${badIdReason}` });

  if (!account.steam64ids.includes(steam64id)) {
    if (account.steam64ids.length >= MAX_STEAM64IDS) {
      return res.status(400).json({ error: `Too many steam64ids (max ${MAX_STEAM64IDS})` });
    }
    account.steam64ids.push(steam64id);
    writeAccounts(accounts);
  }
  enqueueInventoryIfDue(steam64id);
  res.json(account);
});

// DELETE /accounts/:uid/steam64ids/:id — remove a steam64id
router.delete('/:uid/steam64ids/:id', (req, res) => {
  const { accounts, account } = getAccount(req.params.uid);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const pos = account.steam64ids.indexOf(req.params.id);
  if (pos === -1) return res.status(404).json({ error: 'steam64id not found on account' });

  account.steam64ids.splice(pos, 1);
  writeAccounts(accounts);
  res.json(account);
});

// POST /accounts/:uid/customItems — add a custom item (no-op if already present)
router.post('/:uid/customItems', (req, res) => {
  const { accounts, account } = getAccount(req.params.uid);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  const { item } = req.body;
  if (typeof item !== 'string' || !item) return res.status(400).json({ error: 'item is required' });
  const badItemReason = db.getBadReason('item', item);
  if (badItemReason) return res.status(400).json({ error: `item "${item}" was previously rejected: ${badItemReason}` });

  if (!account.customItems.includes(item)) {
    if (account.customItems.length >= MAX_CUSTOM_ITEMS) {
      return res.status(400).json({ error: `Too many customItems (max ${MAX_CUSTOM_ITEMS})` });
    }
    account.customItems.push(item);
    writeAccounts(accounts);
  }
  enqueuePrice(item);
  res.json(account);
});

// DELETE /accounts/:uid/customItems/:item — remove a custom item
router.delete('/:uid/customItems/:item', (req, res) => {
  const { accounts, account } = getAccount(req.params.uid);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  // Express has already decoded the param; decoding again breaks names containing '%'
  const { item } = req.params;
  const pos = account.customItems.indexOf(item);
  if (pos === -1) return res.status(404).json({ error: 'item not found on account' });

  account.customItems.splice(pos, 1);
  writeAccounts(accounts);
  res.json(account);
});

// GET /accounts/:uid/inventory — live passthrough to Steam, all steam64ids merged
router.get('/:uid/inventory', async (req, res) => {
  const { account } = getAccount(req.params.uid);
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
  const { account } = getAccount(req.params.uid);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const latestPrice = db.prepare(`
    SELECT ps.lowest_price, ps.median_price, ps.volume, ps.captured_at
    FROM price_snapshots ps
    WHERE ps.item_id = (SELECT id FROM item_names WHERE name = ?)
    ORDER BY ps.captured_at DESC
    LIMIT 1
  `);

  // Inventory items per steam64id
  const invQuery = db.prepare(`
    SELECT n.name AS market_hash_name, ii.first_seen, ii.last_seen, ii.missing
    FROM inventory_items ii
    JOIN item_names n ON n.id = ii.item_id
    WHERE ii.steam64id = ?
    ORDER BY n.name
  `);

  const steam64ids = {};
  for (const id of account.steam64ids || []) {
    const rows = invQuery.all(id);
    steam64ids[id] = rows.map((r) => ({
      market_hash_name: r.market_hash_name,
      first_seen: r.first_seen,
      last_seen: r.last_seen,
      missing: r.missing === 1,
      price: latestPrice.get(r.market_hash_name) ?? null,
    }));
  }

  // Custom items with latest price
  const customItems = (account.customItems || []).map((name) => ({
    market_hash_name: name,
    price: latestPrice.get(name) ?? null,
  }));

  res.json({ uid: account.uid, friendlyName: account.friendlyName, steam64ids, customItems });
});

// GET /accounts/:uid/progress — scan state per steam64id and custom item
router.get('/:uid/progress', (req, res) => {
  const { account } = getAccount(req.params.uid);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const reenqueueDelaySecs = Math.floor(REENQUEUE_DELAY_MS / 1000);

  const lastFetchStmt = db.prepare(`
    SELECT item_count, duration_ms, fetched_at
    FROM inventory_fetches
    WHERE steam64id = ?
    ORDER BY fetched_at DESC
    LIMIT 1
  `);

  const steam64ids = {};
  for (const id of account.steam64ids || []) {
    const queued = isInventoryQueued(id);
    const lastFetch = lastFetchStmt.get(id) ?? null;
    steam64ids[id] = {
      queued,
      lastFetch,
      nextScanAt: !queued && lastFetch ? lastFetch.fetched_at + reenqueueDelaySecs : null,
    };
  }

  const lastPriceStmt = db.prepare(`
    SELECT ps.lowest_price, ps.captured_at
    FROM price_snapshots ps
    WHERE ps.item_id = (SELECT id FROM item_names WHERE name = ?)
    ORDER BY ps.captured_at DESC
    LIMIT 1
  `);

  const customItems = {};
  for (const name of account.customItems || []) {
    const queued = isPriceQueued(name);
    const lastPrice = lastPriceStmt.get(name) ?? null;
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
  const { account } = getAccount(req.params.uid);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const days = parseInt(req.query.days ?? '7', 10);
  const since = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
  const itemFilter = req.query.item;

  const items = itemFilter ? [itemFilter] : Array.isArray(account.customItems) ? account.customItems : [];

  if (items.length === 0) return res.json({});

  const placeholders = items.map(() => '?').join(', ');
  const snapshots = db
    .prepare(
      `
    SELECT n.name AS market_hash_name, ps.lowest_price, ps.median_price, ps.volume, ps.captured_at
    FROM price_snapshots ps
    JOIN item_names n ON n.id = ps.item_id
    WHERE ps.item_id IN (SELECT id FROM item_names WHERE name IN (${placeholders})) AND ps.captured_at >= ?
    ORDER BY n.name, ps.captured_at DESC
  `
    )
    .all(...items, since);

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
