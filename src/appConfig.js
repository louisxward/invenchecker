"use strict";

const path = require("path");

const DATA_DIR = path.join(__dirname, "../data");

module.exports = {
  PORT: process.env.PORT ? Number(process.env.PORT) : 33001,
  DB_PATH: process.env.DB_PATH || path.join(DATA_DIR, "invenchecker.db"),
  ACCOUNTS_PATH: process.env.CONFIG_PATH || path.join(DATA_DIR, "accounts.json"),
  LOG_LEVEL: process.env.LOG_LEVEL || "info",
  PRICE_RATE_LIMIT_MS: process.env.PRICE_RATE_LIMIT_MS ? Number(process.env.PRICE_RATE_LIMIT_MS) : 1100,
  INVENTORY_RATE_LIMIT_MS: process.env.INVENTORY_RATE_LIMIT_MS ? Number(process.env.INVENTORY_RATE_LIMIT_MS) : 3000,
  RULES_PATH: process.env.RULES_PATH || path.join(DATA_DIR, "rules.json"),
  SEVEN_DAYS_SECS: process.env.SEVEN_DAYS_SECS ? Number(process.env.SEVEN_DAYS_SECS) : 7 * 24 * 60 * 60,
  QUEUE_WARN_SIZE: process.env.QUEUE_WARN_SIZE ? Number(process.env.QUEUE_WARN_SIZE) : 50,
  WORKER_IDLE_SLEEP_MS: process.env.WORKER_IDLE_SLEEP_MS ? Number(process.env.WORKER_IDLE_SLEEP_MS) : 500,
  REENQUEUE_DELAY_MS: process.env.REENQUEUE_DELAY_MS ? Number(process.env.REENQUEUE_DELAY_MS) : 6 * 60 * 60 * 1000,
  RATE_LIMIT_RETRY_MS: process.env.RATE_LIMIT_RETRY_MS ? Number(process.env.RATE_LIMIT_RETRY_MS) : 60 * 1000,
  MAX_STEAM64IDS: process.env.MAX_STEAM64IDS ? Number(process.env.MAX_STEAM64IDS) : 10,
  MAX_CUSTOM_ITEMS: process.env.MAX_CUSTOM_ITEMS ? Number(process.env.MAX_CUSTOM_ITEMS) : 50,
  STEAM_APP_ID: process.env.STEAM_APP_ID ? Number(process.env.STEAM_APP_ID) : 730,
  STEAM_INVENTORY_URL: "https://steamcommunity.com/inventory",
  STEAM_PRICE_URL: "https://steamcommunity.com/market/priceoverview"
};
