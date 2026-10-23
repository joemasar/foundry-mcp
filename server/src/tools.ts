import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FoundryBridge } from "./bridge.js";
import { buildLayout } from "./mapLayout.js";

const MAX_TEXT = 60_000;

function text(value: unknown) {
  let out = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (out.length > MAX_TEXT) out = out.slice(0, MAX_TEXT) + `\n... (cut off, ${out.length - MAX_TEXT} more characters)`;
  return { content: [{ type: "text" as const, text: out }] };
}

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
};

// Shared schema pieces
const DOC_TYPES = ["Actor", "Item", "JournalEntry", "Scene", "RollTable", "Macro", "Playlist", "Cards", "Adventure"] as const;
const sceneRef = z
  .string()
  .optional()
  .describe("Scene UUID (e.g. 'Scene.abc123'). Leave out to use the scene the GM is currently viewing.");
const folderRef = z.string().optional().describe("Folder name or ID to put the new document in. Created if it does not exist.");
const pf2eTraits = z.array(z.string()).optional().describe("PF2e trait slugs, lowercase, e.g. ['undead','skeleton','mindless']");

const strikeSchema = z.object({
  name: z.string().describe("e.g. 'Jaws', 'Shortbow'"),
  bonus: z.number().int().describe("Attack modifier, e.g. 14 for +14"),
  damage: z
    .array(z.object({ formula: z.string().describe("e.g. '2d8+6'"), type: z.string().describe("PF2e damage type slug: slashing, piercing, bludgeoning, fire, cold, poison, mental, void, vitality, etc.") }))
    .min(1),
  traits: z.array(z.string()).optional().describe("Weapon traits, e.g. ['agile','finesse','reach-10']"),
  range: z.number().optional().describe("Range increment in feet for ranged attacks (adds the range-increment trait)."),
  effects: z.array(z.string()).optional().describe("Attack effect slugs, e.g. ['grab','knockdown','improved-grab']"),
});

const actionSchema = z.object({
  name: z.string(),
  actionType: z.enum(["action", "reaction", "free", "passive"]).default("action"),
  actions: z.number().int().min(1).max(3).optional().describe("Number of actions for actionType 'action'."),
  category: z.enum(["offensive", "defensive", "interaction"]).optional(),
  description: z.string().describe("HTML. PF2e inline rolls work, e.g. '@Damage[4d6[fire]]' and '@Check[reflex|dc:24|basic]'."),
  traits: z.array(z.string()).optional(),
});

