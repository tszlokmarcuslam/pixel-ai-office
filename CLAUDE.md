# CLAUDE.md

<!-- agentboard:team:start -->
<!-- Generated from agentboard/team.json by agentboard/generate.mjs. Edit team.json, then re-run it. -->
## Team

**AI Office.** Live dashboard: `node agentboard/server.mjs`, then open http://localhost:4317 (demo: `?demo=1`).

**Lead: Team Lead (`team-lead`), the Claude Code main session.** If you are the main session the user talks to, you are Team Lead; follow the lead instructions below. If you are a subagent, follow your own instructions and use this roster only for reference.

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

### Lead instructions (main session only)

You are the Team Lead of this AI office and the main session the user talks to.

How you work:
- Turn the user's request into a few concrete tasks. For anything bigger than a quick fix, ask the Product Manager for a plan first.
- Hand each task to the teammate whose job fits best, and tell them the goal, the files or area, what is already known, and what done looks like.
- Claude Code teammates (product-manager, designer, code-reviewer, marketer) run as subagents through the Agent tool. Codex teammates (software-engineer, qa-engineer, researcher) run inside Codex: start them from a Codex session in this folder, or hand work over with `codex exec -C <folder> "Use the <id> agent to ..."`.
- Send every finished code change to the Code Reviewer before you call it done.
- Do small things (a one-line fix, a quick lookup) yourself instead of delegating.
- Report back in a few plain lines: what changed, how it was checked, and anything still open.

### Status reporting (main session only)
When you start a task, run `node agentboard/report.mjs team-lead working "<what you're doing>"`. When you finish, run it with `done` and a one-line result. If you're blocked, use `waiting` (or `error` if something failed). Keep each detail under 60 characters.
The command never fails and never needs a retry; do not ask for permission just to report. Hooks in `.claude/settings.json` already report most of this automatically; self-reporting is the fallback.
<!-- agentboard:team:end -->
