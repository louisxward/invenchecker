"use strict";

const crypto = require("crypto");
const express = require("express");
const router = express.Router();
const { readConfig, writeConfig } = require("../config");
const { fetchInventory } = require("../steam");
const db = require("../db");
const logger = require("../logger");

function getAccount(uid) {
  const accounts = readConfig();
  const account = accounts.find((a) => a.uid === uid);
  return { accounts, account };
}

// GET /accounts
router.get("/", (req, res) => {
  const accounts = readConfig();
  res.json(accounts);
});

// POST /accounts
router.post("/", (req, res) => {
  const { friendlyName, discordId, steam64ids, customItems = [] } = req.body;

  if (!friendlyName || !discordId || !Array.isArray(steam64ids) || steam64ids.length === 0) {
    return res.status(400).json({ error: "friendlyName, discordId, and steam64ids[] are required" });
  }

  const accounts = readConfig();
  if (accounts.find((a) => a.discordId === discordId)) {
    return res.status(409).json({ error: "Account with this discordId already exists" });
  }

  const uid = crypto.randomBytes(8).toString("hex");
  const account = { uid, friendlyName, discordId, steam64ids, customItems };
  accounts.push(account);
  writeConfig(accounts);

  logger.info({ uid, friendlyName, discordId }, "Account added");
  res.status(201).json(account);
});

// POST /accounts/discord — create account via Discord, return uid
// If discordId already exists, returns 409 with the existing uid
router.post("/discord", (req, res) => {
  const { discordId, friendlyName } = req.body;

  if (!discordId) {
    return res.status(400).json({ error: "discordId is required" });
  }

  const accounts = readConfig();
  const existing = accounts.find((a) => a.discordId === discordId);
  if (existing) {
    return res.status(409).json({ error: "Account with this discordId already exists" });
  }

  const uid = crypto.randomBytes(8).toString("hex");
  const account = { uid, friendlyName: friendlyName || null, discordId, steam64ids: [], customItems: [] };
  accounts.push(account);
  writeConfig(accounts);

  logger.info({ uid, discordId }, "Account created via Discord");
  res.status(201).json({ uid });
});

// GET /accounts/:uid
router.get("/:uid", (req, res) => {
  const { account } = getAccount(req.params.uid);
  if (!account) return res.status(404).json({ error: "Account not found" });
  res.json(account);
});

// PUT /accounts/:uid
router.put("/:uid", (req, res) => {
  const { accounts, account } = getAccount(req.params.uid);
  if (!account) return res.status(404).json({ error: "Account not found" });

  const idx = accounts.findIndex((a) => a.uid === req.params.uid);
  if (req.body.friendlyName !== undefined) accounts[idx].friendlyName = req.body.friendlyName;
  if (req.body.discordId !== undefined) accounts[idx].discordId = req.body.discordId;
  if (req.body.steam64ids !== undefined) accounts[idx].steam64ids = req.body.steam64ids;
  if (req.body.customItems !== undefined) accounts[idx].customItems = req.body.customItems;
  writeConfig(accounts);

  res.json(accounts[idx]);
});

// DELETE /accounts/:uid
router.delete("/:uid", (req, res) => {
  const { accounts, account } = getAccount(req.params.uid);
  if (!account) return res.status(404).json({ error: "Account not found" });

  const idx = accounts.findIndex((a) => a.uid === req.params.uid);
  accounts.splice(idx, 1);
  writeConfig(accounts);

  logger.info({ uid: account.uid, friendlyName: account.friendlyName }, "Account deleted");
  res.status(204).send();
});

// POST /accounts/:uid/steam64ids — add a steam64id (no-op if already present)
router.post("/:uid/steam64ids", (req, res) => {
  const { accounts, account } = getAccount(req.params.uid);
  if (!account) return res.status(404).json({ error: "Account not found" });
  const { steam64id } = req.body;
  if (!steam64id) return res.status(400).json({ error: "steam64id is required" });

  const idx = accounts.findIndex(a => a.uid === req.params.uid);
  if (!accounts[idx].steam64ids.includes(steam64id)) {
    accounts[idx].steam64ids.push(steam64id);
    writeConfig(accounts);
  }
  res.json(accounts[idx]);
});

