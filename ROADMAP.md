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

## Done: v0.4 (items 5, 7, 8 and 9)

Released as v0.4.0. Live-tested on dev (2026-10-23): XP award and undo, treasure preview, the Party stash and a loot actor (with coins), a playlist played and stopped, a map-art scene with walls, previews of two scenes, session_log, and cleanup preview and confirm. **v0.4.1** fixes two things the test found: an empty `find_audio` search listed nothing, and bombs (weapons with the consumable trait in PF2e 8.x) were picked as permanent items.

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

## Done: v0.5 (item 10)

Released as v0.5.0. Live-tested on dev (2026-10-24) on a test scene with two PC tokens: a cone and a line from a token, a burst on a grid corner (12 squares, as PF2e counts a 10-foot burst), an emanation that follows its token, difficult terrain, a pit trap and a two-way portal, all drawn by `preview_scene` and listed by `session_log`. Walking a PC into the trap whispered the GM its card (Reflex DC 18, 2d6 bludgeoning) and switched the trap off; walking a PC onto the portal moved it to the arrival area, aura and all. Cleanup deleted the trap macro and its folder, but kept the test scene because it had become the active scene (cause unclear; Foundry's teleport doesn't activate scenes). After making River Crossing active again, a second cleanup deleted the scene and everything on it.

### Spell areas and Regions (Tier 3, item 10)
- Foundry v14 has no measured templates: they became Regions. Spell areas are Regions shaped the way PF2e places them (burst = circle, 90° cone, line one square wide, emanation around the token), flagged with PF2e's `areaShape`
- `place_spell_area`: a burst, cone, line, emanation or square, in feet, from a PF2e spell's own area or a shape and size. At a grid point (bursts centre on grid corners), or from a token: centred on it, surrounding it, or starting at its edge and aimed by direction (degrees or compass) or toward a square. Returns the squares covered and the tokens inside. Can be GM-only, or attached to the token so it moves with it
- `create_region`: rectangles, circles, polygons or single squares (holes allowed), hidden from players by default. Behaviours: difficult or greater difficult terrain (PF2e movement costs; flying ignores it unless asked), teleport to an existing region or a new arrival area on any scene (two-way optional), and traps
- Traps fire when a player's token enters: a tagged script macro (run on the GM's client) posts a card to the GM with PF2e `@Check` and `@Damage` buttons, can pause the game, and switches the trap off after one use. Or run your own macro
- Hidden means `visibility: GAMEMASTER`, not Region `hidden`: in v14 a hidden Region's behaviours don't run
- `preview_scene` draws Regions and spell areas in their colours with names (dashed = players can't see them) and lists them with their behaviours
- Regions and trap macros are session-tagged, so `session_log` and `cleanup_session` find them
- Pure geometry (feet to pixels, cone and line aim, token edges, squares covered, outlines) is in `foundry-module/scripts/areas.js` with tests in `server/src/test/areas.test.ts`

## Next

Nothing planned after item 10. Then the production install (see Housekeeping).

Small fixes found in the v0.5.0 live test:
- `move_tokens` returns before v14's move animation ends, so it reports the tokens' old squares (the move does happen). Return the target squares, or wait for the move
- `preview_scene` can put a Region's name on top of a token's name
- Check that the trap's chat card shows PF2e's save and damage buttons (the message stores `@Check` / `@Damage` text that PF2e turns into buttons when it shows the card)

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
