# invenchecker

Version: 0.0.1

Publisher: ChowIndustries

CS2 inventory price tracker. Monitors Steam inventories for tracked items, records price snapshots continuously, and alerts when a price spikes 15%+ over its 7-day low.

## Quick Start

```bash
# 1. Create required host directory
mkdir -p data

# 2. Start the app
docker compose up --build
```

The app runs on port **33001**.

## Configuration

### accounts.json

Accounts are stored in `data/accounts.json`. You can edit this file directly or use the API. The file is mounted as a Docker volume so changes persist across container restarts.

Example:

```json
[
  {
    "uid": "a1b2c3d4e5f6a7b8",
    ?"friendlyName": "My Account",
    ?"discordId": "123456789012345678",
    ?"steam64ids": ["76561198000000000"],
    ?"customItems": ["AK-47 | Redline (Field-Tested)", "AWP | Dragon Lore (Factory New)"]
  }
]
```

> **Note:** `customItems` values must match the Steam `market_hash_name` exactly (case-sensitive).

## API Endpoints

### Health

| Method | Path      | Description                                                        |
| ------ | --------- | ------------------------------------------------------------------ |
| GET    | `/health` | Returns status, last manual scan time, and current queue depths |

### Accounts

| Method | Path                               | Description                                                                   |
| ------ | ---------------------------------- | ----------------------------------------------------------------------------- |
| GET    | `/accounts`                        | List all accounts                                                             |
| POST   | `/accounts`                        | Add an account (`friendlyName`, `discordId`, `steam64ids[]`, `customItems[]`) |
| POST   | `/accounts/discord`                | Create a minimal account via Discord (`discordId`, optional `friendlyName`)   |
| GET    | `/accounts/:uid`                   | Get account by UID                                                            |
| PUT    | `/accounts/:uid`                   | Update account fields                                                         |
| DELETE | `/accounts/:uid`                   | Remove account                                                                |
| POST   | `/accounts/:uid/steam64ids`        | Add a Steam64 ID to account (`steam64id`)                                     |
| DELETE | `/accounts/:uid/steam64ids/:id`    | Remove a Steam64 ID from account                                              |
| POST   | `/accounts/:uid/customItems`       | Add a custom item to account (`item`)                                         |
| DELETE | `/accounts/:uid/customItems/:item` | Remove a custom item from account (URL-encoded)                               |
| GET    | `/accounts/:uid/inventory`         | Fetch live Steam inventory (all steam64ids merged)                            |
| GET    | `/accounts/:uid/summary`           | Inventory items per Steam64 ID + custom items, each with latest price         |
| GET    | `/accounts/:uid/prices`            | Price history (`?item=<name>&days=7`)                                         |

### Alerts & Scanning

| Method | Path                             | Description                                                   |
| ------ | -------------------------------- | ------------------------------------------------------------- |
| GET    | `/alerts`                        | Admin view — all alerts                                       |
| GET    | `/alerts/user/:uid`              | Unresolved alerts for a specific account UID                  |
| PUT    | `/alerts/recipients/:id/resolve` | Resolve a single alert recipient row                          |
| PUT    | `/alerts/user/:uid/resolve-all`  | Resolve all unresolved alerts for a UID                       |
| POST   | `/alerts/scan`                   | Enqueue all accounts for scanning immediately (returns instantly) |

### Example Requests

```bash
# Add an account
curl -X POST http://localhost:33001/accounts \
  -H "Content-Type: application/json" \
  -d '{"friendlyName":"Main","discordId":"123456789012345678","steam64ids":["76561198000000000"],"customItems":["AK-47 | Redline (Field-Tested)"]}'

# Create account via Discord
curl -X POST http://localhost:33001/accounts/discord \
  -H "Content-Type: application/json" \
  -d '{"discordId":"123456789012345678","friendlyName":"Main"}'

# Add a Steam ID to an existing account
curl -X POST http://localhost:33001/accounts/<uid>/steam64ids \
  -H "Content-Type: application/json" \
  -d '{"steam64id":"76561198000000000"}'

# Add a custom item to track
curl -X POST http://localhost:33001/accounts/<uid>/customItems \
  -H "Content-Type: application/json" \
  -d '{"item":"AK-47 | Redline (Field-Tested)"}'

# Check price history
curl "http://localhost:33001/accounts/<uid>/prices?days=7"

# Check alerts for a user
curl http://localhost:33001/alerts/user/<uid>

# Resolve all alerts for a user
curl -X PUT http://localhost:33001/alerts/user/<uid>/resolve-all

# Trigger a manual scan
curl -X POST http://localhost:33001/alerts/scan
```

## How It Works

Two queues run continuously in the background:

- **Inventory queue** — fetches each Steam64 ID's inventory, upserts items to the DB, and feeds found items into the price queue.
- **Price queue** — fetches the current market price for each item (rate-limited to ~1 req/sec), records a snapshot, and creates an alert if the price is ≥ 15% above its 7-day low.

After each item is processed it is automatically re-enqueued to run again **6 hours later**.

When an account is created or updated (new steam64id or custom item added), those items are enqueued immediately — no waiting for the next scheduled run.

Alerts are exposed via `GET /alerts` for polling.

## Environment Variables

| Variable | Default | Required | Description |
|---|---|---|---|
| `PORT` | `33001` | No | Port the server listens on |
| `DB_PATH` | `<DATA_DIR>/invenchecker.db` | No | Path to the SQLite database file |
| `CONFIG_PATH` | `<DATA_DIR>/accounts.json` | No | Path to the accounts config file |
| `LOG_LEVEL` | `info` | No | Logging level |
| `PRICE_RATE_LIMIT_MS` | `1100` | No | Minimum milliseconds between price API requests |
| `SPIKE_THRESHOLD` | `1.15` | No | Price spike multiplier threshold (e.g. 1.15 = 15% increase) |
| `SEVEN_DAYS_SECS` | `604800` | No | Duration in seconds representing 7 days |
| `REENQUEUE_DELAY_MS` | `21600000` | No | Milliseconds between re-scans of each item (default 6 hours) |
| `WORKER_IDLE_SLEEP_MS` | `500` | No | Milliseconds workers sleep when their queue is empty |
| `STEAM_APP_ID` | `730` | No | Steam App ID to check inventory for (730 = CS2) |


## Local Development (without Docker)

```bash
npm install
mkdir -p data
echo '[]' > data/accounts.json
NODE_ENV=development npm run dev
```
