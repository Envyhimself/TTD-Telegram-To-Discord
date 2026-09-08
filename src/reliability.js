export const DISCORD_UPLOAD_SAFE_LIMIT = 8 * 1024 * 1024;
export const MAX_RETRY_ATTEMPTS = 2;
export const HEALTH_STALE_MS = 180_000;
// Increased from 5 to 25 so multi-post bursts and busy news channels never lag
// or roll off the 20-message t.me/s/ preview window before getting forwarded.
export const MAX_MESSAGES_PER_RUN = 25;
export const MAX_VIDEO_UPLOADS_PER_RUN = 2;
export const DISCORD_WEBHOOK_MAX_EMBEDS = 10;

export const RUN_LOCK_TTL_SECONDS = 900;
export const RUN_LOCK_STALE_MS = 600_000;
// A post that fails this many times in a row is treated as permanently
// undeliverable (e.g. a video whose signed URL keeps expiring). Rather than
// wedge the channel cursor on it forever (which would block every later post
// and keep reporting 'partial'), the relay emits it as a dead-letter link and
// advances past it so the rest of the channel keeps flowing.
export const MAX_PERMANENT_FAILURES = 10;

export function lockShouldSkip(lockValue, now = Date.now()) {
  if (!lockValue) return false;
  const lockTime = new Date(lockValue).getTime();
  if (Number.isNaN(lockTime)) return false;
  return (now - lockTime) < RUN_LOCK_STALE_MS;
}

export function classifyVideoBatch(uploadedCount) {
  return uploadedCount < MAX_VIDEO_UPLOADS_PER_RUN ? 'upload' : 'fallback';
}

// Max Discord PATCH (edit) requests per channel per run. Keeps edit bursts
// (e.g. after a fingerprint upgrade or a large backfill) inside Discord's
// 5 req/s webhook rate limit and the worker's CPU budget.
export const MAX_EDITS_PER_RUN = 25;
export const DISCORD_CONTENT_MAX = 2000;

// Discord rejects content over 2000 chars; truncate with an ellipsis.
export function truncateContent(content) {
  if (!content) return content;
  if (content.length <= DISCORD_CONTENT_MAX) return content;
  return content.slice(0, DISCORD_CONTENT_MAX - 3) + '...';
}
// Min gap between retry attempts for a FAILED post. Without this, a
// rate-limited (429) or unreachable Discord gets hammered every 10s polling
// cycle until the give-up counter fires — spinning CPU for no progress.
export const RETRY_BACKOFF_MS = 90_000;
// Pacing between Discord edit requests (webhook budget is 5 req/s).
export const EDIT_PACING_MS = 250;

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

// Format the full text portion of a message (polls, documents, video/audio
// fallback links, forward header) before it goes to Discord.
export function formatMessageContent(msg, videoFallbackUrls = [], reason = '') {
  let content = (msg.text || '').trim();

  if (msg.poll) {
    const pollLines = [
      `📊 **${msg.poll.pollType || 'Poll'}**: **${msg.poll.question}**`,
      ...(msg.poll.options || []).map(o => `• ${o}`)
    ];
    content = [content, pollLines.join('\n')].filter(Boolean).join('\n\n');
  }

  if (msg.documents?.length) {
    const docLines = msg.documents.map(d => {
      const label = d.url ? `📁 **[${d.title}](${d.url})**` : `📁 **${d.title}**`;
      return d.extra ? `${label} (${d.extra})` : label;
    });
    content = [content, docLines.join('\n')].filter(Boolean).join('\n\n');
  }

  if (videoFallbackUrls.length) {
    const links = videoFallbackUrls.map((url, i) => `[Video ${i + 1}](${url})`).join('\n');
    const note = `*(Video delivered via direct link due to ${reason || 'file size / network'})*`;
    content = [content, links, note].filter(Boolean).join('\n\n');
  }

  if (msg.forwardedFrom) {
    const fwdHeader = msg.forwardedFrom.href
      ? `↪️ *Forwarded from [**${msg.forwardedFrom.name}**](${msg.forwardedFrom.href})*`
      : `↪️ *Forwarded from **${msg.forwardedFrom.name}***`;
    content = `${fwdHeader}\n\n${content}`.trim();
  }

  return content;
}

