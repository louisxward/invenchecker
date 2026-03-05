# invenchecker

Version: 0.0.1

Publisher: ChowIndustries

CS2 inventory price tracker. Monitors Steam inventories for tracked items, records price snapshots every 6 hours, and alerts when a price spikes 15%+ over its 7-day low.

## Quick Start

```bash
# 1. Create required host directory
mkdir -p data

# 2. Start the app
docker compose up --build
```

The app runs on port **3000**.

## Configuration

Accounts are stored in `data/accounts.json`. You can edit this file directly or use the API. The file is mounted as a Docker volume so changes persist across container restarts.

Example:

```json
[
  {
    "uid": "a1b2c3d4e5f6a7b8",
    "friendlyName": "My Account",
    "discordId": "123456789012345678",
    "steam64ids": ["76561198000000000"],
    "customItems": ["AK-47 | Redline (Field-Tested)", "AWP | Dragon Lore (Factory New)"]
  }
]
```

> **Note:** `customItems` values must match the Steam `market_hash_name` exactly (case-sensitive).

## API Endpoints

### Health

| Method | Path      | Description                                                        |
| ------ | --------- | ------------------------------------------------------------------ |
| GET    | `/health` | Returns `{"status":"ok","lastScannedAt":<unix>,"lastScanMs":<ms>}` |

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
| POST   | `/alerts/scan`                   | Run a full scan immediately (synchronous, returns all alerts) |

### Example Requests

```bash
# Add an account
curl -X POST http://localhost:3000/accounts \
  -H "Content-Type: application/json" \
  -d '{"friendlyName":"Main","discordId":"123456789012345678","steam64ids":["76561198000000000"],"customItems":["AK-47 | Redline (Field-Tested)"]}'

# Create account via Discord
curl -X POST http://localhost:3000/accounts/discord \
  -H "Content-Type: application/json" \
  -d '{"discordId":"123456789012345678","friendlyName":"Main"}'

# Add a Steam ID to an existing account
curl -X POST http://localhost:3000/accounts/<uid>/steam64ids \
  -H "Content-Type: application/json" \
  -d '{"steam64id":"76561198000000000"}'

# Add a custom item to track
curl -X POST http://localhost:3000/accounts/<uid>/customItems \
  -H "Content-Type: application/json" \
  -d '{"item":"AK-47 | Redline (Field-Tested)"}'

# Check price history
curl "http://localhost:3000/accounts/<uid>/prices?days=7"

# Check alerts for a user
curl http://localhost:3000/alerts/user/<uid>

# Resolve all alerts for a user
curl -X PUT http://localhost:3000/alerts/user/<uid>/resolve-all

# Trigger a manual scan
curl -X POST http://localhost:3000/alerts/scan
```

## How It Works

1. Every 6 hours (00:00, 06:00, 12:00, 18:00) the scanner runs for all configured accounts.
2. For each account's `customItems`, it fetches the current price from the Steam Community Market.
3. Each price is stored as a snapshot in SQLite.
4. If the current price is >= 15% above the 7-day low, an alert is created and logged at `WARN` level.
5. Alerts are exposed via `GET /alerts` for polling.

## Environment Variables

| Variable      | Default                     | Description                          |
| ------------- | --------------------------- | ------------------------------------ |
| `NODE_ENV`    | `production`                | Set to `development` for pretty logs |
| `PORT`        | `3000`                      | HTTP port                            |
| `LOG_LEVEL`   | `info`                      | Pino log level                       |
| `DB_PATH`     | `/app/data/invenchecker.db` | SQLite file path                     |
| `CONFIG_PATH` | `/app/data/accounts.json`   | Accounts config path                 |

## Local Development (without Docker)

```bash
npm install
mkdir -p data
echo '[]' > data/accounts.json
NODE_ENV=development npm run dev
```
