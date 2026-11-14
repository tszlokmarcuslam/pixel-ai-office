#!/usr/bin/env node
// Generates every team file from agentboard/team.json (the source of truth). No dependencies.
//   node agentboard/generate.mjs           write/update files
//   node agentboard/generate.mjs --check   validate team.json and check every file is up to date (no writes)
//
// Writes: .claude/agents/<id>.md, .codex/agents/<id>.toml, the Team section of CLAUDE.md and AGENTS.md,
// the AgentBoard hooks in .claude/settings.json and .codex/hooks.json, the [agents] table in
// .codex/config.toml, and the events.jsonl line in .gitignore. It never deletes an agent file;
// files that are not in team.json are listed as "unmanaged".
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '..');
const CHECK = process.argv.includes('--check');
const MARK = 'Generated from agentboard/team.json by agentboard/generate.mjs. Edit team.json, then re-run it.';
const rel = (p) => path.relative(ROOT, p) || '.';

// ---------- schema ----------
const ENUMS = {
  scene: ['office', 'classroom'],
  platform: ['claude-code', 'codex'],
  sandbox: ['read-only', 'workspace-write'],
  hairStyle: ['short', 'long', 'bun', 'curly', 'bald'],
  accessory: ['none', 'glasses', 'headset', 'cap', 'scarf', 'badge'],
  deskItem: ['laptop', 'books', 'mug', 'plant', 'monitor-stack', 'microscope'],
};
const HEX = /^#[0-9a-fA-F]{6}$/;
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NICK = /^[A-Za-z0-9 _-]+$/;

export function validate(team) {
  const errs = [], warns = [];
  const need = (cond, msg) => { if (!cond) errs.push(msg); };
  const str = (v) => typeof v === 'string' && v.trim().length > 0;
  need(team && typeof team === 'object', 'team.json must be a JSON object');
  if (!team || typeof team !== 'object') return { errs, warns };
  need(team.version === 1, 'version must be 1');
  need(ENUMS.scene.includes(team.scene), `scene must be one of ${ENUMS.scene.join(' | ')}`);
  need(str(team.title), 'title must be a non-empty string');
  need(Array.isArray(team.agents) && team.agents.length > 0, 'agents must be a non-empty array');
  const agents = Array.isArray(team.agents) ? team.agents : [];
  if (agents.length > 12) warns.push(`${agents.length} agents: the dashboard is tuned for up to 12`);
  const ids = new Set(), names = new Set(), seats = new Set();
  agents.forEach((a, i) => {
    const at = `agents[${i}]${a && a.id ? ` (${a.id})` : ''}`;
    if (!a || typeof a !== 'object') { errs.push(`${at} must be an object`); return; }
    need(str(a.id) && KEBAB.test(a.id), `${at}.id must be kebab-case`);
    if (ids.has(a.id)) errs.push(`${at}.id is a duplicate`); ids.add(a.id);
    need(str(a.displayName), `${at}.displayName must be a non-empty string`);
    if (str(a.displayName) && a.displayName.length > 20) warns.push(`${at}.displayName is long; name tags fit about 18 characters`);
    if (names.has(a.displayName)) warns.push(`${at}.displayName "${a.displayName}" is used twice`); names.add(a.displayName);
    need(ENUMS.platform.includes(a.platform), `${at}.platform must be one of ${ENUMS.platform.join(' | ')}`);
    for (const k of ['role', 'description', 'instructions', 'model']) need(str(a[k]), `${at}.${k} must be a non-empty string`);
    need(Array.isArray(a.tools) && a.tools.every(str), `${at}.tools must be an array of strings`);
    if (Array.isArray(a.tools) && a.tools.some((t) => typeof t === 'string' && /[\r\n]/.test(t))) errs.push(`${at}.tools entries must be on one line`);
    if (typeof a.model === 'string' && /[\r\n]/.test(a.model)) errs.push(`${at}.model must be on one line`);
    if (a.platform === 'codex') {
      if (Array.isArray(a.tools) && a.tools.length) warns.push(`${at}.tools is ignored for Codex agents (leave it empty)`);
      need(a.sandbox === undefined || ENUMS.sandbox.includes(a.sandbox), `${at}.sandbox must be one of ${ENUMS.sandbox.join(' | ')}`);
    } else if (a.sandbox !== undefined) warns.push(`${at}.sandbox only applies to Codex agents`);
    const l = a.look;
    need(l && typeof l === 'object', `${at}.look must be an object`);
    if (l && typeof l === 'object') {
      for (const k of ['skin', 'hair', 'outfit']) need(HEX.test(l[k] || ''), `${at}.look.${k} must be a #rrggbb colour`);
      for (const k of ['hairStyle', 'accessory', 'deskItem']) need(ENUMS[k].includes(l[k]), `${at}.look.${k} must be one of ${ENUMS[k].join(' | ')}`);
    }
    const s = a.seat;
    need(s && Number.isFinite(s.x) && Number.isFinite(s.y), `${at}.seat must have numeric x and y`);
    if (s && Number.isFinite(s.x) && Number.isFinite(s.y)) {
      const k = `${s.x},${s.y}`;
      if (seats.has(k)) warns.push(`${at}.seat ${k} is taken; the dashboard will auto-place it`); seats.add(k);
    }
  });
  need(str(team.lead) && ids.has(team.lead), 'lead must be the id of one of the agents');
  const lead = agents.find((a) => a && a.id === team.lead);
  if (lead && lead.platform !== 'claude-code') warns.push('the lead is the main session; this setup expects it on claude-code');
  // Outfit colours should be distinct so characters are easy to tell apart.
  const outfits = new Map();
  for (const a of agents) if (a?.look?.outfit) {
    const o = a.look.outfit.toLowerCase();
    if (outfits.has(o)) warns.push(`${a.id} and ${outfits.get(o)} share outfit colour ${o}`); else outfits.set(o, a.id);
  }
  return { errs, warns };
}

