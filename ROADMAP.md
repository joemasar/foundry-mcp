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

## Next: Tier 2, story and rewards

5. **Rewards.** Award XP to the party and hand out treasure that fits the party's level, using PF2e's treasure-by-level rules.
6. **Session log and cleanup.** Tag everything Claude creates, so "list what we made tonight" or "delete the test stuff" is one command. Today's cleanup needed several manual lookups to find folder IDs.
7. **Music and ambience.** Play, stop or switch playlists ("tavern music", "battle drums").

## Later: Tier 3, maps

8. **Map preview.** Capture a picture of a scene and send it back to Claude, so it can check that its maps look right.
9. **Map art.** Generate battle map images with the image tools in the Claude app, then upload them as scenes with walls.
10. **Spell areas and Regions.** Spell area templates, and v14 Regions for traps, difficult terrain and teleporters.

## Housekeeping

- **Unreleased fix:** reveal, hide and rename list every token they touched, even ones that didn't change. It's on GitHub but not in a release yet; ship it with the next module release.
- **Production install:** not done yet. Use the same manifest URL as dev, enable the module in the world, and paste the token.
- **Folder IDs:** `list_documents` should return folder IDs, so folders can be deleted without reading full documents.
- **Tool list refresh:** after changing the server code, reconnect foundry-vtt in `/mcp` or start a new chat. A running chat keeps the tool list it started with.
- **Live testing:** `server/scripts/run-steps.mjs <steps.json>` drives the server against a real world without needing the chat's tool list.

## Releasing

- Module: `.\release-module.ps1 -Version x.y.z` (bumps `module.json`, builds the zip, tags, pushes, creates the GitHub release). Then **Check for Updates** in Foundry's setup screen.
- Server: `cd server; npm test`, then reconnect foundry-vtt in `/mcp`.
