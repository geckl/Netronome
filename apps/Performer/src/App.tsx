import logo from './logo.svg';
import './App.css';
import * as Tone from "tone";
import Woodblock from './sounds/woodblock.wav'
import { useState, useEffect } from 'react';
import io, { Socket } from 'socket.io-client';
import React from 'react';


// Record monotonic clock's initial value
//const baseTime = window.performance.timeOrigin;
//console.log(baseTime);
// console.log(Tone.getContext().now());
// let baseTime = window.performance.now();
let timeDiff = 0;


function App() {

  const [socket, setSocket] = useState<Socket | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  // const [currentTime, setCurrentTime] = useState(0);
  const [timeOrigin, setTimeOrigin] = useState(window.performance.timeOrigin);

  // useEffect(() => {

  // }, []);

  useEffect(() => {
    console.log("static time origin: ", window.performance.timeOrigin, " variable time origin: ", timeOrigin);
  }, [timeOrigin]);

  function togglePlayback(play: boolean, time: number = 0, position: string = "0:0:0") {
    if (play) {
      Tone.getTransport().start(time);
      setIsPlaying(true);
    } else {
      Tone.getTransport().stop(time);
      setIsPlaying(false);
    }
  }

  async function joinOrchestra() {
    if (socket) {
      socket.disconnect();
      setSocket(null);
    } else {
      //audio.src = "data:audio/mpeg;base64,SUQzBAAAAAABEVRYWFgAAAAtAAADY29tbWVudABCaWdTb3VuZEJhbmsuY29tIC8gTGFTb25vdGhlcXVlLm9yZwBURU5DAAAAHQAAA1N3aXRjaCBQbHVzIMKpIE5DSCBTb2Z0d2FyZQBUSVQyAAAABgAAAzIyMzUAVFNTRQAAAA8AAANMYXZmNTcuODMuMTAwAAAAAAAAAAAAAAD/80DEAAAAA0gAAAAATEFNRTMuMTAwVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQsRbAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQMSkAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV";
      //audio.play();

      const audioContext = new Tone.Context();
      // baseTime = Date.now();
      timeDiff = window.performance.now();
      Tone.setContext(audioContext, true);
      // console.log("BaseTime: ", timeDiff);
      // console.log("ToneTime: ", Tone.getContext().immediate());
      await Tone.start();

      const socketInstance = io();
      setSocket(socketInstance);

      // listen for events emitted by the server
      socketInstance.on('connect', () => {
        console.log('Connected to server');
      });

      socketInstance.on('start', (targetTime: number, position: string = "0:0:0") => {
        console.log(`start`);
        let time = getAbsoluteTime(targetTime, timeDiff);
        console.log("Timeline Time: ", time);
        // console.log(Tone.getContext().now());
        togglePlayback(true, time, position);
      });

      socketInstance.on('stop', (data) => {
        console.log(`stop`);
        setIsPlaying(false);
        togglePlayback(false);
      });

      socketInstance.on("starttime", (data => {
        console.log("Backend Start Time: " + data);
      }
      ));

      socketInstance.on('audioStream', async (audioData) => {
        var newData = audioData.split(";");
        newData[0] = "data:audio/ogg;";
        newData = newData[0] + newData[1];
        console.log(newData);

        if (document.hidden) {
          return;
        }

        var player = new Tone.Player(newData).toDestination();
        Tone.loaded().then(() => {
          player.start();
        });
      });

      // socketInstance.on("disconnect", (reason) => {
      //   setSocket(null);
      //   console.log("Performer disconnected: ", reason);
      // });

      //create a synth and connect it to the main output (your speakers)
      //const synth = new Tone.Synth().toDestination();
      var player = new Tone.Player(Woodblock).toDestination();
      Tone.getTransport().scheduleRepeat((time) => {
        player.start(time);
      }, "4n", 0);

      // socketInstance.on('ping', function(ms) {
      //   console.log(ms)
      //   //const latency = ms;
      //   //console.log(latency);
      // });

      // client-side
      setInterval(() => {
        const start = Date.now();
        setTimeOrigin(start - window.performance.now());

        // volatile, so the packet will be discarded if the socket is not connected
        socketInstance.volatile.emit("ping", start, () => {
          const latency = Date.now() - start;
          console.log("Performer latency: ", latency);
        });
      }, 5000);

      // setInterval(() => {
      //   setCurrentTime(Tone.getContext().now());
      // }, 10);

    }
  };

  function getAbsoluteTime(targetTime: number, timeDiff: number) {
    return (targetTime - timeOrigin - timeDiff) / 1000;
    //return (targetTime - );
  }

  return (
    <div className="App">
      <header className="App-header">
        <img src={logo} className="App-logo" alt="logo" />
        <p>
          NETRONOME {isPlaying ? "Stop" : "Play"}
        </p>
        {/* <button onClick={() => togglePlayback()}>{isPlaying ? "Stop" : "Play"}</button> */}
        <button onClick={() => joinOrchestra()}>{socket ? "Disconnect" : "Join"}</button>
        {/* <p>{currentTime}</p> */}
      </header>
    </div>
  );
}

export default App;