export function healthFromLastRun(lastRun, now = Date.now()) {
  if (!lastRun || !lastRun.time) return { healthy: false, reason: 'never-run' };
  const lastTime = new Date(lastRun.time).getTime();
  const ageMs = now - lastTime;
  if (Number.isNaN(lastTime)) return { healthy: false, reason: 'bad-timestamp' };
  // A run is still executing (40s polling window): the last recorded result
  // is mid-flight, not a failure.
  if ((lastRun.inProgress || lastRun.result?.inProgress) && ageMs < 180_000) {
    return { healthy: true, reason: 'in-progress' };
  }
  if (ageMs > HEALTH_STALE_MS) return { healthy: false, reason: 'cron-stale' };
  const status = lastRun.result?.status;
  if (status === 'ok') return { healthy: true, reason: 'ok' };
  // "partial" with NO stuck new posts is transient: edit failures and
  // fallbacks self-resolve on the next run without blocking new messages,
  // so it must not look unhealthy (it would trigger watchdog kick-spam).
  if (status === 'partial') {
    const channels = lastRun.result?.channels || [];
    const stuckPosts = channels.reduce((n, c) => n + (c?.failedIds?.length || 0), 0);
    const permanent = channels.reduce((n, c) => n + (c?.permanentIds?.length || 0), 0);
    if (stuckPosts === 0 && permanent === 0) {
      return { healthy: true, reason: 'recovering' };
    }
  }
  return { healthy: false, reason: `last-run-${status || 'failed'}` };
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
  const rawAudios = (msg.audios || []).map(a => {
    const raw = typeof a === 'string' ? a : (a.url || '');
    try { const parsed = new URL(raw); parsed.search = ''; return parsed.toString(); } catch { return raw; }
  }).sort().join('|');
  const rawDocs = (msg.documents || []).map(d => `${d.title || ''}:${d.extra || ''}`).sort().join('|');
  const pollFp = msg.poll ? `${msg.poll.question}:${(msg.poll.options || []).join(';')}` : '';

  const payload = `${text}::img:${rawImages}::vid:${rawVideos}::aud:${rawAudios}::doc:${rawDocs}::poll:${pollFp}`;
  const enc = new TextEncoder().encode(payload);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// The pre-v1.1.4 fingerprint only covered text + images + videos. Messages
// stored with that format (e.g. voice notes, which the old parser ignored)
// will hash differently under the new format even though their original
// content never changed. If text/images/videos are byte-identical to what
// the legacy hash was computed from, treat the stored mapping as current
// and skip the pointless re-edit.
export async function legacyFingerprintMessage(msg) {
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

export async function selectEditedMessages(currentMessages, mappings, limit = MAX_EDITS_PER_RUN) {
  const edits = [];
  for (const msg of currentMessages || []) {
    if (!msg.hasContent) continue;
    const mapping = mappings[String(msg.id)];
    if (!mapping || !mapping.discordMessageId) continue;
    const currentFp = await fingerprintMessage(msg);
    if (!mapping.fingerprint || mapping.fingerprint === currentFp) continue;
    // Stored hash was computed by the older, narrower fingerprint: only
    // re-edit if the original covered fields (text/images/videos) changed.
    if ((await legacyFingerprintMessage(msg)) === mapping.fingerprint) continue;
    edits.push({ message: msg, fingerprint: currentFp, mapping });
    if (edits.length >= limit) break;
  }
  return edits;
}

export function buildEditPayload(msg) {
  const videoUrls = (msg.videos || []).map(v => v.url || v);
  const content = truncateContent(formatMessageContent(msg, videoUrls, 'edited media'));
  const embeds = (msg.images || []).slice(0, DISCORD_WEBHOOK_MAX_EMBEDS).map(url => ({ image: { url } }));
  return {
    content: content || undefined,
    embeds,
    attachments: []
  };
}
