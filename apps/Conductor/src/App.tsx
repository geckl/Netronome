import logo from './logo.svg';
import './App.css';
import * as Tone from "tone";
import Woodblock from './sounds/woodblock.wav'
import { useState, useEffect } from 'react';
import io, { Socket } from 'socket.io-client';
import InputDropdown from './Inputs';
import React from 'react';


// const socket = io():
// socket.on('connect', function() {
//   console.log('I have made a two-way connection to the server!')
// })

//create a synth and connect it to the main output (your speakers)
//const synth = new Tone.Synth().toDestination();
var player = new Tone.Player(Woodblock).toDestination();
const loopPlayer = new Tone.Loop((time) => {
  player.start(time);
}, "4n").start(0);
//const synthA = new Tone.FMSynth().toDestination();
//const synthB = new Tone.AMSynth().toDestination();


//const Transport = Tone.getTransport();


function App() {

  const [socket, setSocket] = useState<Socket | null>(null);
  const [isPlaying, setIsPlaying] = useState(false)
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]); //MediaDeviceInfo
  const [selectedAudioId, setSelectedAudioId] = useState(null);

  useEffect(() => {
    const socketInstance = io({
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
    //   metronome(true);
    // });

    socketInstance.on("starttime", (data => {
      console.log("Start Time: " + data);
    }
    ))

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

    getDevices();

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
              socket.emit("audioStream", base64String);
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

  function metronome(play: boolean) {
    if (socket) {
      if (play) {
        socket.emit('conductor-start');
        Tone.getTransport().start();
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

  return (
    <div className="App">
      <header className="App-header">
        <img src={logo} className="App-logo" alt="logo" />
        <p>
          NETRONOME (CONDUCTOR MODE)
        </p>
        <button onClick={() => metronome(!isPlaying)}>{isPlaying ? "Stop" : "Play"}</button>
        <InputDropdown inputs={audioInputs} setSelectedAudioId={setSelectedAudioId} ></InputDropdown>
      </header>
    </div>
  );
}

export default App;
