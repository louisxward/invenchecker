# CLAUDE.md

CS2 inventory price tracker (Node 24, CommonJS, Express 5, better-sqlite3). It watches Steam inventories and custom item lists, records price snapshots continuously, and creates alerts when a price spikes over its 7-day low. It has no UI: **chowbot** (`~/code/chowbot`, `src/services/invencheckerService.js`) is the only client, calling this API over the shared `invenchecker` Docker network and DMing the alerts. The user-facing docs are in [README.md](README.md), with the API spec in [openapi.yaml](openapi.yaml). Keep the endpoint and env tables there in sync when you change behaviour, and check chowbot's client when you change a response.

## Commands

```bash
npm install
npm run dev                  # NODE_ENV=development (pino-pretty), node --watch
npm test                     # jest
npm run lint                 # eslint (flat config in eslint.config.js, core rules only)
npx prettier@3 --check .     # formatting (.prettierrc: single quotes, 120 cols, es5 commas)
npx jest tests/scanner.test.js   # a single test file
docker compose up --build    # needs the external `invenchecker` network and /opt/data/invenchecker
```

Every env var has a default (see `.env.example` and `src/config.js`). Docker loads an optional `.env`; `npm run dev` doesn't.

## Layout

```
src/
  index.js         startup (process handlers, database, queues, API), graceful shutdown
  app.js           Express app (createApp) with the global error handler
  config.js        env vars and file paths
  logger.js        pino, LOG_LEVEL; pino-pretty when NODE_ENV=development
  database/        index.js (init, getDb, close), migrations.js (migrate, run in one transaction by init)
  repositories/    one file per table, all SQL lives here
  rules.js         price-tier rules from rules.json (cached; changes need a restart)
  steam.js         Steam inventory + priceoverview clients (10s timeout), isNetworkError, isServerError
  scanner.js       processes one inventory or one price: snapshots, alerts, bad entries, tracking checks
  queue.js         the two FIFO queues and their workers, scheduling of re-scans
  routes/          index.js (/health), accounts.js, alerts.js
```

The layers are routes, `queue.js` and `scanner.js` → `repositories/` → `database/`. Only repositories and migrations run SQL. `index.js` calls `database.init()` before starting the queues and the API; anything that calls `getDb()` before that throws. Repositories are synchronous (better-sqlite3), take plain values, and log `'repository - fnName'` at debug.

| Repository         | Table                                                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `itemNames`        | `item_names`; `getOrCreateItemId` caches ids for the current connection                                                                |
| `priceSnapshots`   | `price_snapshots`: create, 7-day low, spike-reset check, latest, history                                                               |
| `alerts`           | `alerts`: create, last for an item, list                                                                                               |
| `alertRecipients`  | `alert_recipients`: add, unresolved per uid, resolve one / all                                                                         |
| `inventoryItems`   | `inventory_items`: upsert seen, mark missing, holders of an item, list                                                                 |
| `inventoryFetches` | `inventory_fetches`: record, last fetch                                                                                                |
| `badEntries`       | `bad_entries`: isBad, markBad, getBadReason                                                                                            |
| `accounts`         | `accounts` + `account_steam64ids` + `account_custom_items`: list, get, create, update, delete, add/remove list entries, tracked checks |

## Persistence

- **`data/rules.json`**: hand-edited price tiers, sorted by `minPrice` descending. Missing or invalid falls back to `DEFAULT_RULES` in `rules.js` (four tiers: ≥ £50 3h/+15%/+25%, ≥ £10 6h/+20%/+35%, ≥ £1 12h/+30%/+50%, below 24h/+50%/+100%). A file replaces them completely.
- **`data/invenchecker.db`** (SQLite, WAL): `accounts` with `account_steam64ids` and `account_custom_items` (ordered by `position`, repeats allowed, since the API returns lists as stored), `item_names` (name ↔ id), `price_snapshots`, `alerts`, `alert_recipients` (per-uid resolved state), `inventory_items` (per steam64id, `missing` when it leaves the inventory), `inventory_fetches`, `bad_entries` (steam64ids/items Steam rejected; permanent, and the API refuses to re-add them). Migrations (`database/migrations.js`) are numbered by `user_version`: 1 is the original schema (its steps still detect older layouts by their columns), 2 adds the account tables and imports `data/accounts.json` (`CONFIG_PATH`) once, refusing to start on a malformed file. Add new migrations to the end of `MIGRATIONS`.
- **`data/accounts.json`**: legacy only. Imported by migration 2 and then ignored; startup logs a warning while it exists.

