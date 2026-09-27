'use strict';

const logger = require('../logger');
const { getDb } = require('../database');

// Accounts come back as { uid, friendlyName, discordId, steam64ids, customItems }, in the order they
// were created, with each list in the order it was stored (repeats included).

const LIST_TABLES = {
  steam64ids: { table: 'account_steam64ids', column: 'steam64id' },
  customItems: { table: 'account_custom_items', column: 'item' },
};

function listFor(key, uid) {
  const { table, column } = LIST_TABLES[key];
  return getDb()
    .prepare(`SELECT ${column} AS value FROM ${table} WHERE uid = ? ORDER BY position`)
    .all(uid)
    .map((r) => r.value);
}

function toAccount(row) {
  return {
    uid: row.uid,
    friendlyName: row.friendly_name,
    discordId: row.discord_id,
    steam64ids: listFor('steam64ids', row.uid),
    customItems: listFor('customItems', row.uid),
  };
}

function replaceList(key, uid, values) {
  const { table, column } = LIST_TABLES[key];
  const db = getDb();
  db.prepare(`DELETE FROM ${table} WHERE uid = ?`).run(uid);
  const insert = db.prepare(`INSERT INTO ${table} (uid, position, ${column}) VALUES (?, ?, ?)`);
  values.forEach((value, i) => insert.run(uid, i, value));
}

function appendToList(key, uid, value) {
  const { table, column } = LIST_TABLES[key];
  getDb()
    .prepare(
      `INSERT INTO ${table} (uid, position, ${column})
       VALUES (?, (SELECT COALESCE(MAX(position), -1) + 1 FROM ${table} WHERE uid = ?), ?)`
    )
    .run(uid, uid, value);
}

// Removes the first occurrence; returns whether there was one
function removeFromList(key, uid, value) {
  const { table, column } = LIST_TABLES[key];
  return (
    getDb()
      .prepare(
        `DELETE FROM ${table} WHERE rowid =
           (SELECT rowid FROM ${table} WHERE uid = ? AND ${column} = ? ORDER BY position LIMIT 1)`
      )
      .run(uid, value).changes > 0
  );
}

function listAccounts() {
  logger.debug('repository - listAccounts');
  return getDb().prepare('SELECT uid, friendly_name, discord_id FROM accounts ORDER BY rowid').all().map(toAccount);
}

// undefined if there is no such account
function getAccount(uid) {
  logger.debug('repository - getAccount');
  const row = getDb().prepare('SELECT uid, friendly_name, discord_id FROM accounts WHERE uid = ?').get(uid);
  return row && toAccount(row);
}

function isDiscordIdTaken(discordId, exceptUid = null) {
  logger.debug('repository - isDiscordIdTaken');
  return !!getDb()
    .prepare('SELECT 1 FROM accounts WHERE discord_id = ? AND uid IS NOT ? LIMIT 1')
    .get(discordId, exceptUid);
}

function createAccount({ uid, friendlyName, discordId, steam64ids, customItems }) {
  logger.debug('repository - createAccount');
  const db = getDb();
  db.transaction(() => {
    db.prepare('INSERT INTO accounts (uid, friendly_name, discord_id) VALUES (?, ?, ?)').run(
      uid,
      friendlyName,
      discordId
    );
    replaceList('steam64ids', uid, steam64ids);
    replaceList('customItems', uid, customItems);
  })();
}

// Fields left undefined are unchanged; lists are replaced as a whole
function updateAccount(uid, { friendlyName, discordId, steam64ids, customItems }) {
  logger.debug('repository - updateAccount');
  const db = getDb();
  db.transaction(() => {
    if (friendlyName !== undefined)
      db.prepare('UPDATE accounts SET friendly_name = ? WHERE uid = ?').run(friendlyName, uid);
    if (discordId !== undefined) db.prepare('UPDATE accounts SET discord_id = ? WHERE uid = ?').run(discordId, uid);
    if (steam64ids !== undefined) replaceList('steam64ids', uid, steam64ids);
    if (customItems !== undefined) replaceList('customItems', uid, customItems);
  })();
}

// The account's lists go with it (ON DELETE CASCADE)
function deleteAccount(uid) {
  logger.debug('repository - deleteAccount');
  getDb().prepare('DELETE FROM accounts WHERE uid = ?').run(uid);
}

function addSteam64id(uid, steam64id) {
  logger.debug('repository - addSteam64id');
  appendToList('steam64ids', uid, steam64id);
}

function removeSteam64id(uid, steam64id) {
  logger.debug('repository - removeSteam64id');
  return removeFromList('steam64ids', uid, steam64id);
}

function addCustomItem(uid, item) {
  logger.debug('repository - addCustomItem');
  appendToList('customItems', uid, item);
}

function removeCustomItem(uid, item) {
  logger.debug('repository - removeCustomItem');
  return removeFromList('customItems', uid, item);
}

// Whether any account lists the steam64id
function isSteam64idTracked(steam64id) {
  logger.debug('repository - isSteam64idTracked');
  return !!getDb().prepare('SELECT 1 FROM account_steam64ids WHERE steam64id = ? LIMIT 1').get(steam64id);
}

// Whether any account lists the item as a custom item
function isCustomItemTracked(item) {
  logger.debug('repository - isCustomItemTracked');
  return !!getDb().prepare('SELECT 1 FROM account_custom_items WHERE item = ? LIMIT 1').get(item);
}

module.exports = {
  listAccounts,
  getAccount,
  isDiscordIdTaken,
  createAccount,
  updateAccount,
  deleteAccount,
  addSteam64id,
  removeSteam64id,
  addCustomItem,
  removeCustomItem,
  isSteam64idTracked,
  isCustomItemTracked,
};
