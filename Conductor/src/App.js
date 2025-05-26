import logo from './logo.svg';
import './App.css';
import * as Tone from "tone";
import Woodblock from './sounds/woodblock.wav'
import { useState, useEffect } from 'react';
//const io = require("socket.io");
//import { onEnabled } from './WebMidi';
import io from 'socket.io-client';


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


new Tone.getTransport();


function App() {

  const [socket, setSocket] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false)

  useEffect(() => {
    const socketInstance = io('http://localhost:3000');
    setSocket(socketInstance);
  
    // listen for events emitted by the server
  
    socketInstance.on('connect', () => {
      console.log('Connected to server');
    });
  
    socketInstance.on('message', (data) => {
      console.log(`Received message: ${data}`);
    });

    socketInstance.on("starttime", (data =>
    {
      console.log("Start Time: " + data);
    }
    ))

    // socketInstance.on('ping', function(ms) {
    //   console.log(ms)
    //   //const latency = ms;
    //   //console.log(latency);
    // });

  
    return () => {
      if (socketInstance) {
        socketInstance.disconnect();
      }
    };
  }, []);

  //play a middle 'C' for the duration of an 8th note
  function startOrchestra() {
    socket.emit('conductor-start');
    setIsPlaying(!isPlaying);
  }

  //const myp5 = new p5(s);

  return (
    <div className="App">
      <header className="App-header">
        <img src={logo} className="App-logo" alt="logo" />
        <p>
          CONDUCTOR MODE
        </p>
        <button onClick={() => startOrchestra()}>{isPlaying ? "Stop" : "Play"}</button>
      </header>
    </div>
  );
}

export default App;
