'use strict';

const fs = require('node:fs');
const { ACCOUNTS_PATH: accountsPath } = require('./config');
const logger = require('./logger');

function readAccounts() {
  try {
    const raw = fs.readFileSync(accountsPath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      logger.warn({ accountsPath }, 'accounts - accounts.json not found, returning empty list');
      return [];
    }
    throw err;
  }
}

// Written to a temp file and renamed, so a crash mid-write can't leave a truncated accounts.json
function writeAccounts(accounts) {
  const tmpPath = accountsPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(accounts, null, 2), 'utf8');
  fs.renameSync(tmpPath, accountsPath);
}

module.exports = { readAccounts, writeAccounts, accountsPath };
