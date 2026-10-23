import { Router } from "express";
import type { ServerClock } from "../core/clock.js";
import type { SyncService } from "../core/sync-service.js";
import type { ConnectionRegistry } from "../core/registry.js";

/**
 * GET /api/clients — "any app" roster view.
 *
 * Merges the connection registry (roles, statuses) with the SyncService's
 * per-connection latency estimates, so third-party apps can piggyback on
 * server-measured quality instead of guessing:
 *
 *   { bootId, count, clients: [{ id, role, name, status,
 *                                rtt, oneway, jitter, samples, lastRttAt }] }
 *
 * The client-side clock offset is deliberately absent — offset estimation
 * lives on the client (t0 of the probe is in the client's clock domain);
 * every app syncs itself against /api/clock or /api/sync.
 */
export function rosterRoutes(clock: ServerClock, registry: ConnectionRegistry, sync: SyncService): Router {
  const router = Router();

  router.get("/clients", (_req, res) => {
    const estimates = new Map(sync.snapshot().map((e) => [e.socketId, e]));
    const stats = (id: string) => {
      const estimate = estimates.get(id);
      return estimate
        ? {
            rtt: estimate.rtt,
            oneway: estimate.oneway,
            jitter: estimate.jitter,
            samples: estimate.samples,
            lastRttAt: estimate.lastRttAt,
          }
        : { rtt: null, oneway: null, jitter: null, samples: 0, lastRttAt: null };
    };

    const clients = [
      ...registry.roster().map((performer) => ({
        id: performer.id,
        role: "performer",
        name: performer.name,
        status: performer.status,
        ...stats(performer.id),
      })),
    ];

    if (registry.conductorId) {
      clients.push({
        id: registry.conductorId,
        role: "conductor",
        name: "Conductor",
        // The registry enforces the claim; fine-grained connection status is a
        // UI concern that lives on the socket side.
        status: "Connected",
        ...stats(registry.conductorId),
      });
    }

    res.json({ bootId: clock.bootId, count: clients.length, clients });
  });

  return router;
}
