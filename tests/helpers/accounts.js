'use strict';

// Replaces every account with the given ones (missing fields default like the API's). Call after
// require('../src/database').init().
function setAccounts(list) {
  const accounts = require('../../src/repositories/accounts');
  for (const account of accounts.listAccounts()) accounts.deleteAccount(account.uid);
  for (const a of list) {
    accounts.createAccount({
      uid: a.uid,
      friendlyName: a.friendlyName ?? null,
      discordId: a.discordId ?? null,
      steam64ids: a.steam64ids ?? [],
      customItems: a.customItems ?? [],
    });
  }
}

module.exports = { setAccounts };
