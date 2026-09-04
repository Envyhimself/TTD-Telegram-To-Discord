export const DISCORD_UPLOAD_SAFE_LIMIT = 8 * 1024 * 1024;
export const MAX_RETRY_ATTEMPTS = 2;
export const HEALTH_STALE_MS = 180_000;
export const MAX_MESSAGES_PER_RUN = 5;
export const MAX_VIDEO_UPLOADS_PER_RUN = 2;

export const RUN_LOCK_TTL_SECONDS = 900;
export const RUN_LOCK_STALE_MS = 600_000;

export function lockShouldSkip(lockValue, now = Date.now()) {
  if (!lockValue) return false;
  const lockTime = new Date(lockValue).getTime();
  if (Number.isNaN(lockTime)) return false;
  return (now - lockTime) < RUN_LOCK_STALE_MS;
}

export function classifyVideoBatch(uploadedCount) {
  return uploadedCount < MAX_VIDEO_UPLOADS_PER_RUN ? 'upload' : 'fallback';
}

export function classifyVideo(headResponse) {
  if (!headResponse || !headResponse.ok) {
    return { action: 'retry', reason: 'telegram-head-failed' };
  }
  const length = Number(headResponse.length);
  if (!Number.isFinite(length) || length <= 0) {
    return { action: 'retry', reason: 'telegram-unknown-length' };
  }
  if (length > DISCORD_UPLOAD_SAFE_LIMIT) {
    return { action: 'fallback', reason: 'discord-upload-limit' };
  }
  return { action: 'upload', length };
}

export function nextFailureAction(attempts) {
  return attempts >= MAX_RETRY_ATTEMPTS ? 'fallback' : 'retry';
}

export function buildFallbackContent(text, videoUrls = [], reason = 'file size / network') {
  const links = videoUrls.map((url, i) => `[Video ${i + 1}](${url})`).join('\n');
  const note = `*(Video delivered via direct link due to ${reason})*`;
  return [text, links, note].filter(Boolean).join('\n\n');
}

export function selectMessageBatch(messages, lastSeenId, maxMessages = MAX_MESSAGES_PER_RUN) {
  return (messages || [])
    .filter(m => m.id > lastSeenId)
    .sort((a, b) => a.id - b.id)
    .slice(0, maxMessages);
}

export function healthFromLastRun(lastRun, now = Date.now()) {
  if (!lastRun || !lastRun.time) return { healthy: false, reason: 'never-run' };
  const lastTime = new Date(lastRun.time).getTime();
  if (Number.isNaN(lastTime) || (now - lastTime) > HEALTH_STALE_MS) {
    return { healthy: false, reason: 'cron-stale' };
  }
  const status = lastRun.result?.status;
  if (status !== 'ok') {
    return { healthy: false, reason: `last-run-${status || 'failed'}` };
  }
  return { healthy: true, reason: 'ok' };
}

export function buildWaitWebhookUrl(url) {
  if (!url) return url;
  const parsed = new URL(url);
  parsed.searchParams.set('wait', 'true');
  return parsed.toString();
}

export function buildDiscordMessageUrl(webhookUrl, messageId) {
  const parsed = new URL(webhookUrl);
  parsed.search = '';
  const base = parsed.toString().replace(/\/+$/, '');
  return `${base}/messages/${messageId}`;
}

export async function fingerprintMessage(msg) {
  const text = (msg.text || '').trim();
  const rawImages = (msg.images || []).map(u => {
    try { const parsed = new URL(u); parsed.search = ''; return parsed.toString(); } catch { return u; }
  }).sort().join('|');
  const rawVideos = (msg.videos || []).map(v => {
    const raw = typeof v === 'string' ? v : (v.url || '');
    try { const parsed = new URL(raw); parsed.search = ''; return parsed.toString(); } catch { return raw; }
  }).sort().join('|');

  const payload = `${text}::img:${rawImages}::vid:${rawVideos}`;
  const enc = new TextEncoder().encode(payload);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function selectEditedMessages(currentMessages, mappings) {
  const edits = [];
  for (const msg of currentMessages || []) {
    if (!msg.hasContent) continue;
    const mapping = mappings[String(msg.id)];
    if (!mapping || !mapping.discordMessageId) continue;
    const currentFp = await fingerprintMessage(msg);
    if (mapping.fingerprint && mapping.fingerprint !== currentFp) {
      edits.push({ message: msg, fingerprint: currentFp, mapping });
    }
  }
  return edits;
}

export function buildEditPayload(msg) {
  const videoUrls = (msg.videos || []).map(v => v.url || v);
  const content = videoUrls.length
    ? buildFallbackContent(msg.text, videoUrls, 'edited media')
    : (msg.text || '');
  const embeds = (msg.images || []).slice(0, 4).map(url => ({ image: { url } }));
  return {
    content: content || undefined,
    embeds,
    attachments: []
  };
}
