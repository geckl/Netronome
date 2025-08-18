import { Socket } from "socket.io-client";
import { DeviceType, RTCConnection } from "./types";
import * as Tone from "tone";
import React, { RefObject } from "react";

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
  const obj = {
    message: msg,
    timestamp: new Date(),
  };
  if (rtcConnection.dc.readyState === "open") {
    rtcConnection.dc.send(JSON.stringify(obj));
  } else {
    console.error("Data channel is not open. Cannot send message.");
  }
}

export function onewaySync(targetId: string, rtcConnection: RTCConnection, socket: Socket): Promise<number> {
  let timeout = 10000;
  return new Promise<number>((resolve, reject) => {
    let timer;
    let serverRoundtripLatency: number, clientRoundtripLatency: number, clientLatency: number;
    const start = window.performance.now() + 100;

    function responseHandler() {
      // resolve promise with the value we got
      if (serverRoundtripLatency != undefined && clientRoundtripLatency != undefined && clientLatency != undefined) {
        var ratio: number;
        if (serverRoundtripLatency + clientRoundtripLatency === 0) {
          ratio = 0;
        } else {
          ratio = clientLatency / (serverRoundtripLatency + clientRoundtripLatency);
        }
        const oneWayOffset: number = (serverRoundtripLatency - clientRoundtripLatency) * ratio / 2;
        resolve(oneWayOffset);
        clearTimeout(timer);
      }
    }

    socket.on(`calculate-latency-client-${targetId}`, () => {
      const stop1 = window.performance.now() + 100;
      clientRoundtripLatency = stop1 - start;
      responseHandler();
    });

    rtcConnection.dc.addEventListener('message', event => {
      const message = JSON.parse(event.data).message;
      if (message.command === `calculate-latency-server-${targetId}`) {
        // const senderId = message.sender;
        const stop2 = window.performance.now() + 100;
        serverRoundtripLatency = stop2 - start;
        responseHandler();

      }
    }, { once: false });

    setTimeout(() => {
      sendMessage(rtcConnection, { command: "calculate-latency-client-1", senderId: socket.id });
      socket.emit("calculate-latency-server-1", targetId, () => {
        const stop0 = window.performance.now() + 100;
        clientLatency = stop0 - start;
        responseHandler();
      });
    }, 1);

    // set timeout so if a response is not received within a 
    // reasonable amount of time, the promise will reject
    timer = setTimeout(() => {
      reject(new Error("timeout waiting for msg"));
      socket.removeListener(`calculate-latency-client-${targetId}`);
    }, timeout);

  });
}

export function togglePlayback(play: boolean, time: number = 0, position: string | undefined = undefined) {
  Tone.getTransport().pause();
  if (play) {
    if (time > (window.performance.now())) {
      const startTime = ((time - window.performance.now() + (Tone.immediate() * 1000)) / 1000);
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

export async function synchronize(socket: Socket, serverOffset: RefObject<number>) {
  let latencies: number[] = [];
  let serverOffsets: number[] = [];
  for (let i = 0; i < 5; i++) {
    const start = window.performance.now() + 100;
    // volatile, so the packet will be discarded if the socket is not connected
    socket.volatile.emit("calculate-latency", start, (latencyPlusOffset: number) => {
      const latency = (window.performance.now() + 100) - start;
      latencies.push(latency / 2);
      serverOffsets.push((Math.round(latencyPlusOffset - (latency / 2))));
    });
    await timer(500);
  }
  let middleOffsets = serverOffsets.sort().slice(1, -1);
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
  Tone.getTransport().stop();
  Tone.getTransport().cancel();
  Tone.getTransport().dispose();
}