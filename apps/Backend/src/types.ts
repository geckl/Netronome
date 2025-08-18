import { Socket } from "socket.io";

export type Connection = {
    performer: Performer
    socket: Socket;
}

export type Performer = {
    id: string;
    name: string;
    status: ConnectionStatus;
    latencies: number[]
}

export type ConnectionStatus = 'Disconnected' | 'Connecting' | 'Connected';
