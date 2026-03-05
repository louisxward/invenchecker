"use strict";

const INVENTORY_URL_1 = "https://steamcommunity.com/inventory";
const INVENTORY_URL_2 = "2?l=english&count=2";
const PRICE_URL = "https://steamcommunity.com/market/priceoverview";
const APP_ID = 730;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePrice(str) {
  if (!str) return null;
  const cleaned = str.replace(/[^0-9.]/g, "");
  const val = parseFloat(cleaned);
  return isNaN(val) ? null : val;
}

function buildHeaders() {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9"
  };

  // Steam session cookies — required for inventory access.
  // Get these from your browser's devtools after logging into steamcommunity.com.
  // const sessionId = process.env.STEAM_SESSION_ID;
  // const loginSecure = process.env.STEAM_LOGIN_SECURE;

  // if (sessionId && loginSecure) {
  //   headers["Cookie"] = `sessionid=${sessionId}; steamLoginSecure=${loginSecure}`;
  // }

  return headers;
}

async function fetchInventory(steam64id) {
  const url = `${INVENTORY_URL_1}/${steam64id}/${APP_ID}/${INVENTORY_URL_2}`;
  const headers = buildHeaders();
  headers["Referer"] = `https://steamcommunity.com/profiles/${steam64id}/inventory/`;

  const res = await fetch(url, { headers });

  if (res.status === 400 || res.status === 403) {
    throw new Error(`Cannot access inventory for ${steam64id}`);
  }
  if (res.status === 429) {
    throw new Error(`Rate limited fetching inventory for ${steam64id}`);
  }
  if (!res.ok) {
    throw new Error(`Failed to fetch inventory for ${steam64id}: HTTP ${res.status}`);
  }

  const data = await res.json();

  if (!data.success) {
    throw new Error(`Steam returned success=false for inventory ${steam64id}`);
  }

  return data.descriptions || [];
}

async function fetchPrice(marketHashName) {
  const url = `${PRICE_URL}/?appid=${APP_ID}&currency=1&market_hash_name=${encodeURIComponent(marketHashName)}`;
  const res = await fetch(url, { headers: buildHeaders() });

  if (res.status === 429) {
    throw new Error(`Rate limited fetching price for "${marketHashName}"`);
  }
  if (!res.ok) {
    throw new Error(`Failed to fetch price for "${marketHashName}": HTTP ${res.status}`);
  }

  const data = await res.json();

  if (!data.success) {
    return null;
  }

  return {
    lowest_price: parsePrice(data.lowest_price),
    median_price: parsePrice(data.median_price),
    volume: data.volume ? parseInt(data.volume.replace(/,/g, ""), 10) : null
  };
}

module.exports = { fetchInventory, fetchPrice, sleep };
