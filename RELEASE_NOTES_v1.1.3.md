## TTD v1.1.3 — Never-Go-Quiet (Auto-Reviving Watchdog + No-Channel-Wedge)

### 🐛 The second silent-outage bug (found live by the watchdog, in 5 minutes)
The v1.1.2 lock fix stopped the *cron* from wedging, but it couldn't stop a
**single permanently-undeliverable post** from wedging the *channel*. A post
whose video signed-URL keeps expiring (or that Discord keeps rejecting) fails
every cycle; the old code did `break` on that failure, so the KV cursor never
advanced past it — and **every later post in that channel was blocked
forever**, reporting `partial` and going quiet while the other channels kept
working. This is exactly the kind of "it stopped again" that the lock fix
couldn't see.

### ✅ What v1.1.3 changes
- **A bad post can no longer hold a channel hostage.** After `MAX_PERMANENT_FAILURES`
  (10) consecutive failures on the same post, the relay records a dead letter
  with the real reason, **advances the cursor past it**, and keeps delivering
  the rest of the channel. One broken video no longer means a silent channel.
- **A 24/7 watchdog Worker** (`ttd-watchdog`, cron every 5 min) now monitors all
  three relays through **Cloudflare service bindings** (same-account, no public
  internet dependency). If any relay stops recording runs, the watchdog calls a
  new `/wd-kick` route on it to force a fresh sync and revives it — then re-checks
  to confirm recovery. Its check history is stored in KV and exposed at
  `https://ttd-watchdog.amoaaa.workers.dev/status`.
  - Watchdog checks retry up to 4× with backoff so a transient service-binding
    DNS blip (1101) never triggers a false "relay down" alarm.

### ✅ Verified in production
- The watchdog **caught the real bug on its second tick**: it saw `warroom` and
  `warroom-second` go `last-run-partial`, kicked both (`kicked: true, status: 200`),
  and they returned `healthyAfterKick: true` — the full detect→kick→recover loop,
  with no human in the loop.
- After the channel-wedge fix deployed, the stuck cursor on `fighter_radar`
  advanced 135790 → 135795, the offending post was dead-lettered as
  `permanent-giveup`, and the channel returned to `status: ok`.
- Subsequent watchdog ticks report all three relays `OK` with **no false kick**.
- All three relays observed across multiple consecutive on-the-minute cron cycles,
  all `healthy: true, status: ok`.

### Architecture note
A same-account Cloudflare Worker **cannot** `fetch()` a sibling Worker by its
`workers.dev` URL (edge returns error 1042/1101). It **can** reach it through a
`[[services]]` binding (`env.BINDING.fetch(new Request(<public-url>))`) — that is
what the watchdog uses, and it is the documented, supported pattern.

### Release assets
- Standalone wizard binaries for Windows and Linux (CAXA-built).
