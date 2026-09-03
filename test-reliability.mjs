import assert from 'node:assert/strict';
import { buildDiscordMessageUrl, buildEditPayload, buildFallbackContent, buildWaitWebhookUrl, classifyVideo, fingerprintMessage, healthFromLastRun, nextFailureAction, selectEditedMessages, selectMessageBatch } from './src/reliability.js';

assert.equal(classifyVideo({ ok: true, length: 13_791_398 }).action, 'fallback', 'oversize Discord upload must not be downloaded');
assert.equal(classifyVideo({ ok: true, length: 8_000_000 }).action, 'upload', 'small MP4 should upload');
assert.equal(classifyVideo({ ok: false, status: 403 }).action, 'retry', 'Telegram failure should retry');
assert.equal(classifyVideo({ ok: true, length: null }).action, 'retry', 'unknown size should not risk unbounded buffering');

assert.equal(nextFailureAction(1), 'retry');
assert.equal(nextFailureAction(2), 'retry');
assert.equal(nextFailureAction(3), 'fallback');

assert.equal(healthFromLastRun(null, Date.now()).healthy, false);
assert.equal(healthFromLastRun({ time: new Date(Date.now() - 30_000).toISOString(), result: { status: 'ok' } }, Date.now()).healthy, true);
assert.equal(healthFromLastRun({ time: new Date(Date.now() - 180_000).toISOString(), result: { status: 'ok' } }, Date.now()).healthy, false);
assert.equal(healthFromLastRun({ time: new Date().toISOString(), result: { status: 'error' } }, Date.now()).healthy, false);

const messages = [
  { id: 1, hasContent: true }, { id: 2, hasContent: true }, { id: 3, hasContent: true },
  { id: 4, hasContent: true }, { id: 5, hasContent: true }, { id: 6, hasContent: true }
];
assert.deepEqual(selectMessageBatch(messages, 0).map(m => m.id), [6], 'first run only takes newest content');
assert.deepEqual(selectMessageBatch(messages, 1).map(m => m.id), [2, 3, 4, 5, 6], 'catch-up is bounded');
assert.deepEqual(selectMessageBatch(messages, 4).map(m => m.id), [5, 6], 'small backlog is complete');

const long = 'x'.repeat(2000);
const fb = buildFallbackContent(long, ['https://cdn.example/v1.mp4'], 'discord-upload-limit');
assert.ok(fb.length <= 2000, 'fallback fits Discord limit');
assert.ok(fb.includes('https://cdn.example/v1.mp4'), 'download link survives truncation');
const fb2 = buildFallbackContent('short', ['https://cdn.example/a.mp4', 'https://cdn.example/b.mp4'], null);
assert.ok(fb2.includes('a.mp4') && fb2.includes('b.mp4'), 'multi-video links kept');

const original = { id: 10, text: 'before', images: ['https://img/1.jpg'], videos: [] };
const edited = { ...original, text: 'after' };
assert.notEqual(await fingerprintMessage(original), await fingerprintMessage(edited), 'text edits change fingerprint');
assert.equal(await fingerprintMessage(original), await fingerprintMessage({ ...original, images: ['https://img/1.jpg'] }), 'same content is stable');
const mappings = { 10: { discordMessageId: '999', fingerprint: await fingerprintMessage(original) } };
assert.deepEqual((await selectEditedMessages([edited], mappings)).map(x => x.message.id), [10], 'changed mapped post is selected');
assert.deepEqual(await selectEditedMessages([original], mappings), [], 'unchanged mapped post is ignored');
assert.equal(buildWaitWebhookUrl('https://discord.com/api/webhooks/1/token'), 'https://discord.com/api/webhooks/1/token?wait=true');
assert.equal(buildWaitWebhookUrl('https://discord.com/api/webhooks/1/token?thread_id=2'), 'https://discord.com/api/webhooks/1/token?thread_id=2&wait=true');
assert.equal(buildDiscordMessageUrl('https://discord.com/api/webhooks/1/token?thread_id=2', '999'), 'https://discord.com/api/webhooks/1/token/messages/999?thread_id=2');

// Signed Telegram video URLs rotate on every fetch; same video file must not
// look like an edit when only the signature query string changes.
const signedA = 'https://cdn.example/t/videocache/x.mp4?a=1&expire=100&token=old';
const signedB = 'https://cdn.example/t/videocache/x.mp4?a=2&expire=200&token=new';
const vMsgA = { id: 20, text: 't', images: [], videos: [{ url: signedA, poster: null }] };
const vMsgB = { id: 20, text: 't', images: [], videos: [{ url: signedB, poster: null }] };
assert.equal(await fingerprintMessage(vMsgA), await fingerprintMessage(vMsgB), 'rotated video signature is not an edit');
const vmappings = { 20: { discordMessageId: '555', fingerprint: await fingerprintMessage(vMsgA) } };
assert.deepEqual(await selectEditedMessages([vMsgB], vmappings), [], 'no edit detected for signature rotation');
const vEdited = { ...vMsgA, text: 'edited' };
assert.equal((await selectEditedMessages([vEdited], vmappings)).length, 1, 'text change on video post is an edit');
const editPayload = buildEditPayload({ text: 'updated', images: [], videos: [] });
assert.deepEqual(editPayload, { content: 'updated', embeds: [], attachments: [] }, 'edit clears removed media');
const videoEdit = buildEditPayload({ text: 'updated', images: [], videos: [{ url: 'https://cdn.example/v.mp4' }] });
assert.ok(videoEdit.content.includes('https://cdn.example/v.mp4') && videoEdit.content.length <= 2000, 'edited video stays accessible');

console.log('reliability tests OK');
