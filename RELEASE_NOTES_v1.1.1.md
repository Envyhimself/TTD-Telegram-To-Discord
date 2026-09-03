## TTD v1.1.1 — Telegram Edit Synchronization

### 🚀 New Feature
- **Edit mirroring**: When a Telegram channel edits a recently mirrored post, the matching Discord message is updated **in place** on the next one-minute sync — no duplicate message, no new post.
- Works for text, image (re-embedded), and video edits (refreshed as current download links with old attachments cleared).
- Telegram→Discord message-ID mapping is stored in KV (newest 300 posts per channel). Rotating Telegram media signatures are ignored, so unchanged posts are never re-sent.
- Coverage: posts first delivered by v1.1.1+ while still visible in Telegram's public preview.

### 🔧 Reliability Fixes
- Strict execution lock: manual `/test` can no longer overlap a running cron sync (prevents any duplicate-delivery race).
- Edit failures report `partial` status and surface in `/health` instead of being masked as healthy.
- Webhook posts use `?wait=true` so Discord returns the created message ID (required for editing).

### 📦 Standalone Binaries
- `telegram-wizard-windows-x64.exe`
- `telegram-wizard-linux-x64`
