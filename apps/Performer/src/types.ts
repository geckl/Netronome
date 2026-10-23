/** Shared app types. Timing/RTC experiment types are retired with the legacy sync path. */

export type ConnectionStatus = "Disconnected" | "Connecting" | "Connected";

export const JoinButton = {
  Disconnected: "Join",
  Connecting: "",
  Connected: "Resync",
};
