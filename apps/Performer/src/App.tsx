import logo from './logo.svg';
import './App.css';
import * as Tone from "tone";
import Woodblock from './sounds/woodblock.wav'
import { useState, useEffect } from 'react';
//const io = require("socket.io");
//import { onEnabled } from './WebMidi';
import io, { Socket } from 'socket.io-client';
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
  const [isPlaying, setIsPlaying] = useState(false);
  //const [audio, setAudio] = useState("data:audio/mpeg;base64,SUQzBAAAAAABEVRYWFgAAAAtAAADY29tbWVudABCaWdTb3VuZEJhbmsuY29tIC8gTGFTb25vdGhlcXVlLm9yZwBURU5DAAAAHQAAA1N3aXRjaCBQbHVzIMKpIE5DSCBTb2Z0d2FyZQBUSVQyAAAABgAAAzIyMzUAVFNTRQAAAA8AAANMYXZmNTcuODMuMTAwAAAAAAAAAAAAAAD/80DEAAAAA0gAAAAATEFNRTMuMTAwVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQsRbAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQMSkAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV");

  //var audio = new Audio();
  //audio.autoplay = true;

  useEffect(() => {

  }, []);

  function metronome(play: boolean) {
    if (play) {
      Tone.getTransport().start();
    } else {
      Tone.getTransport().stop();
    }
  }

  async function joinOrchestra() {
    if (socket) {
      socket.disconnect();
      setSocket(null);
    } else {
      //audio.src = "data:audio/mpeg;base64,SUQzBAAAAAABEVRYWFgAAAAtAAADY29tbWVudABCaWdTb3VuZEJhbmsuY29tIC8gTGFTb25vdGhlcXVlLm9yZwBURU5DAAAAHQAAA1N3aXRjaCBQbHVzIMKpIE5DSCBTb2Z0d2FyZQBUSVQyAAAABgAAAzIyMzUAVFNTRQAAAA8AAANMYXZmNTcuODMuMTAwAAAAAAAAAAAAAAD/80DEAAAAA0gAAAAATEFNRTMuMTAwVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQsRbAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQMSkAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV";
      //audio.play();
      await Tone.start();
      const socketInstance = io();
      setSocket(socketInstance);

      // listen for events emitted by the server

      socketInstance.on('connect', () => {
        console.log('Connected to server');
        // navigator.mediaDevices.getUserMedia({ audio: true, video: false })
        //   .then((stream) => {
        //     var madiaRecorder = new MediaRecorder(stream);
        //     var audioChunks: Blob[] = [];

        //     madiaRecorder.addEventListener("dataavailable", function (event) {
        //       audioChunks.push(event.data);
        //     });

        //     madiaRecorder.addEventListener("stop", function () {
        //       var audioBlob = new Blob(audioChunks);
        //       audioChunks = [];
        //       var fileReader = new FileReader();
        //       fileReader.readAsDataURL(audioBlob);
        //       fileReader.onloadend = function () {
        //         var base64String = fileReader.result;
        //         socketInstance.emit("audioStream", base64String);
        //       };

        //       madiaRecorder.start();
        //       setTimeout(function () {
        //         madiaRecorder.stop();
        //       }, 1000);
        //     });

        //     madiaRecorder.start();
        //     setTimeout(function () {
        //       madiaRecorder.stop();
        //     }, 1000);
        //   })
        //   .catch((error) => {
        //     console.error('Error capturing audio.', error);
        //   });
      });

      socketInstance.on('start', (data) => {
        console.log(`start`);
        setIsPlaying(true);
        metronome(true);
      });

      socketInstance.on('stop', (data) => {
        console.log(`stop`);
        setIsPlaying(false);
        metronome(false);
      });

      socketInstance.on("starttime", (data => {
        console.log("Start Time: " + data);
      }
      ));

      socketInstance.on('audioStream', async (audioData) => {
        var newData = audioData.split(";");
        newData[0] = "data:audio/ogg;";
        newData = newData[0] + newData[1];

        console.log(newData);

        //var buffer = new Audio(newData);
        if (document.hidden) {
          return;
        }
        //var source = await Tone.getContext().decodeAudioData(newData);
        var player = new Tone.Player(newData).toDestination();
        Tone.loaded().then(() => {
          player.start();
        });
      
        //audio.src = newData;
        //audio.load();
      });

      // socketInstance.on('ping', function(ms) {
      //   console.log(ms)
      //   //const latency = ms;
      //   //console.log(latency);
      // });
    }
  };

return (
  <div className="App">
    <header className="App-header">
      <img src={logo} className="App-logo" alt="logo" />
      <p>
        NETRONOME {isPlaying ? "Stop" : "Play"}
      </p>
      {/* <button onClick={() => toggleMetronome()}>{isPlaying ? "Stop" : "Play"}</button> */}
      <button onClick={() => joinOrchestra()}>{socket ? "Disconnect" : "Join"}</button>
    </header>
  </div>
);
}

export default App;
