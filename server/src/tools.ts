import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FoundryBridge } from "./bridge.js";
import { buildLayout } from "./mapLayout.js";
import { DIFFICULTIES, budgetFor, evaluateEncounter, pickEncounter, type Difficulty } from "./encounter.js";

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
const DOC_TYPES = ["Actor", "Item", "JournalEntry", "Scene", "RollTable", "Macro", "Playlist", "Cards", "Adventure", "Folder"] as const;
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
      description:
        "List documents in the world (not compendiums), e.g. all NPCs, all journals in a folder, or scenes matching a name. Each result has its folder name and folderId. Use documentType 'Folder' to list folders themselves (with what they hold) and get their UUIDs.",
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
        "Put creatures on a scene. Each position is a grid square (column, row) counted from the top-left of the map. Give exact positions, or an area and the tokens are spread over free squares in it without overlapping. With positions, extra tokens go in a row next to the last one.",
      inputSchema: {
        sceneUuid: sceneRef,
        actorUuid: z.string().describe("World actor UUID. Import compendium creatures first."),
        positions: z.array(z.object({ x: z.number(), y: z.number() })).optional().describe("Exact squares, one per token."),
        area: z
          .object({ x: z.number().int(), y: z.number().int(), w: z.number().int().min(1), h: z.number().int().min(1) })
          .optional()
          .describe("Or a grid area: tokens go on free squares inside it, sized for the creature (Large takes 2x2)."),
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
      description:
        "Delete a world document (actor, item, journal, scene, token, folder, etc.). This cannot be undone. Always ask the GM before deleting anything you did not just create. A deleted folder's contents move up to its parent. To remove everything from a session, use cleanup_session.",
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

  // ---------- Live table: tokens ----------

  const tokenRefs = z
    .array(z.string())
    .min(1)
    .describe("Token names or IDs. A name also matches numbered copies: 'Goblin Pyro' finds 'Goblin Pyro 1' and 'Goblin Pyro 2'.");

  server.registerTool(
    "move_tokens",
    {
      title: "Move tokens",
      description: "Move tokens to grid squares (column, row from the top-left). Moves ignore walls, so check the map makes sense.",
      inputSchema: {
        sceneUuid: sceneRef,
        moves: z.array(z.object({ token: z.string().describe("Exact token name or ID"), x: z.number(), y: z.number() })).min(1),
      },
    },
    (args) => call("tokens.move", args),
  );

  server.registerTool(
    "set_token_state",
    {
      title: "Reveal, hide, rename or remove tokens",
      description: "Reveal hidden tokens (spring the ambush), hide them again, rename them, or remove them from the map. Hiding or revealing also updates them in a running combat.",
      inputSchema: {
        sceneUuid: sceneRef,
        tokens: tokenRefs,
        action: z.enum(["reveal", "hide", "rename", "remove"]),
        name: z.string().optional().describe("New name for 'rename'. Several tokens get numbered."),
      },
    },
    (args) => call("tokens.state", args),
  );

  server.registerTool(
    "damage_or_heal",
    {
      title: "Damage or heal",
      description:
        "Change hit points on tokens. In PF2e, damage goes through the system: temporary HP are used first, resistances/weaknesses/immunities apply when you give a damage type, and creatures at 0 HP are knocked out or killed by the usual rules. Use mode 'set' to set HP to an exact number.",
      inputSchema: {
        sceneUuid: sceneRef,
        tokens: tokenRefs,
        mode: z.enum(["damage", "heal", "set"]),
        amount: z.number().int().min(0),
        damageType: z.string().optional().describe("PF2e damage type for damage, e.g. 'fire', 'slashing', 'void'."),
      },
    },
    (args) => call("tokens.hp", args),
  );

  server.registerTool(
    "set_conditions",
    {
      title: "Add or remove conditions",
      description: "Add or remove conditions on tokens: frightened 1, prone, off-guard, grabbed, slowed 1, stunned 2, dying, persistent damage is not covered. Valued conditions take a value; adding one that is already there sets it to the new value.",
      inputSchema: {
        sceneUuid: sceneRef,
        tokens: tokenRefs,
        add: z
          .array(z.object({ slug: z.string().describe("PF2e condition slug: frightened, off-guard, prone, grabbed, restrained, slowed, stunned, sickened, clumsy, enfeebled, drained, stupefied, blinded, dazzled, deafened, fatigued, hidden, unconscious, wounded, dying, doomed, quickened, confused, fleeing, paralyzed, petrified, controlled, immobilized, invisible, concealed, undetected, encumbered..."), value: z.number().int().min(1).optional() }))
          .optional(),
        remove: z.array(z.string()).optional().describe("Condition slugs to remove completely."),
      },
    },
    (args) => call("tokens.conditions", args),
  );

  // ---------- Live table: combat ----------

  server.registerTool(
    "combat_status",
    {
      title: "Combat status",
      description: "See the running combat: round, whose turn it is, and every combatant's initiative, HP, AC and conditions.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => call("combat.status"),
  );

  server.registerTool(
    "combat_control",
    {
      title: "Run combat",
      description:
        "Drive the running combat: start, next_turn, previous_turn, next_round, end (deletes the combat; ask the GM first), add tokens (NPC initiative is rolled), remove tokens, mark tokens defeated, or roll_initiative (for the named tokens, or everyone who has not rolled). Returns the updated turn order.",
      inputSchema: {
        action: z.enum(["start", "next_turn", "previous_turn", "next_round", "end", "add", "remove", "defeated", "roll_initiative"]),
        tokens: z.array(z.string()).optional().describe("Token names or IDs, for add, remove, defeated and roll_initiative."),
        sceneUuid: sceneRef,
      },
    },
    (args) => call("combat.control", args),
  );

  // ---------- Live table: chat ----------

  server.registerTool(
    "read_chat",
    {
      title: "Read the chat log",
      description:
        "Read recent chat messages: who said or rolled what, roll totals, and for PF2e checks the type, DC, target and outcome (success, failure, critical success...). Use it to catch up on what just happened at the table.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20),
        rollsOnly: z.boolean().default(false),
        includeWhispers: z.boolean().default(true),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => call("chat.read", args),
  );

  // ---------- Encounters ----------

  async function partyInfo(level?: number, size?: number) {
    if (level !== undefined && size !== undefined) return { level, size, members: undefined as unknown };
    const party = await bridge.request<{ party: string | null; members: { name: string; level?: number }[] }>("pf2e.party");
    const levels = party.members.map((m) => m.level).filter((n): n is number => typeof n === "number");
    if (!levels.length) {
      throw new Error("No PF2e Party with members found in this world. Give partyLevel and partySize, or add the characters to the Party in the Actors tab.");
    }
    return {
      level: level ?? Math.round(levels.reduce((a, b) => a + b, 0) / levels.length),
      size: size ?? levels.length,
      members: party.members,
    };
  }

  server.registerTool(
    "evaluate_encounter",
    {
      title: "Rate an encounter",
      description:
        "Rate how hard a fight is with the PF2e XP rules (trivial, low, moderate, severe, extreme). Give a list of creatures, or leave it out to rate the hostile creatures on a scene. Party level and size come from the PF2e Party unless you give them.",
      inputSchema: {
        creatures: z
          .array(z.object({ name: z.string(), level: z.number().int(), count: z.number().int().min(1).default(1), adjustment: z.enum(["elite", "weak"]).optional() }))
          .optional(),
        sceneUuid: sceneRef,
        partyLevel: z.number().int().min(1).max(20).optional(),
        partySize: z.number().int().min(1).max(10).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const party = await partyInfo(args.partyLevel, args.partySize);
        let creatures = args.creatures;
        let scene: string | undefined;
        if (!creatures) {
          const r = await bridge.request<{ scene: string; creatures: { name: string; level: number; adjustment: "elite" | "weak" | null }[] }>(
            "encounter.sceneCreatures",
            { sceneUuid: args.sceneUuid },
          );
          scene = r.scene;
          creatures = r.creatures.map((c) => ({ ...c, count: 1, adjustment: c.adjustment ?? undefined }));
          if (!creatures.length) throw new Error(`No hostile creatures on "${r.scene}".`);
        }
        return text({ scene, partyMembers: party.members, ...evaluateEncounter(creatures, party.level, party.size) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "build_encounter",
    {
      title: "Build an encounter",
      description:
        "Build a balanced PF2e fight in one step. Either give the creatures (compendium UUIDs and counts) or describe a theme (traits and/or name words) and let it pick creatures that fit the XP budget for the difficulty. It imports them, can place them on a scene inside an area, and writes a GM journal with the stat links and XP math. Use dryRun to preview the picks first.",
      inputSchema: {
        name: z.string().describe("Encounter name, e.g. 'Crypt Ambush'."),
        difficulty: z.enum(DIFFICULTIES as [Difficulty, ...Difficulty[]]).default("moderate"),
        creatures: z
          .array(z.object({ uuid: z.string(), count: z.number().int().min(1).default(1) }))
          .optional()
          .describe("Exact creatures to use. Leave out to auto-pick from the theme."),
        traits: z.array(z.string()).optional().describe("Theme for auto-pick: every creature must have these traits, e.g. ['undead'] or ['goblin']."),
        query: z.string().optional().describe("Theme for auto-pick: words in the creature name, e.g. 'skeleton'."),
        pack: z.string().optional().describe("Only pick from packs matching this, e.g. 'monster-core'."),
        maxTypes: z.number().int().min(1).max(6).default(3).describe("Most different kinds of creature to auto-pick."),
        partyLevel: z.number().int().min(1).max(20).optional(),
        partySize: z.number().int().min(1).max(10).optional(),
        sceneUuid: z.string().optional().describe("Place the creatures on this scene. Leave out to only import them."),
        area: z
          .object({ x: z.number().int(), y: z.number().int(), w: z.number().int().min(1), h: z.number().int().min(1) })
          .optional()
          .describe("Grid area to place tokens in. Required with sceneUuid."),
        hidden: z.boolean().default(true).describe("Place tokens hidden (default) so players don't see them until revealed."),
        folder: z.string().optional().describe("Folder for the creatures and journal. Defaults to the encounter name."),
        journal: z.boolean().default(true),
        dryRun: z.boolean().default(false),
      },
    },
    async (args) => {
      try {
        const party = await partyInfo(args.partyLevel, args.partySize);
        type Chosen = { uuid: string; name: string; level: number; count: number };
        let chosen: Chosen[];

        if (args.creatures?.length) {
          chosen = [];
          for (const c of args.creatures) {
            const doc = await bridge.request<{ name: string; level: number; type: string }>("get", { uuid: c.uuid });
            chosen.push({ uuid: c.uuid, name: doc.name, level: doc.level, count: c.count });
          }
        } else {
          if (!args.traits?.length && !args.query) throw new Error("Give creatures, or a theme with traits or query.");
          const search = await bridge.request<{ results: { uuid: string; name: string; level: number; rarity?: string; type: string }[] }>(
            "compendium.search",
            {
              query: args.query ?? "",
              documentType: "Actor",
              subtype: "npc",
              traits: args.traits,
              pack: args.pack,
              minLevel: party.level - 4,
              maxLevel: party.level + 4,
              limit: 200,
            },
            120_000,
          );
          const candidates = search.results.filter((r) => typeof r.level === "number" && r.rarity !== "unique");
          if (!candidates.length) throw new Error("No creatures match that theme near the party's level.");
          // Avoid near-duplicate stat blocks from different books with the same name.
          const byName = new Map<string, (typeof candidates)[number]>();
          for (const c of candidates) if (!byName.has(c.name)) byName.set(c.name, c);
          const { picks } = pickEncounter([...byName.values()], party.level, party.size, args.difficulty, { maxTypes: args.maxTypes });
          if (!picks.length) throw new Error("Couldn't fit any matching creature into the budget.");
          chosen = picks.map((p) => ({ uuid: p.uuid, name: p.name, level: p.level, count: p.count }));
        }

        const evaluation = evaluateEncounter(chosen, party.level, party.size);
        const budget = budgetFor(args.difficulty, party.size);
        if (args.dryRun) return text({ dryRun: true, target: args.difficulty, budget, picks: chosen, evaluation });

        const folder = args.folder ?? args.name;
        if (args.sceneUuid && !args.area) throw new Error("Give an area to place the creatures in.");

        const created: { name: string; actorUuid: string; count: number; level: number; tokens?: string[] }[] = [];
        for (const c of chosen) {
          const imp = await bridge.request<{ created: { uuid: string; name: string }[] }>("compendium.import", { uuid: c.uuid, folder });
          const actorUuid = imp.created[0].uuid;
          const row: (typeof created)[number] = { name: c.name, actorUuid, count: c.count, level: c.level };
          if (args.sceneUuid) {
            const placed = await bridge.request<{ tokens: { name: string }[] }>("scene.placeTokens", {
              sceneUuid: args.sceneUuid,
              actorUuid,
              area: args.area,
              count: c.count,
              hidden: args.hidden,
            });
            row.tokens = placed.tokens.map((t) => t.name);
          }
          created.push(row);
        }

        let journalUuid: string | undefined;
        if (args.journal) {
          const rows = created
            .map((c) => `<tr><td>@UUID[${c.actorUuid}]{${c.name}}</td><td>${c.level}</td><td>${c.count}</td></tr>`)
            .join("");
          const html =
            `<p><strong>${evaluation.difficulty[0].toUpperCase() + evaluation.difficulty.slice(1)}</strong> for ${party.size} characters of level ${party.level}: ${evaluation.totalXp} XP (target ${args.difficulty}, budget ${budget}).</p>` +
            `<table><thead><tr><th>Creature</th><th>Level</th><th>Count</th></tr></thead><tbody>${rows}</tbody></table>` +
            (args.sceneUuid ? `<p>Placed on @UUID[${args.sceneUuid}]{the map}${args.hidden ? ", hidden" : ""}.</p>` : "") +
            (evaluation.warnings.length ? `<p><strong>Watch out:</strong> ${evaluation.warnings.join(" ")}</p>` : "");
          const j = await bridge.request<{ uuid: string }>("journal.create", { name: `Encounter: ${args.name}`, folder, pages: [{ title: "Encounter", content: html }] });
          journalUuid = j.uuid;
        }

        return text({ encounter: args.name, folder, created, journalUuid, evaluation });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ---------- Session log ----------

  const sessionRef = z
    .string()
    .describe("'current', a session name (e.g. 'Session 12' or 'test'; every session with that name matches), or a session ID from session_log.");

  server.registerTool(
    "start_session",
    {
      title: "Start a session",
      description:
        "Start a new named session. Everything Claude creates from now on is tagged with it, so it can be listed or cleaned up later. Use a game night ('Session 12') or a scratch name ('test'). Without this, a session named after the date and time starts on its own and lasts 12 hours.",
      inputSchema: {
        name: z.string().min(1),
      },
    },
    (args) => call("session.start", args),
  );

  server.registerTool(
    "session_log",
    {
      title: "What Claude made",
      description:
        "List what Claude created in a session: actors, items, journals, scenes, tables, folders, combats, plus tokens, walls, lights and pins it added to existing scenes, and items it gave to characters. Use session 'all' for an overview of every session with counts.",
      inputSchema: {
        session: z.union([z.literal("all"), sessionRef]).default("current"),
        limit: z.number().int().min(1).max(500).default(200),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => call("session.list", args),
  );

  server.registerTool(
    "cleanup_session",
    {
      title: "Clean up a session",
      description:
        "Delete everything Claude created in a session. Without confirm it only previews: show the GM the list and get a yes before calling again with confirm: true. Keeps the active scene, folders that still hold other things, and items on player characters (unless includeCharacterItems). Uploaded files and chat messages stay.",
      inputSchema: {
        session: z.union([z.literal("all"), sessionRef]),
        confirm: z.boolean().default(false).describe("false previews; true deletes. Only true after the GM agreed to the preview."),
        includeCharacterItems: z.boolean().default(false).describe("Also take back items Claude gave to player characters."),
      },
      annotations: { destructiveHint: true },
    },
    (args) => call("session.cleanup", args, 120_000),
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
