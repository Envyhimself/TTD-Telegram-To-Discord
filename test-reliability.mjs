import assert from 'node:assert/strict';
import {
  buildDiscordMessageUrl,
  buildEditPayload,
  buildFallbackContent,
  buildWaitWebhookUrl,
  classifyVideo,
  classifyVideoBatch,
  fingerprintMessage,
  formatMessageContent,
  healthFromLastRun,
  legacyFingerprintMessage,
  lockShouldSkip,
  nextFailureAction,
  selectEditedMessages,
  selectMessageBatch
} from './src/reliability.js';

assert.equal(classifyVideoBatch(0), 'upload', 'first video uploads');
assert.equal(classifyVideoBatch(1), 'upload', 'second video uploads');
assert.equal(classifyVideoBatch(2), 'fallback', 'third+ video in single run falls back to link');

assert.equal(classifyVideo({ ok: true, length: 13_791_398 }).action, 'fallback', 'oversize Discord upload must not be downloaded');
assert.equal(classifyVideo({ ok: true, length: 8_000_000 }).action, 'upload', 'small MP4 should upload');
assert.equal(classifyVideo({ ok: false, status: 403 }).action, 'retry', 'Telegram failure should retry');
assert.equal(classifyVideo({ ok: true, length: null }).action, 'retry', 'unknown size should not risk unbounded buffering');

assert.equal(nextFailureAction(1), 'retry');
assert.equal(nextFailureAction(2), 'fallback');

const msgs = Array.from({ length: 30 }, (_, i) => ({ id: i + 10, text: 'msg ' + i }));
const batch = selectMessageBatch(msgs, 9);
assert.equal(batch.length, 25, 'batch is capped at 25 so busy channels never lag behind the preview window');
assert.equal(batch[0].id, 10);
assert.equal(batch[24].id, 34);

assert.equal(healthFromLastRun(null).healthy, false);
assert.equal(healthFromLastRun({ time: new Date().toISOString(), result: { status: 'ok' } }).healthy, true);
assert.equal(healthFromLastRun({ time: new Date(Date.now() - 190_000).toISOString(), result: { status: 'ok' } }).healthy, false);
// partial with no stuck posts = transient (edits/fallbacks resolve next run) — NOT unhealthy
assert.equal(healthFromLastRun({ time: new Date().toISOString(), result: { status: 'partial', channels: [{ failedIds: [] }] } }).healthy, true);
// partial WITH a stuck new post = unhealthy (watchdog should kick)
assert.equal(healthFromLastRun({ time: new Date().toISOString(), result: { status: 'partial', channels: [{ failedIds: [123] }] } }).healthy, false);
assert.equal(healthFromLastRun({ time: new Date().toISOString(), result: { status: 'error' } }).healthy, false);
assert.equal(healthFromLastRun({ time: new Date().toISOString(), inProgress: true, result: { status: 'in-progress', channels: [] } }).healthy, true);

assert.equal(lockShouldSkip(null), false, 'no lock -> run');
assert.equal(lockShouldSkip(new Date().toISOString()), true, 'fresh lock (<10m) -> skip');
assert.equal(lockShouldSkip(new Date(Date.now() - 700_000).toISOString()), false, 'stale lock (>10m) -> break lock and run');

const waitUrl = buildWaitWebhookUrl('https://discord.com/api/webhooks/123/abc');
assert.equal(waitUrl, 'https://discord.com/api/webhooks/123/abc?wait=true');
assert.equal(buildWaitWebhookUrl('https://discord.com/api/webhooks/123/abc?wait=true'), 'https://discord.com/api/webhooks/123/abc?wait=true');

const editUrl = buildDiscordMessageUrl('https://discord.com/api/webhooks/123/abc', '999');
assert.equal(editUrl, 'https://discord.com/api/webhooks/123/abc/messages/999');

