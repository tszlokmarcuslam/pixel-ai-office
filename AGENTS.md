# AGENTS.md

<!-- agentboard:team:start -->
<!-- Generated from agentboard/team.json by agentboard/generate.mjs. Edit team.json, then re-run it. -->
## Team

**AI Office.** Live dashboard: `node agentboard/server.mjs`, then open http://localhost:4317 (demo: `?demo=1`).

**Lead: Team Lead (`team-lead`), the Claude Code main session.** In Codex, the main session coordinates the Codex agents below (it reports to the dashboard as `codex-main`). If you are a spawned agent, follow your own instructions and use this roster only for reference.

| Agent | Runs on | Role | Delegate when |
|---|---|---|---|
| Product Manager (`product-manager`) | Claude Code subagent | Turns ideas into clear, ordered plans | Use first for any feature, project or bug with unclear scope: works out what to build, in what order and by whom, and returns a short plan with checks. Read-only; does not edit files. |
| Designer (`designer`) | Claude Code subagent | Designs and builds screens, layouts and visual style | Use for anything people see: page and screen design, layout, colours, typography, components, icons, accessibility, and building the UI in code. Edits files and checks the result. |
| Code Reviewer (`code-reviewer`) | Claude Code subagent | Checks every change for bugs and risks (read-only) | Use after any code change and before calling work done: reviews the diff for bugs, regressions, security problems and missing tests. Read-only; returns ranked findings, never edits. |
| Marketer (`marketer`) | Claude Code subagent | Writes the words that sell: pages, posts, launches | Use for anything that tells people about the product: landing page and store copy, release notes, launch posts, emails, taglines, and competitor or audience research. Edits copy files. |
| Software Engineer (`software-engineer`) | Codex agent (workspace-write) | Builds features end to end: logic, APIs, data | Use to build or fix how things work: features, business logic, APIs, data models and migrations, background jobs, scripts and integrations. Edits files in the workspace and runs the tests. |
| QA Engineer (`qa-engineer`) | Codex agent (workspace-write) | Tests everything and catches bugs before users do | Use to prove things work: write and run tests for new or changed behaviour, reproduce a reported bug with a failing test first, and check the whole suite. Edits test files in the workspace. |
| Researcher (`researcher`) | Codex agent (read-only) | Finds answers in docs, code and the web (read-only) | Use before building or deciding: how a library or API works, which version supports what, where something lives in the codebase, what users or competitors do. Read-only; returns a short answer with sources. |

- Claude Code subagents: delegate with the Agent tool, using the id as the agent type.
- Codex agents: spawn them by role name from a Codex session in this folder (for example "spawn the test-writer agent to …"), or hand off from Claude Code with `codex exec -C . "Use the <id> agent to …"`.
- Codex only loads `.codex/` (agents, config, hooks) after this folder is trusted in Codex.

### Status reporting (Codex main session only)

When you start a task, run `node agentboard/report.mjs codex-main working "<what you're doing>"`. When you finish, run it with `done` and a one-line result. If you're blocked, use `waiting` (or `error`). Keep each detail under 60 characters. Hooks in `.codex/hooks.json` report automatically once they are trusted.
<!-- agentboard:team:end -->
