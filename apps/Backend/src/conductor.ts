import { Namespace, Socket } from "socket.io";
import { Performer } from "./types.js";
import { UUID } from "crypto";
import {  orc, ipAddress } from "./server.ts"


const conductorRoutes = (conductors: Namespace, performers: Namespace) => {

    // Conductor Socket
    conductors.on('connection', (socket: Socket) => {
        let uuid: UUID = crypto.randomUUID();
        const conductor: Performer = { id: uuid, name: "Conductor", status: "Disconnected", latencies: [] }
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

        socket.on("join-orchestra", (latencies: number[]) => {
            conductor.latencies = latencies;
            conductor.status = "Connected"
            // orc.addPerformer(conductor);
            // conductors.emit("update-members", members);
            console.log("conductor joined orchestra: ", conductor);
        });

        socket.on('conductor-start', (targetTime: number, position: string, cb: (newTargetTime: number) => void) => {
            console.log("Target Time: ", targetTime);
            console.log("Total Latency: ", orc.totalLatency);
            const newTargetTime = targetTime + orc.totalLatency;
            console.log('conductor-start');
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

        // Handle incoming audio stream
        socket.on('audioStream', (audioData: string | ArrayBuffer | null) => {
            performers.emit('audioStream', audioData);
        });
    });

}

export default conductorRoutes;