## Key flows

- **Queues** (`queue.js`): the inventory worker fetches one steam64id at a time and feeds its items to the price queue (`enqueuePriceIfDue`). The price worker fetches one item at a time, then `scanner.processPriceForItem` records a snapshot and maybe an alert. Each entry schedules its own next scan with `setTimeout`: inventories after `REENQUEUE_DELAY_MS`, prices after the matching rule's `scanHours`. When a timer fires, `requeueInventory`/`requeuePrice` drop the entry if no account tracks it any more. A restart re-seeds from the accounts, respecting the last scan times.
- **Scan duration**: `runScan` (`POST /alerts/scan`) only enqueues and sets `scanState.startedAt`. `checkScanComplete` in `queue.js` runs when a worker goes idle and sets `lastScanMs` once both queues are empty and nothing is in flight (`inFlight` covers an entry being processed or paused for a retry). The workers loop over `processNextInventory` / `processNextPrice`, which tests call directly.
- **Results** from the scanner: `'rate_limited'` (HTTP 429) or `'retry'` (network error, timeout, or 5xx) pause the worker for `RATE_LIMIT_RETRY_MS` and retry. Any other Steam error marks the entry bad. A 5xx only counts towards the limit of 3 (`SERVER_ERROR_LIMIT`, in memory) when Steam answered another request of the same kind since that entry last failed, so an outage can't blacklist everything.
- **Alerts**: an alert fires when the price is ≥ 7-day low × (1 + `alertPct`). After an alert, another one only fires at ≥ low × (1 + `realertPct`), or once the price has dipped back under the alert threshold since the last alert. Recipients are every uid whose custom items include the item or whose steam64ids hold it (not missing).
- **API**: no auth, deliberately deferred (see TODO.md). It's only exposed on the Docker network (`expose`, not `ports`).

## Conventions

- Logging is structured, one line per event: `logger.info({ steam64id }, 'inventory - fetched')`. The area is short and lowercase (`startup`, `shutdown`, `process`, `api`, `queue`, `inventory`, `price`, `alert`, `scan`, `accounts`, `rules`). Errors pass `{ err }`.
- Import order: `node:` built-ins, packages, `config`/`logger`, then internal modules.
- Catch variables are `err`; `===` except `== null`.
- Tests: `tests/setup.js` points each Jest worker at an in-memory DB, a missing accounts.json (nothing to import) and a missing rules.json (so the built-in rules apply; the scanner spike tests use the £10 tier). `tests/helpers/accounts.js` `setAccounts()` replaces the accounts. Test files that touch the database call `require('../src/database').init()` in `beforeAll`, and may use `getDb()` for fixtures. `tests/db.test.js` runs the migrations against real temp files (`loadModules` sets `DB_PATH` before config is loaded). Route tests mount a single router on a bare Express app; `health.test.js` uses `createApp()`.

## Gotchas

- `scanner.js` and `queue.js` require each other; scanner loads `./queue` lazily inside functions.
- Express 5: `req.body` is undefined without a JSON body (the accounts router defaults it to `{}`), and `app.listen`'s callback receives listen errors.
- Jest runs tests in a separate realm, so `instanceof TypeError` fails on errors thrown by Node's own `fetch`. `isNetworkError` checks `err.name` instead.
