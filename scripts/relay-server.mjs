/**
 * Standalone Node.js Paseo relay server.
 *
 * Implements the same wire protocol as the Cloudflare Durable Object adapter
 * (packages/relay/src/cloudflare-adapter.ts) so a self-hosted relay can run
 * anywhere Node >= 18 is available:
 *
 *   ws://<host>:<port>/ws?serverId=<id>&role=server&v=2              (daemon control socket)
 *   ws://<host>:<port>/ws?serverId=<id>&role=server&connectionId=X   (daemon data socket)
 *   ws://<host>:<port>/ws?serverId=<id>&role=client&v=2              (app client socket)
 *   ws://<host>:<port>/ws?serverId=<id>&role=<server|client>&v=1     (legacy pairing)
 *
 * Usage: node relay-server.mjs [--listen 0.0.0.0:8234]
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";

const CONTROL_PING_INTERVAL_MS = 10_000;

function parseListen(argv) {
  const idx = argv.indexOf("--listen");
  const value = idx >= 0 ? argv[idx + 1] : process.env.PASEO_RELAY_LISTEN || "0.0.0.0:8234";
  const at = value.lastIndexOf(":");
  if (at <= 0) throw new Error(`Invalid --listen value: ${value}`);
  return { host: value.slice(0, at), port: Number(value.slice(at + 1)) };
}

/** One relay session per serverId — the in-process analogue of a Durable Object. */
class RelaySession {
  constructor(serverId) {
    this.serverId = serverId;
    /** @type {Set<import("ws").WebSocket>} v1 daemon sockets */
    this.v1Servers = new Set();
    /** @type {Set<import("ws").WebSocket>} v1 client sockets */
    this.v1Clients = new Set();
    /** @type {Set<import("ws").WebSocket>} daemon control sockets (v2) */
    this.controlSockets = new Set();
    /** @type {Map<string, Set<import("ws").WebSocket>>} connectionId -> daemon data sockets */
    this.serverData = new Map();
    /** @type {Map<string, Set<import("ws").WebSocket>>} connectionId -> client sockets */
    this.clients = new Map();
    /** @type {Map<string, Array<string|Buffer>>} frames buffered until the daemon data socket opens */
    this.pendingFrames = new Map();
  }

  /** Shared close/error logging + cleanup for every accepted socket. */
  trackSocket(ws, cleanup, label) {
    ws.on("close", (code, reason) => {
      console.log(`[relay] close ${label} code=${code} reason=${reason?.toString?.() ?? ""}`);
      cleanup();
    });
    ws.on("error", (err) => {
      console.log(`[relay] error ${label}: ${err?.message ?? err}`);
      cleanup();
    });
  }

  closeAllIn(set, code, reason) {
    for (const ws of set) {
      try {
        ws.close(code, reason);
      } catch {
        // ignore
      }
    }
  }

  listConnectedConnectionIds() {
    const out = new Set();
    for (const [connectionId, sockets] of this.clients) {
      for (const ws of sockets) {
        if (ws.readyState === ws.OPEN) out.add(connectionId);
      }
    }
    return Array.from(out);
  }

  notifyControls(message) {
    const text = JSON.stringify(message);
    for (const ws of this.controlSockets) {
      try {
        ws.send(text);
      } catch {
        try {
          ws.close(1011, "Control send failed");
        } catch {
          // ignore
        }
      }
    }
  }

  hasOpen(set) {
    for (const ws of set) {
      if (ws.readyState === ws.OPEN) return true;
    }
    return false;
  }

  nudgeOrResetControlForConnection(connectionId) {
    const initialDelayMs = 10_000;
    const secondDelayMs = 5_000;
    setTimeout(() => {
      if (!this.hasOpen(this.clients.get(connectionId) ?? new Set())) return;
      if (this.hasOpen(this.serverData.get(connectionId) ?? new Set())) return;
      this.notifyControls({ type: "sync", connectionIds: this.listConnectedConnectionIds() });
      setTimeout(() => {
        if (!this.hasOpen(this.clients.get(connectionId) ?? new Set())) return;
        if (this.hasOpen(this.serverData.get(connectionId) ?? new Set())) return;
        this.closeAllIn(this.controlSockets, 1011, "Control unresponsive");
      }, secondDelayMs);
    }, initialDelayMs);
  }

  bufferFrame(connectionId, message) {
    const frames = this.pendingFrames.get(connectionId) ?? [];
    frames.push(message);
    if (frames.length > 200) frames.splice(0, frames.length - 200);
    this.pendingFrames.set(connectionId, frames);
  }

  flushFrames(connectionId, serverWs) {
    const frames = this.pendingFrames.get(connectionId);
    if (!frames || frames.length === 0) return;
    this.pendingFrames.delete(connectionId);
    for (const frame of frames) {
      try {
        serverWs.send(frame);
      } catch {
        this.bufferFrame(connectionId, frame);
        break;
      }
    }
  }

  addV1(ws, role) {
    const mine = role === "server" ? this.v1Servers : this.v1Clients;
    this.closeAllIn(mine, 1008, "Replaced by new connection");
    mine.add(ws);
    this.trackSocket(ws, () => mine.delete(ws), `v1 ${role} ${this.serverId}`);
    ws.on("message", (data, isBinary) => {
      const targets = role === "server" ? this.v1Clients : this.v1Servers;
      for (const target of targets) {
        try {
          target.send(data, { binary: isBinary });
        } catch {
          // ignore
        }
      }
    });
  }

