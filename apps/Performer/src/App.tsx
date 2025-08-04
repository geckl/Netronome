import { ReactComponent as Logo } from './logo.svg';
import './styles/App.css';
import * as Tone from "tone";
import Woodblock from './sounds/woodblock.wav'
import React, { useState, useEffect, useRef } from 'react';
import io, { Socket } from 'socket.io-client';
import { convertTime, synchronize, timer } from './util';
import { ConnectionStatus, JoinButton } from './types';
import { connectedSocketEvents, initialSocketEvents } from './SocketIO';

function App() {

  const connectionState = useRef<ConnectionStatus>("Disconnected");
  const [isSyncing, setIsSyncing] = useState(false);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const serverOffset = useRef<number>(0);
  const volume = useRef<Tone.Gain>(null);
  // const backtrack = useRef<Tone.Player>(null);
  const [colorMode, setColorMode] = useState<string>("#61DAFB");
  const oneWayOffsets = useRef<number[]>([]);
  const [oneWayOffsetAverage, setOneWayOffsetAverage] = useState<number>(0);

  // useEffect(() => {
  //   console.log("One Way Offset Average: ", oneWayOffsetAverage);
  // }, [oneWayOffsetAverage]);

  useEffect(() => {
    const socketInstance = io();
    setSocket(socketInstance);

    // Add socketIO listeners needed for connection
    initialSocketEvents(socketInstance, setSocket, connectionState, oneWayOffsets, setOneWayOffsetAverage);

    return () => {
      if (socketInstance) {
        socketInstance.disconnect();
        setSocket(null);
      }
    };
  }, []);

  async function resyncOrchestra() {
    setIsSyncing(true);
    const latencies = await synchronize(socket, serverOffset);
    socket.emit("sync-orchestra", latencies);
    setIsSyncing(false);
    connectionState.current = "Connected";
  }

  async function joinOrchestra() {
    if (connectionState.current === "Connected") {
      resyncOrchestra();
      return;
    } else if (!socket) {
      console.error("Socket is not connected!");
      connectionState.current = "Disconnected";
      return;
    } else {
      setIsSyncing(true);
      console.log("Join Orchestra!");
      connectionState.current = "Connecting"

      const audioContext = new Tone.Context();
      Tone.setContext(audioContext, true);
      Tone.getTransport().bpm.value = 60;
      volume.current = new Tone.Gain(0.5).toDestination();

      // This must be called on a button click for browser compatibility
      await Tone.start();

      // Add socketIO listeners needed for performance
      connectedSocketEvents(socket, setIsPlaying, connectionState, serverOffset, oneWayOffsetAverage,);

      //create a synth and connect it to the main output (your speakers)
      var player = new Tone.Player(Woodblock);
      player.connect(volume.current);
      Tone.getTransport().scheduleRepeat((time) => {
        player.start(time);
        Tone.getDraw().schedule(function () {
          setColorMode("white");
        }, time)
        Tone.getDraw().schedule(function () {
          setColorMode("#61DAFB");
        }, time + .1)
      }, "4n", 0);

      const latencies = await synchronize(socket, serverOffset);
      connectionState.current = "Connected";

      socket.emit("sync-orchestra", latencies);
      setIsSyncing(false);
    };
  }

  function onVolumeChange(e) {
    const value = parseFloat(e.target.value);
    if (volume.current) {
      volume.current.gain.value = value;
    }
  }

  return (
    <div className="App" style={{ backgroundColor: "#00161e" }}>
      <div h="100vh" w="100vw" justify-content="top" align-items="center" spacing={4} bg="white">
        <header className="App-header">
          <p>
            NETRONOME
          </p>
          <Logo className="App-logo" fill={colorMode} />
        </header>
        <button onClick={() => joinOrchestra()} disabled={isSyncing} className="Join-button">
          {!isSyncing && JoinButton[connectionState.current]}
          <div className="spinner-3" hidden={!isSyncing}></div>
        </button>
        {connectionState.current === "Connected" &&
          (<div className="Volume-slider">
            <label for="volume" size={"sm"}>Volume</label>
            <input type="range" id="volume" min={0} max={1} step={.01} defaultValue={0.5} onChange={onVolumeChange} />
          </div>)}
      </div>
    </div>
  );
}

export default App;