#!/usr/bin/env node
// Appends one status event to agentboard/events.jsonl. No dependencies. Never throws, never blocks,
// prints nothing (hook stdout can end up in a model's context), and always exits 0.
//
// Self-report:  node agentboard/report.mjs <agent> <state> "<detail>" ["<task>"]
//               states: idle | thinking | working | waiting | done | error
// Hook mode:    node agentboard/report.mjs --hook <claude-code|codex> <EventName>   (event JSON on stdin)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const T0 = new Date().toISOString(); // stamp when the event happened, not when stdin finished
const STATES = ['idle', 'thinking', 'working', 'waiting', 'done', 'error'];
const ALIASES = { start: 'working', started: 'working', busy: 'working', run: 'working', running: 'working', think: 'thinking',
  finish: 'done', finished: 'done', complete: 'done', completed: 'done', ok: 'done', success: 'done',
  blocked: 'waiting', wait: 'waiting', ask: 'waiting', fail: 'error', failed: 'error', err: 'error', stop: 'idle', stopped: 'idle' };
const CODEX_MAIN = 'codex-main';

let DIR = '.';
try { DIR = path.dirname(fileURLToPath(import.meta.url)); } catch {}
const EVENTS = path.join(DIR, 'events.jsonl');

process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));
setTimeout(() => process.exit(0), 4000).unref(); // hard stop, whatever happens

function team() {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, 'team.json'), 'utf8')); } catch { return null; }
}
function clip(s, n) {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  const chars = [...s];
  return chars.length > n ? chars.slice(0, n - 1).join('') + '…' : s;
}
function normState(s) {
  s = String(s || '').toLowerCase().trim();
  if (STATES.includes(s)) return s;
  return Object.hasOwn(ALIASES, s) ? ALIASES[s] : 'working'; // own keys only: not `constructor`, `__proto__`, …
}
function append(ev) {
  try {
    const line = JSON.stringify(ev) + '\n';
    fs.appendFileSync(EVENTS, line, { encoding: 'utf8' });
  } catch { /* read-only sandbox, missing folder, full disk: drop the event silently */ }
}
function event(agent, state, detail, task, platform, extra = {}) {
  const t = team();
  const def = t?.agents?.find((a) => a.id === agent);
  const ev = { ts: T0, agent: clip(agent, 64) || 'unknown', platform: platform || def?.platform || 'claude-code', state: normState(state), detail: clip(detail, 60) };
  if (task) ev.task = clip(task, 120);
  Object.assign(ev, extra);
  append(ev);
}

// ---------- hook mode ----------
const base = (p) => { try { return path.basename(String(p)); } catch { return String(p); } };
function host(u) { try { return new URL(String(u)).host; } catch { return clip(u, 30); } }
function cmdText(c) { return Array.isArray(c) ? (c[0] === 'bash' && c[1] === '-lc' ? c.slice(2).join(' ') : c.join(' ')) : String(c ?? ''); }

function toolDetail(name, input = {}) {
  const n = String(name || 'tool');
  const i = input && typeof input === 'object' ? input : {};
  switch (n) {
    case 'Bash': case 'shell': case 'exec_command': case 'local_shell': case 'unified_exec': case 'container.exec':
      return `$ ${cmdText(i.command ?? i.cmd ?? '')}`;
    case 'Read': return `Reading ${base(i.file_path ?? i.path ?? '')}`;
    case 'Edit': case 'MultiEdit': return `Editing ${base(i.file_path ?? '')}`;
    case 'Write': return `Writing ${base(i.file_path ?? '')}`;
    case 'NotebookEdit': return `Editing ${base(i.notebook_path ?? '')}`;
    case 'Grep': return `Searching "${i.pattern ?? ''}"`;
    case 'Glob': return `Finding ${i.pattern ?? ''}`;
    case 'WebFetch': return `Fetching ${host(i.url)}`;
    case 'WebSearch': case 'web_search': return `Web: ${i.query ?? ''}`;
    case 'Agent': case 'Task': return `Delegating to ${i.subagent_type || 'a subagent'}`;
    case 'spawn_agent': return `Spawning ${i.agent_type || 'an agent'}`;
    case 'TodoWrite': case 'update_plan': return 'Updating the plan';
    case 'apply_patch': {
      const m = /\*\*\* (?:Update|Add|Delete) File: (.+)/.exec(String(i.input ?? i.patch ?? i.command ?? ''));
      return m ? `Editing ${base(m[1].trim())}` : 'Applying a patch';
    }
    default:
      if (n.startsWith('mcp__')) { const [, srv, tool] = n.split('__'); return `MCP ${srv}: ${tool || ''}`; }
      return n;
  }
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    const done = () => resolve(data);
    const t = setTimeout(done, 1500);
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { data += c; if (data.length > 2_000_000) { clearTimeout(t); done(); } });
      process.stdin.on('end', () => { clearTimeout(t); done(); });
      process.stdin.on('error', () => { clearTimeout(t); done(); });
    } catch { clearTimeout(t); done(); }
  });
}

