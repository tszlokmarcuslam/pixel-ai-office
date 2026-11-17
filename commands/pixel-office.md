---
description: Open the pixel AI office. Shows your Claude Code subagents at work; pass a router URL (OmniRoute, LiteLLM, OpenRouter) to also show the models behind it
argument-hint: "[router URL, e.g. http://localhost:20128 — optional]"
---
Start the pixel AI office for the user. The plugin's files are in `${CLAUDE_PLUGIN_ROOT}`.

1. Start the board in the background (it serves http://localhost:4317/office):
   `node "${CLAUDE_PLUGIN_ROOT}/agentboard/server.mjs"`
   If port 4317 is busy, it is probably already running; carry on.
2. Only if a router URL was given (`$ARGUMENTS` is not empty): start the router tap in the background. It listens on http://localhost:4318/v1 and forwards every call to the router:
   `ROUTER_URL="$ARGUMENTS" node "${CLAUDE_PLUGIN_ROOT}/agentboard/router.mjs"`
   With no router URL, skip this step: the plugin's hooks already report this session and its subagents to the board.
3. Tell the user, briefly:
   - open http://localhost:4317/office (add `?demo=1` to see it without any activity);
   - without a router, each subagent this session starts gets its own desk, labelled with its role;
   - with a router, also point their apps at `http://localhost:4318/v1` instead of the router, so each model call shows up as an agent working.
