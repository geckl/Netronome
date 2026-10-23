/**
 * REST clock-sync check — run against a live server (boots nothing).
 *
 *   npx tsx scripts/rest-sync-check.ts [url] [samples]
 *   e.g. npx tsx scripts/rest-sync-check.ts http://localhost:3000 12
 *
 * Performs `samples` NTP-style 4-timestamp handshakes over plain HTTP
 * (GET /api/sync provides t1/t2; the client times the round trip for t0/t3),
 * then prints per-sample results plus a robust summary (trimmed median
 * offset, median RTT -> one-way). The client-side math uses the exact same
 * estimator module as the backend (src/core/estimator.ts), so this doubles
 * as a live proof that the Phase-1 probe API converges.
 *
 * Note: the very first request pays DNS/TCP connection setup, so it is
 * expected to be an outlier; the trimmed stats absorb it. Run with enough
 * samples (>= 8) for a stable estimate.
 */
import { ntpSlice, median, trimmedMean, stdev, type NtpSample } from "../src/core/estimator.js";

const url = process.argv[2] ?? "http://localhost:3000";
const sampleCount = Math.max(2, Number(process.argv[3] ?? 8));

type Row = { i: number; offset: number; rtt: number; serverProc: number };
const rows: Row[] = [];

for (let i = 0; i < sampleCount; i++) {
  const t0 = performance.now(); // client clock: request sent
  const res = await fetch(`${url}/api/sync`, { cache: "no-store" });
  const t3 = performance.now(); // client clock: reply received
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { t1, t2 } = (await res.json()) as { t1: number; t2: number };
  const slice = ntpSlice({ t0, t1, t2, t3 } satisfies NtpSample);
  rows.push({ i, offset: slice.offset, rtt: slice.rtt, serverProc: slice.serverProc });
  await new Promise((r) => setTimeout(r, 100)); // cool down between probes
}

const offsets = rows.map((r) => r.offset);
const rtts = rows.map((r) => r.rtt);
const oneway = median(rtts) / 2;

console.table(rows.map((r) => ({ ...r, offset: +r.offset.toFixed(2), rtt: +r.rtt.toFixed(2) })));
console.log(`
── REST clock sync summary (${sampleCount} samples) ──────────────
  offset (server − client): median ${median(offsets).toFixed(2)} ms, trimmed ${trimmedMean(offsets).toFixed(2)} ms ± ${stdev(offsets).toFixed(2)}
  rtt:                      median ${median(rtts).toFixed(2)} ms, trimmed ${trimmedMean(rtts).toFixed(2)} ms ± ${stdev(rtts).toFixed(2)}
  one-way (symmetric est.): ${oneway.toFixed(2)} ms
`);
