import { CHANNELS, fetchChannelMessages } from './telegram.js';
import { buildFallbackContent, classifyVideo, healthFromLastRun, nextFailureAction, selectMessageBatch } from './reliability.js';

const DISCORD_WEBHOOK_MAX_EMBEDS = 4;
const RUN_LOCK_TTL_SECONDS = 60;

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runAndRecord(env, 'cron'));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health' || url.pathname === '/status') {
      const lastRun = await readJson(env.STATE_KV, 'CRON_LAST_RUN');
      const health = healthFromLastRun(lastRun);
      const deadLetters = await readJson(env.STATE_KV, 'DEAD_LETTERS') || [];
      return Response.json({
        status: health.healthy ? 'healthy' : 'unhealthy',
        healthy: health.healthy,
        reason: health.reason,
        cronSchedule: '* * * * *',
        hasWebhookSecret: Boolean(env.DISCORD_WEBHOOK_URL),
        lastScheduledRun: lastRun,
        recentDeadLetters: deadLetters.slice(-10)
      }, { status: health.healthy ? 200 : 503 });
    }

    if (url.pathname === '/test') {
      return Response.json(await runAndRecord(env, 'manual'));
    }

    return new Response('Telegram to Discord Sync Worker is running.', { status: 200 });
  }
};

