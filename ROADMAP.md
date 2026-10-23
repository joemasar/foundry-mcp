# Roadmap

What the Foundry MCP server can do today, and what's planned next. Built for a Pathfinder 2e game on Foundry v14 (dev: https://foundry-dev.jobusrum.dev, production: https://jobusrum.dev).

## Done

### v0.1: building content
- World overview, listing and reading documents, updates, deletes, folders
- Compendium search across every pack, and import with rename and field changes (re-skinning official monsters)
- Homebrew PF2e creatures (strikes, abilities, lore skills, innate/prepared spells, resistances) and items
- Elite and weak adjustments
- Journals with linked pages, adding pages, showing handouts to players, roll tables
- Scenes from uploaded images, quick dungeon layouts from rooms (walls, doors, secret doors, lights), walls, lights, map pins, hidden token placement
- Starting encounters, dice and table rolls, chat messages
- `run_script` escape hatch (off by default)

### v0.2: running the table (Tier 1)
- **Tokens:** move, reveal, hide, rename and remove tokens; damage (through PF2e, so temp HP, resistances and knock-outs apply), heal, set HP; add and remove conditions
- **Combat:** status (turn order with HP, AC and conditions), next and previous turn, next round, add and remove combatants, mark defeated, roll initiative, end; works on a fight on any scene
- **Encounters:** rate a fight with the PF2e XP rules using the Party's level and size; build a themed fight that fits a difficulty, imports it, places it hidden in an area without overlapping tokens, and writes a GM journal (with a dry-run preview)
- **Chat log:** recent messages and rolls, with check type, DC, target and outcome

### v0.3: session log (Tier 2, item 6)
- Everything Claude creates is tagged with the current session: documents, folders, combats, and tokens, walls, lights, pins, journal pages and items it adds to things the GM made
- `start_session` names a session ("Session 12", "test"); otherwise one named after the date and time starts on its own and lasts 12 hours. The session is stored in the world, so it carries across chats
- `session_log` lists what a session made, or every session with counts
- `cleanup_session` previews, then deletes on confirm. It keeps the active scene, folders that still hold other things, and items on player characters unless asked
- `list_documents` returns folder IDs and can list folders
- Released as v0.3.0, with the fix that makes reveal, hide and rename list every token they touched
- **v0.3.1:** fixes creates failing after a token, wall or item was added ("folders is not a valid embedded Document within the Scene Document"). A shared `{ keepId: true }` options object picked up Foundry's `parent`; every create now gets a fresh one
- Live-tested on v0.3.1 (2026-10-23): import into a folder, hidden token on an existing scene, linked journal, `session_log`, cleanup preview and confirm. The scene kept its other tokens

## Next: Tier 2, story and rewards

5. **Rewards.** Award XP to the party and hand out treasure that fits the party's level, using PF2e's treasure-by-level rules.
7. **Music and ambience.** Play, stop or switch playlists ("tavern music", "battle drums").

## Later: Tier 3, maps

8. **Map preview.** Capture a picture of a scene and send it back to Claude, so it can check that its maps look right.
9. **Map art.** Generate battle map images with the image tools in the Claude app, then upload them as scenes with walls.
10. **Spell areas and Regions.** Spell area templates, and v14 Regions for traps, difficult terrain and teleporters.

## Housekeeping

- **Untagged older content:** things Claude made before v0.3.0 aren't tagged, so `session_log` and `cleanup_session` can't find them. Clean those up by hand.
- **Live check after a release:** start a 'test' session, import a creature into a folder, place a hidden token on an existing scene, create a journal in the same folder, then `session_log` and `cleanup_session` (preview, then confirm), and check the scene kept its other tokens. Last run: v0.3.1, 2026-10-23, all passed.
- **After testing:** start a real session (e.g. 'Session 13') so game-night content isn't tagged 'test'.
- **Production install:** after item 10 ships; until then, build and test on dev only. Then use the same manifest URL as dev, enable the module in the world, and paste the token.
- **Tool list refresh:** after changing the server code, reconnect foundry-vtt in `/mcp` or start a new chat. A running chat keeps the tool list it started with.
- **Live testing:** `server/scripts/run-steps.mjs <steps.json>` drives the server against a real world without needing the chat's tool list.

## Releasing

- Module: `.\release-module.ps1 -Version x.y.z` (bumps `module.json`, builds the zip, tags, pushes, creates the GitHub release). Then **Check for Updates** in Foundry's setup screen.
- Server: `cd server; npm test`, then reconnect foundry-vtt in `/mcp`.
