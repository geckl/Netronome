import logo from './logo.svg';
import './styles/App.css';
import * as Tone from "tone";
import Woodblock from './sounds/woodblock.wav'
import { useState, useEffect, useRef } from 'react';
import io, { Socket } from 'socket.io-client';
// import InputDropdown from './components/Inputs';
import React from 'react';
import { ConnectionStatus, JoinButton, Performer } from './types';
import { Button, CloseButton, HStack, Spacer, VStack } from "@chakra-ui/react"
import ConnectionsDrawer from './components/Connections/ConnectionsDrawer';
import { TempoSlider } from './components/Tempo/TempoSlider';
import { convertTime, synchronize, timer } from './util';
import { BacktrackButton } from './components/Backtrack/BacktrackButton';
import { VolumeSlider } from './components/Volume/VolumeSlider';
import SharePopup from './components/Connections/SharePopup';
import { initialSocketEvents } from './SocketIO';
import { setBacktrack } from './components/Backtrack/BacktrackPlayer';

function App() {

  const [connectionState, setConnectionState] = useState<ConnectionStatus>("Disconnected");
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isPlaying, setIsPlaying] = useState(false)
  const [ipAddress, setIpAddress] = useState("");
  const [members, setMembers] = useState<Performer[]>([]);
  const serverOffset = useRef<number>(0);
  const [isBacktrack, setIsBacktrack] = useState(false);
  const volume = useRef<Tone.Gain>(null);
  const tempo = useRef<number>(60);

  useEffect(() => {
    const socketInstance = io('/conductor', {
      transports: ['websocket'],
      upgrade: false
    });
    setSocket(socketInstance);

    // Add socketIO listeners needed for connection
    initialSocketEvents(socketInstance, setIpAddress, setMembers, serverOffset, tempo);

    return () => {
      if (socketInstance) {
        socketInstance.disconnect();
        setSocket(null);
      }
    };
  }, []);

  async function joinOrchestra() {
    if (connectionState === "Connected") {
      setConnectionState("Disconnected");
      Tone.getTransport().stop();
      Tone.getTransport().cancel();
      Tone.getTransport().dispose();
    } else {
      console.log("Join Orchestra!");
      setConnectionState("Connecting")

      const audioContext = new Tone.Context();
      Tone.setContext(audioContext, true);
      Tone.getTransport().bpm.value = 60;
      volume.current = new Tone.Gain(0.5).toDestination();
      Tone.getTransport().position = "0:0:0";

      // This must be called on a button click for browser compatibility
      await Tone.start();

      const latencies = await synchronize(socket, serverOffset);

      // Add socketIO listeners needed for performance
      socket.on("server-update", (tempo: number, isPlaying: boolean) => {
        console.log("Server Tempo: ", tempo);
        setTempo([tempo]);
        setIsPlaying(isPlaying);
      });

      socket.on("server-backtrack", (arrayBuffer: ArrayBuffer) => {
        setBacktrack(arrayBuffer, setIsBacktrack,  socket, togglePlayback);
        console.log("Server Backtrack: ", arrayBuffer);
      });
      socket.emit("conductor-sync-orchestra", latencies);

      //create a synth and connect it to the main output
      var player = new Tone.Player(Woodblock);
      player.connect(volume.current);
      Tone.getTransport().scheduleRepeat((time) => {
        player.start(time);
      }, "4n", 0);

      setConnectionState("Connected");
    }
  }

  function togglePlayback(play: boolean, position: Tone.Unit.Time | undefined = undefined) {
    Tone.getTransport().pause();
    if (socket) {
      if (play) {
        const targetTime = convertTime("Server", Tone.now(), serverOffset.current);
        socket.emit('conductor-start', targetTime, position, (newTargetTime: number) => {
          // console.log(targetTime, "->", newTargetTime - serverOffset.current);
          const time2 = convertTime("Client", newTargetTime, serverOffset.current);
          Tone.getTransport().start(time2, position);
          setIsPlaying(true)
        });
      } else {
        socket.emit('conductor-stop');
        setIsPlaying(false);
      }
    }
  }

  function setTempo(newTempo) {
    tempo.current = newTempo[0];
    if (socket) {
      const targetTime = convertTime("Server", Tone.immediate(), serverOffset.current)
      console.log("Target Time: ", targetTime);
      const position = "0:0:0";
      socket.emit("conductor-change-tempo", targetTime, position, newTempo, (newTargetTime: number) => {
        console.log("New Target Time: ", newTargetTime);
        let time2 = convertTime("Client", newTargetTime, serverOffset.current);
        Tone.getTransport().bpm.setValueAtTime(newTempo, time2);
      });
    }
  }


  return (
    <div className="App" >
      <VStack h="100vh" w="100vw" justifyContent="top" alignItems="center" spacing={4} bg="brand.900">
        <header>
          <p>
            NETRONOME (CONDUCTOR MODE)
          </p>
          <img src={logo} className="App-logo" alt="logo" />
        </header>
        <ConnectionsDrawer members={members}></ConnectionsDrawer>
        <SharePopup ipAddress={ipAddress}></SharePopup>
        <Button onClick={() => joinOrchestra()} disabled={connectionState === "Connecting"} className="Join-button" bg="brand.300">
          {JoinButton[connectionState]}
          <div className="spinner-3" hidden={(connectionState !== "Connecting")}></div>
        </Button>
        <Button className="controls" bg="brand.700" onClick={async () => togglePlayback(!isPlaying, Tone.getTransport().position)} hidden={connectionState !== "Connected"} >{isPlaying ? "Stop" : "Play"}</Button>
        {(connectionState === "Connected") ? (<VStack>
          <VolumeSlider volume={volume} />
          <TempoSlider tempo={tempo} setTempo={setTempo} />
          <Spacer />
          {!isBacktrack ? <BacktrackButton socket={socket} togglePlayback={togglePlayback} setIsBacktrack={setIsBacktrack} /> : <HStack>
            <div id="overview-container"></div>
            <CloseButton variant="ghost" colorPalette="blue" onClick={() => setBacktrack(null, setIsBacktrack, socket)} />
          </HStack>}
        </VStack>) : null}
        {/* <InputDropdown class="controls" inputs={audioInputs} setSelectedAudioId={setSelectedAudioId} isJoined={!isJoined} ></InputDropdown> */}
      </VStack>
    </div>
  );
}

export default App;
