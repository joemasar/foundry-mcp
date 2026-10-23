// WebSocket bridge between this MCP server and the Foundry module running in the GM's browser.
// The browser connects to us (browsers can't accept incoming connections), says hello with the
// shared token, and then answers requests we send it.

import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";

export interface FoundryInfo {
  world: string;
  system: string;
  systemVersion: string;
  foundryVersion: string;
  user: string;
  connectedAt: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const log = (...args: unknown[]) => console.error("[foundry-mcp]", ...args);

export class FoundryBridge {
  private wss?: WebSocketServer;
  private client?: WebSocket;
  private pending = new Map<string, Pending>();
  private heartbeat?: NodeJS.Timeout;
  info?: FoundryInfo;
  listenError?: string;

  constructor(
    private host: string,
    private port: number,
    private token: string,
  ) {}

  start() {
    this.wss = new WebSocketServer({ host: this.host, port: this.port, maxPayload: 64 * 1024 * 1024 });
    this.wss.on("listening", () => log(`waiting for Foundry on ws://${this.host}:${this.port}`));
    this.wss.on("error", (err: NodeJS.ErrnoException) => {
      this.listenError =
        err.code === "EADDRINUSE"
          ? `Port ${this.port} is already in use. Another copy of this MCP server is probably running (for example in Claude Desktop and Claude Code at once). Close it, or set FOUNDRY_MCP_PORT to a different port here and in the Foundry module settings.`
          : `Could not open the bridge port: ${err.message}`;
      log(this.listenError);
    });
    this.wss.on("connection", (ws) => this.onConnection(ws));
    this.heartbeat = setInterval(() => {
      if (this.client?.readyState === WebSocket.OPEN) this.client.ping();
    }, 20_000);
  }

  private onConnection(ws: WebSocket) {
    let authed = false;
    const helloTimer = setTimeout(() => {
      if (!authed) ws.close(4001, "No hello received");
    }, 10_000);

    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (!authed) {
        if (msg.type !== "hello" || msg.token !== this.token) {
          log("rejected a connection with a missing or wrong token");
          ws.send(JSON.stringify({ type: "rejected", reason: "Bad token" }));
          ws.close(4003, "Bad token");
          return;
        }
        authed = true;
        clearTimeout(helloTimer);
        // Only one Foundry client at a time; the newest one wins.
        if (this.client && this.client !== ws) this.client.close(4000, "Replaced by a newer connection");
        this.client = ws;
        this.info = {
          world: msg.world,
          system: msg.system,
          systemVersion: msg.systemVersion,
          foundryVersion: msg.foundryVersion,
          user: msg.user,
          connectedAt: new Date().toISOString(),
        };
        ws.send(JSON.stringify({ type: "welcome" }));
        log(`Foundry connected: world "${msg.world}" (${msg.system} ${msg.systemVersion}, Foundry ${msg.foundryVersion})`);
        return;
      }

      if (msg.type === "response" && typeof msg.id === "string") {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error ?? "Unknown error in Foundry"));
      }
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (this.client === ws) {
        this.client = undefined;
        this.info = undefined;
        log("Foundry disconnected");
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error("Foundry disconnected before answering"));
          this.pending.delete(id);
        }
      }
    });
    ws.on("error", (err) => log("socket error:", err.message));
  }

  get connected() {
    return this.client?.readyState === WebSocket.OPEN;
  }

  request<T = unknown>(action: string, params: unknown = {}, timeoutMs = 60_000): Promise<T> {
    if (this.listenError) return Promise.reject(new Error(this.listenError));
    if (!this.connected || !this.client) {
      return Promise.reject(
        new Error(
          "Foundry is not connected. Open your world in a browser, log in as the GM, and make sure the 'Foundry MCP Bridge' module is enabled with the same token.",
        ),
      );
    }
    const id = randomUUID();
    const client = this.client;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Foundry did not answer "${action}" within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      client.send(JSON.stringify({ type: "request", id, action, params }));
    });
  }

  stop() {
    clearInterval(this.heartbeat);
    this.wss?.close();
  }
}
