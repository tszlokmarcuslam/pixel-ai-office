#!/usr/bin/env node
// AgentBoard server: serves the dashboard, /team.json, and streams agentboard/events.jsonl
// to the page over Server-Sent Events. No dependencies.
//   node agentboard/server.mjs            -> http://localhost:4317
//   PORT=5000 node agentboard/server.mjs  -> another port
//
// SSE ids are "<generation>:<byte offset>". The generation names one version of events.jsonl
// (its inode plus a count of truncations/rewrites this process has seen). A reconnecting page
// gets only what it missed when its Last-Event-ID has the current generation; otherwise it
// gets `reset` and the full replay.
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '..');
const PAGE = path.join(DIR, 'index.html');
const TEAM = path.join(DIR, 'team.json');
const EVENTS = path.join(DIR, 'events.jsonl');
const PORT = Number(process.env.PORT) || 4317;
const HOST = process.env.HOST || '127.0.0.1';
const REPLAY_MAX_BYTES = 8 * 1024 * 1024; // replay at most the last 8 MB of history
const NL = 0x0a;
const EMPTY = Buffer.alloc(0);

const clients = new Set();
let offset = 0;        // bytes of events.jsonl already read (complete lines + carry)
let carry = EMPTY;     // bytes of a partial last line not yet terminated by \n (raw bytes: may end mid-character)
let ino = 0;           // inode of events.jsonl when last read (0 = missing)
let mtime = 0;         // its mtime then, to skip idle polls
let resets = 0;        // truncations/replacements seen by this process
let gen = '0.0';       // generation tag used in SSE ids
let reading = false;
let again = false;

const setGen = () => { gen = `${ino.toString(36)}.${resets}`; };
const id = (end) => `${gen}:${end}`;
const lineEnd = () => offset - carry.length; // byte offset just after the last complete line

function stat() {
  try { return fs.statSync(EVENTS); } catch { return null; }
}

// Raw bytes [start, end) of events.jsonl; shorter if the file shrank meanwhile.
function readRange(start, end) {
  if (end <= start) return EMPTY;
  const fd = fs.openSync(EVENTS, 'r');
  try {
    const buf = Buffer.alloc(end - start);
    const n = fs.readSync(fd, buf, 0, buf.length, start);
    return n === buf.length ? buf : buf.subarray(0, n);
  } finally { fs.closeSync(fd); }
}

function sse(res, { event, id, data }) {
  let out = '';
  if (event) out += `event: ${event}\n`;
  if (id !== undefined) out += `id: ${id}\n`;
  out += `data: ${data}\n\n`;
  res.write(out);
}

// Split bytes into complete lines (split on byte 0x0A, so a multi-byte character is never cut),
// tagging each with the byte offset just after its \n.
function* lines(buf, base) {
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(NL, pos);
    if (nl === -1) return;
    const line = buf.toString('utf8', pos, nl).trim();
    pos = nl + 1;
    if (line) yield { line, end: base + pos };
  }
}

// A valid event, re-serialised so stray raw CRs (legal JSON whitespace) can't break SSE framing; else null.
function eventJson(line) {
  try {
    const e = JSON.parse(line);
    return e && typeof e.agent === 'string' && typeof e.state === 'string' ? JSON.stringify(e) : null;
  } catch { return null; }
}

function broadcast(msg) {
  for (const res of clients) { try { sse(res, msg); } catch { clients.delete(res); } }
}

// Is `end` (a line end we handed out) still a line end in the current file?
function boundaryAt(end) {
  if (end <= 0) return true;
  try { const b = readRange(end - 1, end); return b.length === 1 && b[0] === NL; } catch { return false; }
}

