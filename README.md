# 📡 Telegram → Discord Relay

Mirror public Telegram channels into a Discord text channel — automatically, forever, from Cloudflare's edge. No server, no bot, nothing running on your machine.

```
Telegram channel  ──▶  Cloudflare Worker (cron, every minute)  ──▶  Discord webhook
   @warroom              fetch + parse + dedupe (KV)              text + media embeds
   @fighter_radar
   @news_hut
```

Because the Worker fetches Telegram from Cloudflare's network, it keeps working even on networks where Telegram is blocked.

## ⚡ Install (wizard)

Requires [Node.js 18+](https://nodejs.org) only.

```bash
git clone https://github.com/<you>/telegram-to-discord.git
cd telegram-to-discord
npm install
node wizard.js
```

The wizard walks you through everything and is **safe to re-run**:

1. installs dependencies
2. picks the Telegram channels to mirror (defaults included)
3. validates your Discord webhook (and posts a test message — skippable on blocked networks)
4. logs you in to Cloudflare (browser popup, once)
5. creates the KV namespace, writes `wrangler.toml`, and deploys
6. stores the webhook as an encrypted secret and runs a first live sync

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

```bash
node wizard.js            # re-run, or edit src/channels.js directly:
```

```js
export const CHANNELS = [
  { handle: 'warroom', name: 'WARROOM News' },
  { handle: 'any_channel', name: 'Any Channel' }
];
```

Then `npx wrangler deploy`. Each channel keeps its own dedupe cursor, so adding one never replays history — it starts with its single newest post and follows from there.

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
