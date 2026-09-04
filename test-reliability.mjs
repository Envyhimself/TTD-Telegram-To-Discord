import assert from 'node:assert/strict';
import {
  buildDiscordMessageUrl,
  buildEditPayload,
  buildFallbackContent,
  buildWaitWebhookUrl,
  classifyVideo,
  classifyVideoBatch,
  fingerprintMessage,
  healthFromLastRun,
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

const batch = selectMessageBatch([
  { id: 10, text: 'a' },
  { id: 11, text: 'b' },
  { id: 12, text: 'c' },
  { id: 13, text: 'd' },
  { id: 14, text: 'e' },
  { id: 15, text: 'f' }
], 9);
assert.equal(batch.length, 5, 'batch size must be capped to 5 to protect worker limits');
assert.equal(batch[0].id, 10);
assert.equal(batch[4].id, 14);

assert.equal(healthFromLastRun(null).healthy, false);
assert.equal(healthFromLastRun({ time: new Date().toISOString(), result: { status: 'ok' } }).healthy, true);
assert.equal(healthFromLastRun({ time: new Date(Date.now() - 190_000).toISOString(), result: { status: 'ok' } }, Date.now()).healthy, false);
assert.equal(healthFromLastRun({ time: new Date().toISOString(), result: { status: 'partial' } }).healthy, false);

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

console.log('test-reliability OK');
