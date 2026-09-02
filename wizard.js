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
import { writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const c = process.stdout.isTTY ? {
  b: s => `\x1b[1m${s}\x1b[0m`,
  dim: s => `\x1b[2m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`,
  cyan: s => `\x1b[36m${s}\x1b[0m`
} : { b: s => s, dim: s => s, green: s => s, red: s => s, cyan: s => s };

const line = () => console.log(c.dim('─'.repeat(62)));

// caxa launches the wizard through a child process on Windows, where stdout.isTTY
// may be false even in a visible console. Force terminal mode so typed input echoes.
const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: process.platform === 'win32' || Boolean(process.stdout.isTTY)
});
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

const waitForExit = () => {
  if (process.platform === 'win32' && process.stdin.isTTY) {
    spawnSync('cmd.exe', ['/c', 'pause'], { stdio: 'inherit' });
  }
};

const die = msg => {
  console.error('\n' + c.red('✖ ' + msg));
  rl.close();
  waitForExit();
  process.exit(1);
};

// caxa runs wizard.js from an extracted internal directory. Copy the embedded
// project into the user's current folder so Wrangler/npm have real source files.
function materializeProject() {
  const bundledRoot = dirname(fileURLToPath(import.meta.url));
  const cwd = process.cwd();
  const files = [
    'package.json',
    'package-lock.json',
    'src/index.js',
    'src/telegram.js',
    'src/discord.js'
  ];
  let copied = 0;
  for (const rel of files) {
    const source = join(bundledRoot, rel);
    const target = join(cwd, rel);
    if (existsSync(target)) continue;
    if (!existsSync(source)) throw new Error(`Packaged file missing: ${rel}`);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    copied++;
  }
  if (copied) console.log(c.green('✔') + ` Project files created in ${cwd}`);
}

materializeProject();

// ── channel selection ───────────────────────────────────────────────────────

const pretty = h => h.split(/[_\s-]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

export function validateWorkerName(raw) {
  const name = String(raw || '').trim().toLowerCase();
  if (!name) return { ok: false, error: 'Worker name is required.' };
  if (name.length > 63) return { ok: false, error: 'Use 63 characters or fewer.' };
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)) {
    return { ok: false, error: 'Use lowercase letters, numbers, and hyphens; no spaces or leading/trailing hyphen.' };
  }
  return { ok: true, name };
}

export function extractWorkerUrl(output) {
  return (String(output || '').match(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev\b/i) || [])[0] || '';
}

async function chooseWorkerName() {
  line();
  console.log(c.b('Choose a unique Cloudflare Worker name'));
  console.log(c.dim('Each relay needs a different name so it gets its own Worker, KV state, secret, cron, and URL.\n'));
  while (true) {
    const check = validateWorkerName(await askQ('Worker name (example: ttd-war-news)'));
    if (check.ok) {
      console.log(c.green('✔') + ` Worker: ${check.name}`);
      console.log(c.green('✔') + ` KV: ${check.name}-STATE_KV`);
      return check.name;
    }
    console.log(c.red('✖ ' + check.error));
  }
}

// Parse pasted handles ("warroom, @News_Hut  my_news") into a deduped CHANNELS list.
export function parseChannelList(raw) {
  const byHandle = new Map();
  for (const part of String(raw || '').split(/[,;\s]+/).filter(Boolean)) {
    const h = part.replace(/^@/, '').toLowerCase();
    if (h && !byHandle.has(h)) byHandle.set(h, { handle: h, name: pretty(h) });
  }
  return [...byHandle.values()];
}

