import logo from './logo.svg';
import './styles/App.css';
import * as Tone from "tone";
import Woodblock from './sounds/woodblock.wav'
import { useState, useEffect, useRef } from 'react';
import io, { Socket } from 'socket.io-client';
import InputDropdown from './components/Inputs';
import React from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Connection, DeviceType, JoinButton, Performer } from './types';
import { Button, Flex, HStack, Spacer, VStack } from "@chakra-ui/react"
import Demo from "./components/Connections/ConnectionsDrawer"
import ConnectionsDrawer from './components/Connections/ConnectionsDrawer';
import { TempoSlider } from './components/Tempo/TempoSlider';
import { convertTime, getDevices, timer } from './util';
import { BacktrackButton } from './components/Backtrack/BacktrackButton';
import { VolumeSlider } from './components/Volume/VolumeSlider';

// var backtrack: Tone.Player | null = null;

function App() {

  const [connectionState, setConnectionState] = useState<Connection>("Disconnected");
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isPlaying, setIsPlaying] = useState(false)
  const [ipAddress, setIpAddress] = useState("");
  const [members, setMembers] = useState<Performer>([]);
  const serverOffset = useRef<number>(0);
  const backtrack = useRef<Tone.Player>(null);
  const volume = useRef<Tone.Gain>(null);
  // const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]); //MediaDeviceInfo
  // const [selectedAudioId, setSelectedAudioId] = useState(null);
  // const [timeOrigin, setTimeOrigin] = useState(window.performance.timeOrigin);

  // useEffect(() => {
  //   console.log("static time origin: ", window.performance.timeOrigin, " variable time origin: ", timeOrigin);
  // }, [timeOrigin]);

  console.log(backtrack.current);

  useEffect(() => {
    const socketInstance = io('/conductor', {
      transports: ['websocket'],
      upgrade: false
    });
    setSocket(socketInstance);

    // listen for events emitted by the server
    socketInstance.on('connect', () => {
      console.log('Connected to server');
    });

    socketInstance.on("server-ip", (ipAddress: string) => {
      console.log("Server IP Address: ", ipAddress);
      setIpAddress(`http://${ipAddress}:3000`);
    });

    socketInstance.on("starttime", (data: Date) => {
      console.log("Backend Start Time: ");
      console.log(new Date(data));
    });

    socketInstance.on("update-members", (members: Performer) => {
      setMembers(members);
      console.log(members);
    });

    // socketInstance.on('audioStream', (audioData) => {
    //  playAudio(audioData)
    // });

    // getDevices(setAudioInputs);

    // // client-side
    // setInterval(() => {
    //   // volatile, so the packet will be discarded if the socket is not connected
    //   socketInstance.volatile.emit("ping", start, () => {
    //     const latency = window.performance.now() - start;
    //     console.log("Conductor latency: ", latency);
    //   });
    // }, 5000);

    return () => {
      if (socketInstance) {
        socketInstance.disconnect();
      }
    };
  }, []);

  // useEffect(() => {
  //   streamAudio();
  // }, [selectedAudioId]);

  async function joinOrchestra() {
    if (connectionState === "Connected") {
      setConnectionState("Disconnected");
    } else {
      console.log("Join Orchestra!");
      setConnectionState("Connecting")

      const audioContext = new Tone.Context();
      Tone.setContext(audioContext, true);
      Tone.getTransport().bpm.value = 60;
      volume.current = new Tone.Gain(0.5).toDestination();

      // This must be called on a button click for browser compatibility
      await Tone.start();

      let latencies: number[] = [];
      let serverOffsets: number[] = [];

      async function synchronize() {
        for (let i = 0; i < 5; i++) {
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

      //create a synth and connect it to the main output (your speakers)
      var player = new Tone.Player(Woodblock);
      player.connect(volume.current);
      Tone.getTransport().scheduleRepeat((time) => {
        player.start(time);
        // console.log(Tone.getTransport().position);
      }, "4n", 0);

      setConnectionState("Connected");
    }
  }

  function togglePlayback(play: boolean, position: string = "0:0:0") {
    if (socket) {
      if (play) {
        const targetTime = convertTime("Server", Tone.immediate(), serverOffset);
        console.log("Target Time: ", targetTime)
        socket.emit('conductor-start', targetTime, position, (newTargetTime: number) => {
          // console.log(targetTime, "->", newTargetTime - serverOffset.current);
          const time = convertTime("Client", newTargetTime, serverOffset);
          console.log("Timeline Time: ", time);
          //console.log("Target Time: ", newTargetTime - serverOffset.current);
          //console.log(Tone.getContext().immediate());
          Tone.getTransport().start(time);
          setIsPlaying(true)
        });
      } else {
        socket.emit('conductor-stop');
        Tone.getTransport().stop();
        setIsPlaying(false);
      }
    }
  }

  return (
    <div className="App">
      <VStack minHeight={"100%"} >
        <header>
          <img src={logo} className="App-logo" alt="logo" />
        </header>
        <ConnectionsDrawer members={members}></ConnectionsDrawer>
        <Button onClick={() => joinOrchestra()} disabled={connectionState === "Connecting"} className="Join-button" bg="brand.300">
          {JoinButton[connectionState]}
          <div className="spinner-3" hidden={(connectionState !== "Connecting")}></div>
        </Button>
        <p>
          NETRONOME (CONDUCTOR MODE)
        </p>
        <Button className="controls" bg="brand.700" onClick={() => togglePlayback(!isPlaying)} hidden={connectionState !== "Connected"} >{isPlaying ? "Stop" : "Play"}</Button>
        {connectionState === "Connected" && <VolumeSlider volume={volume} />}
        {connectionState === "Connected" && <TempoSlider socket={socket} serverOffset={serverOffset} />}
        <Spacer />
        {/* <InputDropdown class="controls" inputs={audioInputs} setSelectedAudioId={setSelectedAudioId} isJoined={!isJoined} ></InputDropdown> */}
        {connectionState === "Connected" && <BacktrackButton backtrack={backtrack} socket={socket}/>}
      </VStack>
      <Spacer />
      <footer>
        <VStack>
          <p>Connect to Netronome here:</p>
          <QRCodeSVG value={ipAddress} ></QRCodeSVG>
          <Spacer />
        </VStack>
      </footer>
    </div>
  );
}

export default App;
