// Full durable result for Business OS notes.
// OpenClaw's task record only carries a ~120-char progressSummary ("…"). For a completed
// task with a child session, the final assistant message is read (read-only
// `sessions.get`) and used as the durable result. Any failure falls back to the summary.
'use strict';

const MAX_RESULT_CHARS = 20000;

function finalAssistantText(res) {
  const msgs = res && Array.isArray(res.messages) ? res.messages : [];
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (!m || m.role !== 'assistant') continue;
    const c = m.content;
    const text = typeof c === 'string' ? c
      : Array.isArray(c) ? c.filter((x) => x && x.type === 'text' && typeof x.text === 'string').map((x) => x.text).join('\n') : '';
    if (text.trim()) return text.trim();
  }
  return '';
}

async function fetchFullResult(rpc, task) {
  if (!task || task.status !== 'completed' || typeof task.childSessionKey !== 'string' || !task.childSessionKey) return null;
  try {
    const text = finalAssistantText(await rpc('sessions.get', { sessionKey: task.childSessionKey }));
    if (!text || /^NO_REPLY$/i.test(text)) return null; // a yielded turn has no result yet
    return text.length > MAX_RESULT_CHARS ? text.slice(0, MAX_RESULT_CHARS) + '\n\n[truncated]' : text;
  } catch {
    return null;
  }
}

module.exports = { finalAssistantText, fetchFullResult, MAX_RESULT_CHARS };
