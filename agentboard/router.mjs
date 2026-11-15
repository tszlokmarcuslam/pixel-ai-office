#!/usr/bin/env node
// Router tap: an OpenAI-compatible pass-through in front of any AI router (OmniRoute, LiteLLM, OpenRouter, ...).
// Point your apps at http://localhost:4318/v1 instead of the router. Every model call is written to
// events.jsonl as "<model family> working/done/error", so the pixel office (/office) shows who is busy.
//   ROUTER_URL=http://localhost:20128 node agentboard/router.mjs      (OmniRoute's default port)
//   node agentboard/router.mjs --selftest
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const EVENTS = path.join(DIR, 'events.jsonl');
const TARGET = new URL(process.env.ROUTER_URL || 'http://localhost:20128');
const PORT = Number(process.env.TAP_PORT) || 4318;

const FAMILIES = [
  ['claude', /claude|anthropic|sonnet|opus|haiku/i],
  ['chatgpt', /gpt|openai|chatgpt|codex|(^|\/)o[1345](-|$)/i],
  ['deepseek', /deepseek/i],
  ['gemini', /gemini/i],
];
function family(model) {
  const m = String(model || '').trim();
  for (const [f, re] of FAMILIES) if (re.test(m)) return f;
  // unknown model: "qwen/qwen3-coder" -> "qwen", "meta-llama/llama-3.1" -> "llama"
  return (m.split('/').pop().split(/[-:.\d]/)[0] || 'router').toLowerCase().slice(0, 24);
}
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
function lastUser(j) {
  const text = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p?.text || '').join(' ') : '';
  const msgs = Array.isArray(j.messages) ? j.messages : Array.isArray(j.input) ? j.input : [];
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]?.role === 'user') return text(msgs[i].content);
  return typeof j.input === 'string' ? j.input : typeof j.prompt === 'string' ? j.prompt : '';
}
function emit(agent, state, detail, task, model) {
  const ev = { ts: new Date().toISOString(), agent, platform: 'router', state, detail: clip(detail, 60), task: clip(task, 120), model };
  try { fs.appendFileSync(EVENTS, JSON.stringify(ev) + '\n'); } catch { /* board is optional: never break the request */ }
}

if (process.argv[2] === '--selftest') {
  assert.equal(family('anthropic/claude-sonnet-4'), 'claude');
  assert.equal(family('gpt-4o-mini'), 'chatgpt');
  assert.equal(family('o3-mini'), 'chatgpt');
  assert.equal(family('deepseek-chat'), 'deepseek');
  assert.equal(family('google/gemini-2.5-pro'), 'gemini');
  assert.equal(family('qwen/qwen3-coder'), 'qwen');
  assert.equal(family('meta-llama/llama-3.1-70b'), 'llama');
  assert.equal(family(''), 'router');
  assert.equal(lastUser({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }, { role: 'assistant', content: 'x' }] }), 'hi');
  assert.equal(lastUser({ input: 'yo' }), 'yo');
  console.log('router.mjs selftest ok');
  process.exit(0);
}

const DROP_RES = ['content-encoding', 'content-length', 'transfer-encoding', 'connection'];
http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  let j = {};
  try { j = JSON.parse(body.toString('utf8')) || {}; } catch { /* not JSON: pass through untouched */ }
  const track = req.method === 'POST' && typeof j.model === 'string'; // model calls only, not /v1/models listings
  const ask = lastUser(j) || req.url;
  let agent = family(j.model), model = j.model;
  if (track) emit(agent, 'working', ask, ask, model);

  const headers = { ...req.headers };
  delete headers.host; delete headers['content-length']; delete headers.connection;
  let up;
  try {
    up = await fetch(new URL(req.url, TARGET), { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
  } catch (err) {
    if (track) emit(agent, 'error', 'Router unreachable', ask, model);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Router at ${TARGET.origin} unreachable: ${err.message}` } }));
    return;
  }
  const h = {};
  up.headers.forEach((v, k) => { if (!DROP_RES.includes(k)) h[k] = v; });
  res.writeHead(up.status, h);
  // The router may pick a different model than asked ("auto" combos): hand the task to whoever answers.
  let head = '', resolved = !track;
  try {
    if (up.body) for await (const c of up.body) {
      if (!resolved) {
        head += Buffer.from(c).toString('utf8');
        const m = /"model"\s*:\s*"([^"]+)"/.exec(head);
        if (m || head.length > 8192) {
          resolved = true;
          if (m && family(m[1]) !== agent) { emit(agent, 'idle', 'Handed off', ask, model); agent = family(m[1]); model = m[1]; emit(agent, 'working', ask, ask, model); }
        }
      }
      res.write(c);
    }
  } catch { up = { status: 599 }; }
  res.end();
  if (track) emit(agent, up.status < 400 ? 'done' : 'error', up.status < 400 ? ask : `HTTP ${up.status}`, ask, model);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Router tap: http://localhost:${PORT}/v1  ->  ${TARGET.origin}`);
  console.log('Point your apps here; watch them work at http://localhost:4317/office');
});
