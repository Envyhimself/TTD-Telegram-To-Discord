## TTD v1.1.2 — 24/7 Uptime (Cron Self-Healing + CPU-Protected Runs)

### 🐛 The bug that stopped the relays at night
A single sync run with several videos took **>60 seconds** of CPU. The overlap-prevention lock expired at exactly 60 seconds while the run was still in progress, so:
1. The next cron tick started a **second parallel run** (double CPU load, duplicate posts).
2. When a heavy run got **killed by Cloudflare's CPU limit** before it could clear the lock, every following tick saw a "stale lock" and skipped — and the skip path **never updated the last-run record**, so the relay silently froze with `cron-stale`.

This is why the relays kept stopping overnight (the quiet hours are when video-heavy batches pile up) and only came back when you poked them manually.

### ✅ What v1.1.2 changes
- **Self-healing lock**: the run lock now lives 15 minutes (longer than any possible run) but a lock older than 10 minutes is treated as abandoned and broken through. A killed run can never stall the relay again.
- **Every skip records the run**: even when a run is skipped because another is in progress, the worker records a healthy "skipped" result, so health reporting can never wedge on `cron-stale`.
- **CPU budget per run**: at most **2 video files are downloaded/uploaded per sync run**; any extra videos in the same batch are delivered instantly as text + poster + direct download link. This keeps every run well inside Cloudflare's CPU wall, even when 30+ posts pile up overnight.
- **Hard guard on the cron handler**: the scheduled entrypoint can no longer crash the isolate; failures are logged and the worker stays alive for the next tick.
- **Wider health window**: healthy margin raised to 3 minutes so a legitimately slow video run never false-alarms.

### ✅ Verified in production
All three relays (`warroom`, `warroom-second`, `hamburger`) were redeployed and observed across multiple consecutive cron cycles:
- Every tick fires on the minute and reports `healthy: true, status: ok`.
- Catch-up after the outage completed automatically: new posts delivered, 35+ edited messages mirrored in place, and the one rate-limited edit batch self-healed on the very next cycle.

### Release assets
- Standalone wizard binaries for Windows and Linux (CAXA-built).
