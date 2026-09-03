import assert from 'node:assert/strict';
import { buildFallbackContent, classifyVideo, healthFromLastRun, nextFailureAction, selectMessageBatch } from './src/reliability.js';

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

console.log('reliability tests OK');
