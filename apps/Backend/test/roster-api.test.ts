import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import express from "express";
import type { AddressInfo } from "node:net";
import { ServerClock } from "../src/core/clock.js";
import { SyncService } from "../src/core/sync-service.js";
import type { ConnectionRegistry } from "../src/core/registry.js";
import type { ConnectionEstimate } from "../src/core/sync-service.js";
import { rosterRoutes } from "../src/api/roster.js";

/**
 * GET /api/clients — roster view merging registry roles with SyncService
 * measured latency, so any app can see ensemble quality at a glance.
 */
describe("roster API", () => {
  let server: http.Server;
  let base = "";

  beforeAll(async () => {
    const clock = new ServerClock();
    const registry = {
      roster: () => [
        { id: "p1", name: "Performer #1", status: "Connected", latencies: [21, 19] },
        { id: "p2", name: "Performer #2", status: "Connecting", latencies: [] },
      ],
      conductorId: "c1",
    } as unknown as ConnectionRegistry;
    const sync = {
      snapshot: (): ConnectionEstimate[] => [
        { socketId: "p1", rtt: 30, oneway: 15, jitter: 2.5, samples: 8, lastRttAt: 1234.5 },
        { socketId: "c1", rtt: 18, oneway: 9, jitter: 1, samples: 5, lastRttAt: 1233.4 },
      ],
    } as unknown as SyncService;

    const app = express();
    app.use("/api", rosterRoutes(clock, registry, sync));
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("merges roles, statuses and measured stats into one view", async () => {
    const res = await fetch(`${base}/api/clients`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(typeof body.bootId).toBe("string");
    expect(body.count).toBe(3);
    const clients = body.clients as Array<Record<string, unknown>>;

    const performer = clients.find((c) => c.id === "p1")!;
    expect(performer).toMatchObject({ role: "performer", name: "Performer #1", status: "Connected", rtt: 30, oneway: 15 });
    const connector = clients.find((c) => c.id === "p2")!;
    expect(connector).toMatchObject({ status: "Connecting", rtt: null, samples: 0 });
    const conductor = clients.find((c) => c.id === "c1")!;
    expect(conductor).toMatchObject({ role: "conductor", rtt: 18, oneway: 9 });
  });
});
