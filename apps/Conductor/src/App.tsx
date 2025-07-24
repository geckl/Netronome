import logo from './logo.svg';
import './styles/App.css';
import * as Tone from "tone";
import Woodblock from './sounds/woodblock.wav'
import { useState, useEffect, useRef } from 'react';
import io, { Socket } from 'socket.io-client';
import InputDropdown from './components/Inputs';
import React from 'react';
import { Connection, ConnectionStatus, JoinButton, Performer } from './types';
import { Button, CloseButton, HStack, Spacer, VStack } from "@chakra-ui/react"
import ConnectionsDrawer from './components/Connections/ConnectionsDrawer';
import { TempoSlider } from './components/Tempo/TempoSlider';
import { convertTime, timer } from './util';
import { BacktrackButton } from './components/Backtrack/BacktrackButton';
import { VolumeSlider } from './components/Volume/VolumeSlider';
import Peaks from 'peaks.js';
import ConnectPopup from './components/Connections/ConnectPopup';

// var backtrack: Tone.Player | null = null;

function App() {

  const [connectionState, setConnectionState] = useState<ConnectionStatus>("Disconnected");
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isPlaying, setIsPlaying] = useState(false)
  const [ipAddress, setIpAddress] = useState("");
  const [members, setMembers] = useState<Performer[]>([]);
  const serverOffset = useRef<number>(0);
  const backtrack = useRef<Tone.Player>(null);
  const [isBacktrack, setIsBacktrack] = useState(false);
  const volume = useRef<Tone.Gain>(null);
  const tempo = useRef<number>(60);
  const peaks = useRef(null);
  const updatePlayhead = useRef(null);
  //const [tempo, setTempo] = useState<number>(60);
  // const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]); //MediaDeviceInfo
  // const [selectedAudioId, setSelectedAudioId] = useState(null);
  // const [timeOrigin, setTimeOrigin] = useState(window.performance.timeOrigin);

  // useEffect(() => {
  //   console.log("static time origin: ", window.performance.timeOrigin, " variable time origin: ", timeOrigin);
  // }, [timeOrigin]);

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

    socketInstance.on("update-members", (members: Performer[]) => {
      console.log("update members!");
      setMembers(members);
    });

    socketInstance.on("status-update", (cb: (ip: boolean, t: number, p: number) => void) => {
      console.log("status update!");
      const targetTime = convertTime("Server", Tone.now(), serverOffset);
      const position: number = Tone.getTransport().getSecondsAtTime(Tone.now());
      cb(Tone.getTransport().state === "started", targetTime, position);
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
      Tone.getTransport().position = "0:0:0";

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

        socket.on("server-change-tempo", (tempo: number) => {
          console.log("Server Tempo: ", tempo);
          setTempo(tempo);
        });

        socket.on("server-backtrack", (arrayBuffer: ArrayBuffer) => {
          setBacktrack(arrayBuffer);
          console.log("Server Backtrack: ", arrayBuffer);
        });

        socket.emit("conductor-sync-orchestra", latencies);
      }
      await synchronize();

      //create a synth and connect it to the main output (your speakers)
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
    // if(position == undefined) {
    //   position = Tone.getTransport().position;
    // }
    if (socket) {
      if (play) {
        const targetTime = convertTime("Server", Tone.now(), serverOffset);
        socket.emit('conductor-start', targetTime, position, (newTargetTime: number) => {
          // console.log(targetTime, "->", newTargetTime - serverOffset.current);
          const time2 = convertTime("Client", newTargetTime, serverOffset);
          Tone.getTransport().start(time2, position);
          setIsPlaying(true)
        });
      } else {
        socket.emit('conductor-stop');
        setIsPlaying(false);
      }
    }
  }

  function setTempo(tempo) {
    console.log("Change Tempo!");
    if (socket) {
      const targetTime = convertTime("Server", Tone.immediate(), serverOffset)
      console.log("Target Time: ", targetTime);
      const position = "0:0:0";
      socket.emit("conductor-change-tempo", targetTime, position, tempo, (newTargetTime: number) => {
        console.log("New Target Time: ", newTargetTime);
        let time2 = convertTime("Client", newTargetTime, serverOffset);
        Tone.getTransport().bpm.setValueAtTime(tempo, time2);
      });
    }
  }

  function readBacktrackFile(audioFile: File | null) {
    if (socket) {
      if (audioFile === null) {
        socket.emit("conductor-backtrack", null);
        console.log("Backtrack cleared");
      } else {
        const stream = audioFile.stream()
        const reader = stream.getReader();
        const readChunk = () => {
          reader.read().then(({ done, value }) => {
            if (done) {
              console.log("Stream finished");
              return;
            }
            socket.emit("conductor-backtrack", value);
            // Continue reading the next chunk
            readChunk();
          });
        };
        // Start reading the stream
        readChunk();
      }
    }
  }

  function setBacktrack(arrayBuffer: ArrayBuffer | null) {

    if (arrayBuffer) {
      setIsBacktrack(true);
      // Convert array buffer into audio buffer
      Tone.getContext().decodeAudioData(arrayBuffer).then((audioBuffer) => {
        backtrack.current = new Tone.Player(audioBuffer).sync().start(0).toDestination();

        const player = {
          externalPlayer: backtrack.current,
          eventEmitter: null,

          init: function (eventEmitter) {
            console.log("init backtrack!");
            this.eventEmitter = eventEmitter;

            // this.externalPlayer.sync();
            // this.externalPlayer.start();

            Tone.getTransport().position = "0:0:0";

            updatePlayhead.current = Tone.getTransport().scheduleRepeat(() => {
              const time = this.getCurrentTime();
              eventEmitter.emit('player.timeupdate', time);

              if (time >= this.getDuration()) {
                Tone.getTransport().stop();
              }
            }, 0.25);

            return Promise.resolve();
          },

          destroy: function () {
            console.log("destroy backtrack!");
            // Tone.getContext().dispose();
            backtrack.current.dispose();
            Tone.getTransport().clear(updatePlayhead.current);
            // if (peaks.current) {
            //   peaks.current.destroy();
            // }

            backtrack.current = null;

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
            togglePlayback(true)
            this.eventEmitter.emit('player.playing', this.getCurrentTime());
            return Promise.resolve();
          },

          pause: function () {
            console.log("pause backtrack!");
            // Tone.getTransport().pause();

            this.eventEmitter.emit('player.pause', this.getCurrentTime());
          },

          isPlaying: function () {
            return Tone.getTransport().state === "started";
          },

          seek: async function (time) {
            console.log("seek backtrack! ");
            const position = Tone.Time(time, "s").toBarsBeatsSixteenths();
            if (Tone.getTransport().state === "started") {
              togglePlayback(true, position);
            } else {
              Tone.getTransport().position = position;
            }

            this.eventEmitter.emit('player.seeked', this.getCurrentTime());
            this.eventEmitter.emit('player.timeupdate', this.getCurrentTime());
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
            container: document.getElementById('overview-container')
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
          if (err) {
            console.error(err.message);
            return;
          }
          peaks.current = peaksInstance;
        });
      }).catch((error) => {
        setIsBacktrack(false);
        console.error("Backtrack error: ", error);
      }
      );
    } else {
      if (backtrack.current) {
        peaks.current.destroy();
        socket.emit("conductor-backtrack", null);
        setIsBacktrack(false);
      }
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
        <ConnectPopup ipAddress={ipAddress}></ConnectPopup>
        <Button onClick={() => joinOrchestra()} disabled={connectionState === "Connecting"} className="Join-button" bg="brand.300">
          {JoinButton[connectionState]}
          <div className="spinner-3" hidden={(connectionState !== "Connecting")}></div>
        </Button>
        <Button className="controls" bg="brand.700" onClick={async () => togglePlayback(!isPlaying, Tone.getTransport().position)} hidden={connectionState !== "Connected"} >{isPlaying ? "Stop" : "Play"}</Button>
        {(connectionState === "Connected") ? (<VStack>
          <VolumeSlider volume={volume} />
          <TempoSlider tempo={tempo} setTempo={setTempo} />
          <Spacer />
          {!isBacktrack ? <BacktrackButton setBacktrack={setBacktrack} readBacktrackFile={readBacktrackFile} /> : <HStack>
            <div id="overview-container"></div>
            <CloseButton variant="ghost" colorPalette="blue" onClick={() => setBacktrack(null)} />
          </HStack>}
        </VStack>) : null}
        {/* <InputDropdown class="controls" inputs={audioInputs} setSelectedAudioId={setSelectedAudioId} isJoined={!isJoined} ></InputDropdown> */}
      </VStack>
      {/* <footer>
      </footer> */}
    </div>
  );
}

export default App;
