import { Socket } from "socket.io-client";
import { DeviceType, RTCConnection } from "./types";
import * as Tone from "tone";

// Returns a Promise that resolves after "ms" Milliseconds
export const timer = ms => new Promise(res => setTimeout(res, ms));

export const playAudio = (audioData: any) => {
    console.log(typeof audioData);
    console.log(audioData);

    const blob = new Blob([audioData], { type: "audio/mpeg" });

    
    const audioString = JSON.stringify(audioData);

    //var newData = audioString.split(";");
    //    newData[0] = "data:audio/mpeg;";
    //    newData = newData[0] + newData[1];
  
        var audio = new Audio(audioString);
        if (!audio || document.hidden) {
          return;
        }
        audio.play();
}

  export const convertTime = (destination: DeviceType, time: number, serverOffset: number) => {
    if (destination === "Server") {
      // Client time in seconds
      return (time * 1000) + serverOffset;
    } else if (destination === "Client") {
      //Server time in milliseconds
      return (time - serverOffset) / 1000;
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

        const start = window.performance.now(); // use performance.now() for higher precision

        function responseHandler() {
          console.log(serverRoundtripLatency, clientRoundtripLatency, clientLatency);
          // resolve promise with the value we got
          if (serverRoundtripLatency != undefined && clientRoundtripLatency != undefined && clientLatency != undefined) {
            var ratio: number;
            if(serverRoundtripLatency + clientRoundtripLatency === 0) {
              console.log("X");
              ratio = 0;
            } else {
              console.log("Y");
              ratio = clientLatency / (serverRoundtripLatency + clientRoundtripLatency);
            }
            const oneWayOffset: number = (serverRoundtripLatency - clientRoundtripLatency) * ratio / 2;
            console.log("oneWayOffset: ", oneWayOffset);
            resolve(oneWayOffset);
            clearTimeout(timer);
          }
        }

        socket.on(`calculate-latency-client-${targetId}`, () => {
          console.log("calculate-latency-client response received");
          const stop1 = window.performance.now();
          clientRoundtripLatency = stop1 - start;
          responseHandler();
        });

        rtcConnection.dc.addEventListener('message', event => {
          console.log("calculate-latency-server response received");
          const message = JSON.parse(event.data).message;
          if (message.command === `calculate-latency-server-${targetId}`) {
            const senderId = message.sender;
            const stop2 = window.performance.now();
            serverRoundtripLatency = stop2 - start;
            responseHandler();

          }
        }, { once: false });

       setTimeout(() => {
        sendMessage(rtcConnection, { command: "calculate-latency-client-1", senderId: socket.id });
        socket.emit("calculate-latency-server-1", targetId, () => {
          const stop0 = window.performance.now();
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