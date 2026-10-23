# Foundry MCP

## Fixing a bug

1. **Find the cause first.** When a live test or tool call fails, read the relevant code
   (`foundry-module/scripts/handlers.js`, `sessions.js`, or `server/src`), explain the cause to
   the user, and get a yes before changing code. Confirm the cause with a harmless repro when you can.
2. **Branch.** Make the fix on a new branch off `master` (e.g. `fix/<short-name>`).
3. **Check.** `node --check` on any changed module script, and `npm test` in `server/`.
4. **Commit** on the branch, then fast-forward `master` to it (`git fetch`, `git switch master`,
   `git merge --ff-only <branch>`).
5. **Release** from `master` with `.\release-module.ps1 -Version <next patch>`, e.g. 0.3.0 → 0.3.1.
   The script bumps `module.json`, builds the zip, commits, tags, pushes and creates the GitHub release.
6. **Verify the release:** `gh release view v<version>` lists `foundry-mcp.zip` and `module.json`, and
   `releases/latest/download/module.json` shows the new version.
7. **Update the server.** The Foundry server is remote and installs the module from GitHub releases,
   so a push alone does nothing. The user runs Add-on Modules → Check for Updates, updates the
   module and reloads the world. Then check `foundry_status` shows the new `moduleVersion` and
   rerun the failed test.

Changes to `server/` only (the MCP server) need no module release: rebuild with `npm run build` in `server/`
and restart the MCP server (a new Claude session).
