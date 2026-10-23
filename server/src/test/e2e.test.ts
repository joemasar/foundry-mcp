// Runs the real MCP server over stdio, connects a fake "Foundry" WebSocket client, and checks
// that tool calls travel all the way through and back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 31499;
const TOKEN = "test-token";

const textOf = (r: any) => r.content[0].text as string;

test("tools work end to end through a fake Foundry client", async (t) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(here, "..", "index.js")],
    env: { ...process.env, FOUNDRY_MCP_PORT: String(PORT), FOUNDRY_MCP_TOKEN: TOKEN } as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close());

  const { tools } = await client.listTools();
  const names = tools.map((x) => x.name);
  for (const n of ["foundry_status", "search_compendium", "create_pf2e_npc", "build_map_layout", "place_tokens", "create_journal", "start_session", "session_log", "cleanup_session"]) {
    assert.ok(names.includes(n), `missing tool ${n}`);
  }

  // Not connected yet: a friendly status, and other tools give a clear error.
  const offline = JSON.parse(textOf(await client.callTool({ name: "foundry_status", arguments: {} })));
  assert.equal(offline.connected, false);
  const err = await client.callTool({ name: "list_documents", arguments: { documentType: "Actor" } });
  assert.equal(err.isError, true);
  assert.match(textOf(err), /not connected/);

  // A wrong token is rejected.
  const bad = new WebSocket(`ws://127.0.0.1:${PORT}`);
  await new Promise<void>((resolve) => {
    bad.on("open", () => bad.send(JSON.stringify({ type: "hello", token: "nope" })));
    bad.on("close", () => resolve());
  });

  // The fake Foundry: answers every request by echoing the action and params.
  const seen: any[] = [];
  const fake = new WebSocket(`ws://127.0.0.1:${PORT}`);
  t.after(() => fake.close());
  await new Promise<void>((resolve) => {
    fake.on("open", () =>
      fake.send(JSON.stringify({ type: "hello", token: TOKEN, world: "Test World", system: "pf2e", systemVersion: "7.0", foundryVersion: "14.369", user: "Gamemaster" })),
    );
    fake.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "welcome") return resolve();
      if (msg.type === "request") {
        seen.push(msg);
        if (msg.action === "delete") {
          fake.send(JSON.stringify({ type: "response", id: msg.id, ok: false, error: "Nope, kept it" }));
        } else {
          fake.send(JSON.stringify({ type: "response", id: msg.id, ok: true, result: { action: msg.action, params: msg.params } }));
        }
      }
    });
  });

  const status = JSON.parse(textOf(await client.callTool({ name: "foundry_status", arguments: {} })));
  assert.equal(status.action, "status");

  const npc = JSON.parse(
    textOf(
      await client.callTool({
        name: "create_pf2e_npc",
        arguments: {
          name: "Bog Lurker",
          level: 3,
          ac: 19,
          hp: 45,
          perception: 9,
          saves: { fortitude: 11, reflex: 8, will: 7 },
          abilities: { str: 4, dex: 2, con: 3, int: -2, wis: 1, cha: 0 },
          strikes: [{ name: "Claw", bonus: 12, damage: [{ formula: "2d6+5", type: "slashing" }], traits: ["agile"] }],
        },
      }),
    ),
  );
  assert.equal(npc.action, "pf2e.createNpc");
  assert.equal(npc.params.size, "med", "defaults are filled in by the schema");
  assert.equal(npc.params.speed, 25);

  // build_map_layout computes walls on the server before sending.
  const map = JSON.parse(
    textOf(
      await client.callTool({
        name: "build_map_layout",
        arguments: {
          name: "Crypt",
          rooms: [
            { x: 0, y: 0, w: 4, h: 4, label: "Entry" },
            { x: 4, y: 1, w: 6, h: 2, label: "Hall" },
          ],
          doors: [{ x: 3, y: 1, side: "e" }],
        },
      }),
    ),
  );
  assert.equal(map.action, "scene.buildLayout");
  assert.ok(map.params.layout.walls.some((w: any) => w.door === 1));
  assert.equal(map.params.layout.drawings.length, 2);

  // Session tools: listing defaults to the current session, cleanup previews unless confirmed.
  const log = JSON.parse(textOf(await client.callTool({ name: "session_log", arguments: {} })));
  assert.equal(log.action, "session.list");
  assert.equal(log.params.session, "current");
  const preview = JSON.parse(textOf(await client.callTool({ name: "cleanup_session", arguments: { session: "test" } })));
  assert.equal(preview.action, "session.cleanup");
  assert.equal(preview.params.confirm, false);
  const noSession = await client.callTool({ name: "cleanup_session", arguments: {} });
  assert.equal(noSession.isError, true, "cleanup needs a session");

  // Bad input is caught by the schema before reaching Foundry.
  const invalid = await client.callTool({ name: "delete_document", arguments: { uuid: "Actor.x", confirm: false } });
  assert.equal(invalid.isError, true);

  // Errors raised in Foundry come back to Claude.
  const denied = await client.callTool({ name: "delete_document", arguments: { uuid: "Actor.x", confirm: true } });
  assert.equal(denied.isError, true);
  assert.match(textOf(denied), /Nope, kept it/);

  assert.ok(seen.length >= 4);
});