async function readJson(kv, key) {
  if (!kv) return null;
  const raw = await kv.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function runAndRecord(env, source) {
  if (!env.STATE_KV) return syncAllChannels(env);
  const lock = await env.STATE_KV.get('SYNC_LOCK');
  if (lock && source !== 'manual') return { status: 'skipped', reason: 'sync-already-running' };
  await env.STATE_KV.put('SYNC_LOCK', new Date().toISOString(), { expirationTtl: RUN_LOCK_TTL_SECONDS });
  try {
    const result = await syncAllChannels(env);
    await env.STATE_KV.put('CRON_LAST_RUN', JSON.stringify({ time: new Date().toISOString(), source, result }));
    return result;
  } finally {
    await env.STATE_KV.delete('SYNC_LOCK');
  }
}

async function syncAllChannels(env) {
  const webhookUrl = env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return { status: 'error', error: 'DISCORD_WEBHOOK_URL is not configured.' };

  const results = [];
  for (const channel of CHANNELS) {
    try {
      results.push(await syncChannel(channel, env, webhookUrl));
    } catch (err) {
      results.push({ channel: channel.handle, status: 'error', error: String(err?.message || err) });
    }
  }
  return { status: results.every(r => r.status === 'ok') ? 'ok' : 'partial', channels: results };
}

async function syncChannel(channel, env, webhookUrl) {
  const messages = await fetchChannelMessages(channel.handle);
  const kvKey = `last_seen:${channel.handle}`;
  let lastSeenId = 0;
  if (env.STATE_KV) {
    let val = await env.STATE_KV.get(kvKey);
    if (!val && channel.handle === 'warroom') val = await env.STATE_KV.get('LAST_SEEN_ID');
    if (val) lastSeenId = parseInt(val, 10);
  }

  const newMessages = selectMessageBatch(messages, lastSeenId);

  if (!newMessages?.length) {
    return { channel: channel.handle, status: 'ok', postedCount: 0, lastSeenId, message: 'No new posts.' };
  }

  let cursor = lastSeenId;
  const postedIds = [], fallbackIds = [], skippedIds = [], failedIds = [];
  for (const msg of newMessages) {
    if (!msg.hasContent) {
      skippedIds.push(msg.id);
      cursor = Math.max(cursor, msg.id);
      continue;
    }

    let outcome = await postToWebhook(webhookUrl, channel.name, msg);
    const failureKey = `failure:${channel.handle}:${msg.id}`;

    if (outcome.status === 'posted') {
      if (env.STATE_KV) await env.STATE_KV.delete(failureKey);
      cursor = Math.max(cursor, msg.id);
      postedIds.push(msg.id);
      continue;
    }

    const failures = env.STATE_KV ? Number(await env.STATE_KV.get(failureKey) || 0) + 1 : 1;
    if (env.STATE_KV) await env.STATE_KV.put(failureKey, String(failures), { expirationTtl: 86400 });

    if (outcome.status === 'fallback' || nextFailureAction(failures) === 'fallback') {
      const fallback = await postFallback(webhookUrl, channel.name, msg, outcome.reason);
      if (fallback) {
        cursor = Math.max(cursor, msg.id);
        fallbackIds.push(msg.id);
        if (env.STATE_KV) {
          await env.STATE_KV.delete(failureKey);
          await recordDeadLetter(env.STATE_KV, channel.handle, msg.id, outcome.reason, failures);
        }
        continue;
      }
    }

    failedIds.push(msg.id);
    break;
  }

  if (env.STATE_KV && cursor > lastSeenId) await env.STATE_KV.put(kvKey, String(cursor));
  return {
    channel: channel.handle,
    status: failedIds.length ? 'partial' : 'ok',
    postedCount: postedIds.length,
    postedIds, fallbackIds, skippedIds, failedIds, cursor
  };
}

async function recordDeadLetter(kv, channel, id, reason, attempts) {
  const items = await readJson(kv, 'DEAD_LETTERS') || [];
  items.push({ time: new Date().toISOString(), channel, id, reason, attempts });
  await kv.put('DEAD_LETTERS', JSON.stringify(items.slice(-25)));
}

function basePayload(channelName, content) {
  return { username: channelName, avatar_url: 'https://telegram.org/img/t_logo.png', content: content || undefined };
}

async function postFallback(webhookUrl, channelName, msg, reason) {
  const videoUrls = (msg.videos || []).map(v => v.url || v);
  const content = buildFallbackContent(msg.text, videoUrls, reason);
  const payload = basePayload(channelName, content);
  const posters = (msg.videos || []).map(v => v.poster).filter(Boolean).slice(0, DISCORD_WEBHOOK_MAX_EMBEDS);
  if (posters.length) payload.embeds = posters.map(url => ({ image: { url } }));
  const res = await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return res.ok || res.status === 204;
}

async function postToWebhook(webhookUrl, channelName, msg) {
  let content = msg.text || '';
  if (content.length > 2000) content = content.slice(0, 1995) + '...';
  const videos = (msg.videos || []).slice(0, 4);

  if (videos.length) {
    const files = [];
    for (let i = 0; i < videos.length; i++) {
      try {
        const head = await fetch(videos[i].url, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0' } });
        const length = Number(head.headers.get('content-length'));
        const decision = classifyVideo({ ok: head.ok, status: head.status, length });
        if (decision.action !== 'upload') return { status: decision.action === 'fallback' ? 'fallback' : 'failed', reason: decision.reason };

        const vidRes = await fetch(videos[i].url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!vidRes.ok) return { status: 'failed', reason: `telegram-http-${vidRes.status}` };
        const buf = await vidRes.arrayBuffer();
        files.push(new Blob([buf], { type: 'video/mp4' }));
      } catch (err) {
        console.error(`Video fetch failed for post ${msg.id}:`, err);
        return { status: 'failed', reason: 'video-network-error' };
      }
    }

    const form = new FormData();
    form.append('payload_json', JSON.stringify({
      ...basePayload(channelName, content),
      attachments: files.map((_, i) => ({ id: i, filename: `video_${msg.id}_${i + 1}.mp4` }))
    }));
    files.forEach((blob, i) => form.append(`files[${i}]`, blob, `video_${msg.id}_${i + 1}.mp4`));
    try {
      const res = await fetch(webhookUrl, { method: 'POST', body: form });
      if (res.ok || res.status === 204) return { status: 'posted' };
      const body = await res.text();
      console.error(`Discord rejected video ${msg.id}: HTTP ${res.status} ${body}`);
      return { status: res.status === 413 ? 'fallback' : 'failed', reason: `discord-http-${res.status}` };
    } catch (err) {
      return { status: 'failed', reason: 'discord-network-error' };
    }
  }

  const embeds = (msg.images || []).slice(0, DISCORD_WEBHOOK_MAX_EMBEDS).map(url => ({ image: { url } }));
  if (!content && !embeds.length) return { status: 'posted' };
  const payload = basePayload(channelName, content);
  if (embeds.length) payload.embeds = embeds;
  try {
    const res = await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return res.ok || res.status === 204 ? { status: 'posted' } : { status: 'failed', reason: `discord-http-${res.status}` };
  } catch {
    return { status: 'failed', reason: 'discord-network-error' };
  }
}
