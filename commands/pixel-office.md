---
description: Open the pixel AI office and tap an AI router (OmniRoute, LiteLLM, OpenRouter) so its agents show up
---
Start the pixel office for the user:

1. Run `node agentboard/server.mjs` in the background (serves http://localhost:4317/office).
2. Run `ROUTER_URL=${ARGUMENTS:-http://localhost:20128} node agentboard/router.mjs` in the background. It listens on http://localhost:4318/v1 and passes every call to the router.
3. Tell the user to point their apps at `http://localhost:4318/v1` instead of the router, and open http://localhost:4317/office (add `?demo=1` to see it without traffic).
