import { CHANNELS, fetchChannelMessages } from './telegram.js';

const DISCORD_WEBHOOK_MAX_EMBEDS = 4;

export default {
  // Cron Trigger - runs automatically every 1 minute
  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncAllChannels(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

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

  // Sync every channel independently - one failing must not block the others
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

  // Per-channel deduplication cursor in KV.
  // Legacy fallback: warroom's old single global key keeps history intact.
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
    // First run for this channel: seed with the newest message that has content
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

  for (const msg of newMessages) {
    if (!msg.hasContent) {
      // Empty payload would be rejected by Discord - advance past it silently
      skippedIds.push(msg.id);
      cursor = Math.max(cursor, msg.id);
      continue;
    }
    const outcome = await postToWebhook(webhookUrl, channel.name, msg);
    if (outcome === 'posted') {
      cursor = Math.max(cursor, msg.id);
      postedIds.push(msg.id);
    }
    // 'failed' -> cursor not advanced; it will retry next tick
  }

  if (env.STATE_KV && cursor > lastSeenId) {
    await env.STATE_KV.put(kvKey, cursor.toString());
  }

  return { channel: channel.handle, status: 'ok', postedCount: postedIds.length, postedIds, skippedIds, cursor };
}

async function postToWebhook(webhookUrl, channelName, msg) {
  let content = msg.text;
  if (content.length > 2000) {
    content = content.substring(0, 1995) + '...';
  }

  const embeds = (msg.images || []).map(imgUrl => ({ image: { url: imgUrl } })).slice(0, DISCORD_WEBHOOK_MAX_EMBEDS);

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
