import { Socket } from "socket.io-client";
import { handleAnswer, handleCandidate, handleOffer, hangup, makeCall, rtcConnections } from './WebRTC';
import { convertTime, sendMessage, togglePlayback } from "./util";
import * as Tone from "tone";
import React from "react";

var backtrack: Tone.Player | null = null;
var backtrackBufferTotal: ArrayBuffer | null = null;

// listen for events emitted by the server
export const initialSocketEvents = (
  socketInstance: Socket,
  setSocket: (socket: Socket | null) => void,
  connectionState: React.MutableRefObject<string>,
  oneWayOffsets: React.MutableRefObject<number[]>,
  setOneWayOffsetAverage: (average: number) => void
) => {
  socketInstance.on('connect', () => {
    console.log('Connected to server');
    setSocket(socketInstance);
    socketInstance.emit("rtc-invite", { senderId: socketInstance.id });
  });

  socketInstance.on("starttime", (data => {
    console.log("Backend Start Time: " + data);
  }
  ));

  socketInstance.on("ping", (callback) => {
    callback();
  });

  socketInstance.on("calculate-latency-server-2", (targetId: string) => {
    console.log("Recieved Latency Message: ", targetId);
    const connection = rtcConnections.get(targetId);
    console.log("Connection: ", connection);
    if (connection) {
      sendMessage(connection, { command: `calculate-latency-server-${socketInstance.id}` });
    }
  });

  socketInstance.on('reconnect', function () {
    console.log('you have been reconnected');
    connectionState.current = "Connected";
    setSocket(socketInstance);
  });

  socketInstance.on('disconnect', function () {
    socketInstance.emit("rtc-message", { type: "bye", senderId: socketInstance.id });
    connectionState.current = "Disconnected";
    setSocket(null);
  });

  socketInstance.on("rtc-message", (e) => {
    console.log("rtc-message: ", e);
    switch (e.type) {
      case "offer":
        handleOffer(e, socketInstance, oneWayOffsets, setOneWayOffsetAverage);
        break;
      case "answer":
        handleAnswer(e);
        break;
      case "candidate":
        handleCandidate(e);
        break;
      case "bye":
        hangup(e);
        break;
      default:
        console.log("unhandled", e);
        break;
    }
  });

  socketInstance.on("rtc-invite", (e) => {
    console.log("rtc-invite: ", e);
    makeCall(e, socketInstance, oneWayOffsets, setOneWayOffsetAverage);
  });
}

export const connectedSocketEvents = (
  socket: Socket,
  connectionState: React.MutableRefObject<string>,
  serverOffset: React.MutableRefObject<number>,
  oneWayOffsetAverage: number,
) => {

  socket.on('start', (targetTime: number, position: string | number = "0:0:0", tempo: number | null = null) => {
    if (tempo) {
      console.log("Tempo: ", tempo);
      Tone.getTransport().bpm.value = tempo;
    }
    // console.log(`start: ${targetTime} at position ${position}`);
    if (connectionState.current === "Connected") {
      // console.log("Server Offset: ", serverOffset.current);
      // console.log("One Way Offset: ", oneWayOffsetAverage);
      const time = convertTime("Client", targetTime, serverOffset.current + oneWayOffsetAverage);
      if( typeof position === "number") {
        console.log("Convert position to bars:beats:sixteenths");
        position = Tone.Time(position, "s").toBarsBeatsSixteenths();
      }
      togglePlayback(true, time, position);
    }
  });

  socket.on('stop', (data) => {
    console.log(`stop`);
    // setIsPlaying(false);
    togglePlayback(false);
  });

  socket.on('change-tempo', (targetTime: number, position: string = "0:0:0", newTempo: number) => {
    if (connectionState.current === "Connected") {
      console.log("change-tempo");
      console.log("Server Offset: ", serverOffset.current);
      console.log("One Way Offset: ", oneWayOffsetAverage);
      const time = convertTime("Client", targetTime, serverOffset.current + oneWayOffsetAverage);
      const startTime = ((time - (window.performance.now() + 100) + (Tone.immediate() * 1000)) / 1000);
      Tone.getTransport().bpm.setValueAtTime(newTempo, startTime);
    }
  });

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
    } else {
      //console.log("New Backtrack: ", backtrackBuffer);
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
      Tone.getContext().decodeAudioData(newBuffer.slice(0)).then((audioBuffer) => {
        if (backtrack) {
          backtrack.stop();
          backtrack.dispose();
          backtrack = null;
        }
        backtrack = new Tone.Player(audioBuffer, () => {
          console.log("Backtrack loaded!");
        }
        ).sync().start(0).toDestination();
      }).catch((error) => {
        console.error("Error decoding audio data: ", error);
      }
      );
    }
  });
}