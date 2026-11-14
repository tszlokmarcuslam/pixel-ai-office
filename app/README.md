# AgentBoard.app

A small Mac app that opens the AgentBoard dashboard in its own window. Double-click it: if the dashboard server isn't running yet, the app starts `node agentboard/server.mjs` for you, and stops it again when you quit (it never stops a server it didn't start).

- Rebuild and install to `~/Applications`: `app/build.sh --install` (just `app/build.sh` builds into `app/build/`).
- Check it without opening a window: `app/build/AgentBoard.app/Contents/MacOS/AgentBoard --selftest`.
- Server log: `~/Library/Logs/AgentBoard/server.log` (also File → Open Server Log).
- Moved the project? File → Choose Project Folder… (the app remembers your choice).
- Icon: edit `icon.svg`, run `app/make-icon.sh` (needs Google Chrome), then rebuild.
