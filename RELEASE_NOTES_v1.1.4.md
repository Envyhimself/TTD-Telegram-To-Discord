# v1.1.4 — Every Post, Instantly (Voice Notes, Polls, Docs, Forwards + Instant Sync)

## What changed

### 1. Voice notes, polls, documents and forwarded posts are now forwarded
The old parser only looked at text, photos and videos. Anything else — **voice
notes**, audio tracks, **polls**, **document files**, and **forwarded posts** —
came through the preview page with no recognized content, was marked
"has no content" and **silently skipped**. That's why messages "disappeared".

v1.1.4 extracts all of them:
- 🎙️ **Voice notes** → uploaded as a playable audio attachment (≤8 MB) or a
  "Voice Message (0:32) [Listen/Download]" link
- 🎵 **Audio tracks** → attachment or "Artist — Title" link
- 📊 **Polls** → rendered with question + options (and percentages once counted)
- 📁 **Documents** → rendered as a linked file with title + size
- ↪️ **Forwarded posts** → prefixed with "Forwarded from <channel>"
All of these are also included in the edit-detection fingerprint, so edits to
them are mirrored too.

### 2. Near-instant delivery
Cron now polls **every 10 seconds** for a 40-second window (was: once per
minute). A new post appears in Discord ~5–15 seconds after it appears on
Telegram instead of up to 60 seconds. Per-run batch size raised 5 → 25 so
bursts can't roll off Telegram's 20-message preview window.

### 3. One bad post can never silence a channel again
- **Retryable failures** (Discord 429 / 5xx / network, expiring media URLs) are
  backed off 90 s and retried — they are **never** dead-lettered, so a Discord
  outage cannot wedge a channel into skipped messages.
- **Non-retryable failures** (file too big, Discord validation error, dead URL)
  fall back to a **direct link** after 2 attempts, and only dead-letter after 10.
- A **circuit breaker** pauses a channel for 15 minutes after 5 Discord-side
  failures, so an outage burns zero CPU and the backlog is delivered
  automatically when Discord returns.
- Failed posts no longer stop the batch — later posts in the same run keep
  flowing (the cursor only advances past posts actually delivered).

### 4. No more phantom edit storms
Upgrading the fingerprint format would have made the relay try to "re-edit"
hundreds of old messages on the next run (and hit Discord's 5 req/s limit,
which is what caused the earlier `partial` flapping). Mappings written by older
versions are recognized: a post is only re-edited if the fields the old hash
covered (text/photos/videos) actually changed. Edits are capped at 25 per
channel per run, paced at 250 ms, and stop cleanly on a 429.

### 5. Uptime hardening
- Mid-run the relay marks itself `in-progress`, so the watchdog never mistakes
  a 30-second in-flight run for a stale one and kick-spams.
- `partial` with no stuck posts is reported **healthy** (edits/fallbacks
  self-resolve); only genuinely stuck posts or errors look unhealthy.
- KV writes only happen when the delivery state actually changes — the
  faster polling stays well inside free-plan write budgets.

## Compatibility
Drop-in: same KV schema, same webhook secrets, same `/health`, `/test`,
`/wd-kick` endpoints. The watchdog worker is unchanged.

## Rollout
All three relays (warroom, warroom-second, hamburger) redeployed with the new
code; 20 unit tests pass (voice/poll/doc/forward formatting, legacy-fingerprint
skip, edit cap, circuit semantics, health logic).
