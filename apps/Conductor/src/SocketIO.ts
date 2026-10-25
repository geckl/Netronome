import type { Socket } from "@netronome/client";
import type { Performer } from "./types";

/**
 * SocketIO — Conductor app plumbing that is NOT synchronization.
 *
 * Every deadline-carrying message arrives as `transport.*` / `beat` envelopes
 * and is consumed in ConductorSync.ts. The legacy `status-update` consult is
 * retired (the backend engine computes catch-up and state purely server-side);
 * `server-ip` and `update-members` are plain app-level relays.
 */

export const initialSocketEvents = (
  socketInstance: Socket,
  setIpAddress: (ip: string) => void,
  setMembers: (members: Performer[]) => void,
  onMembers?: (members: Performer[]) => void,
) => {
  // listen for events emitted by the server
  socketInstance.on("connect", () => {
    console.log("Connected to server");
  });

  socketInstance.on("server-ip", (ipAddress: string) => {
    setIpAddress(`http://${ipAddress}:3000`);
  });

  socketInstance.on("update-members", (members: Performer[]) => {
    setMembers(members);
    onMembers?.(members);
  });
};
