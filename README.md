# 📡 Telegram → Discord Relay

Mirror public Telegram channels into a Discord text channel — automatically, forever, from Cloudflare's edge. No server, no bot, nothing running on your machine.

```
Telegram channel  ──▶  Cloudflare Worker (cron, every minute)  ──▶  Discord webhook
   @Example             fetch + parse + dedupe (KV)                   text + media embeds
   @Example
   @Example
```

Because the Worker fetches Telegram from Cloudflare's network, it keeps working even on networks where Telegram is blocked.

## ⚡ Install

**Option A — standalone executable (no Node.js needed):**

Download from [Releases](https://github.com/Miizuim/telegram-to-discord/releases):
- `telegram-wizard-windows-x64.exe` (Windows)
- `telegram-wizard-linux-x64` (Linux)

Put it in an empty folder and run it — it unpacks the whole project there and starts the setup wizard immediately.

**Option B — from source** (requires [Node.js 18+](https://nodejs.org)):

```bash
git clone https://github.com/<you>/telegram-to-discord.git
cd telegram-to-discord
npm install
node wizard.js
```

The wizard walks you through everything and is **safe to re-run**:

1. chooses a unique Worker name — use a different one for every relay on the same Cloudflare account
2. asks you to paste exactly which Telegram channels to forward (nothing pre-selected)
3. installs dependencies
4. validates your Discord webhook (test message; skippable on blocked networks)
5. logs you in to Cloudflare (browser popup, once)
6. creates a separate KV namespace, deploys that named Worker, and stores its webhook secret
7. runs a first live sync

Each name creates an independent Worker, KV cursor store, cron trigger, secret scope, and `workers.dev` URL. For multiple relays, run the wizard from a separate empty folder for each installation and choose a new name.

When it finishes, your channel starts receiving posts — done.

<details>
<summary>Manual setup (without the wizard)</summary>

```bash
npm install
npx wrangler login
npx wrangler kv namespace create STATE_KV        # copy the id into wrangler.toml
npx wrangler secret put DISCORD_WEBHOOK_URL      # paste your webhook URL
npx wrangler deploy
```

Edit `src/channels.js` to choose channels, then `npx wrangler deploy` again.
</details>

## Getting your Discord webhook URL (30 seconds)

1. In Discord: **channel ⚙ Edit → Integrations → Webhooks → New Webhook**
2. **Copy Webhook URL**

That URL is the only credential this project needs.

## Managing channels

Re-run the wizard — it shows a **recommended channels** menu (pick by number, ranges, `all`, or `none`) plus a field for your own handles, previews the final list, and rewrites `src/channels.js`:

```bash
node wizard.js
```

Or edit `src/channels.js` directly:

```js
export const CHANNELS = [
  { handle: 'warroom', name: 'WARROOM News' },
  { handle: 'any_channel', name: 'Any Channel' }
];
```

The recommended list lives in the `RECOMMENDED` array at the top of `wizard.js` — add your favorite channels there once, and every future install gets them as suggestions.

## Operations

```bash
npx wrangler tail                                                    # live logs
curl https://<your-worker>.workers.dev/test                          # force a sync now
npx wrangler kv:key get --binding=STATE_KV "last_seen:warroom"       # inspect a cursor
npx wrangler kv:key put --binding=STATE_KV "last_seen:warroom" "0"   # reset a channel
```

## How it works

- A cron trigger (`* * * * *`) runs the Worker every minute on Cloudflare's edge.
- It fetches the public preview of each channel (`t.me/s/<handle>`), parses message text (converted to Discord markdown: bold, italic, quotes, links), photos, and video thumbnails.
- A per-channel position marker in Workers KV makes runs idempotent — no duplicates, survives deploys, and retries only failed posts.
- Empty payloads (video-only posts with nothing extractable) are skipped instead of erroring.

## License

MIT — see [LICENSE](LICENSE).
