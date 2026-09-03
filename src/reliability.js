export const SAFE_DISCORD_UPLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_FAILURES_BEFORE_FALLBACK = 3;
export const HEALTH_STALE_MS = 150_000;
export const MAX_MESSAGES_PER_RUN = 5;

export function selectMessageBatch(messages, lastSeenId, limit = MAX_MESSAGES_PER_RUN) {
  if (!lastSeenId) {
    const newest = [...messages].reverse().find(m => m.hasContent);
    return newest ? [newest] : [];
  }
  return messages.filter(m => m.id > lastSeenId).slice(0, limit);
}

export function classifyVideo({ ok, status = 0, length }) {
  if (!ok) return { action: 'retry', reason: `telegram-http-${status || 'error'}` };
  if (!Number.isFinite(length) || length <= 0) return { action: 'retry', reason: 'unknown-size' };
  if (length > SAFE_DISCORD_UPLOAD_BYTES) return { action: 'fallback', reason: 'discord-upload-limit', length };
  return { action: 'upload', length };
}

export function nextFailureAction(count) {
  return count >= MAX_FAILURES_BEFORE_FALLBACK ? 'fallback' : 'retry';
}

// Builds a <=2000-char Discord body for a message whose video could not be
// uploaded. The download link is guaranteed to survive truncation.
export function buildFallbackContent(text, videoUrls, reason) {
  const links = videoUrls.map((u, i) => `[Download video ${i + 1}](${u})`).join('\n');
  const note = `⚠️ Video sent as a link${reason ? ` (${reason})` : ''}.`;
  const suffix = [links, note].filter(Boolean).join('\n\n');
  if (!text) return suffix.slice(0, 2000);
  if (!suffix) return text.slice(0, 2000);

  const overhead = 2; // '\n\n' separator length
  const maxHeadLen = Math.max(0, 2000 - suffix.length - overhead);
  if (text.length <= maxHeadLen) return `${text}\n\n${suffix}`;
  if (maxHeadLen <= 1) return suffix.slice(0, 2000);
  const head = text.slice(0, maxHeadLen - 1) + '…';
  return `${head}\n\n${suffix}`;
}

export function buildEditPayload(msg) {
  const videoUrls = (msg.videos || []).map(v => v.url || v);
  const content = videoUrls.length
    ? buildFallbackContent(msg.text, videoUrls, 'edited media')
    : (msg.text || '').slice(0, 2000);
  const embeds = (msg.images || []).slice(0, 4).map(url => ({ image: { url } }));
  return { content, embeds, attachments: [] };
}

export function buildDiscordMessageUrl(webhookUrl, discordMessageId) {
  const url = new URL(webhookUrl);
  url.pathname = `${url.pathname}/messages/${discordMessageId}`;
  return url.toString();
}

// Signed Telegram video URLs rotate on every fetch, so fingerprints normalize
// video URLs to origin+path; image URLs and converted text are stable.
export function normalizeVideoUrl(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

export async function fingerprintMessage(msg) {
  const data = [
    msg.text || '',
    (msg.images || []).map(normalizeVideoUrl).join('|'),
    (msg.videos || []).map(v => normalizeVideoUrl(v.url || v)).join('|')
  ].join('\u0000');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Returns mapped posts whose Telegram-side content changed since last delivery.
export async function selectEditedMessages(messages, mappings) {
  const out = [];
  for (const message of messages) {
    const mapping = mappings[String(message.id)];
    if (!mapping || !mapping.fingerprint) continue;
    const fingerprint = await fingerprintMessage(message);
    if (fingerprint !== mapping.fingerprint) out.push({ message, fingerprint, mapping });
  }
  return out;
}

export function buildWaitWebhookUrl(webhookUrl) {
  const url = new URL(webhookUrl);
  if (!url.searchParams.has('wait')) url.searchParams.set('wait', 'true');
  return url.toString();
}

export function healthFromLastRun(lastRun, now = Date.now()) {
  if (!lastRun || !lastRun.time) return { healthy: false, reason: 'never-ran', ageMs: null };
  const ageMs = Math.max(0, now - Date.parse(lastRun.time));
  if (!Number.isFinite(ageMs) || ageMs > HEALTH_STALE_MS) return { healthy: false, reason: 'cron-stale', ageMs };
  const channels = lastRun.result?.channels || [];
  const bad = channels.filter(c => c.status !== 'ok');
  if (lastRun.result?.status === 'error' || bad.length) return { healthy: false, reason: 'channel-errors', ageMs, badChannels: bad.map(c => c.channel) };
  return { healthy: true, reason: 'ok', ageMs };
}
