import { CHANNELS, fetchChannelMessages } from './telegram.js';
import {
  buildDiscordMessageUrl,
  buildEditPayload,
  buildWaitWebhookUrl,
  classifyVideo,
  DISCORD_CONTENT_MAX,
  DISCORD_UPLOAD_SAFE_LIMIT,
  DISCORD_WEBHOOK_MAX_EMBEDS,
  EDIT_PACING_MS,
  fingerprintMessage,
  formatMessageContent,
  healthFromLastRun,
  lockShouldSkip,
  MAX_PERMANENT_FAILURES,
  MAX_RETRY_ATTEMPTS,
  MAX_VIDEO_UPLOADS_PER_RUN,
  nextFailureAction,
  RETRY_BACKOFF_MS,
  RUN_LOCK_STALE_MS,
  RUN_LOCK_TTL_SECONDS,
  selectEditedMessages,
  selectMessageBatch,
  truncateContent
} from './reliability.js';

export default {
  async scheduled(_event, env, ctx) {
    try {
      ctx.waitUntil(runAndRecord(env, 'cron').catch(err => {
        console.error('Cron run error:', err);
      }));
    } catch (err) {
      console.error('scheduled() dispatch error:', err);
    }
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

    if (url.pathname === '/wd-kick') {
      // Watchdog recovery endpoint: force a fresh sync (same as /test,
      // labeled 'watchdog' so the run is distinguishable in CRON_LAST_RUN).
      return Response.json(await runAndRecord(env, 'watchdog'));
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
  // Short, self-clearing coordinator lock (90s TTL, 80s stale break). It
  // prevents an overlapping scheduled() + manual /test from posting the same
  // message twice, but because the TTL is shorter than a real run can never
  // reach (single sync finishes in <60s), it can never wedge the channel the
  // way the old 900s TTL + 10min stale break did when a run got killed.
  const lock = await env.STATE_KV.get('SYNC_LOCK');
  if (lockShouldSkip(lock)) {
    await env.STATE_KV.put('CRON_LAST_RUN', JSON.stringify({
      time: new Date().toISOString(), source,
      result: { status: 'ok', skipped: true, message: 'Another sync is in progress.', channels: [] }
    }));
    return { status: 'skipped', reason: 'sync-already-running' };
  }
  await env.STATE_KV.put('SYNC_LOCK', new Date().toISOString(), { expirationTtl: RUN_LOCK_TTL_SECONDS });
  try {
    if (source === 'cron') {
      // A single sync per cron tick. Files-based polls are reliable for the
      // Free plan (a multi-loop 40s polling window got CPU/wall-clock-killed
      // mid-loop and left CRON_LAST_RUN stuck on inProgress:true forever).
      const result = await syncAllChannels(env);
      await env.STATE_KV.put('CRON_LAST_RUN', JSON.stringify({
        time: new Date().toISOString(), source, inProgress: false, result
      }));
      return result;
    } else {
      const result = await syncAllChannels(env);
      await env.STATE_KV.put('CRON_LAST_RUN', JSON.stringify({ time: new Date().toISOString(), source, result }));
      return result;
    }
  } finally {
    await env.STATE_KV.delete('SYNC_LOCK');
  }
}

async function syncAllChannels(env) {
  const webhookUrl = env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return { status: 'error', error: 'DISCORD_WEBHOOK_URL is not configured.' };

  const videoBudget = { remaining: MAX_VIDEO_UPLOADS_PER_RUN };
  const results = [];
  for (const channel of CHANNELS) {
    try {
      results.push(await syncChannel(channel, env, webhookUrl, videoBudget));
    } catch (err) {
      results.push({ channel: channel.handle, status: 'error', error: String(err?.message || err) });
    }
  }
  return { status: results.every(r => r.status === 'ok') ? 'ok' : 'partial', channels: results };
}

async function loadMappings(kv, handle) {
  if (!kv) return {};
  const raw = await kv.get('msgmap:' + handle);
  if (!raw) return {};
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

async function saveMappings(kv, handle, map) {
  // 500 = ~500-message history for edit detection; also bounds the
  // per-run edit-candidate scan (25 new + 500 candidate messages per page).
  const ids = Object.keys(map).map(Number).sort((a, b) => b - a).slice(0, 500);
  const trimmed = {};
  for (const id of ids) trimmed[id] = map[id];
  await kv.put('msgmap:' + handle, JSON.stringify(trimmed));
}

async function recordMapping(kv, handle, map, msg, discordMessageId) {
  if (!kv || !discordMessageId) return;
  map[String(msg.id)] = { discordMessageId: String(discordMessageId), fingerprint: await fingerprintMessage(msg) };
}

async function syncChannel(channel, env, webhookUrl, videoBudget) {
  const messages = await fetchChannelMessages(channel.handle);
  const kvKey = 'last_seen:' + channel.handle;
  let lastSeenId = 0;
  if (env.STATE_KV) {
    let val = await env.STATE_KV.get(kvKey);
    if (!val && channel.handle === 'warroom') val = await env.STATE_KV.get('LAST_SEEN_ID');
    if (val) lastSeenId = parseInt(val, 10);
  }

  const mappings = await loadMappings(env.STATE_KV, channel.handle);
  const newMessages = selectMessageBatch(messages, lastSeenId);

  let cursor = lastSeenId;
  const postedIds = [], fallbackIds = [], skippedIds = [], failedIds = [], editedIds = [], editFailedIds = [];
  const permanentIds = [];
  let circuitOpen = false;
  let consecutive = 0;

  for (const msg of newMessages) {
    if (!msg.hasContent) {
      skippedIds.push(msg.id);
      cursor = Math.max(cursor, msg.id);
      continue;
    }

    // Circuit breaker: if Discord-side delivery has failed 5 times recently
    // for this channel (blanket 429s / outage), stop hammering it for 15
    // minutes. Keeps the give-up counters from churning during a Discord
    // incident and keeps CPU flat while the downstream is closed.
    const breakerKey = 'breaker:' + channel.handle;
    const breaker = env.STATE_KV ? await readJson(env.STATE_KV, breakerKey) : null;
    if (breaker && breaker.open && Date.now() - new Date(breaker.open).getTime() < 15 * 60_000) {
      circuitOpen = true;
      break;
    }
    const channelFailures = env.STATE_KV ? Number(await env.STATE_KV.get('cfails:' + channel.handle) || 0) : 0;
    const recordChannelFailure = async () => {
      if (!env.STATE_KV) return;
      await env.STATE_KV.put('cfails:' + channel.handle, String(channelFailures + 1), { expirationTtl: 600 });
    };

    const failureKey = 'failure:' + channel.handle + ':' + msg.id;
    // Stuck-post guard: if this exact post was already attempted less than
    // RETRY_BACKOFF_MS ago (and hasn't reached permanent-give-up yet), don't
    // hammer it again on this 10s poll — retry it on a later run. Keeps CPU
    // flat while Discord rate-limits or a media URL keeps expiring.
    const failures = env.STATE_KV ? Number(await env.STATE_KV.get(failureKey) || 0) : 0;
    const lastAttempt = env.STATE_KV ? await readJson(env.STATE_KV, 'lastattempt:' + channel.handle + ':' + msg.id) : null;
    const inBackoff = lastAttempt && Date.now() - new Date(lastAttempt.time).getTime() < RETRY_BACKOFF_MS;
    if (inBackoff && failures < MAX_PERMANENT_FAILURES - 1) {
      break;
    }
    if (env.STATE_KV) await env.STATE_KV.put('lastattempt:' + channel.handle + ':' + msg.id,
      JSON.stringify({ time: new Date().toISOString() }), { expirationTtl: 86400 });

    let outcome = await postToWebhook(buildWaitWebhookUrl(webhookUrl), channel.name, msg, videoBudget);

    if (outcome.status === 'posted') {
      await recordMapping(env.STATE_KV, channel.handle, mappings, msg, outcome.discordMessageId);
      if (env.STATE_KV) {
        await env.STATE_KV.delete(failureKey);
        await env.STATE_KV.delete('lastattempt:' + channel.handle + ':' + msg.id);
        await env.STATE_KV.delete(breakerKey);
        await env.STATE_KV.delete('cfails:' + channel.handle);
      }
      cursor = Math.max(cursor, msg.id);
      postedIds.push(msg.id);
      consecutive = 0;
      continue;
    }

    const newFailures = failures + 1;
    // A Discord-side failure (webhook 429/5xx/network) counts toward the
    // channel breaker; media/Telegram-side failures do not (a single dead
    // video URL must not open the breaker).
    const discordDown = outcome.retryable && /discord/.test(outcome.reason || '');
    if (discordDown) await recordChannelFailure();

    // Only NON-retryable failures (413 size, 400 bad payload, dead media URL)
    // count toward permanent give-up. Retryable failures (429, network,
    // Discord 5xx) are backed off but never dead-lettered — a Discord outage
    // must not wedge a channel into skipped messages.
    const permanent = !outcome.retryable && newFailures >= MAX_PERMANENT_FAILURES;
    if (env.STATE_KV && !permanent) await env.STATE_KV.put(failureKey, String(newFailures), { expirationTtl: 86400 });

    // Link fallback: immediate for 'fallback' outcomes (oversize media,
    // batch video budget), or after MAX_RETRY_ATTEMPTS for a post whose
    // content Discord rejects / whose media URL keeps dying. Retryable
    // failures (429/network/5xx) are NEVER link-fallbacked while Discord is
    // down — they simply wait for the backoff and retry on a later run.
    if (outcome.status === 'fallback' || (!outcome.retryable && newFailures >= MAX_RETRY_ATTEMPTS + 1)) {
      const fb = await postFallback(buildWaitWebhookUrl(webhookUrl), channel.name, msg, outcome.reason);
      if (fb.ok) {
        await recordMapping(env.STATE_KV, channel.handle, mappings, msg, fb.discordMessageId);
        cursor = Math.max(cursor, msg.id);
        fallbackIds.push(msg.id);
        if (env.STATE_KV) {
          await env.STATE_KV.delete(failureKey);
          await env.STATE_KV.delete('lastattempt:' + channel.handle + ':' + msg.id);
          await env.STATE_KV.delete(breakerKey);
          await env.STATE_KV.delete('cfails:' + channel.handle);
          await recordDeadLetter(env.STATE_KV, channel.handle, msg.id, outcome.reason, newFailures);
        }
        consecutive = 0;
        continue;
      }
      if (fb.rateLimited) await recordChannelFailure();
    }

    if (permanent) {
      // Permanently undeliverable (e.g. a video whose signed URL keeps
      // expiring, or a Discord validation rejection). Emitting it again just
      // fails again and wedges the cursor — which would block EVERY later
      // post in this channel forever. Record a dead letter, advance past it,
      // and keep the channel flowing.
      if (env.STATE_KV) {
        await recordDeadLetter(env.STATE_KV, channel.handle, msg.id,
          'permanent-giveup:' + (outcome.reason || 'unknown'), newFailures);
        await env.STATE_KV.delete(failureKey);
        await env.STATE_KV.delete('lastattempt:' + channel.handle + ':' + msg.id);
      }
      cursor = Math.max(cursor, msg.id);
      permanentIds.push(msg.id);
      consecutive = 0;
      continue;
    }

    // Failed but not permanently dead: it is retried on a later run once
    // RETRY_BACKOFF_MS has elapsed. Track consecutive failures for the
    // circuit breaker, and keep trying LATER posts in this batch — one bad
    // post must not silence the rest of the channel.
    consecutive++;
    failedIds.push(msg.id);
    if (consecutive >= 3 || channelFailures + (discordDown ? 1 : 0) >= 5) {
      // 3 consecutive failures in this run, or 5 Discord-side failures
      // recently = Discord outage / blanket 429s. Open the circuit breaker
      // (pause this channel 15 minutes) and stop this run: retrying the rest
      // would just burn CPU on a downstream that rejects everything.
      if (env.STATE_KV && !discordDown) {
        await env.STATE_KV.put('cfails:' + channel.handle, String(channelFailures + consecutive), { expirationTtl: 600 });
      }
      if (env.STATE_KV) {
        await env.STATE_KV.put(breakerKey, JSON.stringify({ open: new Date().toISOString() }), { expirationTtl: 15 * 60 });
      }
      circuitOpen = true;
      break;
    }
  }

  for (const { message, fingerprint, mapping } of await selectEditedMessages(messages, mappings)) {
    const result = await editDiscordMessage(webhookUrl, mapping.discordMessageId, message);
    if (result.status === 'ok') {
      mappings[String(message.id)] = { discordMessageId: mapping.discordMessageId, fingerprint };
      editedIds.push(message.id);
    } else if (result.status === 'gone') {
      delete mappings[String(message.id)];
    } else if (result.status === 'rate-limited') {
      // Discord 429: stop pacing the budget for this run, the remaining
      // edits will apply on a later run (fingerprints are unchanged).
      editFailedIds.push(message.id);
      break;
    } else {
      editFailedIds.push(message.id);
    }
    await new Promise(r => setTimeout(r, EDIT_PACING_MS));
  }

  if (env.STATE_KV && cursor > lastSeenId) await env.STATE_KV.put(kvKey, String(cursor));
  // Save mappings only when something changed — the 500-entry map is ~60KB
  // and rewriting it every 10s poll would burn the free KV write budget.
  if (env.STATE_KV && (postedIds.length || fallbackIds.length || editedIds.length || editFailedIds.length)) {
    await saveMappings(env.STATE_KV, channel.handle, mappings);
  }
  return {
    channel: channel.handle,
    status: failedIds.length || editFailedIds.length ? 'partial' : 'ok',
    postedCount: postedIds.length,
    postedIds, fallbackIds, skippedIds, failedIds, permanentIds, editedIds, editFailedIds, cursor,
    circuitOpen
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



async function discordPostResult(res) {
  if (!res.ok && res.status !== 204) return { status: 'failed', reason: 'discord-http-' + res.status };
  let discordMessageId = null;
  if (res.status === 200) {
    try { discordMessageId = (await res.json())?.id || null; } catch {}
  }
  return { status: 'posted', discordMessageId };
}

async function postFallback(webhookUrl, channelName, msg, reason) {
  const videoUrls = (msg.videos || []).map(v => v.url || v);
  let content = truncateContent(formatMessageContent(msg, videoUrls, reason));
  const payload = basePayload(channelName, content);
  const posters = (msg.videos || []).map(v => v.poster).filter(Boolean).slice(0, DISCORD_WEBHOOK_MAX_EMBEDS);
  if (posters.length) payload.embeds = posters.map(url => ({ image: { url } }));
  const res = await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!res.ok && res.status !== 204) return { ok: false, status: res.status, rateLimited: res.status === 429 };
  let discordMessageId = null;
  if (res.status === 200) {
    try { discordMessageId = (await res.json())?.id || null; } catch {}
  }
  return { ok: true, discordMessageId };
}

async function editDiscordMessage(webhookUrl, discordMessageId, msg) {
  const url = buildDiscordMessageUrl(webhookUrl, discordMessageId);
  const payload = buildEditPayload(msg);
  try {
    const res = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (res.ok) return { status: 'ok' };
    if (res.status === 404) return { status: 'gone' };
    if (res.status === 429) return { status: 'rate-limited', reason: 'discord-429' };
    return { status: 'failed', reason: 'discord-http-' + res.status };
  } catch {
    return { status: 'failed', reason: 'edit-network-error' };
  }
}

async function postToWebhook(webhookUrl, channelName, msg, videoBudget = { remaining: 2 }) {
  let content = truncateContent(formatMessageContent(msg));
  const videos = (msg.videos || []).slice(0, 4);

  if (videos.length) {
    if (videoBudget.remaining <= 0) {
      return { status: 'fallback', reason: 'video-batch-budget-exceeded' };
    }
    const files = [];
    for (let i = 0; i < videos.length; i++) {
      try {
        const head = await fetch(videos[i].url, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0' } });
        const length = Number(head.headers.get('content-length'));
        const decision = classifyVideo({ ok: head.ok, status: head.status, length });
        // oversize -> non-retryable link fallback; bad/unknown -> retryable
        if (decision.action !== 'upload') return { status: decision.action === 'fallback' ? 'fallback' : 'failed', reason: decision.reason, retryable: decision.action !== 'fallback' };

        const vidRes = await fetch(videos[i].url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!vidRes.ok) return { status: 'failed', reason: 'telegram-http-' + vidRes.status, retryable: true };
        const buf = await vidRes.arrayBuffer();
        files.push(new Blob([buf], { type: 'video/mp4' }));
      } catch (err) {
        return { status: 'failed', reason: 'video-network-error', retryable: true };
      }
    }

    videoBudget.remaining -= files.length;
    const form = new FormData();
    form.append('payload_json', JSON.stringify({
      ...basePayload(channelName, content),
      attachments: files.map((_, i) => ({ id: i, filename: 'video_' + msg.id + '_' + (i + 1) + '.mp4' }))
    }));
    files.forEach((blob, i) => form.append('files[' + i + ']', blob, 'video_' + msg.id + '_' + (i + 1) + '.mp4'));
    try {
      const res = await fetch(webhookUrl, { method: 'POST', body: form });
      if (res.ok || res.status === 204) return discordPostResult(res);
      // 413 = definitely too big -> non-retryable link fallback; 429/5xx -> retryable
      return { status: res.status === 413 ? 'fallback' : 'failed', reason: 'discord-http-' + res.status, retryable: res.status !== 413 };
    } catch {
      return { status: 'failed', reason: 'discord-network-error', retryable: true };
    }
  }

  // Handle voice notes / audio tracks
  const audios = msg.audios || [];
  if (audios.length) {
    const audio = audios[0];
    try {
      const audioRes = await fetch(audio.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (audioRes.ok) {
        const buf = await audioRes.arrayBuffer();
        if (buf.byteLength <= DISCORD_UPLOAD_SAFE_LIMIT) {
          const form = new FormData();
          const ext = audio.isVoice ? 'ogg' : 'mp3';
          const filename = `${audio.isVoice ? 'voice' : 'audio'}_${msg.id}.${ext}`;
          form.append('payload_json', JSON.stringify({
            ...basePayload(channelName, content),
            attachments: [{ id: 0, filename }]
          }));
          form.append('files[0]', new Blob([buf], { type: audio.isVoice ? 'audio/ogg' : 'audio/mpeg' }), filename);
          const res = await fetch(webhookUrl, { method: 'POST', body: form });
          if (res.ok || res.status === 204) return discordPostResult(res);
        }
      }
    } catch {
      // Network/download issue — fallback to link below
    }

    // Audio upload fallback link
    const audioLabel = audio.isVoice
      ? `🎙️ **Voice Message** ${audio.duration ? `(${audio.duration})` : ''}`
      : `🎵 **Audio**: ${[audio.title, audio.performer].filter(Boolean).join(' - ')} ${audio.duration ? `(${audio.duration})` : ''}`;
    const audioFallback = `${audioLabel} [▶️ Listen / Download](${audio.url})`;
    content = truncateContent([content, audioFallback].filter(Boolean).join('\n\n'));
  }

  const embeds = (msg.images || []).slice(0, DISCORD_WEBHOOK_MAX_EMBEDS).map(url => ({ image: { url } }));
  if (!content && !embeds.length) return { status: 'posted' };
  const payload = basePayload(channelName, content);
  if (embeds.length) payload.embeds = embeds;
  try {
    const res = await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return res.ok || res.status === 204 ? await discordPostResult(res) : { status: 'failed', reason: 'discord-http-' + res.status, retryable: res.status !== 413 };
  } catch {
    return { status: 'failed', reason: 'discord-network-error', retryable: true };
  }
}