async function chooseChannels() {
  while (true) {
    line();
    console.log(c.b('Which Telegram channels do you want forwarded to Discord?'));
    console.log(c.dim('Paste the handles yourself, comma-separated (e.g. warroom, my_news)\n'));
    const raw = await askQ('Channels');
    const CHANNELS = parseChannelList(raw);
    if (CHANNELS.length === 0) {
      console.log(c.red('✖ Paste at least one channel handle.'));
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
  const list = parseChannelList('warroom, @News_Hut  news_hut my_channel');
  assert(list.length === 3, 'dedupe');
  assert(list[0].handle === 'warroom' && list[0].name === 'Warroom', 'pretty name');
  assert(list[1].handle === 'news_hut' && list[1].name === 'News Hut', 'deduped handle');
  assert(list[2].handle === 'my_channel' && list[2].name === 'My Channel', 'underscore split');
  assert(parseChannelList('').length === 0, 'empty input -> empty list');
  assert(parseChannelList('  ').length === 0, 'blank input -> empty list');
  assert(validateWorkerName('TTD-War-News').name === 'ttd-war-news', 'worker name normalized');
  assert(validateWorkerName('').ok === false, 'worker name required');
  assert(validateWorkerName('has spaces').ok === false, 'worker name rejects spaces');
  assert(validateWorkerName('-bad').ok === false, 'worker name rejects edge hyphen');
  assert(extractWorkerUrl('Deployed warroom triggers (3.40 sec)\n  https://warroom.amoaaa.workers.dev\n  schedule: * * * * *') === 'https://warroom.amoaaa.workers.dev', 'nested workers.dev url');
  console.log('wizard selftest OK');
  process.exit(0);
}

// ── main flow ───────────────────────────────────────────────────────────────

async function main() {
  line();
  console.log(c.b(c.cyan('  Telegram → Discord relay  ·  Cloudflare Workers setup wizard')));
  line();
  console.log(`
This wizard will:
  ${c.dim('1.')} choose a unique Worker name (supports multiple relays per account)
  ${c.dim('2.')} ask which channels to forward (you pick everything — no defaults)
  ${c.dim('3.')} install dependencies
  ${c.dim('4.')} validate your Discord webhook (and post a test message)
  ${c.dim('5.')} log in to Cloudflare (browser popup, once)
  ${c.dim('6.')} create an isolated KV namespace and deploy the Worker
  ${c.dim('7.')} store the webhook as an encrypted secret and run a live sync
`);

  // 1. unique Worker name — controls Worker, KV, secret scope, cron, and URL
  const workerName = await chooseWorkerName();

  // 2. channel selection — nothing pre-selected
  const CHANNELS = await chooseChannels();
  writeFileSync('src/channels.js',
    `// Generated by wizard.js — edit freely or re-run the wizard.\n` +
    `export const CHANNELS = ${JSON.stringify(CHANNELS, null, 2)};\n`);
  console.log(c.green('✔') + ' Channel list written to src/channels.js');

  // 2. node check + npm install
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 18) die(`Node.js 18+ required (you have ${process.versions.node}).`);
  console.log(c.green('✔') + ` Node ${process.versions.node}`);

  if (!existsSync('node_modules')) {
    console.log(c.dim('Installing dependencies…'));
    const inst = run('npm', ['install', '--no-fund', '--no-audit']);
    if (!inst.ok) die('npm install failed — check your internet connection.');
  }
  console.log(c.green('✔') + ' Dependencies ready');

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

  // 6. isolated KV namespace + wrangler.toml + deploy
  line();
  const kvTitle = `${workerName}-STATE_KV`;

  // Force Wrangler's namespace title to derive from this installation's name,
  // even when re-running the app in a folder with an old wrangler.toml.
  writeFileSync('wrangler.toml',
`name = "${workerName}"
main = "src/index.js"
compatibility_date = "2024-01-01"
`);

  console.log(c.dim(`Creating isolated KV namespace "${kvTitle}"…`));
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
  const url = extractWorkerUrl(dep.out);
  if (!dep.ok && !url) { console.log(dep.out); die('Deploy failed — see output above.'); }
  if (!url) { console.log(dep.out); die('Deploy finished but could not find the workers.dev URL in the output.'); }
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
  console.log(c.b(c.green('  ✅  All done!\n')));
  console.log(`  Worker:  ${c.b(url)}`);
  console.log(`  Sync:    ${c.dim('automatic, every minute — only your selected channels are forwarded')}`);
  console.log(`  Test:    ${c.dim('open ' + url + '/test anytime to force a sync')}`);
  console.log(c.dim('\n  ' + summary.split('\n').slice(0, 12).join('\n  ')));
  rl.close();
}

main().catch(e => die(e.message));
