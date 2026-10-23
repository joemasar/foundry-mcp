# Foundry VTT MCP Server

Lets Claude act as a GM's assistant inside a live Foundry VTT game (built for Pathfinder 2e on Foundry v13/v14): drop in monsters, re-skin official creatures, make loot, write storylines and handouts, sketch battle maps, place ambushes and start encounters, all from a chat with Claude.

## How it works

```
Claude  ──MCP (stdio)──>  MCP server (Node, this repo)  <──WebSocket──  Foundry module (in the GM's browser)
```

Foundry has no outside API, so a small module runs in the **GM's browser tab** and connects to the MCP server on `ws://localhost:31415`. The server sends it commands; the module runs them with the GM's permissions using Foundry's own API. A shared token stops anything else from connecting.

**The GM's browser and Claude must run on the same computer.** Foundry itself can be anywhere (this PC, another PC, The Forge, Molten), because only the browser tab talks to the server.

## Setup

### 1. Build the server

```bash
cd C:/dev/foundry-mcp/server
npm install
npm run build
```

### 2. Connect Claude

- **Claude Code / Claude desktop app (Code tab):** register it once as a user-level server, so it's in every chat and shows in `/mcp` (where you can reconnect it after rebuilding the server):
  ```bash
  claude mcp add --scope user foundry-vtt -- node C:/dev/foundry-mcp/server/dist/index.js
  ```
  The desktop app bundles `claude.exe` under `%LOCALAPPDATA%\Claude-Data\...\claude-code\<version>\` if it isn't on your PATH.
- **Claude Desktop (chat):** Settings > Developer > Edit Config, and add:
  ```json
  {
    "mcpServers": {
      "foundry-vtt": { "command": "node", "args": ["C:/dev/foundry-mcp/server/dist/index.js"] }
    }
  }
  ```

Run only one copy at a time (both apps at once will fight over the port).

On first start the server creates a token in `%USERPROFILE%\.foundry-mcp\token`. Or set your own with the `FOUNDRY_MCP_TOKEN` environment variable in the config above (`"env": { "FOUNDRY_MCP_TOKEN": "..." }`).

### 3. Install the Foundry module

- **Any Foundry server (recommended):** on the Foundry setup screen, go to **Add-on Modules** > **Install Module**, paste this into **Manifest URL**, and click Install:
  ```
  https://github.com/joemasar/foundry-mcp/releases/latest/download/module.json
  ```
  Later versions show up under **Check for Updates**.
- **Local Foundry, from this folder:** `.\install-module.ps1 -DataPath "<your User Data Path>"`.

To publish a new module version: `.\release-module.ps1 -Version 0.1.1`.

Then, in your world: **Manage Modules** > enable **Foundry MCP Bridge** > **Configure Settings** > **Foundry MCP Bridge**:

| Setting | Value |
| --- | --- |
| MCP server URL | `ws://localhost:31415` |
| Connection token | contents of `%USERPROFILE%\.foundry-mcp\token` |
| Allow scripts | Off, unless you want the `run_script` escape hatch |

You'll see "Foundry MCP: connected to Claude." Settings are stored only in the GM's browser; players never see the token.

### 4. Try it

Ask Claude things like:

- "Check the Foundry connection."
- "The party just kicked in the door. Put 4 goblin warriors and a goblin war chanter hidden in the back of this room, then start the fight."
- "Make an elite version of the Ogre Warrior called Grukk the Unbowed, give him a +1 greataxe, and put him in an 'Act 2' folder."
- "Build a homebrew level 5 swamp hag with a curse reaction and occult innate spells."
- "Write a journal for the smuggler's guild storyline: three NPCs, their secrets, and two hooks for next session. Link the NPCs."
- "Sketch a small crypt: an entry hall, a corridor, a burial chamber with a secret door, and a lit shrine."
- "Upload C:\Maps\tavern.webp as a scene, 70px grid, and make it active."
- "Roll on the 'Rumors' table and whisper me the result."

## Tools

| Area | Tools |
| --- | --- |
| World | `foundry_status`, `list_documents`, `get_document`, `update_document`, `delete_document`, `create_folder` |
| Compendiums | `search_compendium`, `import_from_compendium` (with rename and field changes) |
| Creatures | `create_pf2e_npc`, `apply_pf2e_adjustment` (elite/weak), `add_items_to_actor` |
| Items | `create_pf2e_item` |
| Story | `create_journal`, `add_journal_page`, `show_journal_to_players`, `create_roll_table` |
| Maps | `upload_asset`, `create_scene`, `build_map_layout`, `add_walls`, `add_lights`, `add_map_notes`, `place_tokens`, `scene_control` |
| Encounters | `evaluate_encounter` (PF2e XP difficulty), `build_encounter` (pick, import, place, journal), `start_encounter` |
| Tokens | `move_tokens`, `set_token_state` (reveal, hide, rename, remove), `damage_or_heal`, `set_conditions` |
| Combat | `combat_status`, `combat_control` (turns, rounds, add, remove, defeated, initiative, end) |
| Table | `read_chat`, `roll`, `send_chat` |
| Session log | `start_session`, `session_log` (what Claude made), `cleanup_session` (preview, then delete) |
| Escape hatch | `run_script` (off by default) |

Grid positions are squares counted from the top-left of the map, starting at 0.

Everything Claude creates is tagged with a session, so you can ask "what did we make tonight?" or "delete the test stuff". Name one with "start a session called Session 12"; otherwise a session named after the date and time starts on its own and lasts 12 hours. Cleanup always shows a preview first. Uploaded files and chat messages aren't removed.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `FOUNDRY_MCP_PORT` | `31415` | Bridge port (change the module's server URL to match) |
| `FOUNDRY_MCP_HOST` | `127.0.0.1` | Bridge listen address |
| `FOUNDRY_MCP_TOKEN` | generated | Shared secret |

## Development

```bash
cd server
npm test   # builds, then runs map-layout unit tests and an end-to-end test with a fake Foundry client
```

- `server/src/tools.ts`: tool definitions Claude sees.
- `server/src/bridge.ts`: WebSocket bridge.
- `server/src/mapLayout.ts`: rooms to walls and doors.
- `foundry-module/scripts/handlers.js`: what each action does inside Foundry.
- `foundry-module/scripts/sessions.js`: session tags and cleanup planning (no Foundry globals, tested from `server`).

To add a tool, register it in `tools.ts` and add a handler with the same action name in `handlers.js`. After changing the module, reload the Foundry tab.
