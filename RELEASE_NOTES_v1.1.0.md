## TTD v1.1.0 — Reliability, Anti-Freeze Video Fallback & Health Monitoring

### 🛠️ Fixes & Reliability Improvements
- **Anti-Freeze Video Fallback**: If a video is larger than 8 MB or rejected by Discord/network, TTD automatically delivers the post text and a direct video download link, ensuring newer channel messages are never blocked.
- **Backlog Bounded Catch-Up**: Sync runs process at most 5 messages per channel per minute to prevent Cloudflare Worker CPU timeouts after prolonged disconnects.
- **Cron Run Lock**: Added a 60-second atomic KV lock to prevent race conditions and duplicate deliveries between cron executions and manual test requests.
- **Automatic Retries & Dead-Letter Log**: Failed posts retry up to 3 times before falling back to links, logging failures in KV for auditability.

### 🚀 New Features & Monitoring
- **`/health` & `/status` Endpoints**: Real-time JSON health check reporting uptime status, last scheduled run timestamp, webhook configuration, and recent fallback actions.
- **Packaged Reliability Module**: Included `src/reliability.js` in the standalone executable build.
- **Automated Reliability Test Suite**: Added test coverage in CI and local test pipelines (`npm test`).

### 📦 Standalone Binaries
- `telegram-wizard-windows-x64.exe`
- `telegram-wizard-linux-x64`
