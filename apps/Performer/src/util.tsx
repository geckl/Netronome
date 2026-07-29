import { Socket } from "socket.io-client";
import { DeviceType, RTCConnection } from "./types";
import * as Tone from "tone";
import React, { RefObject } from "react";
import { oneWayDelay2 } from "./SocketIO";

// Returns a Promise that resolves after "ms" Milliseconds
export const timer = ms => new Promise(res => setTimeout(res, ms));

export const convertTime = (destination: DeviceType, time: number, serverOffset: number) => {
  if (destination === "Server") {
    const serverTime = time + serverOffset;
    return serverTime;
  } else if (destination === "Client") {
    const clientTime = time - serverOffset;
    return clientTime;
  } else {
    throw Error(`Not a valid conversion (options are "server" or "client"`);
  }
}

export function throwIfUndefined<T>(x: T | undefined): asserts x is T {
  if (typeof x === "undefined") throw new Error("OH NOEZ");
}

export function sendMessage(rtcConnection: RTCConnection, msg) {
  const start = window.performance.now() + 500;
  const obj = {
    message: msg,
    timestamp: new Date(),
  };
  if (rtcConnection.dc.readyState === "open") {
    rtcConnection.dc.send(JSON.stringify(obj));
  } else {
    console.error("Data channel is not open. Cannot send message.");
  }
  const end = window.performance.now() + 500;
  console.log("UDP Message sent in ", end - start, "ms");
}

export function cyclicalSync(targetId: string, rtcConnection: RTCConnection, socket: Socket): Promise<{ oneWayOffset: number, serverOffset: number }> {
  let timeout = 10000;
  return new Promise<{ oneWayOffset: number, serverOffset: number }>((resolve, reject) => {
    let timer;
    let serverCyclicalLatency: number, clientCyclicalLatency: number, roundtripLatency: number, serverOffset: number;
    const start = window.performance.now() + 500;

    function responseHandler() {
      // resolve promise with the value we got
      if (serverCyclicalLatency != undefined && clientCyclicalLatency != undefined && roundtripLatency != undefined) {
        console.log("Server Cyclical Roundtrip Latency: ", serverCyclicalLatency);
        console.log("Client Cyclical Roundtrip Latency: ", clientCyclicalLatency);
        console.log("Client-Server-Client Roundtrip Latency: ", roundtripLatency);
        var ratio: number;
        if (serverCyclicalLatency + clientCyclicalLatency === 0) {
          ratio = 0;
        } else {
          ratio = roundtripLatency / (serverCyclicalLatency + clientCyclicalLatency);
        }
        const oneWayOffset: number = ((serverCyclicalLatency - clientCyclicalLatency) * ratio) / 2;
        resolve({ oneWayOffset, serverOffset });
        clearTimeout(timer);
      }
    }

    socket.on(`calculate-latency-client-${targetId}`, () => {
       //setTimeout simulated latency
      //setTimeout(() => {
        // console.log("One way delay incoming: ", oneWayDelay2);
        //  console.log("Client Latency Message Received: ");
        const stop1 = window.performance.now() + 500;
        clientCyclicalLatency = stop1 - start;
        responseHandler();
      //}, oneWayDelay2);

    });

    rtcConnection.dc.addEventListener('message', event => {
      const message = JSON.parse(event.data).message;
      if (message.command === `calculate-latency-server-${targetId}`) {
        // console.log("Server Latency Message Received: ", event.data);
        // const senderId = message.sender;
        const stop2 = window.performance.now() + 500;
        serverCyclicalLatency = stop2 - start;
        responseHandler();

      }
    }, { once: false });

    setTimeout(() => {
      // const start = window.performance.now() + 500;
      sendMessage(rtcConnection, { command: "calculate-latency-client-1", senderId: socket.id });
      socket.volatile.emit("calculate-latency-server-1", targetId, start, (latencyPlusOffset: number) => {
        //  console.log("Roundtrip Latency Message Received: ");
         //setTimeout simulated latency
        //setTimeout(() => {
          const stop0 = window.performance.now() + 500;
          roundtripLatency = stop0 - start;
          serverOffset = latencyPlusOffset - (roundtripLatency / 2);
          console.log("SERVER OFFSET: ", serverOffset);
          responseHandler();
        //}, oneWayDelay2);
      });
    }, 10);

    // set timeout so if a response is not received within a 
    // reasonable amount of time, the promise will reject
    timer = setTimeout(() => {
      reject(new Error("timeout waiting for msg"));
      socket.removeListener(`calculate-latency-client-${targetId}`);
    }, timeout);

  });
}

export function togglePlayback(play: boolean, time: number = 0, position: string | undefined = undefined) {
  console.log(`togglePlayback: ${play}, ${time}, ${position}`);
  Tone.getTransport().pause();
  if (play) {
    if (time > (window.performance.now())) {
      const startTime = ((time - window.performance.now() + (Tone.immediate() * 1000)) / 1000);
      console.log("Start time: ", startTime);
      Tone.getTransport().start(startTime, position);
    } else {
      console.log("Start Command Arrived Too Late!");
      const positionTime = Tone.Time(position).toMilliseconds();
      const startTime = Tone.now();
      const difference = startTime - time;
      const newPosition = Tone.Time(positionTime + difference).toBarsBeatsSixteenths();
      Tone.getTransport().start(startTime, newPosition);
    }
  }
}

export async function synchronize(socket: Socket, serverOffsets: RefObject<number[]>, serverOffset: RefObject<number>) {
  let latencies: number[] = [];
  serverOffsets.current = [];
  for (let i = 0; i < 5; i++) {
    const start = window.performance.now() + 500;
    // volatile, so the packet will be discarded if the socket is not connected
    socket.volatile.emit("calculate-latency", start, (latencyPlusOffset: number) => {
      //setTimeout simulated latency
      //setTimeout(() => {
        const latency = (window.performance.now() + 500) - start;
        latencies.push(latency / 2);
        serverOffsets.current.push((Math.round(latencyPlusOffset - (latency / 2))));
      //}, oneWayDelay2);
    });
    await timer(500);
  }
  let middleOffsets = serverOffsets.current.sort().slice(1, -1);
  let meanOffset = Math.round(middleOffsets.reduce((a, b) => a + b) / (middleOffsets.length));
  let averageLatency = latencies.reduce((a, b) => a + b) / latencies.length;
  if (averageLatency > 1000) {
    console.error("Average latency is too high: ", averageLatency, "ms");
    throw new Error("Average latency is too high. Please check your network connection.");
  }
  serverOffset.current = meanOffset;
  return latencies;
}

export function resetTransport() {
  console.log("Resetting Transport");
  Tone.getTransport().stop();
  Tone.getTransport().cancel();
  Tone.getTransport().dispose();
}