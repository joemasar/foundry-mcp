// Drive the MCP server from the command line, for testing against a real Foundry world.
// Usage: node scripts/run-steps.mjs steps.json
// steps.json is a list of {"tool": "...", "args": {...}}. The script starts the server, waits for the
// GM's Foundry tab to connect (it retries on its own), runs each step and prints the results.
import { readFileSync, writeFileSync } from "node:fs";
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

// Images (from preview_scene) are saved next to the steps file.
const outDir = dirname(process.argv[2]);
for (const [i, step] of steps.entries()) {
  const r = await client.callTool({ name: step.tool, arguments: step.args ?? {} });
  console.log(`\n=== ${i + 1}. ${step.tool}${r.isError ? "  [ERROR]" : ""}`);
  for (const [j, part] of r.content.entries()) {
    if (part.type === "image") {
      const ext = part.mimeType.split("/")[1] === "jpeg" ? "jpg" : part.mimeType.split("/")[1];
      const file = join(outDir, `step${i + 1}-${j + 1}.${ext}`);
      writeFileSync(file, Buffer.from(part.data, "base64"));
      console.log(`(image saved to ${file})`);
    } else if (part.type === "text") console.log(part.text);
  }
}
await client.close();