const fp1 = await fingerprintMessage({ id: 1, text: 'hello', images: ['https://t.me/i/1.jpg?token=abc'] });
const fp2 = await fingerprintMessage({ id: 1, text: 'hello', images: ['https://t.me/i/1.jpg?token=xyz'] });
assert.equal(fp1, fp2, 'changing query tokens on image URLs must not trigger fake edits');

const fp3 = await fingerprintMessage({ id: 1, text: 'hello edited', images: ['https://t.me/i/1.jpg'] });
assert.notEqual(fp1, fp3, 'changed text must trigger edit');

const editPayload = buildEditPayload({ text: 'updated', images: [], videos: [] });
assert.deepEqual(editPayload, { content: 'updated', embeds: [], attachments: [] }, 'edit clears removed media');

const pollContent = formatMessageContent({
  text: 'Pick a side',
  poll: { question: 'Winner?', pollType: 'Poll', options: ['A (50%)', 'B (50%)'] }
});
assert.ok(pollContent.includes('Winner?') && pollContent.includes('A (50%)'), 'poll renders question + options');

const docContent = formatMessageContent({
  text: 'Patch notes',
  documents: [{ title: 'notes.pdf', extra: '2.3 MB', url: 'https://example.com/notes.pdf' }]
});
assert.ok(docContent.includes('notes.pdf') && docContent.includes('2.3 MB'), 'document renders title + size');

const fwdContent = formatMessageContent({
  text: 'body',
  forwardedFrom: { name: 'Some Channel', href: 'https://t.me/somechannel' }
});
assert.ok(fwdContent.includes('Forwarded from [**Some Channel**](https://t.me/somechannel)'), 'forward header prepends linked');
assert.equal(fwdContent.indexOf('↪️'), 0, 'forward header comes first');

const audioFp = await fingerprintMessage({ id: 1, text: '', audios: [{ url: 'https://cdn.telegram.org/x.ogg?token=a' }] });
const audioFp2 = await fingerprintMessage({ id: 1, text: '', audios: [{ url: 'https://cdn.telegram.org/x.ogg?token=b' }] });
assert.equal(audioFp, audioFp2, 'audio URL token changes must not trigger fake edits');
assert.notEqual(audioFp, '0'.repeat(64), 'audio-only message has a real fingerprint');

// Legacy-fingerprint compatibility: a mapping stored by v1.1.3 (text+img+vid
// only) must NOT be treated as "edited" just because the new fingerprint
// format now also hashes audio/polls/docs — unless those legacy fields changed.
const legacyMsg = { id: 9, text: 'hello', images: [], videos: [], audios: [{ url: 'https://cdn/x.ogg' }], hasContent: true };
const legacyFp = await legacyFingerprintMessage(legacyMsg);
const newFp = await fingerprintMessage(legacyMsg);
assert.notEqual(newFp, legacyFp, 'new format hash differs for a voice note (audio now hashed)');
const legacyMappings = { '9': { discordMessageId: '111', fingerprint: legacyFp } };
const legacyEdits = await selectEditedMessages([legacyMsg], legacyMappings);
assert.equal(legacyEdits.length, 0, 'unchanged voice note with a legacy fingerprint must not be re-edited');
const changedMsg = { ...legacyMsg, text: 'hello CHANGED' };
const changedEdits = await selectEditedMessages([changedMsg], legacyMappings);
assert.equal(changedEdits.length, 1, 'a real text change under a legacy fingerprint must still be edited');

// Edit candidate cap
const manyEdits = await selectEditedMessages(
  Array.from({ length: 40 }, (_, i) => ({ id: 100 + i, text: 't' + i, images: [], videos: [], hasContent: true })),
  Object.fromEntries(Array.from({ length: 40 }, (_, i) => [String(100 + i), { discordMessageId: 'x', fingerprint: 'deadbeef' }])),
);
assert.equal(manyEdits.length, 25, 'edit candidates are capped at MAX_EDITS_PER_RUN');

console.log('test-reliability OK');
