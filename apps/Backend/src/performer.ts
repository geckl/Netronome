import { Namespace, Socket } from "socket.io";
import { Performer } from "./types.js";
import { io, orc } from "./server.ts"

const members: Performer[] = [];
let membersCounter = 0;

const timer = ms => new Promise(res => setTimeout(res, ms));

const performerRoutes = (performers: Namespace, conductors: Namespace) => {

    // Performer Socket
    performers.on('connection', (socket: Socket) => {
        const performer: Performer = { id: socket.id, name: `Performer #${membersCounter + 1}`, status: "Disconnected", latencies: [] }
        members.push(performer);
        membersCounter++;
        console.log("performer connected: ", performer);

        const oneWayDelay1 = Math.random() * 500; // Simulated one-way delay for testing
        const oneWayDelay2 = Math.random() * 500;

        console.log(`Simulated one-way delay for performer ${performer.id}: ${oneWayDelay1} ms`);

        if (orc.conductor) {
            conductors.sockets.get(orc.conductor.id)?.emit("update-members", members);
        }


        socket.on("request-join", () => {
            performer.status = "Connecting";
            conductors.emit("update-members", members);
        });

        socket.on("calculate-latency", (time: number, cb: (latency: number) => void) => {
            const latencyPlusOffset = performance.now() - time;
            cb(latencyPlusOffset);
        });

        socket.on("calculate-latency-server-1", (targetId: string, cb: () => void) => {
            socket.to(targetId).volatile.emit("calculate-latency-server-2", socket.id);
            cb();
        });

        socket.on("calculate-latency-client-2", (targetId) => {
            socket.to(targetId).volatile.emit(`calculate-latency-client-${socket.id}`);
        });

        // socket.conn.on("heartbeat", () => {
        //   // called after each round trip of the heartbeat mechanism
        //   console.log("heartbeat");
        // });

        socket.on("sync-orchestra", (latencies: number[]) => {
            console.log("sync-orchestra: ");
            performer.latencies = latencies;
            if (performer.status !== "Connected") {
                performer.status = "Connected"
                orc.addPerformer(performer);
                if (orc.backtrack) {
                    socket.emit('backtrack', orc.backtrack);
                }
            }
            // socket.join("ensemble");
            if (orc.conductor) {
                conductors.sockets.get(orc.conductor.id)?.emit("update-members", members);
                conductors.sockets.get(orc.conductor.id)?.emit("status-update", (isPlaying: boolean, targetTime: number, position: number, tempo: number) => {
                    if (isPlaying) {
                        const newTargetTime = targetTime + orc.totalLatency;
                        const newPosition = position + (orc.totalLatency / 1000);
                        socket.emit('start', newTargetTime, newPosition, tempo);
                    }
                });
            }
            console.log("performer synced to orchestra: ", performer);
        });

        socket.on("leave-orchestra", () => {
            if (performer.status === "Connected") {
                orc.removePerformer(performer);
            }
            performer.status = "Disconnected"
            conductors.emit("update-members", members);
            console.log("user left orchestra: ", performer);
        });

        socket.on('connect_error', (err) => {
            console.log(err.message);
        });

        socket.on("rtc-invite", (message) => {
            console.log("rtc-invite: ", message);
            socket.broadcast.emit("rtc-invite", message);
        });

        socket.on("rtc-message", (message) => {
            // console.log("rtc-message: ", message);
            if (message.targetId) {
                socket.to(message.targetId).emit("rtc-message", message);
            } else {
                socket.broadcast.emit("rtc-message", message);
            }
        });

        socket.on('disconnect', () => {
            if (performer.status === "Connected") {
                orc.removePerformer(performer);
            }
            performer.status = "Disconnected"
            let performerIndex = members.map(c => c.id).indexOf(performer.id)
            members.splice(performerIndex, 1);
            // conductors.emit("update-members", members);
            console.log("user disconnected: ", performer.id);
        });

        socket.use((event, next) => {
            setTimeout(() => {
                next();
            }, oneWayDelay1);
        });
        socket.emit("asymmetric-latency", oneWayDelay1, oneWayDelay2);

        const originalEmit = socket.emit;

        socket.emit = (...args) => {
            // Add a 1000ms (1 second) delay
            setTimeout(() => {
                originalEmit.apply(socket, args);
            }, oneWayDelay2)
            return true;
        };


            setInterval(() => {
                if (orc.isPlaying) {
                    const start = performance.now();
                    socket.emit("ping", () => {
                        const latency = (performance.now() - start) / 2;
                        performer.latencies.push(latency);
                        performer.latencies.shift();
                        orc.updateLatencies(performer.latencies);
                    });
                    // conductors.emit("update-members", memebers);
                }
            }, 10000);
        });
}

export default performerRoutes;