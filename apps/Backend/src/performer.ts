import { Namespace, Socket } from "socket.io";
import { orc } from "./server.ts"
import type { ServerClock } from "./core/clock.js";
import type { SyncService } from "./core/sync-service.js";
import type { TransportEngine } from "./core/transport.js";
import type { EnvelopeDispatcher } from "./core/dispatcher.js";
import { EAGER_ROOM } from "./core/dispatcher.js";
import type { ConnectionRegistry } from "./core/registry.js";
import { formatPosition } from "./core/position.js";

const performerRoutes = (performers: Namespace, conductors: Namespace, clock: ServerClock, sync: SyncService, engine: TransportEngine, dispatcher: EnvelopeDispatcher, registry: ConnectionRegistry) => {

    // Performer Socket
    performers.on('connection', (socket: Socket) => {
        const performer = registry.addPerformer(socket.id);
        console.log("performer connected: ", performer.id);
        sync.register(socket.id);

        if (orc.conductor) {
            conductors.sockets.get(orc.conductor.id)?.emit("update-members", registry.roster());
        }

        socket.on("request-join", () => {
            performer.status = "Connecting";
            conductors.emit("update-members", registry.roster());
        });

        socket.on("calculate-latency", (time: number, cb?: (latency: number) => void) => {
            sync.recordProbe(socket.id, time);
            const latencyPlusOffset = clock.now() - time;
            cb?.(latencyPlusOffset);
        });

        socket.on("delivery-mode", (mode: "scheduled" | "on-receipt") => {
            if (mode === "on-receipt") {
                socket.join(EAGER_ROOM);
                console.log("performer opted into fire-on-receipt delivery:", socket.id);
            } else {
                socket.leave(EAGER_ROOM);
            }
        });

        socket.on("sync-orchestra", (latencies: number[]) => {
            console.log("sync-orchestra: ", performer.id);
            performer.latencies = latencies;
            if (performer.status !== "Connected") {
                performer.status = "Connected";
                if (orc.backtrack) {
                    socket.emit('backtrack', orc.backtrack);
                }
            }
            if (orc.conductor) {
                conductors.sockets.get(orc.conductor.id)?.emit("update-members", registry.roster());
            }
            // Phase 3: late-joiner catch-up is pure server logic computed from
            // the engine timeline, riding the SAME envelope contract every app
            // consumes (unicast transport.start) — no status-update round-trip.
            const catchUp = engine.catchUp(dispatcher.lead());
            if (catchUp) {
                const newPosition = formatPosition(catchUp.positionBeats);
                console.log(`catch-up start: at=${Math.round(catchUp.at)}ms position=${newPosition} tempo=${catchUp.tempo}`);
                dispatcher.unicast(socket, "transport.start", catchUp.at, {
                    position: newPosition,
                    positionBeats: catchUp.positionBeats,
                    tempo: catchUp.tempo,
                });
            }
            console.log("performer synced to orchestra: ", performer.id);
        });

        socket.on("leave-orchestra", () => {
            if (performer.status === "Connected") {
                performer.status = "Disconnected";
            }
            conductors.emit("update-members", registry.roster());
            console.log("user left orchestra: ", performer.id);
        });

        // WebRTC signaling from a performer, relayed to the conductor (with the performer id attached)
        socket.on("rtc-invite", () => {
            console.log("rtc-invite from", socket.id);
            conductors.emit("rtc-invite", socket.id);
        });

        socket.on("rtc-answer", (answer: unknown) => {
            conductors.emit("rtc-answer", socket.id, answer);
        });

        socket.on("rtc-ice", (candidate: unknown) => {
            conductors.emit("rtc-ice", socket.id, candidate);
        });

        // Own connection latency probes feed the dispatcher's measured lead.
        // The interval dies with the socket (Phase 5: no more timer leak).
        const pingLoop = setInterval(() => {
            if (!engine.isPlaying()) return;
            const start = clock.now();
            socket.emit("ping", () => {
                const rtt = clock.now() - start;
                performer.latencies.push(rtt / 2);
                performer.latencies.shift();
                sync.recordRtt(socket.id, rtt);
            });
        }, 10_000);

        socket.on('disconnect', () => {
            clearInterval(pingLoop);
            sync.unregister(socket.id);
            registry.removePerformer(socket.id);
            conductors.emit("update-members", registry.roster());
            console.log("user disconnected: ", performer.id);
        });
    });

}

export default performerRoutes;