// ---------- helpers ----------
function hue(hex) {
  const n = parseInt(hex.slice(1), 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 0;
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60; return h < 0 ? h + 360 : h;
}
// Claude Code's `color` field takes 8 names; pick the nearest one to the outfit.
function ccColor(hex) {
  const h = hue(hex);
  if (h < 15 || h >= 345) return 'red';
  if (h < 42) return 'orange';
  if (h < 65) return 'yellow';
  if (h < 170) return 'green';
  if (h < 200) return 'cyan';
  if (h < 255) return 'blue';
  if (h < 290) return 'purple';
  return 'pink';
}
// Lone surrogates can't be written as UTF-8 (they'd come back as U+FFFD and never match on re-run).
const wellFormed = (s) => (typeof s.toWellFormed === 'function' ? s.toWellFormed() : s.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd'));
// A double-quoted string valid in JSON, TOML and YAML. JSON.stringify already escapes C0 controls;
// DEL, C1 controls, line/paragraph separators, BOM and U+FFFE/U+FFFF are invalid or risky in TOML/YAML, so escape them too.
const quoted = (s) => JSON.stringify(wellFormed(String(s))).replace(/[\u007f-\u009f\u2028\u2029\ufeff\ufffe\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const yamlStr = quoted;
const tomlStr = quoted;
function tomlMultiline(s) {
  const t = wellFormed(String(s)).replace(/\r\n/g, '\n');
  // Multi-line strings can't hold control characters (except tab and newline) or a bare CR: use an escaped basic string.
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\ufeff\ufffe\uffff]/.test(t)) return quoted(`${t}\n`); // same value as the forms below
  if (!t.includes("'''")) return `'''\n${t}\n'''`;
  return `"""\n${t.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"')}\n"""`;
}

function statusBlock(a) {
  const lines = [
    '## Status reporting (AgentBoard)',
    `When you start a task, run \`node agentboard/report.mjs ${a.id} working "<what you're doing>"\`. When you finish, run it with \`done\` and a one-line result. If you're blocked, use \`waiting\` (or \`error\` if something failed). Keep each detail under 60 characters.`,
    'The command never fails and never needs a retry; do not ask for permission just to report.',
  ];
  const readOnly = (a.platform === 'codex' && a.sandbox === 'read-only') || (a.platform === 'claude-code' && a.tools?.length && !a.tools.some((t) => /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(t)));
  if (readOnly) lines.push(a.platform === 'codex'
    ? 'This status command is the only file write you may make. If your sandbox blocks it, skip it silently.'
    : 'This status command is the only write you may make.');
  return lines.join('\n');
}

// ---------- file renderers ----------
function claudeAgentFile(a) {
  const fm = ['---', `# ${MARK}`, `name: ${yamlStr(a.id)}`, `description: ${yamlStr(a.description)}`];
  if (a.tools?.length) fm.push(`tools: ${yamlStr(a.tools.join(', '))}`); // same value as the unquoted comma list, but YAML-safe
  if (a.model && a.model !== 'inherit') fm.push(`model: ${yamlStr(a.model)}`);
  fm.push(`color: ${ccColor(a.look.outfit)}`);
  fm.push('---');
  return `${fm.join('\n')}\n\n${a.instructions.trim()}\n\n${statusBlock(a)}\n`;
}
function codexAgentFile(a) {
  const out = [`# ${MARK}`, `name = ${tomlStr(a.id)}`, `description = ${tomlStr(a.description)}`];
  if (NICK.test(a.displayName)) out.push(`nickname_candidates = [${tomlStr(a.displayName)}]`);
  if (a.model && a.model !== 'inherit') out.push(`model = ${tomlStr(a.model)}`);
  if (a.sandbox) {
    out.push('# Codex 0.166 reads sandbox_mode here but does not apply it: a spawned agent keeps its parent\'s sandbox.');
    out.push(`sandbox_mode = ${tomlStr(a.sandbox)}`);
  }
  out.push(`developer_instructions = ${tomlMultiline(`${a.instructions.trim()}\n\n${statusBlock(a)}`)}`);
  return out.join('\n') + '\n';
}

function teamSection(team, flavour) {
  const lead = team.agents.find((a) => a.id === team.lead);
  const others = team.agents.filter((a) => a.id !== team.lead);
  const plat = (a) => a.platform === 'codex' ? `Codex agent${a.sandbox ? ` (${a.sandbox})` : ''}` : 'Claude Code subagent';
  const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const L = [];
  L.push('<!-- agentboard:team:start -->');
  L.push(`<!-- ${MARK} -->`);
  L.push('## Team');
  L.push('');
  L.push(`**${team.title}.** Live dashboard: \`node agentboard/server.mjs\`, then open http://localhost:4317 (demo: \`?demo=1\`).`);
  L.push('');
  if (flavour === 'claude') {
    L.push(`**Lead: ${lead.displayName} (\`${lead.id}\`), the Claude Code main session.** If you are the main session the user talks to, you are ${lead.displayName}; follow the lead instructions below. If you are a subagent, follow your own instructions and use this roster only for reference.`);
  } else {
    L.push(`**Lead: ${lead.displayName} (\`${lead.id}\`), the Claude Code main session.** In Codex, the main session coordinates the Codex agents below (it reports to the dashboard as \`codex-main\`). If you are a spawned agent, follow your own instructions and use this roster only for reference.`);
  }
  L.push('');
  L.push('| Agent | Runs on | Role | Delegate when |');
  L.push('|---|---|---|---|');
  for (const a of others) L.push(`| ${cell(a.displayName)} (\`${a.id}\`) | ${plat(a)} | ${cell(a.role)} | ${cell(a.description)} |`);
  L.push('');
  L.push('- Claude Code subagents: delegate with the Agent tool, using the id as the agent type.');
  L.push('- Codex agents: spawn them by role name from a Codex session in this folder (for example "spawn the test-writer agent to …"), or hand off from Claude Code with `codex exec -C . "Use the <id> agent to …"`.');
  L.push('- Codex only loads `.codex/` (agents, config, hooks) after this folder is trusted in Codex.');
  L.push('');
  if (flavour === 'claude') {
    L.push(`### Lead instructions (main session only)`);
    L.push('');
    L.push(lead.instructions.trim());
    L.push('');
    L.push(statusBlock(lead).replace('## Status reporting (AgentBoard)', '### Status reporting (main session only)') + ' Hooks in `.claude/settings.json` already report most of this automatically; self-reporting is the fallback.');
  } else {
    L.push('### Status reporting (Codex main session only)');
    L.push('');
    L.push('When you start a task, run `node agentboard/report.mjs codex-main working "<what you\'re doing>"`. When you finish, run it with `done` and a one-line result. If you\'re blocked, use `waiting` (or `error`). Keep each detail under 60 characters. Hooks in `.codex/hooks.json` report automatically once they are trusted.');
  }
  L.push('<!-- agentboard:team:end -->');
  return L.join('\n');
}
function upsertSection(existing, section, heading) {
  const re = /<!-- agentboard:team:start -->[\s\S]*?<!-- agentboard:team:end -->/;
  if (existing && re.test(existing)) return existing.replace(re, () => section); // a function, so `$&` etc. in team text stay literal
  const base = existing && existing.trim() ? existing.replace(/\s*$/, '\n\n') : `${heading}\n\n`;
  return base + section + '\n';
}

// ---------- hooks ----------
const IS_OURS = (h) => typeof h?.command === 'string' && h.command.includes('agentboard/report.mjs');
function mergeHooks(existingHooks, ours) {
  const out = {};
  for (const [ev, groups] of Object.entries(existingHooks || {})) {
    const kept = (Array.isArray(groups) ? groups : []).map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !IS_OURS(h)) })).filter((g) => g.hooks.length);
    if (kept.length) out[ev] = kept;
  }
  for (const [ev, groups] of Object.entries(ours)) out[ev] = [...(out[ev] || []), ...groups];
  return out;
}
function claudeHooks() {
  const cmd = (ev) => ({ type: 'command', command: `node "$CLAUDE_PROJECT_DIR/agentboard/report.mjs" --hook claude-code ${ev}`, async: true, timeout: 10 });
  const evs = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Notification', 'SubagentStart', 'SubagentStop', 'Stop', 'StopFailure', 'PreCompact', 'SessionEnd'];
  return Object.fromEntries(evs.map((ev) => [ev, [{ hooks: [cmd(ev)] }]]));
}
function codexHooks() {
  // Codex runs hooks as `$SHELL -lc` in the session cwd. Walk up from there to the folder that has
  // agentboard/report.mjs (works from subfolders, and inside another repo), in plain POSIX sh so the
  // user's login shell doesn't matter. Always silent, always exits 0, even if node or the script is missing.
  const find = 'd=$PWD; while [ ! -f "$d/agentboard/report.mjs" ]; do p=$(dirname "$d"); [ "$p" = "$d" ] && exit 0; d=$p; done';
  const cmd = (ev) => ({ type: 'command', command: `sh -c '${find}; node "$d/agentboard/report.mjs" --hook codex ${ev}; exit 0' >/dev/null 2>&1; true`, async: ev !== 'SessionEnd', timeout: ev === 'SessionEnd' ? 2 : 10 });
  const evs = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'SubagentStart', 'SubagentStop', 'Stop', 'PreCompact', 'Interrupt', 'SessionEnd'];
  return Object.fromEntries(evs.map((ev) => [ev, [{ hooks: [cmd(ev)] }]]));
}
const ALLOW = 'Bash(node agentboard/report.mjs *)';

