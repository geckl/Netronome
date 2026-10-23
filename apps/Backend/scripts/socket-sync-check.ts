/**
 * Socket clock-sync check — connects a fake client to a live server and runs
 * the *legacy* client handshake (5 echo probes via `calculate-latency`, the
 * exact event the bundled apps use), recovering offsets the way the apps do.
 *
 *   npx tsx scripts/socket-sync-check.ts [url]
 *   e.g. npx tsx scripts/socket-sync-check.ts http://localhost:3000
 *
 * Run against a throwaway server (e.g. with NETRONOME_SKIP_OPEN=1 and a spare
 * PORT) — joining does not touch transport state, but it does register the
 * connection server-side, which is the point: with NETRONOME_CLOCK_STATS=1
 * the server log shows the register/probe bookkeeping this client triggers.
 */
import { io, Socket } from "socket.io-client";

const url = process.argv[2] ?? "http://localhost:3000";
const socket: Socket = io(url, { transports: ["websocket"] });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

socket.on("connect", async () => {
  console.log(`connected as ${socket.id} to ${url}\n`);
  const offsets: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now(); // client clock: request sent
    const echo = await new Promise<number>((resolve) =>
      socket.volatile.emit("calculate-latency", t0, (latencyPlusOffset: number) =>
        resolve(latencyPlusOffset),
      ),
    );
    const rtt = performance.now() - t0;
    const offset = echo - rtt / 2; // apps' math, without their +500 fudge
    offsets.push(offset);
    console.log(
      `probe ${i}: echo=${echo.toFixed(1)} rtt=${rtt.toFixed(1)}ms offset=${offset.toFixed(1)}ms`,
    );
    await wait(100);
  }
  const trimmedMiddle = [...offsets].sort((a, b) => a - b).slice(1, -1);
  console.log(
    `\nlegacy-path offset: median ${([...offsets].sort((a, b) => a - b)[2]).toFixed(1)} ms, trimmed-mean ${(
      trimmedMiddle.reduce((a, b) => a + b, 0) / trimmedMiddle.length
    ).toFixed(1)} ms  (server − client; both clocks are monotonic-domain)`,
  );
  socket.disconnect();
  process.exit(0);
});

socket.on("connect_error", (err: Error) => {
  console.error("connect_error:", err.message);
  process.exit(1);
});
