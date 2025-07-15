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
export type RTCConnectionStatus = 'Disconnected' | 'Connecting' | 'Connected';

export const JoinButton = {
 'Disconnected': "Join",
 'Connecting': "",
 'Connected': "Disconnect"
};

export type DeviceType = "Client" | "Server"

export type Message = {
  type: string,
  candidate: string | null,
  sdpMid?: string | null,
  sdpMLineIndex?: number | null,
};

export type LatencyData = {
  serverLatency: number,
  clientLatency: number
}