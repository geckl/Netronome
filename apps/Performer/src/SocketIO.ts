import { Socket } from "socket.io-client";
// import { handleAnswer, handleCandidate, handleOffer, hangup, makeCall, rtcConnections } from './WebRTC';
import { convertTime, playAudio, sendMessage, togglePlayback } from "./util";
import * as Tone from "tone";
import React, { RefObject } from "react";

var backtrack: Tone.Player | null = null;
var backtrackBufferTotal: ArrayBuffer | null = null;

export const oneWayDelay2 = 300; // Simulated one-way delay for testing

// listen for events emitted by the server
export const initialSocketEvents = (
  socketInstance: Socket,
  setSocket: (socket: Socket | null) => void,
  connectionState: RefObject<string>,
  serverOffsets: RefObject<number[]>,
  oneWayOffsets: RefObject<number[]>,
  oneWayOffsetAverage: RefObject<number>
) => {
  socketInstance.on('connect', () => {
     //setTimeout simulated latency
    //setTimeout(() => {
      // console.log("One way delay incoming: ", oneWayDelay2);
      console.log('Connected to server');
      setSocket(socketInstance);
      socketInstance.emit("rtc-invite", { senderId: socketInstance.id });
   // }, oneWayDelay2);
  });

  socketInstance.on("asymmetric-latency", (oneWayDelay1) => {
    console.log("Asymmetric Latency: " + oneWayDelay1 + " ms, " + oneWayDelay2 + " ms");
  });

  socketInstance.on("ping", (callback) => {
     //setTimeout simulated latency
    //setTimeout(() => {
      // console.log("One way delay incoming: ", oneWayDelay2);
      callback();
    //}, oneWayDelay2);
  });

  // socketInstance.on("calculate-latency-server-2", (targetId: string) => {
  //    //setTimeout simulated latency
  //   //setTimeout(() => {
  //     // console.log("One way delay incoming: ", oneWayDelay2);
  //     const connection = rtcConnections.get(targetId);
  //     if (connection) {
  //       sendMessage(connection, { command: `calculate-latency-server-${socketInstance.id}` });
  //     }
  //   //}, oneWayDelay2);

  // });

  socketInstance.on('reconnect', function () {
     //setTimeout simulated latency
    //setTimeout(() => {
      // console.log("One way delay incoming: ", oneWayDelay2);
      console.log('you have been reconnected!');
      connectionState.current = "Connected";
      setSocket(socketInstance);
    //}, oneWayDelay2);

  });

  socketInstance.on('disconnect', function () {
     //setTimeout simulated latency
    //setTimeout(() => {
      // console.log("One way delay incoming: ", oneWayDelay2);
      socketInstance.emit("rtc-message", { type: "bye", senderId: socketInstance.id });
      connectionState.current = "Disconnected";
      setSocket(null);
    //}, oneWayDelay2);

  });

//   socketInstance.on("rtc-message", (e) => {
//      //setTimeout simulated latency
//     //setTimeout(() => {
//       // console.log("One way delay incoming: ", oneWayDelay2);
//       switch (e.type) {
//         case "offer":
//           handleOffer(e, socketInstance, serverOffsets, oneWayOffsets, oneWayOffsetAverage);
//           break;
//         case "answer":
//           handleAnswer(e);
//           break;
//         case "candidate":
//           handleCandidate(e);
//           break;
//         case "bye":
//           hangup(e);
//           break;
//         default:
//           console.log("unhandled", e);
//           break;
//       }
//     //}, oneWayDelay2);
//     // console.log("rtc-message: ", e);
//   });

//   socketInstance.on("rtc-invite", (e) => {
//      //setTimeout simulated latency
//     //setTimeout(() => {
//       // console.log("One way delay incoming: ", oneWayDelay2);
//       makeCall(e, socketInstance, serverOffsets, oneWayOffsets, oneWayOffsetAverage);
//     //}, oneWayDelay2);
//     // console.log("rtc-invite: ", e);
//   });
  };


export const connectedSocketEvents = (
  socket: Socket,
  connectionState: RefObject<string>,
  serverOffset: RefObject<number>,
  oneWayOffsetAverage: RefObject<number>,
) => {
  socket.on('start', (targetTime: number, position: string | number = "0:0:0", tempo: number | null = null) => {
    console.log(`start: ${targetTime}, ${position}, ${tempo}`);
     //setTimeout simulated latency
    //setTimeout(() => {
      // console.log("One way delay incoming: ", oneWayDelay2);
      if (tempo) {
        Tone.getTransport().bpm.value = tempo;
      }
      if (connectionState.current === "Connected") {
        // console.log("One Way Offset Average: ", oneWayOffsetAverage.current);
        const time = convertTime("Client", targetTime, serverOffset.current + oneWayOffsetAverage.current);
        if (typeof position === "number") {
          position = Tone.Time(position, "s").toBarsBeatsSixteenths();
        }
        togglePlayback(true, time, position);
      }
    //}, oneWayDelay2);
  });

  socket.on('stop', (data) => {
    console.log(`stop: ${data}`);
     //setTimeout simulated latency
    //setTimeout(() => {
      // console.log("One way delay incoming: ", oneWayDelay2);
      console.log(`stop`);
      togglePlayback(false);
    //}, oneWayDelay2);

  });

  socket.on('change-tempo', (targetTime: number, position: string = "0:0:0", newTempo: number) => {
     //setTimeout simulated latency
    //setTimeout(() => {
      // console.log("One way delay incoming: ", oneWayDelay2);
      if (connectionState.current === "Connected") {
        // console.log("One Way Offset Average: ", oneWayOffsetAverage.current);
        const time = convertTime("Client", targetTime, serverOffset.current + oneWayOffsetAverage.current);
        const startTime = ((time - (window.performance.now() + 500) + (Tone.immediate() * 1000)) / 1000);
        Tone.getTransport().bpm.setValueAtTime(newTempo, startTime);
      }
    //}, oneWayDelay2);

  });

  socket.on("backtrack", (backtrackBuffer: ArrayBuffer | null) => {
     //setTimeout simulated latency
    //setTimeout(() => {
      // console.log("One way delay incoming: ", oneWayDelay2);
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
    //}, oneWayDelay2);
  });

  socket.on('audioStream', (audioData) => {
     playAudio(audioData)
    });

}