'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const configPath = process.env.CONFIG_PATH || path.join(__dirname, '../data/accounts.json');

function readConfig() {
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      logger.warn({ configPath }, 'accounts.json not found, returning empty list');
      return [];
    }
    throw err;
  }
}

function writeConfig(accounts) {
  const tmpPath = configPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(accounts, null, 2), 'utf8');
  fs.renameSync(tmpPath, configPath);
}

module.exports = { readConfig, writeConfig, configPath };
