import { Socket } from "socket.io-client";
import { UUID } from "crypto";


export type Connection = {
    performer: Performer
    socket: Socket;
}

export type Performer = {
    id: UUID;
    name: string;
    status: ConnectionStatus;
    latencies: number[]
}

export type ConnectionStatus = 'Disconnected' | 'Connecting' | 'Connected';

export const JoinButton = {
   'Disconnected': "Join",
   'Connecting': "",
   'Connected': "Disconnect"
};