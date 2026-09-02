# TTD — Telegram to Discord 

Automated, serverless relay that mirrors public Telegram channels to Discord webhooks with clean text formatting, inline images, and real MP4 video attachments.

Runs 24/7 on **Cloudflare Workers** (cron `* * * * *`) with **Cloudflare KV** cursor tracking to bypass local ISP blocks, prevent duplicate messages, and operate without hosting a bot server.

---

## What TTD Does

- **Multi-channel forwarding**: Mirror any public Telegram channel (`@warroom`, `@news_hut`, etc.) to Discord.
- **Direct media uploads**: Downloads real `.mp4` videos and uploads them to Discord as multipart attachments (`files[0]`) instead of posting bare links.
- **Clean output**: Strips `t.me` URLs and renders clean text, bold headers, paragraphs, and photos.
- **Multiple relays per account**: Pick a unique Worker name per setup (`ttd-war`, `ttd-crypto`). Each installation gets its own isolated Worker, KV namespace, secret, cron trigger, and `workers.dev` URL.
- **Zero defaults**: You choose and paste exactly which channels you want.
- **Sanctions-proof & serverless**: Scraping and webhook delivery execute entirely at Cloudflare's edge.

---

## Quick Start (Pre-built Executable)

Download the standalone installer from the [v1.0.0 Release](https://github.com/Envyhimself/TTD-Telegram-To-Discord/releases/tag/v1.0.0):

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

To run multiple relays on one Cloudflare account:

1. Create a separate folder for each relay (e.g. `C:\TTD\News1`, `C:\TTD\News2`).
2. Run the wizard executable inside each folder.
3. Choose a unique Worker name for each one (e.g. `ttd-news-one`, `ttd-news-two`).
4. Enter the specific channels and target Discord webhook for that instance.

Each instance runs independently without cursor conflicts or shared state.

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

## Verification & Manual Trigger

- **Automatic**: Runs every minute via Cloudflare Cron (`* * * * *`).
- **Manual sync**: Open `https://<your-worker>.<subdomain>.workers.dev/test` in your browser or make a GET request to immediately trigger a sync of the latest messages.
- **Diagnostics**: Open `https://<your-worker>.<subdomain>.workers.dev/diag` to inspect raw HTML parsing and current channel cursors.

---

## License

MIT
