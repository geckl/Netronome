import * as Tone from "tone";
import type { Socket } from "socket.io-client";
import type { RefObject } from "react";
import { playAudio } from "./util";

/**
 * SocketIO — Performer app plumbing that is NOT synchronization.
 *
 * Everything deadline-carrying arrives as `transport.*` / `beat` envelopes and
 * is consumed in Sync.ts. This file keeps only app-level relay events:
 * roster/ping keep-alives, the WebRTC mic path, the backtrack audio asset and
 * the conductor's live audio chunks.
 */

var backtrack: Tone.Player | null = null;
var backtrackBufferTotal: ArrayBuffer | null = null;

// listen for events emitted by the server
export const initialSocketEvents = (
  socketInstance: Socket,
  setSocket: (socket: Socket | null) => void,
  connectionState: RefObject<string>,
) => {
  socketInstance.on("connect", () => {
    console.log("Connected to server");
    setSocket(socketInstance);
    socketInstance.emit("rtc-invite"); // invite the conductor's mic/mix early
  });

  socketInstance.on("ping", (callback) => {
    callback(); // the server's keep-alive RTT loop feeds its own lead estimate
  });

  socketInstance.on("reconnect", function () {
    console.log("you have been reconnected!");
    connectionState.current = "Connected";
    setSocket(socketInstance);
  });

  socketInstance.on("disconnect", function () {
    socketInstance.emit("rtc-message", { type: "bye", senderId: socketInstance.id });
    connectionState.current = "Disconnected";
    setSocket(null);
  });
};

// Connected mode: audio assets only (roster/transport envelopes live in Sync.ts)
export const connectedSocketEvents = (socket: Socket) => {
  socket.on("backtrack", (backtrackBuffer: ArrayBuffer | null) => {
    if (backtrackBuffer === null) {
      console.log("Remove Backtrack!");
      if (backtrack) {
        backtrack.stop();
        backtrack.dispose();
        backtrack = null;
      }
      backtrackBufferTotal = null;
      return;
    }

    var appendBuffer = function (buffer1: ArrayBuffer, buffer2: ArrayBuffer): ArrayBuffer {
      var tmp = new Uint8Array(buffer1.byteLength + buffer2.byteLength);
      tmp.set(new Uint8Array(buffer1), 0);
      tmp.set(new Uint8Array(buffer2), buffer1.byteLength);
      return tmp.buffer;
    };

    var newBuffer: ArrayBuffer;
    if (!backtrackBufferTotal) {
      newBuffer = backtrackBuffer;
    } else {
      newBuffer = appendBuffer(backtrackBufferTotal, backtrackBuffer);
    }
    backtrackBufferTotal = newBuffer;

    // Convert array buffer into audio buffer
    Tone.getContext()
      .decodeAudioData(newBuffer.slice(0))
      .then((audioBuffer) => {
        if (backtrack) {
          backtrack.stop();
          backtrack.dispose();
          backtrack = null;
        }
        backtrack = new Tone.Player(audioBuffer, () => {
          console.log("Backtrack loaded!");
        })
          .sync()
          .start(0)
          .toDestination();
      })
      .catch((error) => {
        console.error("Error decoding audio data: ", error);
      });
  });

  socket.on("audioStream", (audioData) => {
    playAudio(audioData);
  });
};

export function teardownTransport(): void {
  console.log("Resetting Transport");
  Tone.getTransport().stop();
  Tone.getTransport().cancel();
}
