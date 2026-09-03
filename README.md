# TTD — Telegram to Discord

> **Language / زبان:** [🦁☀️ فارسی](README.fa.md) | **English** (below)

Automated, serverless relay that mirrors public Telegram channels to Discord webhooks with clean text formatting, inline images, and real MP4 video attachments.

Runs 24/7 on **Cloudflare Workers** (cron `* * * * *`) with **Cloudflare KV** cursor tracking to bypass local ISP blocks, prevent duplicate messages, and operate without hosting a bot server.

---

## What TTD Does

- **Multi-channel forwarding**: Mirror any public Telegram channel (`@warroom`, `@news_hut`, etc.) to Discord.
- **Direct media uploads**: Downloads real `.mp4` videos (<= 8 MB) and uploads them to Discord as multipart attachments (`files[0]`) instead of posting bare links.
- **Anti-freeze video fallback**: If a video is too large (> 8 MB) or Discord/network rejects the file upload, TTD posts the post text + a direct video download link so newer channel posts never get blocked overnight.
- **Backlog catch-up protection**: Bounds catch-up batches to 5 messages per run per channel, preventing Cloudflare execution timeout spikes during reconnects.
- **Cron run-lock**: Prevents overlapping execution between cron runs and manual trigger requests.
- **Health monitoring**: Built-in `/health` endpoint returning uptime, secret status, last run timestamps, and dead-letter logs.
- **Clean output**: Strips `t.me` URLs and renders clean text, bold headers, paragraphs, and photos.
- **Multiple relays per account**: Pick a unique Worker name per setup (`ttd-war`, `ttd-crypto`). Each installation gets its own isolated Worker, KV namespace, secret, cron trigger, and `workers.dev` URL.
- **Zero defaults**: You choose and paste exactly which channels you want.
- **Sanctions-proof & serverless**: Scraping and webhook delivery execute entirely at Cloudflare's edge.

---

## Quick Start (Pre-built Executable)

Download the standalone installer from the release tab

- **Windows**: `telegram-wizard-windows-x64.exe`
- **Linux**: `telegram-wizard-linux-x64`

### How the Wizard Works

1. **Unique Worker Name**: Choose a name for this relay instance (e.g. `ttd-war-news`).
2. **Channel Selection**: Paste your Telegram handles (comma-separated, e.g. `warroom, news_hut`).
3. **Automated Setup**: Extracts files and installs required dependencies.
4. **Discord Webhook**: Enter your Discord webhook URL (with validation and optional skip for restricted networks).
5. **Cloudflare Login**: Authenticates via Cloudflare browser popup (once).
6. **Deploy & Protect**: Creates `<worker-name>-STATE_KV`, deploys the Worker, securely saves `DISCORD_WEBHOOK_URL`, and executes the first live test sync.

---

## Running Multiple Instances

> [!WARNING]
> **Using the same Telegram channels and the same Discord webhook in more than one Worker sends every message multiple times.** KV deduplication works inside one Worker only; separate Workers have separate KV state and cannot deduplicate each other.
>
> Before creating another Worker, decide whether you want an additional destination:
> - **Different Discord webhook:** create another Worker with a unique name.
> - **Same Discord webhook:** reuse/update the existing Worker, or delete the old Worker first. Do not run both.

To run multiple relays on one Cloudflare account:

1. Create a separate folder for each relay (e.g. `C:\TTD\News1`, `C:\TTD\News2`).
2. Run the wizard executable inside each folder.
3. Choose a unique Worker name for each one (e.g. `ttd-news-one`, `ttd-news-two`).
4. Enter the specific channels and target Discord webhook for that instance.
5. Confirm that no other active Worker uses the same Telegram channels with the same webhook.

Each instance runs independently without cursor conflicts or shared state. That isolation is why two Workers targeting the same channels and webhook produce duplicate Discord messages.

---

## Manual Installation (Node.js)

If you prefer running from source:

```bash
# Clone the repository
git clone https://github.com/Envyhimself/TTD-Telegram-To-Discord.git
cd TTD-Telegram-To-Discord

# Run the interactive wizard
node wizard.js
```

---

## Verification & Monitoring Endpoints
 
- **Automatic Sync**: Runs every minute via Cloudflare Cron (`* * * * *`).
- **Health Check**: Open `https://<your-worker>.<subdomain>.workers.dev/health` to view operational status, last run timestamps, and recent dead-letter fallback logs.
- **Manual Sync**: Open `https://<your-worker>.<subdomain>.workers.dev/test` in your browser or make a GET request to immediately trigger a sync of the latest messages.

---

## License

MIT
