import { Namespace, Socket } from "socket.io";
import { Performer } from "./types.js";
import { orc, ipAddress } from "./server.ts"
import type { ServerClock } from "./core/clock.js";
import type { SyncService } from "./core/sync-service.js";
import type { TransportEngine } from "./core/transport.js";
import type { EnvelopeDispatcher } from "./core/dispatcher.js";
import { EAGER_ROOM } from "./core/dispatcher.js";
import type { ConnectionRegistry } from "./core/registry.js";
import { formatPosition } from "./core/position.js";

const conductorRoutes = (conductors: Namespace, performers: Namespace, clock: ServerClock, sync: SyncService, engine: TransportEngine, dispatcher: EnvelopeDispatcher, registry: ConnectionRegistry) => {

    // Conductor Socket
    conductors.on('connection', (socket: Socket) => {
        console.log("conductor joined!");
        sync.register(socket.id);
        const conductor: Performer = { id: socket.id, name: "Conductor", status: "Disconnected", latencies: [] };
        socket.emit("server-ip", ipAddress);

        socket.on("request-join", () => {
            conductor.status = "Connecting";
        });

        socket.on("calculate-latency", (time: number, cb?: (latency: number) => void) => {
            sync.recordProbe(socket.id, time);
            const latencyPlusOffset = clock.now() - time;
            cb?.(latencyPlusOffset);
        });

        socket.on("delivery-mode", (mode: "scheduled" | "on-receipt") => {
            if (mode === "on-receipt") {
                socket.join(EAGER_ROOM);
                console.log("conductor opted into fire-on-receipt delivery:", socket.id);
            } else {
                socket.leave(EAGER_ROOM);
            }
        });

        socket.on("conductor-sync-orchestra", (latencies: number[], cb?: (bool: boolean) => void) => {
            // Single-conductor rule, enforced in one place (registry).
            // The ack is optional: the SDK's automatic resync re-claims without
            // one, and dereferencing a missing ack crashes the whole server.
            if (!registry.claimConductor(conductor.id)) {
                console.log("A conductor is already connected!");
                return cb?.(false);
            }
            if (!orc.conductor) {
                orc.conductor = conductor;
            } else if (orc.conductor.id !== conductor.id) {
                console.log("A conductor is already connected!");
                return cb?.(false);
            }

            conductor.latencies = latencies;
            conductor.status = "Connected"
            // The engine is the transport truth; the Conductor UI paints its
            // baseline from this snapshot on join.
            socket.emit("server-update", engine.currentTempo(), engine.isPlaying());
            if (orc.backtrack) {
                socket.emit('server-backtrack', orc.backtrack);
            }
            // Phase 3: a conductor joining mid-play catches up on the same
            // envelope contract as every performer (unicast transport.start).
            const catchUp = engine.catchUp(dispatcher.lead());
            if (catchUp) {
                const newPosition = formatPosition(catchUp.positionBeats);
                console.log(`conductor catch-up start: at=${Math.round(catchUp.at)}ms position=${newPosition} tempo=${catchUp.tempo}`);
                dispatcher.unicast(socket, "transport.start", catchUp.at, {
                    position: newPosition,
                    positionBeats: catchUp.positionBeats,
                    tempo: catchUp.tempo,
                });
            }
            console.log("conductor synced to orchestra: ", conductor);
            return cb?.(true);
        });

        socket.on('conductor-start', (targetTime: number, position: string, cb?: (newTargetTime: number) => void) => {
            console.log('conductor-start');
            // Phase 2: the engine owns the deadline — clamped to now + minLead;
            // the legacy blind fast-forward (+1000ms) bump is retired.
            const newTargetTime = engine.start(targetTime, position);
            cb?.(newTargetTime);
        });

        socket.on('conductor-stop', () => {
            console.log('conductor-stop');
            // Freezes the exact server-side position; cancels any pending start.
            const committed = engine.stop();
            console.log(`stopped at ${Math.round(committed.at)}ms, frozen at ${committed.positionBeats.toFixed(3)} beats`);
        });

        socket.on('conductor-change-tempo', (targetTime: number, _position: string, newTempo: number, cb?: (newTargetTime: number) => void) => {
            console.log("change-tempo: ", newTempo);
            // Engine commits the tempo on the timeline (position-continuous);
            // the ratcheting totalLatency budget is no longer involved.
            const newTargetTime = engine.tempo(targetTime, newTempo);
            cb?.(newTargetTime);
        })

        socket.on('conductor-backtrack', (backtrack: ArrayBuffer | null) => {
            console.log("emitting backtrack data");
            var appendBuffer = function (buffer1: ArrayBuffer, buffer2: ArrayBuffer) {
                var tmp = new Uint8Array(buffer1.byteLength + buffer2.byteLength);
                tmp.set(new Uint8Array(buffer1), 0);
                tmp.set(new Uint8Array(buffer2), buffer1.byteLength);
                return tmp.buffer;
            };
            performers.emit('backtrack', backtrack);
            if (backtrack === null) {
                orc.backtrack = null;
            } else if (orc.backtrack === null) {
                orc.backtrack = backtrack;
            } else {
                orc.backtrack = appendBuffer(orc.backtrack, backtrack);
            }
        })

        // WebRTC signaling emitted by the conductor client, relayed to one performer
        socket.on('rtc-offer', (targetId: string, offer: unknown) => {
            console.log("rtc-offer ->", targetId);
            performers.to(targetId).emit('rtc-offer', socket.id, offer);
        });

        socket.on('rtc-ice', (targetId: string, candidate: unknown) => {
            performers.to(targetId).emit('rtc-ice', socket.id, candidate);
        });

        // Chunked stream: optionally targeted at specific performers.
        // Undefined targets = relay to everyone.
        socket.on('audioStream', (audioData: string | ArrayBuffer | null, targets?: string[]) => {
            if (Array.isArray(targets)) {
                targets.forEach((id) => performers.to(id).volatile.emit('audioStream', audioData));
            } else {
                performers.emit('audioStream', audioData);
            }
        });

        socket.on('disconnect', () => {
            sync.unregister(socket.id);
            registry.releaseConductor(socket.id);
            if (orc.conductor && orc.conductor.id === conductor.id) {
                orc.conductor = null;
                conductor.status = "Disconnected";
            }
        });

    });

}

export default conductorRoutes;
