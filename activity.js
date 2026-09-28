// Bounded runtime Activity Feed (NOT durable notes). Newest last; persisted as a small
// JSON file under the data dir (gitignored, never served) so a restart keeps context.
'use strict';

const fs = require('fs');

const KINDS = ['agent', 'worker', 'approval', 'level', 'achievement', 'system', 'task'];
const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]+/g, ' ').slice(0, n);

function createActivity({ file = null, limit = 200, now = Date.now } = {}) {
  let items = [];
  if (file) { try { const x = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(x)) items = x.slice(-limit); } catch { /* fresh */ } }
  let seq = items.length ? items[items.length - 1].seq : 0;
  const persist = () => { if (file) { try { fs.writeFileSync(file, JSON.stringify(items)); } catch { /* best effort */ } } };
  function add(kind, text, meta = {}) {
    if (!KINDS.includes(kind)) kind = 'system';
    const t = clip(text, 200);
    const last = items[items.length - 1];
    if (last && last.kind === kind && last.text === t && now() - last.at < 60000) return last; // collapse repeats
    seq += 1;
    const item = { seq, at: now(), kind, text: t, level: ['ERROR', 'FAILED', 'INCIDENT'].some((w) => t.includes(w)) ? 'warn' : 'info', ref: clip(meta.ref, 60) || null };
    items.push(item);
    if (items.length > limit) items = items.slice(-limit);
    persist();
    return item;
  }
  const list = (n = 50) => items.slice(-Math.min(n, limit));
  return { add, list, KINDS };
}

module.exports = { createActivity };
