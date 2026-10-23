// Drive the MCP server from the command line, for testing against a real Foundry world.
// Usage: node scripts/run-steps.mjs steps.json
// steps.json is a list of {"tool": "...", "args": {...}}. The script starts the server, waits for the
// GM's Foundry tab to connect (it retries on its own), runs each step and prints the results.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const steps = JSON.parse(readFileSync(process.argv[2], "utf8"));

const transport = new StdioClientTransport({ command: process.execPath, args: [join(here, "..", "dist", "index.js")], stderr: "inherit" });
const client = new Client({ name: "run-steps", version: "1.0.0" });
await client.connect(transport);

const deadline = Date.now() + 90_000;
for (;;) {
  const r = await client.callTool({ name: "foundry_status", arguments: {} });
  const status = JSON.parse(r.content[0].text);
  if (status.connected !== false) break;
  if (Date.now() > deadline) {
    console.log("Foundry never connected:", status);
    process.exit(1);
  }
  await new Promise((res) => setTimeout(res, 2000));
}

for (const [i, step] of steps.entries()) {
  const r = await client.callTool({ name: step.tool, arguments: step.args ?? {} });
  console.log(`\n=== ${i + 1}. ${step.tool}${r.isError ? "  [ERROR]" : ""}`);
  console.log(r.content[0].text);
}
await client.close();
