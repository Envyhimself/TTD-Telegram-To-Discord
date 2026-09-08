# v1.1.5 — Critical: restore all relays after silent cron crash

## What broke
All three relays silently stopped forwarding. The cron handler was throwing
`ReferenceError` on **every** run because three constants were referenced in
`src/index.js` but never added to its import block:
- `lockShouldSkip` (crashed every cron tick AND every watchdog kick)
- `RUN_LOCK_TTL_SECONDS` (crashed every cron tick)
- `MAX_RETRY_ATTEMPTS` (latent — would crash the first time a post's failure
  path ran, after the first two were fixed)

Because the error was thrown before the run could record `CRON_LAST_RUN`, the
health endpoint saw a frozen timestamp and reported `cron-stale`, and the
watchdog's recovery kick hit the **same** crash, so nothing could self-heal.

## The fix
- Added the three missing imports.
- Added `test-import-guard.mjs`, wired into `npm test`, which statically
  verifies every reliability.js constant referenced in index.js is imported —
  so this entire class of "delete everything" bug fails CI instead of taking
  the relays down silently.

## Verified
- All 3 relays: `healthy: true`, `status: ok`, lastRun advancing every minute,
  webhook secret present, no ReferenceError in tail logs.
- Watchdog: all 3 relays `healthy`, no kicks.
- `npm test` green (wizard selftest, import-guard, reliability).