async function hook(platform, evName) {
  const raw = await readStdin();
  let p = {};
  try { p = raw.trim() ? JSON.parse(raw) : {}; } catch { return; } // garbled payload: report nothing rather than guess
  if (!p || typeof p !== 'object') return;
  const ev = p.hook_event_name || evName || '';
  const t = team();
  const leadId = platform === 'codex' ? CODEX_MAIN : (t?.lead || 'lead');
  // A subagent carries agent_id (Claude Code and Codex). agent_type alone can also mean `claude --agent`.
  const sub = p.agent_id && p.agent_type ? String(p.agent_type) : '';
  const who = sub || leadId;
  const extra = p.session_id ? { session: String(p.session_id).slice(0, 8) } : {};
  const say = (agent, state, detail, task) => event(agent, state, detail, task, platform, extra);

  switch (ev) {
    case 'SessionStart': return say(who, 'idle', p.source === 'resume' ? 'Session resumed' : 'Session started');
    case 'SessionEnd': return say(who, 'idle', 'Session ended');
    case 'UserPromptSubmit': return say(who, 'thinking', 'Reading your request', p.prompt ? clip(p.prompt, 120) : undefined);
    case 'PreToolUse': {
      const i = p.tool_input || {};
      // Delegation: also tell the dashboard which teammate got which task.
      const target = (p.tool_name === 'Agent' || p.tool_name === 'Task') ? i.subagent_type : p.tool_name === 'spawn_agent' ? i.agent_type : null;
      if (target) say(String(target), 'thinking', `Assigned by ${who}`, i.description || i.message || i.prompt || i.task);
      return say(who, 'working', toolDetail(p.tool_name, i));
    }
    case 'PostToolUse': return say(who, 'thinking', `✓ ${toolDetail(p.tool_name, p.tool_input)}`);
    case 'PostToolUseFailure': return say(who, 'thinking', `${p.tool_name || 'Tool'} failed${p.error ? ': ' + String(p.error).split('\n')[0] : ''}`);
    case 'PermissionRequest': return say(who, 'waiting', `Needs permission: ${toolDetail(p.tool_name, p.tool_input)}`);
    case 'Notification': {
      const k = p.notification_type || '';
      if (k === 'idle_prompt') return say(who, 'idle', 'Waiting for your next message');
      if (/^(permission_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input)$/.test(k) || (!k && p.message)) return say(who, 'waiting', p.message || 'Needs your input');
      return; // auth/quota/plugin notices are not agent states
    }
    case 'SubagentStart': if (!p.agent_type) return; return say(String(p.agent_type), 'working', 'Started');
    case 'SubagentStop': {
      if (!p.agent_type) return; // Claude Code internal agents (prompt suggestions, /btw)
      const lines = String(p.last_assistant_message || '').split('\n').map((s) => s.trim()).filter(Boolean);
      const pick = lines.find((s) => !s.startsWith('#')) || lines[0] || '';
      const last = pick.replace(/^[#>*\-\s]+/, '').replace(/\*\*/g, '').trim();
      return say(String(p.agent_type), 'done', last || 'Finished');
    }
    case 'Stop': return say(who, 'done', 'Turn finished');
    case 'StopFailure': return say(who, 'error', `Stopped: ${p.error_type || p.error || 'API error'}`);
    case 'Interrupt': return say(who, 'idle', 'Interrupted');
    case 'PreCompact': return say(who, 'thinking', 'Compacting context');
    default: return; // unknown events are ignored
  }
}

// ---------- entry ----------
async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--hook') { await hook(args[1] === 'codex' ? 'codex' : 'claude-code', args[2]); return; }
  const [agent, state, detail = '', task = ''] = args;
  if (!agent) return; // nothing to report; stay silent
  event(agent, state, detail, task, process.env.AGENTBOARD_PLATFORM, { source: 'self' });
}
main().then(() => process.exit(0), () => process.exit(0));