// Read whatever was appended since `offset` and push complete lines to every client.
function pump() {
  if (reading) { again = true; return; }
  reading = true;
  try {
    const st = stat();
    const size = st ? st.size : 0, curIno = st ? st.ino : 0, curMtime = st ? st.mtimeMs : 0;
    if (curIno === ino && size === offset && curMtime === mtime) return; // nothing new
    let fresh = curIno !== ino || size < offset;
    if (ino === 0 && offset === 0) fresh = false; // the file just appeared: nothing to undo
    // Same inode and not shorter: make sure the bytes before `offset` are still the ones we read
    // (a rewrite in place can leave the file as long or longer).
    let chunk = EMPTY;
    if (!fresh && size >= offset) {
      if (offset > 0) {
        const buf = readRange(offset - 1, size);
        const want = carry.length ? carry[carry.length - 1] : NL;
        if (buf.length === 0 || buf[0] !== want) fresh = true;
        else chunk = buf.subarray(1);
      } else chunk = readRange(0, size);
    }
    if (fresh) {                        // truncated or replaced: start over everywhere
      offset = 0; carry = EMPTY; resets++;
      ino = curIno; setGen();
      broadcast({ event: 'reset', id: id(0), data: '{}' });
      chunk = readRange(0, size);
    } else if (curIno !== ino) { ino = curIno; setGen(); }
    mtime = curMtime;
    if (!chunk.length) return;
    const base = lineEnd();
    const data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    offset += chunk.length;            // what was actually read, not what stat said
    const lastNl = data.lastIndexOf(NL);
    carry = lastNl === data.length - 1 ? EMPTY : Buffer.from(data.subarray(lastNl + 1));
    if (lastNl === -1) return;
    for (const { line, end } of lines(data.subarray(0, lastNl + 1), base)) {
      const json = eventJson(line);
      if (json) broadcast({ event: 'agent-event', id: id(end), data: json });
    }
  } catch { /* file may be mid-write or missing; next tick retries */ }
  finally {
    reading = false;
    if (again) { again = false; setImmediate(pump); }
  }
}

// Send history to one client: everything after `from` (a byte offset at a line end), capped.
function replay(res, from) {
  const size = lineEnd();              // only complete lines that have been read; later ones arrive via pump()
  let start = Math.max(0, Math.min(from, size));
  if (size - start > REPLAY_MAX_BYTES) start = size - REPLAY_MAX_BYTES;
  let buf = EMPTY;
  try {
    if (start > 0 && start !== from) { // we may have jumped into the middle of a line: drop up to the next \n
      buf = readRange(start - 1, size);
      const nl = buf.indexOf(NL);
      const skip = nl === -1 ? buf.length : nl + 1;
      start += skip - 1;
      buf = buf.subarray(skip);
    } else buf = readRange(start, size);
  } catch { buf = EMPTY; }
  const batch = [];
  let last = start;
  for (const { line, end } of lines(buf, start)) {
    const json = eventJson(line);
    if (json) batch.push(json);
    last = end;
  }
  // One message for the whole history keeps a large replay fast.
  sse(res, { event: 'replay', id: id(last), data: `[${batch.join(',')}]` });
}

// Start at the current end. Byte-precise: if the file doesn't end in \n, the tail is a partial line we'll finish later.
{
  const st = stat();
  if (st) {
    ino = st.ino; mtime = st.mtimeMs; offset = st.size;
    try {
      if (offset > 0) {
        const from = Math.max(0, offset - 65536);
        const tail = readRange(from, offset);
        offset = from + tail.length;
        const nl = tail.lastIndexOf(NL);
        if (nl !== tail.length - 1) carry = Buffer.from(tail.subarray(nl + 1));
      }
    } catch { /* ignore */ }
  }
  setGen();
}

function watch() {
  // fs.watch is fast but can miss events on some filesystems; the poll below is the safety net.
  try {
    fs.watch(DIR, (_type, name) => { if (!name || name === 'events.jsonl') pump(); });
  } catch { /* polling only */ }
  setInterval(pump, 500).unref?.();
  let teamStamp = 0;
  setInterval(() => {
    let m = 0; try { m = fs.statSync(TEAM).mtimeMs; } catch {}
    if (teamStamp && m !== teamStamp) broadcast({ event: 'team', data: '{}' });
    teamStamp = m;
  }, 1000).unref?.();
}

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

