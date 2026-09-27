write some stong tests around alerts. going up and down. between different rules. make sure everything fires. no missed notifications q

skip "Graffiti |" and not "Sealed Graffiti |"

API auth (deferred): the API has no auth; it's only reachable on the invenchecker Docker network. When adding it, use `Authorization: Bearer <token>` compared in constant time (as chowbot's admin API does), keep /health open for the Docker healthcheck, and update chowbot's src/services/invencheckerService.js to send the token in the same change.
