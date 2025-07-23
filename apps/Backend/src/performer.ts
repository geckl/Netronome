import { Namespace, Socket } from "socket.io";
import { Performer } from "./types.js";
import { io, orc } from "./server.ts"

const members: Performer[] = [];
let membersCounter = 0;

const performerRoutes = (performers: Namespace, conductors: Namespace) => {

    // Performer Socket
    performers.on('connection', (socket: Socket) => {
        console.log("performer joined!");

        const performer: Performer = { id: socket.id, name: `Performer #${membersCounter + 1}`, status: "Disconnected", latencies: [] }
        members.push(performer);
        membersCounter++;
        console.log("user connected: ", performer);
        if (orc.conductor) {
            conductors.sockets.get(orc.conductor.id)?.emit("update-members", members);
        }
        // socket.emit("starttime", baselineDate);

        socket.on("request-join", () => {
            performer.status = "Connecting";
            conductors.emit("update-members", members);
        });

        socket.on("calculate-latency", (time: number, cb: (latency: number) => void) => {
            const latencyPlusOffset = performance.now() - time;
            //const latencyPlusOffset = Date.now() - time;
            cb(latencyPlusOffset);
        });

        socket.on("calculate-latency-server-1", (targetId) => {
            console.log("calculate-latency-server: ", targetId);
            socket.to(targetId).volatile.emit("calculate-latency-server-2", socket.id);
        });

        socket.on("calculate-latency-client-2", (targetId) => {
            console.log("calculate-latency-client: ", targetId);
            socket.to(targetId).volatile.emit(`calculate-latency-client-${socket.id}`);
        });

        // socket.conn.on("heartbeat", () => {
        //   // called after each round trip of the heartbeat mechanism
        //   console.log("heartbeat");
        // });

        socket.on("sync-orchestra", (latencies: number[]) => {
            performer.latencies = latencies;
            if (performer.status !== "Connected") {
                performer.status = "Connected"
                orc.addPerformer(performer);
                if(orc.backtrack) {
                    socket.emit('backtrack', orc.backtrack);
                }
            }
            // socket.join("ensemble");
            if (orc.conductor) {
                conductors.sockets.get(orc.conductor.id)?.emit("update-members", members);
                conductors.sockets.get(orc.conductor.id)?.emit("status-update", (isPlaying: boolean, time: number, position: number | string) => {
                    if (isPlaying) {
                        socket.emit('start', time, position);
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
            console.log("rtc-message: ", message);
            socket.to(message.targetId).emit("rtc-message", message);
        });

        socket.on('disconnect', () => {
            if (performer.status === "Connected") {
                orc.removePerformer(performer);
            }
            performer.status = "Disconnected"
            let performerIndex = members.map(c => c.id).indexOf(performer.id)
            members.splice(performerIndex, 1);
            // conductors.emit("update-members", members);
            console.log("user disconnected: ", members);
        });

        setInterval(() => {
            if (orc.isPlaying) {
                const start = performance.now();
                socket.emit("ping", () => {
                    // Normally this number would be divided by two to get one-way latency, but leaving doubled to account for changing latencies
                    const latency = (performance.now() - start) / 2;
                    performer.latencies.push(latency);
                    performer.latencies.shift();
                    console.log(performer.name, " LATENCY: ", performer.latencies);
                });
                // conductors.emit("update-members", memebers);
            }
        }, 10000);
    });
}

export default performerRoutes;