// ---------- connection status (read-only look at how Claude Code and Codex are wired) ----------
const HOME = os.homedir();
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tilde = (p) => (p.startsWith(HOME + path.sep) ? '~' + p.slice(HOME.length) : p);
function ourHooks(obj) {
  let n = 0;
  for (const groups of Object.values(obj?.hooks || {})) for (const g of Array.isArray(groups) ? groups : []) for (const h of g?.hooks || []) if (String(h?.command || '').includes('agentboard/report.mjs')) n++;
  return n;
}
let claudeTrustCache = { at: 0, v: null };
function claudeTrusted() {
  // Claude Code remembers per-folder trust in ~/.claude.json; we only read that one flag.
  if (Date.now() - claudeTrustCache.at < 15000) return claudeTrustCache.v;
  const j = readJson(path.join(HOME, '.claude.json'));
  const v = j && j.projects ? !!(j.projects[ROOT] && j.projects[ROOT].hasTrustDialogAccepted) : null;
  claudeTrustCache = { at: Date.now(), v };
  return v;
}
function codexTrust() {
  const cfg = readText(path.join(HOME, '.codex', 'config.toml'));
  if (cfg === null) return { trusted: null, hooksTrusted: 0 };
  const block = new RegExp(`^\\[projects\\.(?:"${reEsc(ROOT)}"|'${reEsc(ROOT)}')\\]([\\s\\S]*?)(?=^\\[|$(?![\\s\\S]))`, 'm').exec(cfg);
  const trusted = block ? /trust_level\s*=\s*["']trusted["']/.test(block[1]) : false;
  const hooksFile = reEsc(path.join(ROOT, '.codex', 'hooks.json'));
  const hooksTrusted = (cfg.match(new RegExp(`^\\[hooks\\.state\\."${hooksFile}:[^"]+"\\][^\\[]*trusted_hash`, 'gm')) || []).length;
  return { trusted, hooksTrusted };
}
function lastByPlatform() {
  const out = { 'claude-code': { last: null, lastHook: null }, codex: { last: null, lastHook: null } };
  const st = stat(); if (!st || !st.size) return out;
  let text = '';
  try { text = readRange(Math.max(0, st.size - 512 * 1024), st.size).toString('utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    const o = e && out[e.platform]; if (!o || e.source === 'test') continue;
    if (!o.last || e.ts > o.last) o.last = e.ts;
    if (e.source !== 'self' && (!o.lastHook || e.ts > o.lastHook)) o.lastHook = e.ts;
  }
  return out;
}
function status() {
  const last = lastByPlatform();
  const count = (dir, ext) => { try { return fs.readdirSync(dir).filter((f) => f.endsWith(ext)).length; } catch { return 0; } };
  const cx = codexTrust();
  return {
    root: tilde(ROOT),
    claudeCmd: `cd ${tilde(ROOT).replace(/ /g, '\\ ')} && claude`,
    claude: { hooks: ourHooks(readJson(path.join(ROOT, '.claude', 'settings.json'))), agents: count(path.join(ROOT, '.claude', 'agents'), '.md'), trusted: claudeTrusted(), ...last['claude-code'] },
    codex: { hooks: ourHooks(readJson(path.join(ROOT, '.codex', 'hooks.json'))), agents: count(path.join(ROOT, '.codex', 'agents'), '.toml'), installed: fs.existsSync(path.join(HOME, '.codex')), ...cx, ...last.codex },
  };
}
// Only answer the page itself: plain localhost hosts (no DNS rebinding) and, for writes, a custom header (no cross-site forms).
const localHost = (req) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(String(req.headers.host || ''));
function testEvent(platform) {
  const team = readJson(TEAM) || {};
  const agentsList = Array.isArray(team.agents) ? team.agents : [];
  const agent = platform === 'codex'
    ? (agentsList.find((a) => a.platform === 'codex' && a.id !== team.lead)?.id || 'codex-main')
    : (team.lead || agentsList.find((a) => a.platform === 'claude-code')?.id || 'lead');
  fs.appendFileSync(EVENTS, JSON.stringify({ ts: new Date().toISOString(), agent, platform, state: 'done', detail: 'Connection test ✓', source: 'test' }) + '\n');
  return agent;
}
// "Open Claude Code / Open Codex": a fixed script, run in a new Terminal window, in this project folder.
// Written as a .command file and handed to `open`, so no automation permission is needed.
const CODEX_APP_CLI = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
const shq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
function openTool(tool) {
  if (process.platform !== 'darwin') throw new Error('Opening tools from the board only works on macOS for now.');
  const name = tool === 'codex' ? 'Codex' : 'Claude Code';
  const run = tool === 'codex'
    ? `if command -v codex >/dev/null 2>&1; then codex; elif [ -x ${shq(CODEX_APP_CLI)} ]; then ${shq(CODEX_APP_CLI)}; else echo "Codex isn't installed. Get it from https://openai.com/codex"; fi`
    : `if command -v claude >/dev/null 2>&1; then claude; else echo "Claude Code isn't installed. Get it from https://claude.com/claude-code"; fi`;
  const script = [
    '#!/bin/zsh -l',
    `cd ${shq(ROOT)} || exit 1`,
    'clear',
    `printf '\\n  %s · your AI office\\n  %s\\n\\n' ${shq(name)} ${shq(tilde(ROOT))}`,
    run,
    '',
  ].join('\n');
  const file = path.join(os.tmpdir(), `agentboard-open-${tool === 'codex' ? 'codex' : 'claude'}.command`);
  fs.writeFileSync(file, script, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  spawn('open', [file], { detached: true, stdio: 'ignore' }).unref();
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } // fixed base: a bad Host header must not matter
  catch { send(res, 400, 'text/plain', 'bad request'); return; }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    fs.readFile(PAGE, (err, buf) => err ? send(res, 500, 'text/plain', 'index.html missing') : send(res, 200, 'text/html; charset=utf-8', buf));
    return;
  }
  if (url.pathname === '/team.json') {
    fs.readFile(TEAM, (err, buf) => err ? send(res, 404, 'application/json', '{"error":"team.json missing"}') : send(res, 200, 'application/json; charset=utf-8', buf));
    return;
  }
  if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    pump(); // make sure `offset` and `gen` are current before replaying
    const m = /^([0-9a-z]+\.\d+):(\d+)$/.exec(String(req.headers['last-event-id'] || '').trim());
    const last = m ? Number(m[2]) : NaN;
    if (m && m[1] === gen && last > 0 && last <= lineEnd() && boundaryAt(last)) {
      replay(res, last);                 // reconnect to the same file: only what was missed
    } else {
      sse(res, { event: 'reset', id: id(0), data: '{}' });
      replay(res, 0);                    // first load, or the file changed: full history
    }
    clients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }
  if (url.pathname === '/status') {
    if (!localHost(req)) { send(res, 403, 'application/json', '{"error":"forbidden"}'); return; }
    try { send(res, 200, 'application/json; charset=utf-8', JSON.stringify(status())); }
    catch (err) { send(res, 500, 'application/json', JSON.stringify({ error: String(err && err.message || err) })); }
    return;
  }
  if (url.pathname === '/test') {
    if (req.method !== 'POST' || req.headers['x-agentboard'] !== '1' || !localHost(req)) { send(res, 403, 'application/json', '{"error":"forbidden"}'); return; }
    try { const agent = testEvent(url.searchParams.get('platform') === 'codex' ? 'codex' : 'claude-code'); send(res, 200, 'application/json', JSON.stringify({ ok: true, agent })); }
    catch (err) { send(res, 500, 'application/json', JSON.stringify({ error: String(err && err.message || err) })); }
    return;
  }
  if (url.pathname === '/open') {
    if (req.method !== 'POST' || req.headers['x-agentboard'] !== '1' || !localHost(req)) { send(res, 403, 'application/json', '{"error":"forbidden"}'); return; }
    try { openTool(url.searchParams.get('tool') === 'codex' ? 'codex' : 'claude'); send(res, 200, 'application/json', '{"ok":true}'); }
    catch (err) { send(res, 500, 'application/json', JSON.stringify({ error: String(err && err.message || err) })); }
    return;
  }
  if (url.pathname === '/health') { send(res, 200, 'application/json', JSON.stringify({ ok: true, clients: clients.size, bytes: offset, gen })); return; }
  send(res, 404, 'text/plain', 'not found');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`AgentBoard: port ${PORT} is busy. Is the dashboard already running? Try PORT=${PORT + 1}.`);
  else console.error('AgentBoard server error:', err.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  watch();
  console.log(`AgentBoard: http://localhost:${PORT}  (demo: http://localhost:${PORT}/?demo=1)`);
  console.log(`Watching ${path.relative(process.cwd(), EVENTS) || EVENTS}`);
});
