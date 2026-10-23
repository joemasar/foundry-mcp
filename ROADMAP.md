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

## Built, not yet released: v0.4.0 (items 5, 7, 8 and 9)

On branch `feature/rewards`, one commit per item. Ships as one module release (v0.4.0) after a live test on dev.

### Rewards (Tier 2, item 5)
- `award_xp`: XP for the PF2e Party or chosen characters, from a number, an accomplishment (minor 10, moderate 30, major 80) and/or the creatures defeated (always the four-PC award, as GM Core says). Shows before and after, flags anyone ready to level up, optional public chat note, `dryRun` preview. XP isn't a document, so each character keeps a short log of Claude's awards: `session_log` lists them and `cleanup_session` says they stay (a negative award takes XP back)
- `give_treasure`: a share of the level's treasure (default a quarter) or a gp budget, using GM Core's Party Treasure by Level table, with the extra-PC rule (one permanent item, two consumables and currency per character past four, or less for smaller parties). Picks common items at random from the official PF2e compendiums (homebrew only when nothing official fits a level, then a level lower), skipping cursed, artifact, intelligent and snare items; uncommon on request. Coins are tagged coin stacks. Goes to the Party stash, a character, or a new loot actor. Previews by default; the preview's items and coins are passed back to give exactly those, and `seed` repeats a pick
- Everything given is session-tagged. Items in the Party stash now count like items on player characters, so cleanup keeps them unless `includeCharacterItems`

### Music and ambience (Tier 2, item 7)
- `find_audio`: playlists and tracks by a loose name ("tavern music" looks for "tavern"), in the world and in compendium playlists, plus what's playing
- `audio_control`: play (switches off other playlists unless `exclusive: false`, for layering rain over music), stop one or everything, or status; optional volume. A compendium playlist is imported as a tagged copy first
- `create_playlist`: a tagged playlist from sound paths (e.g. from `upload_asset`), or tagged tracks added to an existing one. Cleanup now finds tracks added to the GM's playlists

### Map preview (Tier 3, item 8)
- `preview_scene`: a picture of any scene, drawn in the GM's browser without switching views: map art and tiles, a grid numbered from 0 at the top-left, walls and doors by colour, tokens as boxes (dashed when hidden), lights and pins, returned to Claude as an image with a legend. Layers can be turned off. Art hosted on a site that blocks reading it back is left out with a note

### Map art (Tier 3, item 9)
- `create_map_scene`: an image (local file, URL, base64 or a Foundry path), for example from the Claude app's image tools, becomes a scene sized to the grid asked for (`columns`, `rows`, or the art's own `pixelsPerSquare`; otherwise 25 squares on the long side). Rooms and doors become walls and doors, with no floors drawn over the art. Then `preview_scene` to check it lines up
- `upload_asset` now works out a missing file extension from the image bytes

## Next

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