// Does config.toml already define the root `agents` table? `[agents]` / `[ agents ] # note` / `[[agents]]`,
// or (before the first table header) dotted keys `agents.x = …` or an inline table `agents = { … }`.
// If so the file is left alone: adding another [agents] would make it invalid TOML.
function hasAgentsTable(cfg) {
  const KEY = String.raw`(?:agents|"agents"|'agents')`;
  if (new RegExp(String.raw`^\s*\[\[?\s*${KEY}\s*\]\]?\s*(?:#.*)?$`, 'm').test(cfg)) return true;
  const root = cfg.split(/^\s*\[/m)[0];
  return new RegExp(String.raw`^\s*${KEY}\s*[.=]`, 'm').test(root);
}

// ---------- main ----------
function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw new Error(`${rel(p)} is not valid JSON: ${e.message}`); }
}
function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

// Where a path really points, following symlinks (also dangling ones, so a link to a not-yet-created file counts).
function realish(p, depth = 0) {
  try { return fs.realpathSync(p); } catch {}
  if (depth < 16) { try { return realish(path.resolve(path.dirname(p), fs.readlinkSync(p)), depth + 1); } catch {} }
  try { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); } catch { return path.resolve(p); }
}
function sameFile(a, b) {
  if (realish(a) === realish(b)) return true;
  try { const x = fs.statSync(a), y = fs.statSync(b); return x.dev === y.dev && x.ino === y.ino; } catch { return false; } // hard links
}

