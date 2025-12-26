import { Socket } from "socket.io-client";
import { Performer } from "./types";
import { convertTime } from "./util";
import * as Tone from "tone";
import React, { RefObject } from "react";

export const initialSocketEvents = (
    socketInstance: Socket,
    setIpAddress: (ip: string) => void,
    setMembers: (members: Performer[]) => void,
    serverOffset: RefObject<number>,
    tempo: RefObject<number>
) => {
    // listen for events emitted by the server
    socketInstance.on('connect', () => {
        console.log('Connected to server');
    });

    socketInstance.on("server-ip", (ipAddress: string) => {
        setIpAddress(`http://${ipAddress}:3000`);
    });

    // socketInstance.on("starttime", (data: Date) => {
    //     console.log("Backend Start Time: ", new Date(data));
    // });

    socketInstance.on("update-members", (members: Performer[]) => {
        setMembers(members);
    });

    socketInstance.on("status-update", (cb: (ip: boolean, t: number, p: number, tp: number) => void) => {
        const time = convertTime("Server", window.performance.now() + 100, serverOffset.current);
        //const startTime = ((time - (window.performance.now()) + (Tone.immediate() * 1000)) / 1000);
        const position: number = Tone.Time(Tone.getTransport().position).toSeconds();
        cb(Tone.getTransport().state === "started", time, position, tempo.current);
    });
}
