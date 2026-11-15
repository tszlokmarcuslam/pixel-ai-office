---
description: Open the pixel AI office and tap an AI router (OmniRoute, LiteLLM, OpenRouter) so its agents show up
argument-hint: "[router URL, default http://localhost:20128]"
---
Start the pixel AI office for the user. The plugin's files are in `${CLAUDE_PLUGIN_ROOT}`.

1. Start the board in the background (it serves http://localhost:4317/office):
   `node "${CLAUDE_PLUGIN_ROOT}/agentboard/server.mjs"`
   If port 4317 is busy, it is probably already running; carry on.
2. Start the router tap in the background (it listens on http://localhost:4318/v1 and forwards every call to the router):
   `ROUTER_URL="${ARGUMENTS:-http://localhost:20128}" node "${CLAUDE_PLUGIN_ROOT}/agentboard/router.mjs"`
3. Tell the user, briefly:
   - open http://localhost:4317/office (add `?demo=1` to see it without any traffic);
   - point their apps at `http://localhost:4318/v1` instead of the router, so each model call shows up as an agent working.
