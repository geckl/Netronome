import { ReactComponent as Logo } from './logo.svg';
import './styles/App.css';
import * as Tone from "tone";
import Woodblock from './sounds/woodblock.wav'
import { useState, useEffect, useRef } from 'react';
import io, { connect, Socket } from 'socket.io-client';
import React from 'react';
import { convertTime, playAudio, timer } from './util';
import { Connection, DeviceType, JoinButton } from './types';

function App() {

  const connectionState = useRef<Connection>("Disconnected");
  const [isLoading, setIsLoading] = useState(false);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const serverOffset = useRef<number>(0);
  const [colorMode, setColorMode] = useState<string>("#61DAFB");
  // const [currentTime, setCurrentTime] = useState(0);
  //const [timeOrigin, setTimeOrigin] = useState(window.performance.timeOrigin);

  useEffect(() => {
    console.log("State: ", connectionState);
  }, [connectionState]);

  useEffect(() => {
    const socketInstance = io();
    setSocket(socketInstance);

    // listen for events emitted by the server
    socketInstance.on('connect', () => {
      console.log('Connected to server');
    });

    socketInstance.on('start', (targetTime: number, position: string = "0:0:0") => {
      if (connectionState.current === "Connected") {
        console.log(`start`);
        const time = convertTime("Client", targetTime, serverOffset);
        // console.log("Timeline Time: ", time);
        // console.log("Target Time: ", targetTime - serverOffset.current);
        // console.log(Tone.getContext().now());
        togglePlayback(true, time, position);
      }
    });

    socketInstance.on('stop', (data) => {
      console.log(`stop`);
      setIsPlaying(false);
      togglePlayback(false);
    });

    socketInstance.on('change-tempo', (targetTime: number, position: string = "0:0:0", newTempo: number) => {
      if (connectionState.current === "Connected") {
        console.log("change-tempo");
        let time2 = convertTime("Client", targetTime, serverOffset);
        Tone.getTransport().bpm.setValueAtTime(newTempo, time2);
      }
    })

    socketInstance.on("starttime", (data => {
      console.log("Backend Start Time: " + data);
    }
    ));

    socketInstance.on("ping", (callback) => {
      callback();
    });

    socketInstance.on('disconnect', function () {
      connectionState.current = "Disconnected";
    });

    // socket.on('audioStream', async (audioData) => {
    //   playAudio(audioData);
    // });

    // client-side
    // setInterval(() => {
    //   const start = Date.now();
    //   setTimeOrigin(start - window.performance.now());

    //   // volatile, so the packet will be discarded if the socket is not connected
    //   socketInstance.volatile.emit("ping", start, (serverLatency: number) => {
    //     const latency = Date.now() - start;
    //     setServerOffset((serverLatency - (latency/2))/1000);
    //     console.log("Performer latency: ", latency);
    //     console.log("Server Offset: ", (serverLatency - (latency/2))/1000);
    //     console.log("Variable Time Origin: ", start - window.performance.now());
    //   });
    // }, 5000);

    return () => {
      if (socketInstance) {
        socketInstance.disconnect();
      }
    };
  }, []);

  function togglePlayback(play: boolean, time: number | string = 0, position: string = "0:0:0") {
    if (play) {
      Tone.getTransport().start(time);
      setIsPlaying(true);
    } else {
      Tone.getTransport().stop(time);
      setIsPlaying(false);
    }
  }

  async function joinOrchestra() {
    if (connectionState.current === "Connected") {
      connectionState.current = "Disconnected";
      socket.emit("leave-orchestra");
    } else {
      setIsLoading(true);
      console.log("Join Orchestra!");
      socket.emit("request-join");
      connectionState.current = "Connecting"

      const audioContext = new Tone.Context();
      Tone.setContext(audioContext, true);
      Tone.getTransport().bpm.value = 60;

      // This must be called on a button click for browser compatibility
      await Tone.start();

      let latencies: number[] = [];
      let serverOffsets: number[] = [];

      async function synchronize() {
        for (let i = 0; i < 10; i++) {
          const start = Tone.immediate() * 1000;
          // volatile, so the packet will be discarded if the socket is not connected
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
        socket.emit("join-orchestra", latencies);
      }
      await synchronize();
      connectionState.current = "Connected";

      //create a synth and connect it to the main output (your speakers)
      var player = new Tone.Player(Woodblock).toDestination();
      Tone.getTransport().scheduleRepeat((time) => {
        player.start(time);
        Tone.getDraw().schedule(function () {
          setColorMode("white");
        }, time)
        Tone.getDraw().schedule(function () {
          setColorMode("#61DAFB");
        }, time + .1)
      }, "4n", 0);

      // Tone.getTransport().scheduleRepeat((time) => {
      //   const start = window.performance.now();
      //   //setTimeOrigin(start - window.performance.now());

      //   // volatile, so the packet will be discarded if the socket is not connected
      //   // socket.volatile.emit("calculate-latency", start, (latencyPlusOffset: number) => {
      //   //   const latency = Date.now() - start;
      //   //   setServerOffset((latencyPlusOffset - (latency / 2)) / 1000);
      //   //   console.log("Performer latency: ", latency);
      //   //   console.log("Server Offset: ", (latencyPlusOffset - (latency / 2)) / 1000);
      //   //   console.log("Variable Time Origin: ", start - window.performance.now());
      //   // });
      // }, "1m", 0);

      setIsLoading(false);
    };
  }

  return (
    <div className="App">
      <div minHeight={"100%"}>
        <header className="App-header">
          {/* <img src={logo} className="App-logo" alt="logo" /> */}
          <Logo className="App-logo" fill={colorMode} />
        </header>
        <p>
          NETRONOME {connectionState.current !== "Connected" ? "" : (!isPlaying ? "(Stopped)" : "(Playing)")}
        </p>
        {/* <button onClick={() => togglePlayback()}>{isPlaying ? "Stop" : "Play"}</button> */}
        <button onClick={() => joinOrchestra()} disabled={isLoading} className="Join-button">
          {JoinButton[connectionState.current]}
          <div className="spinner-3" hidden={!isLoading}></div>
        </button>
        {/* <p>{currentTime}</p> */}
      </div>
    </div>
  );
}

export default App;
