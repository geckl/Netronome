import { Namespace, Socket } from "socket.io";
import { Performer } from "./types.js";

import { orc, ipAddress } from "./server.ts"


const conductorRoutes = (conductors: Namespace, performers: Namespace) => {

    // Conductor Socket
    conductors.on('connection', (socket: Socket) => {

        if (orc.conductor) {
            console.log("A conductor is already connected!");
            socket.emit("error", "A conductor is already connected! Disconnecting...");
            socket.disconnect(true);
            return;
        }
        console.log("conductor joined!");
        const conductor: Performer = { id: socket.id, name: "Conductor", status: "Disconnected", latencies: [] }
        orc.conductor = conductor;
        socket.emit("server-ip", ipAddress);

        socket.on("request-join", () => {
            conductor.status = "Connecting";
        });

        socket.on("calculate-latency", (time: number, cb: (latency: number) => void) => {
            const latencyPlusOffset = performance.now() - time;
            //const latencyPlusOffset = Date.now() - time;
            cb(latencyPlusOffset);
        });

        // socket.conn.on("heartbeat", () => {
        //   // called after each round trip of the heartbeat mechanism
        //   console.log("heartbeat");
        // });

        socket.on("conductor-sync-orchestra", (latencies: number[]) => {
            conductor.latencies = latencies;
            conductor.status = "Connected"
            // orc.addPerformer(conductor);
            // conductors.emit("update-members", members);
            console.log("conductor synced to orchestra: ", conductor);
        });

        socket.on('conductor-start', (targetTime: number, position: string, cb: (newTargetTime: number) => void) => {
            console.log('conductor-start');
            // console.log("Target Time: ", targetTime);
            // console.log("Total Latency: ", orc.totalLatency);
            const newTargetTime = targetTime + orc.totalLatency;
            performers.emit('start', newTargetTime, position);
            cb(newTargetTime);
            orc.isPlaying = true;
        });

        socket.on('conductor-stop', () => {
            console.log('conductor-stop');
            performers.emit('stop');
            orc.isPlaying = false;
        });

        socket.on('conductor-change-tempo', (targetTime: number, position: string, newTempo: number, cb: (newTargetTime: number) => void) => {
            console.log("Change Tempo: ", newTempo);
            const newTargetTime = targetTime + orc.totalLatency;
            performers.emit('change-tempo', newTargetTime, position, newTempo);
            cb(newTargetTime);
        })

        socket.on('conductor-backtrack', (backtrack: string | ArrayBuffer | null) => {
            console.log("New Backtrack: ", backtrack);
            performers.emit('backtrack', backtrack);
            orc.backtrack = backtrack;
        })

        // Handle incoming audio stream
        socket.on('audioStream', (audioData: string | ArrayBuffer | null) => {
            performers.emit('audioStream', audioData);
        });

        socket.on("rtc-message", (message) => {
            socket.broadcast.emit("rtc-message", message);
        });

        socket.on('disconnect', () => {
            if (orc.conductor && orc.conductor.id === conductor.id) {
                orc.conductor = null;
                conductor.status = "Disconnected";
            }
        });

    });

}

export default conductorRoutes;