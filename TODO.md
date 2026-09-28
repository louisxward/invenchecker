API auth (deferred): the API has no auth; it's only reachable on the invenchecker Docker network. When adding it, use `Authorization: Bearer <token>` compared in constant time (as chowbot's admin API does), keep /health open for the Docker healthcheck, and update chowbot's src/services/invencheckerService.js to send the token in the same change.

Re-scan inventory items on startup (deferred): the queues are in memory, and after a restart only steam64ids and custom items are scheduled from their last scan time. Items found in inventories are only re-queued at their steam64id's next inventory fetch (up to REENQUEUE_DELAY_MS, 6h), so e.g. a £50+ item on the 3h tier can wait up to 6h after a restart. Fix in startQueues: also schedule every item held (missing = 0) by a tracked steam64id from its last snapshot and price rule, as custom items are.

Better Scan Progress

Mute invenchecker entirely
