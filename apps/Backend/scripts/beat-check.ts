/**
 * Beat check — observe the server-owned beat chain over a REAL clock.
 *
 *   npx tsx scripts/beat-check.ts [url]
 *
 * Starts the transport (engine mode required), listens for `envelope` frames
 * for ~2.5s, and prints beat deadlines + inter-beat deltas. Exit code reflects
 * sanity: beats present, deltas ≈ 60000/bpm, envelopes early (at > arrival).
 */
import { io, Socket } from "socket.io-client";

const url = process.argv[2] ?? "http://localhost:3000";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const socket: Socket = io(`${url}/conductor`, { transports: ["websocket"] });
type Envelope = { seq: number; type: string; at: number; lead: number; data: { index?: number; bpm?: number } };
const beats: { at: number; index: number | undefined; arrived: number }[] = [];
let tempo = 0;

socket.on("envelope", (env: Envelope) => {
  const arrival = performance.now(); // client clock (deltas are still valid)
  if (env.type === "beat") beats.push({ at: env.at, index: env.data.index, arrived: arrival });
  if (env.type === "transport.tempo") tempo = env.data.bpm ?? 0;
});

socket.on("connect", async () => {
  console.log("connected; starting transport at 60 bpm for ~2.5s\n");
  const synced = await new Promise<boolean>((resolve) =>
    socket.emit("conductor-sync-orchestra", [20], (ok: boolean) => resolve(ok)),
  );
  if (!synced) {
    console.error("conductor seat busy — run on a fresh server");
    return process.exit(1);
  }
  const { mono } = (await (await fetch(`${url}/api/clock`)).json()) as { mono: number };
  socket.emit("conductor-start", mono + 500, "0:0:0", (committed: number) => {
    console.log(`start committed: ${committed.toFixed(1)}ms (target was ${mono + 500})`);
  });

  await wait(2500);
  socket.emit("conductor-stop");

  const deltas = beats.slice(1).map((b, i) => b.at - beats[i]!.at);
  console.log(`received ${beats.length} beats (tempo envelope: ${tempo || "none"})`);
  console.log(`first beat index: ${beats[0]?.index}, last: ${beats[beats.length - 1]?.index}`);
  console.log(`inter-beat deltas (ms): ${deltas.map((d) => Math.round(d)).join(", ")}`);
  const okDeltas = deltas.length > 0 && deltas.every((d) => Math.abs(d - 1000) < 50);
  const okEarly = beats.length > 0 && beats.every((b) => b.arrived < b.at); // arrived before deadline
  console.log(`\ndeltas ≈ 1000ms (60 bpm): ${okDeltas ? "OK" : "MISMATCH"}`);
  console.log(`every envelope arrived before its deadline: ${okEarly ? "OK" : "LATE ARRIVALS"}`);
  socket.disconnect();
  process.exit(okDeltas && okEarly ? 0 : 1);
});

socket.on("connect_error", (err: Error) => {
  console.error("connect_error:", err.message);
  process.exit(1);
});
