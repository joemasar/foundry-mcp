// Foundry MCP Bridge: connects the GM's browser to the local MCP server so Claude can work in this world.
import { handlers } from "./handlers.js";

const MODULE_ID = "foundry-mcp";
const loc = (key) => game.i18n.localize(`FOUNDRYMCP.${key}`);

let socket = null;
let retryTimer = null;
let retryDelay = 2000;
let wasConnected = false;
let stopped = false;

function setting(key) {
  return game.settings.get(MODULE_ID, key);
}

function shouldConnect() {
  if (!game.user.isGM || !setting("enabled") || !setting("token")) return false;
  // With several GMs logged in, only the primary active GM connects.
  const activeGM = game.users.activeGM;
  return !activeGM || activeGM.isSelf;
}

function scheduleRetry() {
  if (stopped || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 30000);
}

function disconnect() {
  stopped = true;
  clearTimeout(retryTimer);
  retryTimer = null;
  socket?.close();
  socket = null;
}

function connect() {
  if (!shouldConnect()) return;
  stopped = false;
  if (socket && socket.readyState <= WebSocket.OPEN) return;

  let ws;
  try {
    ws = new WebSocket(setting("serverUrl"));
  } catch (err) {
    console.error(`${MODULE_ID} | bad server URL`, err);
    return;
  }
  socket = ws;

  ws.addEventListener("open", () => {
    ws.send(
      JSON.stringify({
        type: "hello",
        token: setting("token"),
        world: game.world.title,
        system: game.system.id,
        systemVersion: game.system.version,
        foundryVersion: game.version,
        user: game.user.name,
      }),
    );
  });

  ws.addEventListener("message", async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === "welcome") {
      retryDelay = 2000;
      wasConnected = true;
      ui.notifications.info(loc("Connected"));
      return;
    }
    if (msg.type === "rejected") {
      ui.notifications.error(loc("BadToken"));
      stopped = true; // don't hammer the server with a wrong token
      return;
    }
    if (msg.type !== "request") return;

    const reply = (payload) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "response", id: msg.id, ...payload }));
    };
    const handler = handlers[msg.action];
    if (!handler) return reply({ ok: false, error: `Unknown action "${msg.action}". Update the Foundry module to match the MCP server.` });
    try {
      const result = await handler(msg.params ?? {});
      reply({ ok: true, result: result ?? null });
    } catch (err) {
      console.error(`${MODULE_ID} | ${msg.action} failed`, err);
      reply({ ok: false, error: err?.message ?? String(err) });
    }
  });

  ws.addEventListener("close", () => {
    if (socket === ws) socket = null;
    if (wasConnected && !stopped) ui.notifications.warn(loc("Disconnected"));
    wasConnected = false;
    scheduleRetry();
  });
  ws.addEventListener("error", () => {
    // The close event follows and handles the retry. A missing server is normal when Claude isn't running.
  });
}

function reconnect() {
  disconnect();
  retryDelay = 2000;
  connect();
}

Hooks.once("init", () => {
  const register = (key, data) =>
    game.settings.register(MODULE_ID, key, {
      name: `FOUNDRYMCP.${data.label}`,
      hint: `FOUNDRYMCP.${data.label}Hint`,
      scope: "client", // stored only in the GM's browser, never sent to players
      config: true,
      onChange: reconnect,
      ...data.options,
    });
  register("enabled", { label: "Enabled", options: { type: Boolean, default: true } });
  register("serverUrl", { label: "ServerUrl", options: { type: String, default: "ws://localhost:31415" } });
  register("token", { label: "Token", options: { type: String, default: "" } });
  register("allowScripts", { label: "AllowScripts", options: { type: Boolean, default: false, onChange: () => {} } });
});

Hooks.once("ready", () => {
  if (!game.user.isGM) return;
  game.modules.get(MODULE_ID).api = { connect: reconnect, disconnect, get connected() { return socket?.readyState === WebSocket.OPEN; } };
  connect();
});

// If the primary GM changes (another GM logs in or out), re-check who should hold the connection.
Hooks.on("userConnected", () => {
  if (!game.user.isGM) return;
  if (shouldConnect()) connect();
  else if (socket) disconnect();
});
