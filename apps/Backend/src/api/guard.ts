import type { NextFunction, Request, Response } from "express";

/**
 * Local-only guard for conductor-mutating actions: the machine running the
 * server may drive the orchestra; remote devices may only observe.
 *
 * Mounted in front of POST /api/transport/* (Phase 4 — "any app" Express API)
 * and the /conductor static app. The loopback set additionally covers the
 * IPv4-mapped form Node can surface for localhost connections.
 *
 * Reads stay CORS-open: GET /api/{clock,sync,state,clients,stream} are
 * world-accessible, exactly as the plan specifies.
 */
export function onlyLocal(hostAddress: string | undefined) {
  const hostForms = hostAddress ? [hostAddress, `::ffff:${hostAddress}`] : [];
  const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress;
    if (ip && (loopback.includes(ip) || hostForms.includes(ip))) {
      next();
      return;
    }
    res.status(403).send("Access denied: Conductor mode may only be accessed by the computer running Netronome.");
  };
}
