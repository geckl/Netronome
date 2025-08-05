import { Socket } from "socket.io-client";
import { Performer } from "./types";
import { convertTime } from "./util";
import * as Tone from "tone";
import React from "react";

export const initialSocketEvents = (
    socketInstance: Socket,
    setIpAddress: (ip: string) => void,
    setMembers: (members: Performer[]) => void,
    serverOffset: React.MutableRefObject<number>,
    tempo: React.MutableRefObject<number>
) => {
    // listen for events emitted by the server
    socketInstance.on('connect', () => {
        console.log('Connected to server');
    });

    socketInstance.on("server-ip", (ipAddress: string) => {
        console.log("Server IP Address: ", ipAddress);
        setIpAddress(`http://${ipAddress}:3000`);
    });

    socketInstance.on("starttime", (data: Date) => {
        console.log("Backend Start Time: ");
        console.log(new Date(data));
    });

    socketInstance.on("update-members", (members: Performer[]) => {
        console.log("update members!");
        setMembers(members);
    });

    socketInstance.on("status-update", (cb: (ip: boolean, t: number, p: number, tp: number) => void) => {
        console.log("status update!");
        const time = convertTime("Server", window.performance.now() + 100, serverOffset.current);
        const position: number = Tone.getTransport().seconds;
        // const targetPosition = ((position  + ((window.performance.now() + 100 + totalLatency) / 1000) - Tone.immediate()) * 1000);
        console.log("Tempo: ", tempo.current);
        cb(Tone.getTransport().state === "started", time, position, tempo.current);
    });

}
