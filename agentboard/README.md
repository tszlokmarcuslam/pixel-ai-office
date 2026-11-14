# AgentBoard

Your AI team as a little game-style office. Each teammate is a role (Team Lead, Product Manager, Designer, Code Reviewer, Marketer, Software Engineer, QA Engineer, Researcher). When Claude Code or Codex works in this project, the right person sits down and gets to work, waves when they need you, and celebrates when they finish.

## Open it

- **Mac app:** double-click **AgentBoard** in Applications (or `app/build/AgentBoard.app`). It starts everything by itself.
- **Browser:** `node agentboard/server.mjs`, then open http://localhost:4317.

The first time, a short welcome shows your team and two buttons: **Open Claude Code** and **Open Codex**. Each opens the tool in this project in a Terminal window. Say yes when it asks to trust the folder, then ask for something, for example *"Design a simple landing page for my app, get the code reviewed, and write the launch post."*

## Using it

- **Your team** (right): everyone's role and what they're doing right now. Click someone for details; the office zooms to them.
- **Hover** a character for a quick status card. **Drag** to look around, **scroll** to zoom, **F** to fit the room.
- A banner at the top tells you when someone **needs you** or is **stuck**; **Show** takes you to them.
- **Activity** (bottom) is a one-line ticker; open it for the full history with filters.
- **Setup** (top right) shows whether Claude Code and Codex are connected, with the steps left and a **Send a test** button.
- **⋯** menu: shuffle the room, shuffle looks, lighting (follows your clock, always day, always night), **Demo mode** (made-up activity, to try it without any agents), getting started.

The office is big: desks for each tool, the Team Lead's corner, a meeting room, kitchen, lounge and a ping-pong table. It's laid out fresh on every load. When nobody's working, people get coffee, chat, hold meetings, play ping-pong, nap on the sofa or pet the office cat.

## Change the team

Edit `team.json` (each person's `displayName` is the title shown in the office), then run `node agentboard/generate.mjs`. That rewrites the agent files for Claude Code (`.claude/agents/`) and Codex (`.codex/agents/`), the team section in `CLAUDE.md` and `AGENTS.md`, and the status hooks. It never deletes agent files; ones that aren't in `team.json` any more are listed as unmanaged. Role icons and desk props (palette, megaphone, rubber duck…) are picked from the title automatically.

## How status gets in

- **Claude Code hooks** (`.claude/settings.json`) and **Codex hooks** (`.codex/hooks.json`) report every step automatically. Codex needs the folder trusted and the hooks approved once (`/hooks`).
- Every teammate's instructions also tell it to report by itself (`node agentboard/report.mjs <id> <state> "<what>"`), so the board works even before hooks are approved.
- Built-in helpers (Explore, Plan…) walk in through the door as visitors and leave when they're done.

States: Free, Thinking, Working, Needs you, Done (back to Free after 10 s), Stuck, Asleep (no news for 5 minutes while working).

## Files

| File | What it is |
|---|---|
| `team.json` | The team. Source of truth for everything else. |
| `generate.mjs` | Rebuilds agent files, hooks and roster docs from `team.json` (`--check` validates only). |
| `report.mjs` | Appends one status event to `events.jsonl`. Silent, never fails. |
| `server.mjs` | Serves the page and streams `events.jsonl` live; `/status` and the Setup buttons. |
| `index.html` | The office. One file, no CDNs. |
| `events.jsonl` | The live feed (git-ignored). Empty it to start fresh. |

Demo at 5× speed: http://localhost:4317/?demo=1&speed=5