  addControl(ws) {
    this.closeAllIn(this.controlSockets, 1008, "Replaced by new connection");
    this.controlSockets.add(ws);
    this.trackSocket(ws, () => this.controlSockets.delete(ws), `control ${this.serverId}`);
    ws.on("message", (data) => {
      // COMPAT(relay-json-ping): old daemons send JSON pings on the control socket.
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed && parsed.type === "ping") {
          ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
        }
      } catch {
        // non-JSON control payloads are ignored
      }
    });
    try {
      ws.send(JSON.stringify({ type: "sync", connectionIds: this.listConnectedConnectionIds() }));
    } catch {
      // ignore
    }
  }

  addServerData(ws, connectionId) {
    let set = this.serverData.get(connectionId);
    if (!set) {
      set = new Set();
      this.serverData.set(connectionId, set);
    }
    this.closeAllIn(set, 1008, "Replaced by new connection");
    set.add(ws);
    ws.on("message", (data, isBinary) => {
      const targets = this.clients.get(connectionId);
      if (!targets) return;
      for (const target of targets) {
        try {
          target.send(data, { binary: isBinary });
        } catch {
          // ignore
        }
      }
    });
    this.trackSocket(
      ws,
      () => {
        set.delete(ws);
        if (set.size === 0) this.serverData.delete(connectionId);
      },
      `server-data ${connectionId}`,
    );
    this.flushFrames(connectionId, ws);
  }

  addClient(ws, connectionId) {
    let set = this.clients.get(connectionId);
    if (!set) {
      set = new Set();
      this.clients.set(connectionId, set);
    }
    set.add(ws);
    ws.on("message", (data, isBinary) => {
      const servers = this.serverData.get(connectionId);
      if (!servers || servers.size === 0) {
        this.bufferFrame(connectionId, isBinary ? data : data.toString());
        return;
      }
      for (const target of servers) {
        try {
          target.send(data, { binary: isBinary });
        } catch {
          // ignore
        }
      }
    });
    this.trackSocket(
      ws,
      () => {
        set.delete(ws);
        if (set.size > 0) return;
        this.clients.delete(connectionId);
        this.pendingFrames.delete(connectionId);
        this.closeAllIn(
          this.serverData.get(connectionId) ?? new Set(),
          1001,
          "Client disconnected",
        );
        this.notifyControls({ type: "disconnected", connectionId });
      },
      `client ${connectionId}`,
    );
    this.notifyControls({ type: "connected", connectionId });
    this.nudgeOrResetControlForConnection(connectionId);
  }
}

const { host, port } = parseListen(process.argv);
const sessions = new Map();

function getSession(serverId) {
  let session = sessions.get(serverId);
  if (!session) {
    session = new RelaySession(serverId);
    sessions.set(serverId, session);
  }
  return session;
}

const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", sessions: sessions.size }));
    return;
  }
  res.writeHead(426, { "content-type": "text/plain" });
  res.end("Expected WebSocket upgrade");
});

const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  const role = url.searchParams.get("role");
  const serverId = url.searchParams.get("serverId");
  const versionRaw = (url.searchParams.get("v") ?? "1").trim() || "1";
  const connectionIdParam = (url.searchParams.get("connectionId") ?? "").trim();

  if (role !== "server" && role !== "client") {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\nMissing or invalid role parameter");
    socket.destroy();
    return;
  }
  if (!serverId) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\nMissing serverId parameter");
    socket.destroy();
    return;
  }
  if (versionRaw !== "1" && versionRaw !== "2") {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\nInvalid v parameter (expected 1 or 2)");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    // noServer mode does not emit "connection" on the WebSocketServer, so
    // heartbeat bookkeeping must be initialized here.
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });
    const session = getSession(serverId);
    if (versionRaw === "1") {
      session.addV1(ws, role);
      console.log(`[relay] v1:${role} connected serverId=${serverId}`);
      return;
    }
    const connectionId =
      role === "client" && !connectionIdParam
        ? `conn_${randomUUID().replace(/-/g, "").slice(0, 16)}`
        : connectionIdParam;
    if (role === "server" && !connectionId) {
      session.addControl(ws);
      console.log(`[relay] v2:server(control) connected serverId=${serverId}`);
    } else if (role === "server") {
      session.addServerData(ws, connectionId);
      console.log(`[relay] v2:server(data:${connectionId}) connected serverId=${serverId}`);
    } else {
      session.addClient(ws, connectionId);
      console.log(`[relay] v2:client(${connectionId}) connected serverId=${serverId}`);
    }
  });
});

// Server-side heartbeat: drop sockets that stop answering pings so stale
// sessions do not pin control routing forever. ws terminates a socket that
// misses one ping, so cadence must be well under the daemon's 30s control
// stale timeout — otherwise the daemon declares the relay dead and
// reconnects every ~50s (observed as periodic 1006 churn).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      console.log("[relay] heartbeat terminating unresponsive socket");
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      // ignore
    }
  }
}, CONTROL_PING_INTERVAL_MS);
heartbeat.unref();

httpServer.listen(port, host, () => {
  console.log(`[relay] paseo relay listening on ${host}:${port}`);
});
