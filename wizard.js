#!/usr/bin/env node
/**
 * telegram-to-discord — installation wizard
 *
 * Interactive setup for the Cloudflare Worker that mirrors public Telegram
 * channels into a Discord channel via webhook. Safe to re-run at any time:
 * every step is idempotent (login / KV / deploy are reused if already done).
 *
 * Usage:  npm install && node wizard.js
 *         node wizard.js --selftest   (non-interactive logic check, used by CI)
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

const c = process.stdout.isTTY ? {
  b: s => `\x1b[1m${s}\x1b[0m`,
  dim: s => `\x1b[2m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`,
  cyan: s => `\x1b[36m${s}\x1b[0m`
} : { b: s => s, dim: s => s, green: s => s, red: s => s, cyan: s => s };

const line = () => console.log(c.dim('─'.repeat(62)));

const rl = createInterface({ input: process.stdin, terminal: !!process.stdout.isTTY });
function askQ(question, def = '') {
  return new Promise(resolve => {
    rl.question(c.b(question) + (def ? c.dim(` [${def}]`) : '') + ' ', answer => {
      resolve(String(answer).trim() || def);
    });
  });
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: true });
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || ''), status: r.status };
}

const die = msg => { console.error('\n' + c.red('✖ ' + msg)); rl.close(); process.exit(1); };

// ── channel selection ───────────────────────────────────────────────────────

// Curated suggestions shown by the wizard. Edit this list freely.
const RECOMMENDED = [
  { handle: 'warroom',       name: 'WARROOM News',    about: 'war & geopolitics (FA)' },
  { handle: 'fighter_radar', name: 'Fighter Radar',   about: 'military & OSINT (FA)' },
  { handle: 'news_hut',      name: 'News Hut',        about: 'news digest (FA)' },
  { handle: 'telegram',      name: 'Telegram Tips',   about: 'official Telegram channel (EN)' },
  { handle: 'durov',         name: "Durov's Channel", about: 'Telegram founder (EN)' }
];

const pretty = h => h.split(/[_\s-]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

// Parse a menu selection like "1, 3-4", "all", "none" into sorted valid indices (1-based).
export function parseSelection(input, max, defaultSel) {
  const s = String(input || '').trim().toLowerCase();
  if (!s) return [...defaultSel];
  if (s === 'all') return Array.from({ length: max }, (_, i) => i + 1);
  if (s === 'none') return [];
  const out = new Set();
  for (const part of s.split(/[,;\s]+/).filter(Boolean)) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      for (let i = +range[1]; i <= +range[2]; i++) if (i >= 1 && i <= max) out.add(i);
    } else if (/^\d+$/.test(part)) {
      const i = parseInt(part, 10);
      if (i >= 1 && i <= max) out.add(i);
    }
  }
  return [...out].sort((a, b) => a - b);
}

// Merge recommended picks + custom handles into the final CHANNELS list (deduped).
export function buildChannelList(recommended, pickedIndices, customHandles) {
  const byHandle = new Map();
  for (const i of pickedIndices) {
    const ch = recommended[i - 1];
    if (ch) byHandle.set(ch.handle, { handle: ch.handle, name: ch.name });
  }
  for (const raw of customHandles) {
    const h = String(raw).trim().replace(/^@/, '').toLowerCase();
    if (h && !byHandle.has(h)) byHandle.set(h, { handle: h, name: pretty(h) });
  }
  return [...byHandle.values()];
}

async function chooseChannels() {
  while (true) {
    line();
    console.log(c.b('Which channels should be forwarded to Discord?'));
    console.log(c.dim('Recommended — pick by number (e.g. 1,2-4 · "all" · "none" · Enter = default):\n'));
    RECOMMENDED.forEach((r, i) => {
      console.log(`  ${c.b(`[${i + 1}]`)} ${r.name.padEnd(16)} ${c.dim('@' + r.handle + ' — ' + r.about)}`);
    });
    const selRaw = await askQ('Selection', '1,2,3');
    const picked = parseSelection(selRaw, RECOMMENDED.length, [1, 2, 3]);

    console.log('');
    const customRaw = await askQ(c.dim('Your own channels too? (comma-separated handles, Enter to skip)'), '');
    const custom = customRaw.split(',').map(s => s.trim()).filter(Boolean);

    const CHANNELS = buildChannelList(RECOMMENDED, picked, custom);
    if (CHANNELS.length === 0) {
      console.log(c.red('✖ Nothing selected — pick at least one channel.'));
      continue;
    }

    console.log('\n' + c.b('Will forward from:'));
    CHANNELS.forEach(ch => console.log(`  ${c.green('•')} ${ch.name} ${c.dim('@' + ch.handle)}`));
    const ok = await askQ('Looks good? [Y/n]', 'Y');
    if (/^y/i.test(ok)) return CHANNELS;
    console.log(c.dim('Let’s choose again…\n'));
  }
}

// Self-test: `node wizard.js --selftest` (used by CI)
if (process.argv.includes('--selftest')) {
  const assert = (cond, msg) => { if (!cond) { console.error('FAIL: ' + msg); process.exit(1); } };
  assert(JSON.stringify(parseSelection('1, 3', 5, [])) === '[1,3]', 'numbers');
  assert(JSON.stringify(parseSelection('2-4', 5, [])) === '[2,3,4]', 'ranges');
  assert(JSON.stringify(parseSelection('all', 3, [])) === '[1,2,3]', 'all');
  assert(JSON.stringify(parseSelection('none', 3, [])) === '[]', 'none');
  assert(JSON.stringify(parseSelection('', 5, [2])) === '[2]', 'default on empty');
  assert(JSON.stringify(parseSelection('0, 9, x, 3', 5, [])) === '[3]', 'invalid ignored');
  const ch = buildChannelList(RECOMMENDED, [1], ['@warroom', 'my_channel']);
  assert(ch.length === 2 && ch[0].handle === 'warroom' && ch[1].handle === 'my_channel' && ch[1].name === 'My Channel', 'dedupe + pretty');
  const chCustomDupes = buildChannelList(RECOMMENDED, [], ['@News_Hut', 'NEWS_HUT']);
  assert(chCustomDupes.length === 1 && chCustomDupes[0].handle === 'news_hut', 'custom dedupe case-insensitive');
  console.log('wizard selftest OK');
  process.exit(0);
}

// ── main flow ───────────────────────────────────────────────────────────────

async function main() {
  line();
  console.log(c.cyan.b('  Telegram → Discord relay  ·  Cloudflare Workers setup wizard'));
  line();
  console.log(`
This wizard will:
  ${c.dim('1.')} install dependencies
  ${c.dim('2.')} pick which channels to forward (recommended list + your own)
  ${c.dim('3.')} validate your Discord webhook (and post a test message)
  ${c.dim('4.')} log in to Cloudflare (browser popup, once)
  ${c.dim('5.')} create the KV namespace and deploy the Worker
  ${c.dim('6.')} store the webhook as an encrypted secret and run a live sync
`);

  // 1. node check + npm install
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 18) die(`Node.js 18+ required (you have ${process.versions.node}).`);
  console.log(c.green('✔') + ` Node ${process.versions.node}`);

  if (!existsSync('node_modules')) {
    console.log(c.dim('Installing dependencies…'));
    const inst = run('npm', ['install', '--no-fund', '--no-audit']);
    if (!inst.ok) die('npm install failed — check your internet connection.');
  }
  console.log(c.green('✔') + ' Dependencies ready');

  // 2. channel selection
  const CHANNELS = await chooseChannels();
  writeFileSync('src/channels.js',
    `// Generated by wizard.js — edit freely or re-run the wizard.\n` +
    `export const CHANNELS = ${JSON.stringify(CHANNELS, null, 2)};\n`);
  console.log(c.green('✔') + ' Channel list written to src/channels.js');

  // 3. discord webhook
  line();
  console.log(c.dim('Create one in Discord: channel ⚙ Edit → Integrations → Webhooks → New → Copy URL\n'));
  let webhook = '';
  while (true) {
    webhook = await askQ('Discord webhook URL');
    if (!/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(webhook)) {
      console.log(c.red('✖ That does not look like a webhook URL. Try again.'));
      continue;
    }
    console.log(c.dim('Sending a test message to your channel…'));
    try {
      const res = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'Telegram Relay',
          content: `🎉 **Installation complete** — this channel will now receive posts from: ${CHANNELS.map(x => '`@' + x.handle + '`').join(', ')}`
        })
      });
      if (res.ok || res.status === 204) { console.log(c.green('✔') + ' Webhook works — check your Discord channel!'); break; }
      console.log(c.red(`✖ Discord rejected it (HTTP ${res.status}). Try again.`));
    } catch (e) {
      console.log(c.red('✖ Could not reach Discord locally: ' + e.message));
      const skip = await askQ('Some networks block Discord (VPNs/sanctions). Skip validation and continue anyway? [Y/n]', 'Y');
      if (/^y/i.test(skip)) { console.log(c.green('✔') + ' Skipped — the Worker will still deliver from the cloud.'); break; }
    }
  }

  // 4. cloudflare login
  line();
  console.log(c.dim('Checking Cloudflare login…'));
  let who = run('npx', ['wrangler', 'whoami']);
  if (!who.ok || /not authenticated/i.test(who.out)) {
    console.log(c.dim('A browser window will open — log in to Cloudflare and authorize Wrangler.\n'));
    const login = spawnSync('npx', ['wrangler', 'login'], { stdio: 'inherit', shell: true });
    if (login.status !== 0) die('Cloudflare login failed.');
  }
  console.log(c.green('✔') + ' Logged in to Cloudflare');

  // 5. KV namespace + wrangler.toml + deploy
  line();
  const workerName = await askQ('Worker name', 'telegram-to-discord');
  const kvTitle = `${workerName}-STATE_KV`;
  console.log(c.dim(`Creating KV namespace "${kvTitle}"…`));
  let kv = run('npx', ['wrangler', 'kv', 'namespace', 'create', 'STATE_KV']);
  let kvOut = kv.out;
  if (!kv.ok || /10014|already exists/i.test(kvOut)) {
    const list = run('npx', ['wrangler', 'kv', 'namespace', 'list']);
    const m = list.out.match(new RegExp(`"id"\\s*:\\s*"([a-f0-9]{32})"[^}]*"title"\\s*:\\s*"[^"]*${kvTitle}"`)) ||
              list.out.match(new RegExp(`"title"\\s*:\\s*"[^"]*${kvTitle}"[^}]*"id"\\s*:\\s*"([a-f0-9]{32})"`));
    if (!m) die('Could not find or create the KV namespace.');
    kvOut = `existing id ${m[1]}`;
  }
  const kvId = (kvOut.match(/([a-f0-9]{32})/) || [])[1];
  if (!kvId) die('Could not parse the KV namespace id.');
  console.log(c.green('✔') + ` KV namespace ready (${kvId.slice(0, 8)}…)`);

  writeFileSync('wrangler.toml',
`name = "${workerName}"
main = "src/index.js"
compatibility_date = "2024-01-01"

[triggers]
crons = ["* * * * *"]

[[kv_namespaces]]
binding = "STATE_KV"
id = "${kvId}"
`);
  console.log(c.green('✔') + ' wrangler.toml written');

  console.log(c.dim('Deploying to Cloudflare (this creates the Worker + cron)…'));
  const dep = run('npx', ['wrangler', 'deploy']);
  const url = (dep.out.match(/https:\/\/[a-z0-9-]+\.workers\.dev/) || [])[0];
  if (!dep.ok || !url) { console.log(dep.out); die('Deploy failed — see output above.'); }
  console.log(c.green('✔') + ' Deployed: ' + c.b(url));

  // 6. secret + live test
  line();
  console.log(c.dim('Storing webhook as an encrypted Worker secret…'));
  const sec = spawnSync('npx', ['wrangler', 'secret', 'put', 'DISCORD_WEBHOOK_URL'],
    { input: webhook + '\n', encoding: 'utf8', shell: true });
  if (sec.status !== 0) { console.log((sec.stdout || '') + (sec.stderr || '')); die('Could not store the secret.'); }
  console.log(c.green('✔') + ' Secret stored');

  console.log(c.dim('Running first live sync (newest post of each channel)…'));
  await new Promise(r => setTimeout(r, 8000)); // edge propagation
  let summary = '';
  try {
    const res = await fetch(url + '/test');
    summary = await res.text();
  } catch (e) { summary = String(e.message); }

  line();
  console.log(c.green.b('  ✅  All done!\n'));
  console.log(`  Worker:  ${c.b(url)}`);
  console.log(`  Sync:    ${c.dim('automatic, every minute — only your selected channels are forwarded')}`);
  console.log(`  Test:    ${c.dim('open ' + url + '/test anytime to force a sync')}`);
  console.log(c.dim('\n  ' + summary.split('\n').slice(0, 12).join('\n  ')));
  rl.close();
}

main().catch(e => die(e.message));
