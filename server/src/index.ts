#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FoundryBridge } from "./bridge.js";
import { registerTools } from "./tools.js";

const PORT = Number(process.env.FOUNDRY_MCP_PORT ?? 31415);
const HOST = process.env.FOUNDRY_MCP_HOST ?? "127.0.0.1";

// The token proves to us that the browser connecting is your Foundry world.
// Use FOUNDRY_MCP_TOKEN if set; otherwise make one once and keep it in ~/.foundry-mcp/token.
function loadToken(): { token: string; source: string } {
  if (process.env.FOUNDRY_MCP_TOKEN) return { token: process.env.FOUNDRY_MCP_TOKEN, source: "the FOUNDRY_MCP_TOKEN setting" };
  const dir = join(homedir(), ".foundry-mcp");
  const file = join(dir, "token");
  if (existsSync(file)) return { token: readFileSync(file, "utf8").trim(), source: file };
  mkdirSync(dir, { recursive: true });
  const token = randomBytes(18).toString("base64url");
  writeFileSync(file, token, { mode: 0o600 });
  return { token, source: file };
}

const { token, source } = loadToken();
const bridge = new FoundryBridge(HOST, PORT, token);
bridge.start();

const server = new McpServer(
  { name: "foundry-vtt", version: "0.3.0" },
  {
    instructions: [
      "You are helping a Game Master run a Foundry VTT game, usually Pathfinder 2e, live at the table. Be quick and practical.",
      "Start with foundry_status. Prefer official content: search_compendium then import_from_compendium (with name/changes to re-skin) before building homebrew with create_pf2e_npc / create_pf2e_item.",
      "Homebrew PF2e creatures should follow the GM Core 'Building Creatures' tables for their level.",
      "Grid positions are squares counted from the top-left of the scene, starting at 0.",
      "Put new content in folders (e.g. the current session or story arc) so the GM can find it. Link related documents in journals with @UUID[...]{label}.",
      "Tokens placed for ambushes should be hidden. Don't activate scenes, show journals to players, or post public chat unless the GM asked for it.",
      "Never delete anything the GM did not ask you to delete.",
      "Everything you create is tagged with the current session. When the GM asks what you made or to clear it away, use session_log and cleanup_session (preview first, confirm only after they agree). If they say this is a test, call start_session with a name like 'test' first.",
    ].join("\n"),
  },
);

registerTools(server, bridge, { token, source, port: PORT });

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[foundry-mcp] MCP server ready. Token is stored in ${source}`);

const shutdown = () => {
  bridge.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("close", shutdown);