// DELETE /accounts/:uid/steam64ids/:id — remove a steam64id
router.delete("/:uid/steam64ids/:id", (req, res) => {
  const { accounts, account } = getAccount(req.params.uid);
  if (!account) return res.status(404).json({ error: "Account not found" });

  const idx = accounts.findIndex(a => a.uid === req.params.uid);
  const pos = accounts[idx].steam64ids.indexOf(req.params.id);
  if (pos === -1) return res.status(404).json({ error: "steam64id not found on account" });

  accounts[idx].steam64ids.splice(pos, 1);
  writeConfig(accounts);
  res.json(accounts[idx]);
});

// POST /accounts/:uid/customItems — add a custom item (no-op if already present)
router.post("/:uid/customItems", (req, res) => {
  const { accounts, account } = getAccount(req.params.uid);
  if (!account) return res.status(404).json({ error: "Account not found" });
  const { item } = req.body;
  if (!item) return res.status(400).json({ error: "item is required" });

  const idx = accounts.findIndex(a => a.uid === req.params.uid);
  if (!accounts[idx].customItems.includes(item)) {
    accounts[idx].customItems.push(item);
    writeConfig(accounts);
  }
  res.json(accounts[idx]);
});

// DELETE /accounts/:uid/customItems/:item — remove a custom item
router.delete("/:uid/customItems/:item", (req, res) => {
  const { accounts, account } = getAccount(req.params.uid);
  if (!account) return res.status(404).json({ error: "Account not found" });

  const idx = accounts.findIndex(a => a.uid === req.params.uid);
  const item = decodeURIComponent(req.params.item);
  const pos = accounts[idx].customItems.indexOf(item);
  if (pos === -1) return res.status(404).json({ error: "item not found on account" });

  accounts[idx].customItems.splice(pos, 1);
  writeConfig(accounts);
  res.json(accounts[idx]);
});

// GET /accounts/:uid/inventory — live passthrough to Steam, all steam64ids merged
router.get("/:uid/inventory", async (req, res) => {
  const { account } = getAccount(req.params.uid);
  if (!account) return res.status(404).json({ error: "Account not found" });

  try {
    const results = await Promise.all(account.steam64ids.map((id) => fetchInventory(id)));
    const items = results.flat();
    res.json({ uid: account.uid, count: items.length, items });
  } catch (err) {
    logger.error({ err, uid: account.uid }, "Failed to fetch inventory");
    res.status(502).json({ error: err.message });
  }
});

// GET /accounts/:uid/summary — inventory items per steam64id + custom items, each with latest price
router.get("/:uid/summary", (req, res) => {
  const { account } = getAccount(req.params.uid);
  if (!account) return res.status(404).json({ error: "Account not found" });

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
  for (const id of (account.steam64ids || [])) {
    const rows = invQuery.all(id);
    steam64ids[id] = rows.map(r => ({
      market_hash_name: r.market_hash_name,
      first_seen: r.first_seen,
      last_seen: r.last_seen,
      missing: r.missing === 1,
      price: latestPrice.get(r.market_hash_name) ?? null,
    }));
  }

  // Custom items with latest price
  const customItems = (account.customItems || []).map(name => ({
    market_hash_name: name,
    price: latestPrice.get(name) ?? null,
  }));

  res.json({ uid: account.uid, friendlyName: account.friendlyName, steam64ids, customItems });
});

// GET /accounts/:uid/prices
router.get("/:uid/prices", (req, res) => {
  const { account } = getAccount(req.params.uid);
  if (!account) return res.status(404).json({ error: "Account not found" });

  const days = parseInt(req.query.days ?? "7", 10);
  const since = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
  const itemFilter = req.query.item;

  const items = itemFilter ? [itemFilter] : Array.isArray(account.customItems) ? account.customItems : [];

  if (items.length === 0) return res.json({});

  const placeholders = items.map(() => "?").join(", ");
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
      captured_at: s.captured_at
    });
  }

  res.json(grouped);
});

module.exports = router;
