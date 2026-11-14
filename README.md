# AgentBoard

Your AI team as a little game-style office. Each teammate is a role (Team Lead, Product Manager, Designer, Code Reviewer, Marketer, Software Engineer, QA Engineer, Researcher) running in Claude Code or Codex. When they work in this project, the right person sits down and gets to work, waves when they need you, and celebrates when they finish.

![AgentBoard icon](app/icon-1024.png)

## Open it

- **Mac app:** run `app/build.sh --install` once, then open **AgentBoard** from Applications.
- **Browser:** `node agentboard/server.mjs`, then open http://localhost:4317 (try `?demo=1` for made-up activity).

Needs Node.js. No other dependencies.

## What's here

| Path | What it is |
|---|---|
| `agentboard/` | The office (`index.html`), its server, the status reporter, the team (`team.json`) and the generator that writes the agent files. See [agentboard/README.md](agentboard/README.md). |
| `app/` | The native Mac app (Swift + WebKit) that opens the office in its own window. See [app/README.md](app/README.md). |
| `.claude/agents/`, `.codex/agents/` | The teammates for Claude Code and Codex, generated from `team.json`. |
| `.claude/settings.json`, `.codex/hooks.json` | Status hooks that keep the office up to date. |
| `CLAUDE.md`, `AGENTS.md` | The team roster for the main Claude Code and Codex sessions. |

To change the team, edit `agentboard/team.json` and run `node agentboard/generate.mjs`.
