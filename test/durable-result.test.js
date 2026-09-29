'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { finalAssistantText, fetchFullResult, MAX_RESULT_CHARS } = require('../durable-result');
const { startServer } = require('./helpers');

const done = { status: 'completed', childSessionKey: 'agent:researcher:subagent:x' };

test('final assistant text: last assistant message, text parts only', () => {
  assert.equal(finalAssistantText({ messages: [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: [{ type: 'text', text: 'full answer' }, { type: 'tool_use', name: 'x' }] },
    { role: 'user', content: 'tool result' },
  ] }), 'full answer');
  assert.equal(finalAssistantText({ messages: [{ role: 'assistant', content: 'plain' }] }), 'plain');
  assert.equal(finalAssistantText(null), '');
});

test('fetchFullResult: uses sessions.get read-only; falls back (null) on failure, NO_REPLY, missing key or non-completed', async () => {
  const calls = [];
  const rpc = async (m, p) => { calls.push([m, p]); return { messages: [{ role: 'assistant', content: 'An idempotency key is a unique identifier... (full, not truncated)' }] }; };
  assert.match(await fetchFullResult(rpc, done), /full, not truncated/);
  assert.deepEqual(calls, [['sessions.get', { sessionKey: done.childSessionKey }]]);
  assert.equal(await fetchFullResult(async () => ({ messages: [{ role: 'assistant', content: 'NO_REPLY' }] }), done), null);
  assert.equal(await fetchFullResult(async () => { throw new Error('gateway down'); }, done), null);
  assert.equal(await fetchFullResult(rpc, { status: 'failed', childSessionKey: 'k' }), null);
  assert.equal(await fetchFullResult(rpc, { status: 'completed' }), null);
  const long = await fetchFullResult(async () => ({ messages: [{ role: 'assistant', content: 'x'.repeat(MAX_RESULT_CHARS + 50) }] }), done);
  assert.ok(long.length < MAX_RESULT_CHARS + 20 && long.endsWith('[truncated]'));
});

test('sync: durable emission claims the id before the async fetch and releases it on failure', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'openclaw-pixel-sync.js'), 'utf8');
  const fn = src.slice(src.indexOf('const emitDurableTask = async'), src.indexOf('const str = (v, n)'));
  assert.ok(fn.indexOf('durableEmitted.add(eventId)') < fn.indexOf('await fetchFullResult'));
  assert.match(fn, /catch \(e\) \{\n\s+durableEmitted\.delete\(eventId\)/);
  assert.match(src, /childSessionKey: str\(t\.childSessionKey, 200\)/);
  assert.doesNotMatch(fn, /sessions\.(patch|send|delete|reset)/, 'read-only');
});

test('durable-result.js is not served over HTTP', async (t) => {
  const srv = await startServer({ BUSINESS_OS_KILLSWITCH_CLI: '/nonexistent/killswitch/system-kill.js' });
  t.after(() => srv.stop());
  const body = await (await fetch(srv.base + '/durable-result.js')).text();
  assert.doesNotMatch(body, /fetchFullResult/);
});