function plan(team, notes = []) {
  const files = new Map(); // abs path -> content
  for (const a of team.agents) {
    if (a.id === team.lead) continue; // the lead is the main session: CLAUDE.md / AGENTS.md carry its instructions
    if (a.platform === 'claude-code') files.set(path.join(ROOT, '.claude/agents', `${a.id}.md`), claudeAgentFile(a));
    else files.set(path.join(ROOT, '.codex/agents', `${a.id}.toml`), codexAgentFile(a));
  }
  const claudeMd = path.join(ROOT, 'CLAUDE.md');
  files.set(claudeMd, upsertSection(readText(claudeMd), teamSection(team, 'claude'), '# CLAUDE.md'));
  const agentsMd = path.join(ROOT, 'AGENTS.md');
  if (sameFile(claudeMd, agentsMd)) {
    // One file under two names: write one (Claude flavour) section once, or the two writes would undo each other every run.
    notes.push('AGENTS.md and CLAUDE.md are the same file (a link); it gets the Claude Code Team section only. Make AGENTS.md a separate file to give Codex its own section.');
  } else {
    files.set(agentsMd, upsertSection(readText(agentsMd), teamSection(team, 'codex'), '# AGENTS.md'));
  }

  const ccSettingsPath = path.join(ROOT, '.claude/settings.json');
  const cc = readJson(ccSettingsPath, {});
  cc.hooks = mergeHooks(cc.hooks, claudeHooks());
  cc.permissions = cc.permissions || {};
  cc.permissions.allow = Array.from(new Set([...(cc.permissions.allow || []), ALLOW]));
  files.set(ccSettingsPath, JSON.stringify(cc, null, 2) + '\n');

  const cxHooksPath = path.join(ROOT, '.codex/hooks.json');
  const cx = readJson(cxHooksPath, {});
  files.set(cxHooksPath, JSON.stringify({ ...cx, description: cx.description || 'AgentBoard status feed. ' + MARK, hooks: mergeHooks(cx.hooks, codexHooks()) }, null, 2) + '\n'); // keep any other top-level keys

  const cfgPath = path.join(ROOT, '.codex/config.toml');
  const cfg = readText(cfgPath);
  const codexCount = team.agents.filter((a) => a.platform === 'codex' && a.id !== team.lead).length;
  const agentsTable = [
    '[agents]',
    '# Spawned agents open at once (alias of max_concurrent_threads_per_session). One per Codex teammate.',
    `max_threads = ${Math.max(2, Math.min(6, codexCount))}`,
    '# Agents may not spawn their own agents (honoured by the v1 backend; v2 ignores it).',
    'max_depth = 1',
  ].join('\n');
  if (cfg === null) {
    files.set(cfgPath, [`# ${MARK}`, '# Multi-agent is on by default in Codex 0.166 ([features] multi_agent is stable and enabled), so no flag is set here.', '# Codex only reads this file once the project is trusted.', '', agentsTable, ''].join('\n'));
  } else if (!hasAgentsTable(cfg)) {
    files.set(cfgPath, cfg.replace(/\s*$/, '\n\n') + agentsTable + '\n');
  }

  const giPath = path.join(ROOT, '.gitignore');
  const gi = readText(giPath) || '';
  if (!/^\/?agentboard\/events\.jsonl$/m.test(gi)) files.set(giPath, gi.replace(/\s*$/, gi ? '\n' : '') + '# AgentBoard live feed\nagentboard/events.jsonl\n');
  return files;
}

