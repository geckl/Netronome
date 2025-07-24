import { Socket } from "socket.io-client";
import { DeviceType } from "./types";

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

export const convertTime = (destination: DeviceType, time: number, serverOffset: any) => {
  if (destination === "Server") {
    // Client time in seconds
    return (time * 1000) + serverOffset.current;
  } else if (destination === "Client") {
    //Server time in milliseconds
    return (time - serverOffset.current) / 1000;
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