// Discord helpers: webhook posting, interaction signature verification,
// slash-command registration, and deferred-response follow-ups.

const DISCORD_API = 'https://discord.com/api/v10';

// Post a message through the existing webhook (used by the cron sync)
export async function sendToDiscord(webhookUrl, channelName, msg) {
  let content = msg.text;
  if (content.length > 2000) {
    content = content.substring(0, 1995) + '...';
  }
  const embeds = (msg.images || []).map(imgUrl => ({ image: { url: imgUrl } })).slice(0, 4);
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

function hexToUint8Array(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

// Verify Discord's Ed25519 signature on incoming interaction POSTs
export async function verifyDiscordSignature(request, rawBody, env) {
  const signature = request.headers.get('X-Signature-Ed25519');
  const timestamp = request.headers.get('X-Signature-Timestamp');
  if (!signature || !timestamp || signature.length !== 128) return false;
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      hexToUint8Array(env.DISCORD_PUBLIC_KEY || ''),
      { name: 'Ed25519' },
      false,
      ['verify']
    );
    const enc = new TextEncoder();
    const msgData = enc.encode(timestamp + rawBody);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, hexToUint8Array(signature), msgData);
  } catch (err) {
    console.error('Signature verification error:', err);
    return false;
  }
}

// Register the /news slash command globally
export async function registerNewsCommand(env) {
  const res = await fetch(`${DISCORD_API}/applications/${env.DISCORD_APP_ID}/commands`, {
    method: 'POST',
    headers: {
      'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: 'news',
      description: 'Show the latest message from the synced Telegram channels',
      options: [{
        name: 'channel',
        description: 'Pick a specific channel (default: all channels)',
        type: 3,
        required: false,
        choices: [
          { name: 'WarRoom', value: 'warroom' },
          { name: 'Fighter Radar', value: 'fighter_radar' },
          { name: 'News Hut', value: 'news_hut' }
        ]
      }]
    })
  });
  return { status: res.status, body: await res.text() };
}

// Edit the deferred "thinking..." response with the final content
export async function editDeferredResponse(env, interaction, payload) {
  const url = `${DISCORD_API}/webhooks/${env.DISCORD_APP_ID}/${interaction.token}/messages/@original`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return res.ok;
}