function unmanaged(team) {
  const want = new Map(team.agents.filter((a) => a.id !== team.lead).map((a) => [a.id, a.platform]));
  const out = [];
  const ccDir = path.join(ROOT, '.claude/agents');
  for (const f of safeList(ccDir)) if (f.endsWith('.md')) {
    const name = scalar((/^name:[ \t]*(.+)$/m.exec(readText(path.join(ccDir, f)) || '') || [])[1]) || f.replace(/\.md$/, '');
    if (want.get(name) !== 'claude-code') out.push(rel(path.join(ccDir, f)));
  }
  const walk = (d) => safeList(d).flatMap((f) => { const p = path.join(d, f); return fs.statSync(p).isDirectory() ? walk(p) : [p]; });
  for (const p of walk(path.join(ROOT, '.codex/agents'))) if (p.endsWith('.toml')) {
    const name = scalar((/^name[ \t]*=[ \t]*(.+)$/m.exec(readText(p) || '') || [])[1]) || path.basename(p, '.toml');
    if (want.get(name) !== 'codex') out.push(rel(p));
  }
  return out;
}
function safeList(d) { try { return fs.readdirSync(d); } catch { return []; } }
// The value of a one-line YAML/TOML scalar: "double" (JSON-style escapes), 'single', or bare with an optional # comment.
function scalar(v) {
  v = String(v ?? '').trim();
  let m;
  if ((m = /^"((?:[^"\\]|\\.)*)"/.exec(v))) { try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; } }
  if ((m = /^'((?:[^']|'')*)'/.exec(v))) return m[1].replace(/''/g, "'");
  return v.replace(/\s+#.*$/, '').trim();
}

