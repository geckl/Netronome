import { ReactComponent as Logo } from './logo.svg';
import './styles/App.css';
import * as Tone from "tone";
import Woodblock from './sounds/woodblock.wav'
import React, { useState, useEffect, useRef } from 'react';
import io, { Socket } from 'socket.io-client';
import { resetTransport, synchronize } from './util';
import { ConnectionStatus, JoinButton } from './types';
import { connectedSocketEvents, initialSocketEvents } from './SocketIO';
import { ToastContainer, toast } from 'react-toastify';


function App() {

  const connectionState = useRef<ConnectionStatus>("Disconnected");
  const [isSyncing, setIsSyncing] = useState(false);
  const [socket, setSocket] = useState<Socket | null>(null);
  // const [isPlaying, setIsPlaying] = useState(false);
  const volume = useRef<Tone.Gain>(null);
  const delay = useRef<number>(0);
  const [delayDisplay, setDelayDisplay] = useState<number>(0);
  // const backtrack = useRef<Tone.Player>(null);
  const [colorMode, setColorMode] = useState<string>("#61DAFB");
  const serverOffsets = useRef<number[]>([]);
  const serverOffset = useRef<number>(0);
  const oneWayOffsets = useRef<number[]>([]);
  const oneWayOffsetAverage = useRef<number>(0);
  // const [timeOrigin, setTimeOrigin] = useState(window.performance.timeOrigin);

  // console.log(serverOffsets.current);

  useEffect(() => {
    const socketInstance = io();

    // Add socketIO listeners needed for connection
    initialSocketEvents(socketInstance, setSocket, connectionState, serverOffsets, oneWayOffsets, oneWayOffsetAverage);

    return () => {
      if (socketInstance) {
        socketInstance.disconnect();
        socketInstance.removeAllListeners();
        setSocket(null);
      }
    };
  }, []);

  async function resyncOrchestra() {
    console.log("Resync Orchestra!");
    if (socket) {
      try {
        setIsSyncing(true);
        const latencies = await synchronize(socket, serverOffsets, serverOffset);
        socket.emit("sync-orchestra", latencies);
        setIsSyncing(false);
        //connectionState.current = "Connected";
      } catch (error) {
        console.error("Resync failed: ", error);
        connectionState.current = "Disconnected";
        setIsSyncing(false);
        resetTransport();
        toast("Failed To Connect: " + error.message);
      }
    }
  }

  async function joinOrchestra() {
    console.log("Join Orchestra!");
    if (!socket) {
      console.error("Socket is not connected!");
      connectionState.current = "Disconnected";
      resetTransport();
      return;
    } else if (!socket.connected) {
      socket.connect();
    }
    if (connectionState.current === "Connected") {
      // Tone.getContext().resume();
      await resyncOrchestra();
      return;
    } else {
      setIsSyncing(true);
      console.log("Join Orchestra!");
      connectionState.current = "Connecting"

      const audioContext = new Tone.Context({
        lookAhead: 0.5
      });

      Tone.setContext(audioContext, true);
      Tone.getTransport().bpm.value = 60;
      volume.current = new Tone.Gain(0.5).toDestination();
      // This must be called on a button click for browser compatibility
      await Tone.start();

      // Add socketIO listeners needed for performance
      connectedSocketEvents(socket, connectionState, serverOffset, oneWayOffsetAverage,);

      //create a synth and connect it to the main output (your speakers)
      var player = new Tone.Player(Woodblock);
      player.connect(volume.current);
      Tone.getTransport().scheduleRepeat((time) => {
        const delayedTime = time + (delay.current / 1000)
        //console.log("delayedTime: ", delayedTime, "delay: ", delay.current);
        player.start(delayedTime);
        Tone.getDraw().schedule(function () {
          setColorMode("white");
        }, delayedTime)
        Tone.getDraw().schedule(function () {
          setColorMode("#61DAFB");
        }, delayedTime + .1)
      }, "4n", 0);

      try {
        const latencies = await synchronize(socket, serverOffsets, serverOffset);
        connectionState.current = "Connected";
        socket.emit("sync-orchestra", latencies);
        setIsSyncing(false);
      } catch (error) {
        connectionState.current = "Disconnected";
        setIsSyncing(false);
        toast("Failed To Connect: " + error.message);
        resetTransport();
        return;
      }
    };
  }

  function onVolumeChange(e) {
    const value = parseFloat(e.target.value);
    if (volume.current) {
      volume.current.gain.value = value;
      console.log("Volume changed to: ", volume.current.gain.value);
    }
  }

  function onDelayChange(e) {
    const value = parseInt(e.target.value);
    delay.current = value;
    setDelayDisplay(value);
    console.log("Delay changed to: ", delay.current);
  }

  function resetValue(e) {
    e.target.value = 0;
    delay.current = 0;
    setDelayDisplay(0);
  }

  return (
    <div className="App" style={{ backgroundColor: "#00161e" }}>
      <div style={{ height: "100vh", width: "100vw", backgroundColor: "#00161e" }} justify-content="top" align-items="center">
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
          (<div><div className="Volume-slider">
            <label htmlFor="volume">Volume:</label>
            <input type="range" id="volume" min={0} max={1} step={.01} defaultValue={0.5} onChange={onVolumeChange} />
          </div>
            <div className="Delay-slider">
              <label htmlFor="delay">Delay: {delayDisplay} ms</label>
              <input type="range" id="delay" min={-500} max={500} step={1} defaultValue={0} onChange={onDelayChange} onDoubleClick={resetValue}
              />
            </div></div>)}
        <ToastContainer />
      </div>
    </div>
  );
}

export default App;