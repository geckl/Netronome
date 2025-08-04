import { Socket } from "socket.io-client";
import { DeviceType } from "./types";
import * as Tone from "tone";
import React from "react";

// Returns a Promise that resolves after "ms" Milliseconds
export const timer = ms => new Promise(res => setTimeout(res, ms));

export function getDevices({ setAudioInputs }: { setAudioInputs: (inputs: MediaDeviceInfo[]) => void }) {
  const inputs: MediaDeviceInfo[] = [];
  if (!navigator.mediaDevices?.enumerateDevices) {
    console.log("enumerateDevices() not supported.");
  } else {
    // List cameras and microphones.
    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        devices.forEach((device) => {
          //console.log(`${device.kind}: ${device.label} id = ${device.deviceId}`);
          if (device.kind == "audioinput") {
            inputs.push(device);
          }
        });
        setAudioInputs(inputs);
      })
      .catch((err) => {
        console.error(`${err.name}: ${err.message}`);
      });
  }
}

export const streamAudio = ({ selectedAudioId, socket }: { selectedAudioId: string, socket: Socket }) => {
  if (selectedAudioId && socket) {
    console.log("New Audio Source Selected: " + selectedAudioId);
    navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: {
          exact: selectedAudioId,
        },
      },
      video: false
    })
      .then((stream) => {
        var madiaRecorder = new MediaRecorder(stream);
        var audioChunks: Blob[] = [];

        madiaRecorder.addEventListener("dataavailable", function (event) {
          audioChunks.push(event.data);
        });

        madiaRecorder.addEventListener("stop", function () {
          var audioBlob = new Blob(audioChunks);
          audioChunks = [];
          var fileReader = new FileReader();
          fileReader.readAsDataURL(audioBlob);
          fileReader.onloadend = function () {
            var base64String = fileReader.result;
            socket.volatile.emit("audioStream", base64String);
          };

          madiaRecorder.start();
          setTimeout(function () {
            madiaRecorder.stop();
          }, 1000);
        });

        madiaRecorder.start();
        setTimeout(function () {
          madiaRecorder.stop();
        }, 1000);
      })
      .catch((error) => {
        console.error('Error capturing audio.', error);
      });
  }
}

export const playAudio = (audioData: any) => {
  var newData = audioData.split(";");
  newData[0] = "data:audio/ogg;";
  newData = newData[0] + newData[1];

  var audio = new Audio(newData);
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

export const toBase64 = file => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.readAsDataURL(file);
  reader.onload = () => resolve(reader.result);
  reader.onerror = reject;
});

export async function synchronize(socket: Socket, serverOffset: React.MutableRefObject<number>): Promise<number[]> {
  let latencies: number[] = [];
  let serverOffsets: number[] = [];
  for (let i = 0; i < 5; i++) {
    const start = Tone.immediate() * 1000;
    socket.volatile.emit("calculate-latency", start, (latencyPlusOffset: number) => {
      const latency = (Tone.immediate() * 1000) - start;
      latencies.push(latency / 2);
      serverOffsets.push((latencyPlusOffset - (latency / 2)));
      console.log("Performer latency: ", latency);
      console.log("Server Offset: ", (latencyPlusOffset - (latency / 2)));
    });
    await timer(500);
  }
  let middleOffsets = serverOffsets.sort().slice(1, -1);
  let meanOffset = middleOffsets.reduce((a, b) => a + b) / (middleOffsets.length);
  console.log("Mean: ", meanOffset);
  serverOffset.current = meanOffset;
  return latencies;
}