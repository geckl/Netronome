import { Router, json } from "express";
import type { NextFunction, Request, Response } from "express";
import type { ServerClock } from "../core/clock.js";
import type { TransportEngine } from "../core/transport.js";
import type { SyncService } from "../core/sync-service.js";
import { formatPosition, parsePosition, type PositionInput } from "../core/position.js";

/**
 * Transport API (engine-only since Phase 5 — the legacy mode is gone).
 *
 * Phase 2 — GET /api/state read-only snapshot ("any app can know exactly
 * where the orchestra is"), reporting the engine timeline's truth.
 *
 * Phase 4 — the write side: POST /api/transport/{start,stop,seek,tempo} makes
 * the whole Express contract conductor-capable with zero sockets. Requests
 * ride the same guard as the Conductor UI (`onlyLocal`), route through the
 * TransportEngine and are acknowledged with the COMMITTED dispatch
 * `{ at, position, ... }` — never the requested values (late commands clamp
 * forward at now + minLead).
 */

export type TransportApiOptions = {
  /** Local-only guard, shared with the /conductor mount. */
  onlyLocal: (req: Request, res: Response, next: NextFunction) => void;
};

type Committed = { at: number; positionBeats: number };

export function transportRoutes(
  clock: ServerClock,
  engine: TransportEngine,
  sync: SyncService,
  options: TransportApiOptions,
): Router {
  const router = Router();
  const { onlyLocal } = options;

  router.get("/state", (_req, res) => {
    const state = engine.getState(clock.now());
    res.json({
      bootId: clock.bootId,
      // Constant since Phase 5: the TransportEngine is the only mode. Kept as
      // an explicit field so older third-party checks keep parsing the shape.
      engineMode: true,
      minLead: engine.minLead,
      ...state,
      clients: sync.snapshot(),
    });
  });

  // ─── Post body plumbing + shared responses ───────────────────────────────────

  router.use(json({ limit: "1mb" }));

  const badRequest = (res: Response, detail: string): void => {
    res.status(400).json({ error: detail });
  };

  const respond = (res: Response, committed: Committed, tempo: number): void => {
    res.json({
      bootId: clock.bootId,
      at: committed.at,
      position: formatPosition(committed.positionBeats),
      positionBeats: committed.positionBeats,
      tempo,
      playing: engine.isPlaying(),
      pendingStart: engine.isPendingStart(),
    });
  };

  /** `at` from the body; undefined = the engine default; invalid = null (400). */
  const atFromBody = (body: Record<string, unknown>): number | undefined | null => {
    if (body.at === undefined || body.at === null) return undefined;
    const at = Number(body.at);
    if (!Number.isFinite(at) || at < 0) return null;
    return at;
  };

  /** Canonical position input from the body (beats or bars:beats:sixteenths). */
  const positionFromBody = (raw: unknown): PositionInput | undefined | null => {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== "number" && typeof raw !== "string") return null;
    const beats = parsePosition(raw);
    return beats !== undefined ? beats : null; // null = present but unparseable
  };

  // ─── POST /api/transport/start — arm (or restart) the transport ───────────────
  router.post("/transport/start", onlyLocal, (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const requestedAt = atFromBody(body);
    if (requestedAt === null) return badRequest(res, "at must be a non-negative number of server ms");
    const position = positionFromBody(body.position);
    if (position === null) return badRequest(res, "position must be \"bars:beats:sixteenths\" or a beat count");
    const bpm = body.tempo === undefined ? undefined : Number(body.tempo);
    if (bpm !== undefined && (!Number.isFinite(bpm) || bpm <= 0)) {
      return badRequest(res, "tempo must be a positive bpm");
    }

    // Default deadline = now + minLead (the engine clamps late requests up);
    // tempo defaults to the engine's own baseline (last start/tempo value).
    const at = engine.start(requestedAt ?? clock.now() + engine.minLead, position, bpm);
    const committed = { at, positionBeats: engine.beatsAt(at) };
    return respond(res, committed, engine.bpmAt(at));
  });

  // ─── POST /api/transport/stop — freeze the transport now ─────────────────────
  router.post("/transport/stop", onlyLocal, (_req, res) => {
    const committed = engine.stop(); // { at, positionBeats } frozen exactly here
    return respond(res, committed, engine.currentTempo());
  });

  // ─── POST /api/transport/tempo — append a timeline segment (or retune) ───────
  router.post("/transport/tempo", onlyLocal, (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const bpm = Number(body.bpm ?? body.tempo);
    if (!Number.isFinite(bpm) || bpm <= 0) return badRequest(res, "bpm must be a positive number");
    const requestedAt = atFromBody(body);
    if (requestedAt === null) return badRequest(res, "at must be a non-negative number of server ms");

    const at = engine.tempo(requestedAt ?? clock.now(), bpm);
    const committed = { at, positionBeats: engine.beatsAt(at) };
    return respond(res, committed, bpm);
  });

  // ─── POST /api/transport/seek — jump the musical position at `at` ─────────────
  router.post("/transport/seek", onlyLocal, (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const position = positionFromBody(body.position);
    if (position === undefined || position === null) {
      return badRequest(res, "position is required (\"bars:beats:sixteenths\" or a beat count)");
    }
    const requestedAt = atFromBody(body);
    if (requestedAt === null) return badRequest(res, "at must be a non-negative number of server ms");

    const at = engine.seek(requestedAt ?? clock.now() + engine.minLead, position);
    const committed = { at, positionBeats: engine.beatsAt(at) };

    // NOTE: engine clients receive the transport.seek envelope instead;
    // stopped-mode seeks move the frozen resume point silently (`/api/state`).
    return respond(res, committed, engine.currentTempo());
  });

  return router;
}