export function registerTools(server: McpServer, bridge: FoundryBridge, tokenInfo: { token: string; source: string; port: number }) {
  const call = (action: string, params: unknown = {}, timeoutMs?: number) =>
    bridge.request(action, params, timeoutMs).then(text, fail);

  // ---------- Connection & world info ----------

  server.registerTool(
    "foundry_status",
    {
      title: "Foundry status",
      description:
        "Check the connection to Foundry and get an overview of the world: system, version, active scene, players online and how many actors/items/journals/scenes exist. Call this first in a session.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      if (!bridge.connected) {
        return text({
          connected: false,
          problem: bridge.listenError ?? "The GM's Foundry browser tab is not connected.",
          howToConnect: `In Foundry: Game Settings > Configure Settings > Foundry MCP Bridge. Server URL ws://localhost:${tokenInfo.port}, token from ${tokenInfo.source}. The GM must have the world open in a browser.`,
        });
      }
      return call("status");
    },
  );

  // ---------- Finding things ----------

  server.registerTool(
    "list_documents",
    {
      title: "List world documents",
      description: "List documents in the world (not compendiums), e.g. all NPCs, all journals in a folder, or scenes matching a name.",
      inputSchema: {
        documentType: z.enum(DOC_TYPES),
        search: z.string().optional().describe("Case-insensitive name filter."),
        folder: z.string().optional().describe("Only documents in this folder (name or ID)."),
        subtype: z.string().optional().describe("System subtype, e.g. 'npc', 'character', 'weapon', 'consumable'."),
        limit: z.number().int().min(1).max(500).default(100),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => call("list", args),
  );

  server.registerTool(
    "get_document",
    {
      title: "Read a document",
      description:
        "Read one document by UUID (from list_documents or search_compendium). Returns a readable summary by default: for NPCs that is level, defenses, strikes and abilities; for journals the page text; for scenes the size and what is on it. Set full=true for the raw data, which can be very large.",
      inputSchema: {
        uuid: z.string(),
        full: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => call("get", args),
  );

  server.registerTool(
    "search_compendium",
    {
      title: "Search compendiums",
      description:
        "Search compendium packs (Pathfinder bestiaries, equipment, spells, hazards, feats, adventure content and any installed module packs). The fastest way to get official, correct stats: search here first, then import_from_compendium.",
      inputSchema: {
        query: z.string().describe("Words that must all appear in the name, e.g. 'goblin warrior' or 'healing potion'. Use '' with filters to browse."),
        documentType: z.enum(["Actor", "Item", "JournalEntry", "RollTable", "Scene", "Macro", "Adventure"]).optional(),
        subtype: z.string().optional().describe("e.g. 'npc', 'hazard', 'weapon', 'armor', 'consumable', 'spell', 'feat', 'equipment', 'treasure'"),
        pack: z.string().optional().describe("Limit to packs whose ID or title contains this text, e.g. 'bestiary' or 'pf2e.equipment-srd'."),
        minLevel: z.number().int().optional(),
        maxLevel: z.number().int().optional(),
        traits: z.array(z.string()).optional().describe("Every listed trait must be present, e.g. ['undead']"),
        rarity: z.enum(["common", "uncommon", "rare", "unique"]).optional(),
        limit: z.number().int().min(1).max(200).default(25),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => call("compendium.search", args, 120_000),
  );

  // ---------- Creatures ----------

  server.registerTool(
    "import_from_compendium",
    {
      title: "Import from compendium",
      description:
        "Copy a compendium entry (creature, item, journal, table, scene) into the world. Optionally rename or change fields on the copy, so you can re-skin an official monster: e.g. a Goblin Warrior renamed 'Scrapjaw' with more HP. Use apply_pf2e_adjustment for quick elite/weak versions.",
      inputSchema: {
        uuid: z.string().describe("Compendium UUID from search_compendium, e.g. 'Compendium.pf2e.pathfinder-bestiary.Actor.abc123'"),
        name: z.string().optional().describe("New name for the copy."),
        folder: folderRef,
        changes: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Field changes in dot notation, e.g. {'system.attributes.hp.max': 40, 'system.attributes.hp.value': 40, 'img': 'path.webp'}"),
        count: z.number().int().min(1).max(20).default(1).describe("How many copies to make (each one is a separate world document)."),
      },
    },
    (args) => call("compendium.import", args),
  );

  server.registerTool(
    "create_pf2e_npc",
    {
      title: "Create a PF2e creature",
      description:
        "Build a new Pathfinder 2e NPC or monster from a stat block. Use this for homebrew creatures; for official monsters, import_from_compendium is faster and exact. Follow the PF2e Building Creatures guidelines (GM Core) so numbers fit the level. Strikes, abilities, spells and extra compendium items are added to the creature automatically.",
      inputSchema: {
        name: z.string(),
        level: z.number().int().min(-1).max(25),
        size: z.enum(["tiny", "sm", "med", "lg", "huge", "grg"]).default("med"),
        rarity: z.enum(["common", "uncommon", "rare", "unique"]).default("common"),
        traits: pf2eTraits,
        ac: z.number().int(),
        hp: z.number().int().min(1),
        perception: z.number().int(),
        senses: z.array(z.string()).optional().describe("Sense slugs, e.g. ['darkvision','scent'] or ['low-light-vision']"),
        saves: z.object({ fortitude: z.number().int(), reflex: z.number().int(), will: z.number().int() }),
        abilities: z
          .object({ str: z.number().int(), dex: z.number().int(), con: z.number().int(), int: z.number().int(), wis: z.number().int(), cha: z.number().int() })
          .describe("Attribute modifiers, e.g. str: 4"),
        skills: z.record(z.string(), z.number().int()).optional().describe("Skill slug to modifier, e.g. {athletics: 12, stealth: 9}. Lores as 'warfare-lore'."),
        speed: z.number().int().default(25),
        otherSpeeds: z.array(z.object({ type: z.enum(["fly", "swim", "climb", "burrow"]), value: z.number().int() })).optional(),
        languages: z.array(z.string()).optional().describe("Language slugs, e.g. ['common','draconic']"),
        immunities: z.array(z.string()).optional().describe("e.g. ['poison','paralyzed','death-effects']"),
        resistances: z.array(z.object({ type: z.string(), value: z.number().int() })).optional(),
        weaknesses: z.array(z.object({ type: z.string(), value: z.number().int() })).optional(),
        strikes: z.array(strikeSchema).optional(),
        actions: z.array(actionSchema).optional().describe("Special abilities, reactions and passive abilities."),
        spellcasting: z
          .object({
            name: z.string().optional().describe("e.g. 'Occult Innate Spells'"),
            tradition: z.enum(["arcane", "divine", "occult", "primal"]),
            type: z.enum(["innate", "prepared", "spontaneous", "focus"]).default("innate"),
            dc: z.number().int(),
            attack: z.number().int(),
            spells: z.array(z.string()).describe("Spell names to look up in the PF2e spells compendium, e.g. ['Fear', 'Fireball']"),
          })
          .optional(),
        itemUuids: z.array(z.string()).optional().describe("Extra compendium items to add (gear, abilities from the bestiary ability glossary, etc.)."),
        description: z.string().optional().describe("Public description (HTML), shown to players who recall knowledge."),
        gmNotes: z.string().optional().describe("Private GM notes (HTML): tactics, motives, plot hooks."),
        img: z.string().optional().describe("Image path inside Foundry data, e.g. from upload_asset. Defaults to the system icon."),
        folder: folderRef,
      },
    },
    (args) => call("pf2e.createNpc", args, 120_000),
  );

  server.registerTool(
    "apply_pf2e_adjustment",
    {
      title: "Elite / weak adjustment",
      description: "Apply the PF2e elite or weak adjustment to an NPC (or remove it with 'normal'). Good for quick on-the-fly difficulty tuning.",
      inputSchema: {
        actorUuid: z.string(),
        adjustment: z.enum(["elite", "weak", "normal"]),
      },
    },
    (args) => call("pf2e.adjust", args),
  );

  // ---------- Items ----------

  server.registerTool(
    "create_pf2e_item",
    {
      title: "Create a PF2e item",
      description:
        "Create a homebrew PF2e item in the world (loot, magic items, consumables, quest items, feats, effects). For official items use search_compendium + import_from_compendium. Use actorUuid to give it straight to a character or NPC.",
      inputSchema: {
        name: z.string(),
        type: z
          .enum(["equipment", "weapon", "armor", "shield", "consumable", "treasure", "backpack", "feat", "action", "effect", "condition"])
          .describe("'treasure' for coins/gems/art, 'equipment' for worn or held magic items, 'backpack' for containers."),
        level: z.number().int().min(0).max(30).default(0),
        price: z.object({ pp: z.number().optional(), gp: z.number().optional(), sp: z.number().optional(), cp: z.number().optional() }).optional(),
        rarity: z.enum(["common", "uncommon", "rare", "unique"]).default("common"),
        traits: pf2eTraits,
        bulk: z.number().optional().describe("Bulk value; 0.1 means light (L)."),
        description: z.string().describe("HTML description. Inline rolls work, e.g. '[[/r 2d8+5 #healing]]' or '@Damage[2d6[fire]]'."),
        img: z.string().optional(),
        system: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Extra PF2e system fields in dot notation, e.g. for a weapon {'damage.dice': 1, 'damage.die': 'd8', 'damage.damageType': 'slashing', 'category': 'martial', 'group': 'sword', 'runes.potency': 1}"),
        actorUuid: z.string().optional().describe("Put the item directly on this actor instead of the world item list."),
        quantity: z.number().int().min(1).optional(),
        folder: folderRef,
      },
    },
    (args) => call("pf2e.createItem", args),
  );

  server.registerTool(
    "add_items_to_actor",
    {
      title: "Give items to an actor",
      description: "Give existing items (world or compendium UUIDs) to a PC or NPC, e.g. loot, a reward, or extra abilities for a monster.",
      inputSchema: {
        actorUuid: z.string(),
        itemUuids: z.array(z.string()).min(1),
        quantity: z.number().int().min(1).optional().describe("Sets the quantity on each added physical item."),
      },
    },
    (args) => call("actor.addItems", args),
  );

  // ---------- Story ----------

  server.registerTool(
    "create_journal",
    {
      title: "Create a journal",
      description:
        "Create a journal entry with one or more pages: storylines, NPC profiles, handouts, location write-ups, session notes. Content is HTML. Link documents with @UUID[uuid]{label} so the GM can click through to actors, items or scenes.",
      inputSchema: {
        name: z.string(),
        pages: z
          .array(z.object({ title: z.string(), content: z.string().describe("HTML") }))
          .min(1),
        folder: folderRef,
        showToPlayers: z.boolean().default(false).describe("true lets every player read it (observer permission)."),
        popOut: z.boolean().default(false).describe("Open it on the GM's screen after creating it."),
      },
    },
    (args) => call("journal.create", args),
  );

  server.registerTool(
    "add_journal_page",
    {
      title: "Add a journal page",
      description: "Append a page to an existing journal (e.g. a new chapter of the storyline or session notes), or replace a page's text if a page with that title exists and replace=true.",
      inputSchema: {
        journalUuid: z.string(),
        title: z.string(),
        content: z.string().describe("HTML"),
        replace: z.boolean().default(false),
      },
    },
    (args) => call("journal.addPage", args),
  );

  server.registerTool(
    "show_journal_to_players",
    {
      title: "Show a journal to players",
      description: "Pop a journal (or one of its pages) open on every player's screen, like handing out a handout.",
      inputSchema: {
        uuid: z.string().describe("Journal or journal page UUID"),
      },
    },
    (args) => call("journal.show", args),
  );

  server.registerTool(
    "create_roll_table",
    {
      title: "Create a roll table",
      description: "Create a random table: encounters, rumors, loot, NPC names, weather. Ranges are worked out from the weights.",
      inputSchema: {
        name: z.string(),
        description: z.string().optional(),
        results: z
          .array(z.object({ text: z.string(), weight: z.number().int().min(1).default(1) }))
          .min(1),
        formula: z.string().optional().describe("Defaults to 1d(total weight)."),
        folder: folderRef,
      },
    },
    (args) => call("table.create", args),
  );

  // ---------- Maps & scenes ----------

  server.registerTool(
    "upload_asset",
    {
      title: "Upload an image or sound",
      description:
        "Upload a file from this computer (localPath) or from a web URL into Foundry's data folder under foundry-mcp/<subfolder>. Returns the Foundry path to use as a scene background, token or item image, or playlist sound.",
      inputSchema: {
        localPath: z.string().optional().describe("Absolute path to a file on this computer."),
        url: z.string().url().optional().describe("Web URL to download from."),
        fileName: z.string().optional().describe("Name to save as. Defaults to the source file name."),
        subfolder: z.string().default("uploads").describe("e.g. 'maps', 'tokens', 'handouts'"),
      },
    },
    async ({ localPath, url, fileName, subfolder }) => {
      try {
        let data: Buffer;
        let name = fileName;
        if (localPath) {
          data = await readFile(localPath);
          name ??= basename(localPath);
        } else if (url) {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
          data = Buffer.from(await res.arrayBuffer());
          name ??= basename(new URL(url).pathname) || "download";
        } else {
          throw new Error("Give either localPath or url.");
        }
        if (data.length > 50 * 1024 * 1024) throw new Error("File is larger than 50 MB.");
        const ext = extname(name).toLowerCase();
        const mime = MIME[ext];
        if (!mime) throw new Error(`Unsupported file type '${ext}'. Use one of: ${Object.keys(MIME).join(", ")}`);
        const safeName = name.replace(/[^\w.\- ]+/g, "_");
        return await bridge
          .request("asset.upload", { fileName: safeName, subfolder, mime, base64: data.toString("base64") }, 180_000)
          .then(text);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "create_scene",
    {
      title: "Create a scene",
      description:
        "Create a new scene (map). Give a background image path (e.g. from upload_asset) and the scene is sized to the image automatically, or give width/height for a blank scene. For a quick drawn dungeon layout use build_map_layout instead.",
      inputSchema: {
        name: z.string(),
        background: z.string().optional().describe("Foundry image path or URL for the map."),
        width: z.number().int().optional().describe("Pixels. Defaults to the image width, or 30 grid squares."),
        height: z.number().int().optional().describe("Pixels. Defaults to the image height, or 20 grid squares."),
        gridSize: z.number().int().min(20).default(100).describe("Pixels per square. Match your map's grid."),
        gridDistance: z.number().default(5).describe("Feet per square."),
        darkness: z.number().min(0).max(1).default(0).describe("0 = daylight, 1 = pitch dark."),
        tokenVision: z.boolean().default(true),
        backgroundColor: z.string().optional().describe("e.g. '#222222'"),
        folder: folderRef,
        activate: z.boolean().default(false).describe("Make it the active scene for players."),
        view: z.boolean().default(true).describe("Switch the GM's view to it."),
      },
    },
    (args) => call("scene.create", args),
  );

  server.registerTool(
    "build_map_layout",
    {
      title: "Build a map layout",
      description:
        "Draw a quick battle map from rectangular rooms and corridors on a grid: floors are drawn, walls are placed automatically around every room (and between rooms that touch), and doors go where you say. Great for an improvised dungeon, building interior or cave when there is no map art. Cell (0,0) is the top-left square. Rooms that should connect must touch, with a door or opening on the shared edge.",
      inputSchema: {
        name: z.string().describe("Scene name (used when a new scene is created)."),
        sceneUuid: z.string().optional().describe("Draw onto this existing scene instead of creating a new one."),
        rooms: z
          .array(
            z.object({
              x: z.number().int().min(0),
              y: z.number().int().min(0),
              w: z.number().int().min(1),
              h: z.number().int().min(1),
              label: z.string().optional().describe("Shown on the map for the GM, e.g. 'A1 Guard Room'."),
              color: z.string().optional().describe("Floor colour, e.g. '#5a4a3a'."),
              lit: z.boolean().optional().describe("Put a light in the middle of the room."),
            }),
          )
          .min(1),
        doors: z
          .array(
            z.object({
              x: z.number().int(),
              y: z.number().int(),
              side: z.enum(["n", "s", "e", "w"]).describe("Which edge of cell (x,y) the door is on."),
              type: z.enum(["door", "secret", "opening"]).default("door"),
            }),
          )
          .default([]),
        gridSize: z.number().int().default(100),
        darkness: z.number().min(0).max(1).default(0.6),
        replaceExisting: z.boolean().default(false).describe("When drawing onto an existing scene, first delete its walls, drawings and lights."),
        activate: z.boolean().default(false),
        folder: folderRef,
      },
    },
    async (args) => {
      try {
        const layout = buildLayout(args.rooms, args.doors);
        return await bridge.request("scene.buildLayout", { ...args, layout }, 120_000).then(text);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "add_walls",
    {
      title: "Add walls",
      description: "Add walls and doors to a scene, e.g. to make a background image map block vision. Coordinates are grid-line intersections (units='grid') or pixels.",
      inputSchema: {
        sceneUuid: sceneRef,
        units: z.enum(["grid", "pixels"]).default("grid"),
        walls: z
          .array(
            z.object({
              points: z.array(z.number()).min(4).describe("A polyline: [x1,y1, x2,y2, x3,y3, ...]. Each pair after the first adds a segment."),
              type: z.enum(["wall", "door", "secret", "window", "invisible", "ethereal"]).default("wall"),
            }),
          )
          .min(1),
      },
    },
    (args) => call("scene.addWalls", args),
  );

  server.registerTool(
    "add_lights",
    {
      title: "Add lights",
      description: "Add light sources to a scene (torches, braziers, magical glows). x/y in grid squares (2.5 = middle of the third square) or pixels.",
      inputSchema: {
        sceneUuid: sceneRef,
        units: z.enum(["grid", "pixels"]).default("grid"),
        lights: z
          .array(
            z.object({
              x: z.number(),
              y: z.number(),
              bright: z.number().default(20).describe("Bright radius in feet."),
              dim: z.number().default(40).describe("Dim radius in feet."),
              color: z.string().optional().describe("e.g. '#ff9933' for torchlight"),
              animation: z.enum(["torch", "flame", "pulse", "chroma", "wave", "fog", "sunburst", "ghost", "energy", "none"]).default("none"),
            }),
          )
          .min(1),
      },
    },
    (args) => call("scene.addLights", args),
  );

  server.registerTool(
    "place_tokens",
    {
      title: "Place tokens",
      description:
        "Put creatures on a scene. Each position is a grid square (column, row) counted from the top-left of the map. If you ask for more tokens than positions, the extras are placed in a row next to the last one.",
      inputSchema: {
        sceneUuid: sceneRef,
        actorUuid: z.string().describe("World actor UUID. Import compendium creatures first."),
        positions: z.array(z.object({ x: z.number(), y: z.number() })).min(1),
        count: z.number().int().min(1).max(50).optional(),
        hidden: z.boolean().default(false).describe("Hidden from players until revealed (for ambushes)."),
        name: z.string().optional().describe("Override the token name, e.g. 'Cultist'. Numbers are appended when placing several."),
      },
    },
    (args) => call("scene.placeTokens", args),
  );

  server.registerTool(
    "add_map_notes",
    {
      title: "Add map pins",
      description: "Pin journal entries to spots on a scene (room descriptions, clues, points of interest). x/y in grid squares.",
      inputSchema: {
        sceneUuid: sceneRef,
        notes: z
          .array(
            z.object({
              x: z.number(),
              y: z.number(),
              journalUuid: z.string().describe("Journal or journal page UUID."),
              label: z.string().optional(),
            }),
          )
          .min(1),
      },
    },
    (args) => call("scene.addNotes", args),
  );

  server.registerTool(
    "scene_control",
    {
      title: "Change scenes",
      description: "Activate a scene for everyone, switch only the GM's view, or change the lighting (darkness level).",
      inputSchema: {
        sceneUuid: z.string(),
        action: z.enum(["activate", "view", "setDarkness"]),
        darkness: z.number().min(0).max(1).optional(),
      },
    },
    (args) => call("scene.control", args),
  );

  // ---------- At the table ----------

  server.registerTool(
    "start_encounter",
    {
      title: "Start an encounter",
      description: "Create a combat on a scene with the chosen tokens (default: every token on the scene), roll initiative for NPCs, and start it.",
      inputSchema: {
        sceneUuid: sceneRef,
        tokenIds: z.array(z.string()).optional(),
        rollNpcInitiative: z.boolean().default(true),
        start: z.boolean().default(true),
      },
    },
    (args) => call("combat.start", args),
  );

  server.registerTool(
    "roll",
    {
      title: "Roll dice or a table",
      description: "Roll a dice formula or draw from a roll table. Results go to chat (whispered to the GM by default) and are returned here.",
      inputSchema: {
        formula: z.string().optional().describe("e.g. '1d20+7' or '4d6'"),
        tableUuid: z.string().optional(),
        flavor: z.string().optional(),
        whisperGM: z.boolean().default(true),
      },
    },
    (args) => call("roll", args),
  );

  server.registerTool(
    "send_chat",
    {
      title: "Send a chat message",
      description: "Post to Foundry chat: narration, an NPC speaking in character (speakerActorUuid), or a private GM note.",
      inputSchema: {
        content: z.string().describe("HTML"),
        speakerActorUuid: z.string().optional(),
        whisperGM: z.boolean().default(false),
      },
    },
    (args) => call("chat.send", args),
  );

  // ---------- Housekeeping ----------

  server.registerTool(
    "update_document",
    {
      title: "Update a document",
      description: "Change fields on any document using dot notation, e.g. {'name': 'Captain Vex', 'system.attributes.hp.value': 12}. Works on actors, items, tokens, journals, scenes and embedded documents.",
      inputSchema: {
        uuid: z.string(),
        changes: z.record(z.string(), z.unknown()),
      },
    },
    (args) => call("update", args),
  );

  server.registerTool(
    "delete_document",
    {
      title: "Delete a document",
      description: "Delete a world document (actor, item, journal, scene, token, etc.). This cannot be undone. Always ask the GM before deleting anything you did not just create.",
      inputSchema: {
        uuid: z.string(),
        confirm: z.literal(true).describe("Must be true."),
      },
      annotations: { destructiveHint: true },
    },
    (args) => call("delete", args),
  );

  server.registerTool(
    "create_folder",
    {
      title: "Create a folder",
      description: "Create a folder to organise actors, items, journals, scenes or tables (e.g. 'Session 12', 'Act 2 NPCs').",
      inputSchema: {
        name: z.string(),
        documentType: z.enum(["Actor", "Item", "JournalEntry", "Scene", "RollTable", "Macro", "Playlist"]),
        parent: z.string().optional().describe("Parent folder name or ID."),
        color: z.string().optional(),
      },
    },
    (args) => call("folder.create", args),
  );

  server.registerTool(
    "run_script",
    {
      title: "Run a Foundry script",
      description:
        "Run JavaScript inside the GM's Foundry client for anything the other tools can't do. The code is an async function body with game, canvas, ui, foundry and CONFIG in scope; return a JSON-friendly value. Disabled unless the GM turns on 'Allow scripts' in the module settings.",
      inputSchema: {
        code: z.string(),
      },
      annotations: { destructiveHint: true },
    },
    (args) => call("script.run", args, 120_000),
  );
}
