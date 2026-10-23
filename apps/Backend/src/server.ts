import http from "http";
import path from "path";
import os from "os";
import express from "express";
import cors from "cors";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { Server } from "socket.io";
import open from "open";
import { config, parseCorsOrigin, skipOpen } from "./core/env.js";
import { ServerClock } from "./core/clock.js";
import { SyncService } from "./core/sync-service.js";
import { ConnectionRegistry } from "./core/registry.js";
import { EnvelopeDispatcher } from "./core/dispatcher.js";
import { EAGER_ROOM } from "./core/dispatcher.js";
import { TransportEngine } from "./core/transport.js";
import { BeatScheduler } from "./core/scheduler.js";
import { rxStampMiddleware, clockRoutes } from "./api/clock.js";
import { transportRoutes } from "./api/transport.js";
import { rosterRoutes } from "./api/roster.js";
import { sseRoutes, SseHub } from "./api/sse.js";
import { onlyLocal } from "./api/guard.js";
import Orchestra from "./orchestra.js";
import conductorHandlers from "./conductor.ts";
import performerHandlers from "./performer.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const { port, corsOrigin, clockStats } = config;

// ─── Clock & sync services (the backend's single time authority) ─────────────
export const clock = new ServerClock();
export const sync = new SyncService(clock, clockStats);

// ─── Express + Socket.IO ──────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: parseCorsOrigin(corsOrigin) }));

const server = http.createServer(app);

export const io = new Server(server, {
  cors: { origin: parseCorsOrigin(corsOrigin) },
  pingInterval: 10000,
  maxHttpBufferSize: 1e8,
  connectionStateRecovery: {},
});

var networkInterfaces = os.networkInterfaces();
export const ipAddress = Object.values(networkInterfaces).reduce((r: any, list: any) => r.concat(list.reduce((rr: any, i: any) => rr.concat(i.family === 'IPv4' && !i.internal && i.address || []), [])), [])[0];

// Local-only guard shared by the /conductor app and POST /api/transport/*.
const guard = onlyLocal(ipAddress);

// ─── Static apps ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../../Performer/build')));
app.use('/conductor', guard, express.static(path.join(__dirname, '../../Conductor/build')));

// Phase 4: a no-build third-party demo — the whole HTTP contract
// (/api/* + /api/stream SSE), mounted same-origin to sidestep CORS entirely.
app.use('/examples', express.static(path.join(__dirname, '../../../examples')));

// ─── Engine core (namespaces exist, so the dispatcher can broadcast) ─────────
export const orc = new Orchestra();

// Namespaces first: the dispatcher broadcasts through them.
var performers = io.of('/');
var conductors = io.of('/conductor');

// The SSE hub is the fallback channel — same frames, same seq space, plus a
// Last-Event-ID resume ring. It must exist before the dispatcher (the bus
// below fans every envelope out to it), then wires itself to the engine.
const hub = new SseHub(clock);

export const dispatcher = new EnvelopeDispatcher(clock, sync, {
  send: (event, payload) => {
    performers.emit(event, payload);
    conductors.emit(event, payload);
    hub.broadcast(payload);
  },
  tempoCoalesceMs: config.tempoCoalesceMs,
  // Fire-on-receipt consumers ("delivery-mode" -> EAGER_ROOM) get envelopes
  // the instant they are built — a per-client delivery bias kept OUT of the
  // scheduled broadcast bus, so scheduled/SSE consumers see one copy each.
  eagerRoom: {
    emit: (event, payload) => {
      performers.to(EAGER_ROOM).emit(event, payload);
      conductors.to(EAGER_ROOM).emit(event, payload);
    },
  },
});

export const registry = new ConnectionRegistry();

export const engine = new TransportEngine(clock);
// Engine transitions -> envelopes on the wire (no flag needed: without the
// flag no handler ever drives the engine, so nothing is emitted).
engine.on((event) => dispatcher.handleEngineEvent(event));

const scheduler = new BeatScheduler(engine, dispatcher, clock);
scheduler.start(); // self-arming; emits nothing until a transport start commits

hub.wire(engine, dispatcher); // SSE beacons + late-joiner catch-up for streams

// ─── API (Phase 4: reads open, writes local-only) ─────────────────────────
app.use("/api", rxStampMiddleware(clock));
app.use("/api", clockRoutes(clock));
app.use("/api", transportRoutes(clock, engine, sync, {
  onlyLocal: guard,
}));
app.use("/api", rosterRoutes(clock, registry, sync));
app.use("/api", sseRoutes(hub));

// ─── Server-driven namespace handlers ────────────────────────────────────────
conductorHandlers(conductors, performers, clock, sync, engine, dispatcher, registry);
performerHandlers(performers, conductors, clock, sync, engine, dispatcher, registry);

server.listen(port, async () => {
  if (ipAddress) {
    console.log("Connect to Metronome here: http://" + ipAddress + ":" + port);
    console.log("Vanilla SSE example: http://localhost:" + port + "/examples/vanilla-sse/");
    console.log("Engine mode: V2 (server-owned transport)"); // engine-only since Phase 5
    if (!skipOpen) {
      await open(`http://localhost:${port}/conductor`);
    }
  } else {
    console.log("ERROR: NO NETWORK CONNECTION FOUND");
  }
});