function main() {
  const teamPath = path.join(DIR, 'team.json');
  let team;
  try { team = JSON.parse(fs.readFileSync(teamPath, 'utf8')); }
  catch (e) { console.error(`team.json: ${e.message}`); process.exit(1); }
  const { errs, warns } = validate(team);
  for (const w of warns) console.warn(`warning: ${w}`);
  if (errs.length) { for (const e of errs) console.error(`error: ${e}`); console.error(`team.json is invalid (${errs.length} problem${errs.length > 1 ? 's' : ''}).`); process.exit(1); }
  console.log(`team.json is valid: ${team.agents.length} agents, scene ${team.scene}, lead ${team.lead}.`);

  const notes = [];
  const files = plan(team, notes);
  for (const n of notes) console.warn(`warning: ${n}`);
  const stale = [];
  for (const [p, raw] of files) {
    const content = wellFormed(raw); // what UTF-8 can store, so an unchanged file compares equal next run
    const cur = readText(p);
    const status = cur === null ? 'create' : cur === content ? 'same' : 'update';
    if (CHECK) { if (status !== 'same') stale.push(`${rel(p)} (${status === 'create' ? 'missing' : 'out of date'})`); continue; }
    if (status === 'same') { console.log(`  unchanged ${rel(p)}`); continue; }
    if (status === 'update' && /\.(md|toml)$/.test(p) && p.includes(`${path.sep}agents${path.sep}`) && !cur.includes(MARK)) {
      fs.writeFileSync(p + '.bak', cur); console.log(`  backup    ${rel(p)}.bak (file was not generated by AgentBoard)`);
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    console.log(`  ${status === 'create' ? 'created  ' : 'updated  '} ${rel(p)}`);
  }
  // every non-lead agent must have its platform file
  for (const a of team.agents) {
    if (a.id === team.lead) continue;
    const p = a.platform === 'claude-code' ? path.join(ROOT, '.claude/agents', `${a.id}.md`) : path.join(ROOT, '.codex/agents', `${a.id}.toml`);
    if (!CHECK && !fs.existsSync(p)) stale.push(`${rel(p)} (missing after write)`);
  }
  const un = unmanaged(team);
  if (un.length) console.log(`unmanaged (left alone): ${un.join(', ')}`);
  if (CHECK) {
    if (stale.length) { console.error(`out of date: ${stale.join(', ')}. Run: node agentboard/generate.mjs`); process.exit(1); }
    console.log('all generated files are up to date.');
  } else if (stale.length) { console.error(stale.join('\n')); process.exit(1); }
}

// Compare real paths: run through a symlink (e.g. macOS /tmp -> /private/tmp), argv[1] and import.meta.url differ.
function isMain() {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (isMain()) main();
