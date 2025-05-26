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
    const socketInstance = io();
    setSocket(socketInstance);
  
    // listen for events emitted by the server
  
    socketInstance.on('connect', () => {
      console.log('Connected to server');
    });
  
    socketInstance.on('start', (data) => {
      console.log(`start`);
      playSynth();
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
  function playSynth() {
    console.info("PLAY SOUND");
    //synth.triggerAttackRelease("C4", "32n");

    console.log(Tone.getTransport());


    if(Tone.getTransport().state === "started")
    {
      Tone.getTransport().stop();
      setIsPlaying(false);
    } else {
      Tone.getTransport().start();
      setIsPlaying(true)
    }
    
    

  //   //play a note every quarter-note
  //   const loopA = new Tone.Loop((time) => {
  //     synthA.triggerAttackRelease("C2", "8n", time);
  //   }, "4n").start(0);
  //   //play another note every off quarter-note, by starting it "8n"
  //   const loopB = new Tone.Loop((time) => {
  //     synthB.triggerAttackRelease("C4", "8n", time);
  //   }, "4n").start("8n");
  //   // all loops start when the Transport is started
  //   Tone.getTransport().start();
  //   // ramp up to 800 bpm over 10 seconds
  //   Tone.getTransport().bpm.rampTo(800, 10);
  }

  //const myp5 = new p5(s);

  return (
    <div className="App">
      <header className="App-header">
        <img src={logo} className="App-logo" alt="logo" />
        <p>
          MY FIRST NETWORKED SYNTH
        </p>
        <button onClick={() => playSynth()}>{isPlaying ? "Stop" : "Play"}</button>
      </header>
    </div>
  );
}

export default App;
