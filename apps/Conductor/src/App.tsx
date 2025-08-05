import { ReactComponent as Logo } from './logo.svg';
import './styles/App.css';
import * as Tone from "tone";
import Woodblock from './sounds/woodblock.wav'
import { useState, useEffect, useRef } from 'react';
import io, { Socket } from 'socket.io-client';
// import InputDropdown from './components/Inputs';
import React from 'react';
import { ConnectionStatus, JoinButton, NetronomePlaybackState, Performer } from './types';
import { Button, CloseButton, HStack, Spacer, VStack } from "@chakra-ui/react"
import ConnectionsDrawer from './components/Connections/ConnectionsDrawer';
import { TempoSlider } from './components/Tempo/TempoSlider';
import { convertTime, resetTransport, synchronize, timer } from './util';
import { BacktrackButton } from './components/Backtrack/BacktrackButton';
import { VolumeSlider } from './components/Volume/VolumeSlider';
import SharePopup from './components/Connections/SharePopup';
import { initialSocketEvents } from './SocketIO';
import Peaks, { PeaksInstance } from 'peaks.js';
import { get } from 'http';


var peaks: PeaksInstance | undefined = undefined;
var updatePlayhead: number | undefined = undefined;
var backtrack: Tone.Player | null = null;

function App() {

  const [connectionState, setConnectionState] = useState<ConnectionStatus>("Disconnected");
  const [socket, setSocket] = useState<Socket | null>(null);
  // const [isPlaying, setIsPlaying] = useState(false)
  const [ipAddress, setIpAddress] = useState("");
  const [members, setMembers] = useState<Performer[]>([]);
  const serverOffset = useRef<number>(0);
  const [isBacktrack, setIsBacktrack] = useState(false);
  const [colorMode, setColorMode] = useState<string>("#61DAFB");
  const volume = useRef<Tone.Gain>(null);
  const tempo = useRef<number>(60);
  const [state, setState] = useState<NetronomePlaybackState>("stopped");

  useEffect(() => {
    console.log("State: ", state);
  }, [state]);

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
        socketInstance.removeAllListeners();
        setSocket(null);
      }
    };
  }, []);

  async function joinOrchestra() {
    if (!socket) {
      console.error("Socket is not connected!");
      console.log(socket);
      setConnectionState("Disconnected");
      return;
    } else if (!socket.connected) {
      socket.connect();
    }
    if (connectionState === "Connected") {
      setConnectionState("Disconnected");
      resetTransport();
      return;
    } else {
      console.log("Join Orchestra!");
      setConnectionState("Connecting")

      const audioContext = new Tone.Context();
      Tone.setContext(audioContext, true);
      Tone.getTransport().bpm.value = 60;
      volume.current = new Tone.Gain(0.5).toDestination();
      Tone.getTransport().position = "0:0:0";

      Tone.getTransport().on("start", () => {
        setState("started");
      });
      Tone.getTransport().on("stop", () => {
        setState("stopped");
      });
      Tone.getTransport().on("pause", () => {
        setState("paused");
      });

      // This must be called on a button click for browser compatibility
      await Tone.start();

      const latencies = await synchronize(socket, serverOffset);

      // Add socketIO listeners needed for performance
      socket.on("server-update", (tempo: number, isPlaying: boolean) => {
        console.log("Server Tempo: ", tempo);
        setTempo(tempo);
        // setIsPlaying(isPlaying);
      });

      socket.on("server-backtrack", (arrayBuffer: ArrayBuffer) => {
        setBacktrack(arrayBuffer, socket);
        console.log("Server Backtrack: ", arrayBuffer);
      });
      socket.emit("conductor-sync-orchestra", latencies);

      //create a synth and connect it to the main output
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

      setConnectionState("Connected");
    }
  }

  async function togglePlayback(play: boolean, position: Tone.Unit.Time | undefined = undefined): Promise<boolean> {
    Tone.getTransport().pause();
    if (socket) {
      if (play) {
        setState("paused");
        const targetTime = convertTime("Server", window.performance.now() + 100, serverOffset.current);
        socket.emit('conductor-start', targetTime, position, (newTargetTime: number) => {
          // console.log(targetTime, "->", newTargetTime - serverOffset.current);
          const time = convertTime("Client", newTargetTime, serverOffset.current);
          const startTime = ((time - (window.performance.now()) + (Tone.immediate() * 1000)) / 1000);
          console.log("Start Time (ToneJS): ", startTime);
          //setIsPlaying(true);
          Tone.getTransport().start(startTime, position);
          return true;
        });
      } else {
        socket.emit('conductor-stop');
        const tempPosition = Tone.getTransport().position;
        Tone.getTransport().stop();
        Tone.getTransport().position = tempPosition; // Reset position to the last known position
        // setIsPlaying(false);
        return false;
      }
    }
    return false;
  }

  function setTempo(newTempo) {
    tempo.current = newTempo;
    if (socket) {
      const targetTime = convertTime("Server", window.performance.now() + 100, serverOffset.current)
      console.log("Target Time: ", targetTime);
      const position = "0:0:0";
      socket.emit("conductor-change-tempo", targetTime, position, newTempo, (newTargetTime: number) => {
        console.log("New Target Time: ", newTargetTime);
        let time = convertTime("Client", newTargetTime, serverOffset.current);
        const startTime = ((time - (window.performance.now() + 100) + (Tone.immediate() * 1000)) / 1000);
        Tone.getTransport().bpm.setValueAtTime(newTempo, startTime);
      });
    }
  }

  function isPlaying() {
    return (Tone.getTransport().state === "started" || Tone.getTransport().state === "paused");
  }

  function getState() {
    return state;
  }

  function setBacktrack(arrayBuffer: ArrayBuffer | null, socket: Socket | null) {
    if (arrayBuffer) {
      setIsBacktrack(true);
      // Convert array buffer into audio buffer
      Tone.getContext().decodeAudioData(arrayBuffer).then((audioBuffer) => {
        backtrack = new Tone.Player(audioBuffer).sync().start(0).toDestination();

        const player = {
          externalPlayer: backtrack,
          eventEmitter: null,

          init: function (eventEmitter) {
            console.log("init backtrack!");
            this.eventEmitter = eventEmitter;
            Tone.getTransport().position = "0:0:0";
            updatePlayhead = Tone.getTransport().scheduleRepeat(() => {
              const time = this.getCurrentTime();
              eventEmitter.emit('player.timeupdate', time);
              if (time >= this.getDuration()) {
                togglePlayback(false)
              }
            }, 0.50);
            return Promise.resolve();
          },

          destroy: function () {
            console.log("destroy backtrack!");
            backtrack?.dispose();
            if (updatePlayhead) {
              Tone.getTransport().clear(updatePlayhead);
            }
            // if (peaks.current) {
            //   peaks.current.destroy();
            // }
            backtrack = null;
            this.externalPlayer = null;
            this.eventEmitter = null;
          },

          setSource: function (opts) {
            console.log("setSource backtrack!");
            if (this.isPlaying()) {
              this.pause();
            }

            // Update the Tone.js Player object with the new AudioBuffer
            this.externalPlayer.buffer.set(opts.webAudio.audioBuffer);
            return Promise.resolve();
          },

          play: async function () {
            console.log("play backtrack!");
            // togglePlayback(true)
            this.eventEmitter.emit('player.playing', this.getCurrentTime());
            return Promise.resolve();
          },

          pause: function () {
            console.log("pause backtrack!");
            // Tone.getTransport().pause();

            this.eventEmitter.emit('player.pause', this.getCurrentTime());
          },

          isPlaying: function () {
            return isPlaying();
          },

          seek: async function (time) {
            // console.log("seek backtrack! ", time);
            
            if (Tone.getTransport().state !== "paused") {
              // Tone.getTransport().pause();
              // const position = Tone.Time(time, "s").toBarsBeatsSixteenths();
              // Tone.getTransport().position = position;
              this.eventEmitter.emit('player.seeked', time);
              this.eventEmitter.emit('player.timeupdate', time);
            } else{
              this.eventEmitter.emit('player.timeupdate', Tone.getTransport().seconds);
            }
          },

          isSeeking: function () {
            return false;
          },

          getCurrentTime: function () {
            return Tone.getTransport().seconds;
          },

          getDuration: function () {
            return this.externalPlayer.buffer.duration;
          }
        };

        const options = {
          // zoomview: {
          //     container: document.getElementById('zoomview-container')
          // },
          overview: {
            container: document.getElementById('overview-container'),
            waveformColor: "#FFFFFF",
            playheadColor: "#808080",
          },
          player: player,
          webAudio: {
            audioBuffer: audioBuffer,
            scale: 128,
            multiChannel: false
          },
          keyboard: true,
          showPlayheadTime: true,
          zoomLevels: [128, 256, 512, 1024, 2048, 4096]
        };

        Peaks.init(options, function (err, peaksInstance) {
          if (err || !peaksInstance) {
            console.error(err.message || "No Peaks instance created");
            setIsBacktrack(false);
            return;
          }
          // peaksInstance.views.getView('overview')?.enableSeek(false);

          peaksInstance.on('overview.click', async function (event) {
            console.log("click: ", Tone.getTransport().state);
            if (Tone.getTransport().state === "stopped") {
              Tone.getTransport().seconds = event.time;
            } else if (Tone.getTransport().state === "paused") {
              return;
            } else {
              // peaksInstance.player.seek(event.time);
              peaksInstance.views.getView('overview')?.enableSeek(false);
              const position = Tone.Time(event.time, "s").toBarsBeatsSixteenths();
              Tone.getTransport().position = position;
              await togglePlayback(true, position);
              peaksInstance.views.getView('overview')?.enableSeek(true);
            } 
          });
          peaks = peaksInstance;
        });
      }).catch((error) => {
        setIsBacktrack(false);
        console.error("Backtrack error: ", error);
      }
      );
    } else {
      if (backtrack) {
        peaks?.destroy();
        socket?.emit("conductor-backtrack", null);
        setIsBacktrack(false);
      }
    }

    return null;
  }


  return (
    <div className="App" >
      <VStack h="100vh" w="100vw" justifyContent="top" alignItems="center" spacing={4} bg="brand.900">
        <header>
          <p>
            NETRONOME (CONDUCTOR MODE)
          </p>
          <Logo className="App-logo" fill={colorMode} />
        </header>
        <ConnectionsDrawer members={members}></ConnectionsDrawer>
        <SharePopup ipAddress={ipAddress}></SharePopup>
        <Button onClick={() => joinOrchestra()} disabled={connectionState === "Connecting"} className="Join-button" bg="brand.300">
          {JoinButton[connectionState]}
          <div className="spinner-3" hidden={(connectionState !== "Connecting")}></div>
        </Button>
        <Button className="controls" bg="brand.700" onClick={async () => await togglePlayback(state === "stopped", Tone.getTransport().position)} loading={state === "paused"} hidden={connectionState !== "Connected"} >{state !== "stopped" ? "Stop" : "Play"}</Button>
        {(connectionState === "Connected") ? (<VStack>
          <VolumeSlider volume={volume} />
          <TempoSlider tempo={tempo} setTempo={setTempo} />
          <Spacer />
          {!isBacktrack ? <BacktrackButton setBacktrack={setBacktrack} socket={socket} /> : <HStack>
            <div id="overview-container"></div>
            <CloseButton variant="ghost" colorPalette="blue" onClick={() => setBacktrack(null, socket)} />
          </HStack>}
        </VStack>) : null}
        {/* <InputDropdown class="controls" inputs={audioInputs} setSelectedAudioId={setSelectedAudioId} isJoined={!isJoined} ></InputDropdown> */}
      </VStack>
    </div>
  );
}

export default App;
