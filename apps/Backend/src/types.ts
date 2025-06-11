import { Socket } from "socket.io";

export type Performer = {
    name: string;
    socket: Socket;
    latency: number
}