// Drive the MCP server from the command line, for testing against a real Foundry world.
// Usage: node scripts/run-steps.mjs steps.json
// steps.json is a list of {"tool": "...", "args": {...}}. The script starts the server, waits for the
// GM's Foundry tab to connect (it retries on its own), runs each step and prints the results.
// A step with "save": "name" keeps its JSON result, and later args can use it as "{{name.path}}",
// e.g. "{{scene.sceneUuid}}" or "{{joe.created.0.uuid}}". A string that is only a placeholder keeps
// the value's type. A localPath starting with "./" is read relative to the steps file.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
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
const saved = {};

function lookup(path) {
  let v = saved;
  for (const key of path.split(".")) {
    if (v === null || v === undefined || !(key in Object(v))) throw new Error(`No saved value for "{{${path}}}"`);
    v = v[key];
  }
  return v;
}

function fill(value, key) {
  if (typeof value === "string") {
    const whole = value.match(/^\{\{([^{}]+)\}\}$/);
    if (whole) return lookup(whole[1].trim());
    const s = value.replace(/\{\{([^{}]+)\}\}/g, (_, p) => String(lookup(p.trim())));
    return key === "localPath" && s.startsWith("./") ? resolve(outDir, s) : s;
  }
  if (Array.isArray(value)) return value.map((v) => fill(v));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, k)]));
  return value;
}

for (const [i, step] of steps.entries()) {
  let args;
  try {
    args = fill(step.args ?? {});
  } catch (err) {
    console.log(`
=== ${i + 1}. ${step.tool}  [STOPPED] ${err.message}`);
    process.exitCode = 1;
    break;
  }
  const r = await client.callTool({ name: step.tool, arguments: args });
  console.log(`\n=== ${i + 1}. ${step.tool}${r.isError ? "  [ERROR]" : ""}`);
  for (const [j, part] of r.content.entries()) {
    if (part.type === "image") {
      const ext = part.mimeType.split("/")[1] === "jpeg" ? "jpg" : part.mimeType.split("/")[1];
      const file = join(outDir, `step${i + 1}-${j + 1}.${ext}`);
      writeFileSync(file, Buffer.from(part.data, "base64"));
      console.log(`(image saved to ${file})`);
    } else if (part.type === "text") console.log(part.text);
  }
  if (step.save && !r.isError) {
    const textPart = r.content.find((p) => p.type === "text");
    try {
      saved[step.save] = JSON.parse(textPart?.text ?? "null");
    } catch {
      saved[step.save] = textPart?.text;
    }
  }
}
await client.close();
