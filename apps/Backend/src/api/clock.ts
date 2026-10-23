import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type { ServerClock } from "../core/clock.js";

/**
 * Phase-1 clock API — read-only, CORS-open, no auth required.
 *
 * ExpressJS route timestamps:
 *   GET /api/clock — simple clock read including bootId (restart detection).
 *   GET /api/sync  — NTP-style handshake data: { t1 (server rx), t2 (server tx) }.
 *                    The client supplies t0/t3 by timing the HTTP round trip in
 *                    its own clock; the server's processing dwell (t2 - t1) is
 *                    measured, not assumed, so offsets stay clean.
 */
export function rxStampMiddleware(clock: ServerClock) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.locals.rxMono = clock.now();
    next();
  };
}

export function clockRoutes(clock: ServerClock): Router {
  const router = Router();

  router.get("/clock", (_req, res) => {
    const mono = (res.locals.rxMono as number | undefined) ?? clock.now();
    res.json({ mono, epoch: clock.toEpoch(mono), bootId: clock.bootId });
  });

  router.get("/sync", (_req, res) => {
    const t1 = (res.locals.rxMono as number | undefined) ?? clock.now();
    const t2 = clock.now();
    res.json({ t1, t2, bootId: clock.bootId });
  });

  return router;
}
