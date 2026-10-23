import { describe, expect, it } from "vitest";
import { onlyLocal } from "../src/api/guard.js";

/**
 * The conductor guard: loopback (any form Node can surface) plus the host's
 * own LAN address may mutate; everything else gets a 403.
 */
describe("onlyLocal guard", () => {
  const build = (hostAddress?: string) => {
    let nexted = false;
    let status: number | null = null;
    const res = {
      status(code: number) {
        status = code;
        return { send() {} };
      },
    };
    const next = () => void (nexted = true);
    const middleware = onlyLocal(hostAddress);
    const attempt = (ip?: string) => {
      nexted = false;
      status = null;
      middleware(
        { ip, socket: { remoteAddress: ip } } as never,
        res as never,
        next,
      );
      return { nexted, status };
    };
    return { attempt };
  };

  it("lets every loopback spelling through", () => {
    const guard = build("192.168.1.5");
    for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      expect(guard.attempt(ip)).toEqual({ nexted: true, status: null });
    }
  });

  it("lets the host's own LAN address through (either family spelling)", () => {
    const guard = build("192.168.1.5");
    expect(guard.attempt("192.168.1.5").nexted).toBe(true);
    expect(guard.attempt("::ffff:192.168.1.5").nexted).toBe(true);
  });

  it("rejects any other origin with a 403", () => {
    const guard = build("192.168.1.5");
    const result = guard.attempt("203.0.113.9");
    expect(result).toEqual({ nexted: false, status: 403 });
  });

  it("rejects unknown addresses", () => {
    const guard = build("192.168.1.5");
    expect(guard.attempt(undefined).status).toBe(403);
    expect(guard.attempt("10.0.0.77").status).toBe(403);
  });
});
