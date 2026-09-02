import { CHANNELS, fetchChannelMessages } from './telegram.js';

const DISCORD_WEBHOOK_MAX_EMBEDS = 4;
const DISCORD_MAX_UPLOAD_BYTES = 24 * 1024 * 1024; // 24 MB safe margin under Discord's 25 MB limit

export default {
  // Cron Trigger - runs automatically every 1 minute
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const result = await syncAllChannels(env);
      if (env.STATE_KV) {
        await env.STATE_KV.put('CRON_LAST_RUN', JSON.stringify({
          time: new Date().toISOString(),
          result
        }));
      }
    })());
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/status') {
      let lastRun = null;
      if (env.STATE_KV) {
        const raw = await env.STATE_KV.get('CRON_LAST_RUN');
        if (raw) try { lastRun = JSON.parse(raw); } catch (_) {}
      }
      return new Response(JSON.stringify({
        status: 'ok',
        worker: 'warroom',
        cronSchedule: '* * * * *',
        hasWebhookSecret: Boolean(env.DISCORD_WEBHOOK_URL),
        lastScheduledRun: lastRun
      }, null, 2), {
        headers: { 'content-type': 'application/json; charset=utf-8' }
      });
    }

    // Manual sync trigger (testing or forcing an immediate pull)
    if (url.pathname === '/test') {
      const result = await syncAllChannels(env);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'content-type': 'application/json; charset=utf-8' }
      });
    }

    return new Response('Telegram to Discord Sync Worker is running.', { status: 200 });
  }
};

async function syncAllChannels(env) {
  const webhookUrl = env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    return { error: 'DISCORD_WEBHOOK_URL environment variable is not configured.' };
  }

  const results = [];
  for (const channel of CHANNELS) {
    try {
      results.push(await syncChannel(channel, env, webhookUrl));
    } catch (err) {
      results.push({ channel: channel.handle, status: 'error', error: String(err && err.message || err) });
    }
  }
  return { status: 'ok', channels: results };
}

async function syncChannel(channel, env, webhookUrl) {
  const messages = await fetchChannelMessages(channel.handle);

  const kvKey = `last_seen:${channel.handle}`;
  let lastSeenId = 0;
  if (env.STATE_KV) {
    let val = await env.STATE_KV.get(kvKey);
    if (!val && channel.handle === 'warroom') {
      val = await env.STATE_KV.get('LAST_SEEN_ID');
    }
    if (val) lastSeenId = parseInt(val, 10);
  }

  let newMessages;
  if (lastSeenId === 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].hasContent) { newMessages = [messages[i]]; break; }
    }
  } else {
    newMessages = messages.filter(m => m.id > lastSeenId);
  }

  if (!newMessages || newMessages.length === 0) {
    return { channel: channel.handle, status: 'ok', postedCount: 0, lastSeenId, message: 'No new posts.' };
  }

  let cursor = lastSeenId;
  const postedIds = [];
  const skippedIds = [];
  const failedIds = [];

  for (const msg of newMessages) {
    if (!msg.hasContent) {
      skippedIds.push(msg.id);
      cursor = Math.max(cursor, msg.id);
      continue;
    }
    const outcome = await postToWebhook(webhookUrl, channel.name, msg);
    if (outcome === 'posted') {
      cursor = Math.max(cursor, msg.id);
      postedIds.push(msg.id);
      continue;
    }
    // Preserve ordering: never advance past a failed video/message.
    failedIds.push(msg.id);
    break;
  }

  if (env.STATE_KV && cursor > lastSeenId) {
    await env.STATE_KV.put(kvKey, cursor.toString());
  }

  return { channel: channel.handle, status: failedIds.length ? 'partial' : 'ok', postedCount: postedIds.length, postedIds, skippedIds, failedIds, cursor };
}

async function postToWebhook(webhookUrl, channelName, msg) {
  let content = msg.text || '';
  if (content.length > 2000) content = content.substring(0, 1995) + '...';

  const videos = (msg.videos || []).slice(0, 4);

  // Video posts must deliver the actual MP4. Never silently replace them with thumbnails.
  if (videos.length > 0) {
    const files = [];
    let totalBytes = 0;

    try {
      for (let i = 0; i < videos.length; i++) {
        const vidRes = await fetch(videos[i].url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!vidRes.ok) {
          console.error(`Telegram video fetch failed: HTTP ${vidRes.status} (post ${msg.id})`);
          return 'failed';
        }
        const buf = await vidRes.arrayBuffer();
        totalBytes += buf.byteLength;
        if (buf.byteLength === 0 || totalBytes > DISCORD_MAX_UPLOAD_BYTES) {
          console.error(`Video post ${msg.id} is empty or exceeds Discord's upload limit (${totalBytes} bytes)`);
          return 'failed';
        }
        files.push(new Blob([buf], { type: 'video/mp4' }));
      }

      const form = new FormData();
      form.append('payload_json', JSON.stringify({
        username: channelName,
        avatar_url: 'https://telegram.org/img/t_logo.png',
        content: content || undefined,
        attachments: files.map((_, i) => ({ id: i, filename: `video_${msg.id}_${i + 1}.mp4` }))
      }));
      files.forEach((blob, i) => form.append(`files[${i}]`, blob, `video_${msg.id}_${i + 1}.mp4`));

      const res = await fetch(webhookUrl, { method: 'POST', body: form });
      if (res.ok || res.status === 204) return 'posted';
      console.error(`Discord rejected video upload (HTTP ${res.status}):`, await res.text());
      return 'failed';
    } catch (err) {
      console.error(`Real video delivery failed for post ${msg.id}:`, err);
      return 'failed';
    }
  }

  // Non-video posts: normal text + image embeds.
  const embeds = (msg.images || []).slice(0, DISCORD_WEBHOOK_MAX_EMBEDS)
    .map(imgUrl => ({ image: { url: imgUrl } }));
  if (!content && embeds.length === 0) return 'empty';

  const payload = {
    username: channelName,
    avatar_url: 'https://telegram.org/img/t_logo.png',
    content: content || undefined
  };
  if (embeds.length > 0) payload.embeds = embeds;

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return (res.ok || res.status === 204) ? 'posted' : 'failed';
  } catch (err) {
    console.error('Failed to post to Discord webhook:', err);
    return 'failed';
  }
}
