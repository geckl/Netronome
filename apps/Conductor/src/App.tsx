import logo from './logo.svg';
import './App.css';
import * as Tone from "tone";
import Woodblock from './sounds/woodblock.wav'
import { useState, useEffect } from 'react';
import io, { Socket } from 'socket.io-client';
import InputDropdown from './Inputs';
import React from 'react';


// Record monotonic clock's initial value
//const baseTime = window.performance.timeOrigin;
//console.log(baseTime);
//console.log(Tone.getContext().now());
let timeDiff = 0;


function App() {

  const [socket, setSocket] = useState<Socket | null>(null);
  const [isPlaying, setIsPlaying] = useState(false)
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]); //MediaDeviceInfo
  const [selectedAudioId, setSelectedAudioId] = useState(null);


  useEffect(async () => {

    const audioContext = new Tone.Context();
    //baseTime = Date.now();
    timeDiff = window.performance.now();
    Tone.setContext(audioContext, true);

    // This won't work if Conductor is on mobile
    await Tone.start();

    const socketInstance = io('/conductor',{
      transports: ['websocket'],
      upgrade: false
    });
    setSocket(socketInstance);

    // listen for events emitted by the server
    socketInstance.on('connect', () => {
      console.log('Connected to server');
    });

    // socketInstance.on('start', (data) => {
    //   console.log(`start`);
    //   togglePlayback(true);
    // });

    socketInstance.on("starttime", (data: Date) => {
      console.log("Backend Start Time: ");
      console.log(new Date(data));
    }
    );

    socketInstance.on('audioStream', (audioData) => {
      var newData = audioData.split(";");
      newData[0] = "data:audio/ogg;";
      newData = newData[0] + newData[1];

      var audio = new Audio(newData);
      if (!audio || document.hidden) {
        return;
      }
      audio.play();
    });

    // socketInstance.on('ping', function(ms) {
    //   console.log(ms)
    //   //const latency = ms;
    //   //console.log(latency);
    // });

    //create a synth and connect it to the main output (your speakers)
    var player = new Tone.Player(Woodblock).toDestination();
    Tone.getTransport().scheduleRepeat((time) => {
      player.start(time);
    }, "4n", 0);

    getDevices();

    // client-side
    setInterval(() => {
      const start = Date.now();

      // volatile, so the packet will be discarded if the socket is not connected
      socketInstance.volatile.emit("ping", () => {
        const latency = Date.now() - start;
        console.log("Conductor latency: ", latency);
      });
    }, 5000);

    return () => {
      if (socketInstance) {
        socketInstance.disconnect();
      }
    };
  }, []);

  useEffect(() => {
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

    return;
  }, [selectedAudioId]);

  function togglePlayback(play: boolean, position: string = "0:0:0") {
    if (socket) {
      if (play) {
        const targetTime = Date.now() + 1000;
        socket.emit('conductor-start', targetTime, position);
        let time = getAbsoluteTime(targetTime, timeDiff);
        console.log("Timeline Time: ", time);
        //console.log(Tone.getContext().immediate());
        Tone.getTransport().start(time);
        setIsPlaying(true)
      } else {
        socket.emit('conductor-stop');
        Tone.getTransport().stop();
        setIsPlaying(false);
      }
    }
  }


  function getDevices() {
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

  function getAbsoluteTime(targetTime: number, timeDiff: number) {
    return (targetTime - window.performance.timeOrigin - timeDiff) / 1000;
    //return (targetTime - );
  }

  return (
    <div className="App">
      <header className="App-header">
        <img src={logo} className="App-logo" alt="logo" />
        <p>
          NETRONOME (CONDUCTOR MODE)
        </p>
        <button onClick={() => togglePlayback(!isPlaying)}>{isPlaying ? "Stop" : "Play"}</button>
        <InputDropdown inputs={audioInputs} setSelectedAudioId={setSelectedAudioId} ></InputDropdown>
      </header>
    </div>
  );
}

export default App;
