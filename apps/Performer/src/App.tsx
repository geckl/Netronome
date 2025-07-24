import { ReactComponent as Logo } from './logo.svg';
import './styles/App.css';
import * as Tone from "tone";
import Woodblock from './sounds/woodblock.wav'
import React, { useState, useEffect, useRef } from 'react';
import io, { connect, Socket } from 'socket.io-client';
import { convertTime, playAudio, sendMessage, throwIfUndefined, timer } from './util';
import { Connection, ConnectionStatus, DeviceType, JoinButton, LatencyData, Message, RTCConnection, RTCConnectionStatus } from './types';

const rtcConnections = new Map<string, RTCConnection>();
const configuration = {
  // iceServers: [
  //   {
  //     urls: ["stun:stun1.l.google.com:19302", "stun:stun2.l.google.com:19302"],
  //   },
  // ],
  iceCandidatePoolSize: 10,
};

var backtrackBufferTotal: ArrayBuffer = new ArrayBuffer();

function App() {

  const connectionState = useRef<ConnectionStatus>("Disconnected");
  const [isSyncing, setIsSyncing] = useState(false);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const serverOffset = useRef<number>(0);
  const volume = useRef<Tone.Gain>(null);
  const backtrack = useRef<Tone.Player>(null);
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
      socketInstance.emit("rtc-invite", { senderId: socketInstance.id });
    });


    socketInstance.on("starttime", (data => {
      console.log("Backend Start Time: " + data);
    }
    ));

    socketInstance.on("ping", (callback) => {
      callback();
    });

    socketInstance.on("calculate-latency-server-2", (targetId: string) => {
      const connection = rtcConnections.get(targetId);
      if (connection) {
        sendMessage(connection, { command: `calculate-latency-server-${socketInstance.id}` });
      }
    });

    socketInstance.on('reconnect', function () {
      console.log('you have been reconnected');
      connectionState.current = "Connected";
      setSocket(socketInstance);
    });

    socketInstance.on('disconnect', function () {
      socketInstance.emit("rtc-message", { type: "bye", senderId: socketInstance.id });
      connectionState.current = "Disconnected";
      setSocket(null);
    });

    // socketInstance.on('audioStream', async (audioData) => {
    //   playAudio(audioData);
    // });

    async function makeCall(invitation) {
      console.log("makeCall");
      try {
        let pc = new RTCPeerConnection(configuration);
        let dc = pc.createDataChannel("rtc-data-channel", { negotiated: true, id: 0 });
        let connection = { pc, dc };
        rtcConnections.set(invitation.senderId, connection);

        pc.onicecandidate = (e) => {
          throwIfUndefined(socketInstance.id);
          const message: Message = {
            type: "candidate",
            targetId: invitation.senderId,
            senderId: socketInstance.id,
            candidate: null,
          };
          if (e.candidate) {
            message.candidate = e.candidate.candidate;
            message.sdpMid = e.candidate.sdpMid;
            message.sdpMLineIndex = e.candidate.sdpMLineIndex;
          }
          socketInstance.emit("rtc-message", message);
        };

        dc.onopen = (event) => {
          console.log("Data Channel Open!");
          sendMessage(connection, { command: "talk", value: "Hi you!" });
        };

        dc.onmessage = (event) => {
          const message = JSON.parse(event.data).message;
          if (message.command === "calculate-latency-client-1") {
            console.log(event.data);
            const senderId = message.senderId;
            socketInstance.volatile.emit("calculate-latency-client-2", senderId);
          }
        };

        dc.onclose = (event) => {
          console.log("Data Channel Closed!!");
        };

        const offer = await pc.createOffer();
        socketInstance.emit("rtc-message", { type: "offer", sdp: offer.sdp, targetId: invitation.senderId, senderId: socketInstance.id });
        await pc.setLocalDescription(offer);
      } catch (e) {
        console.log(e);
      }
    }

    async function handleOffer(offer) {
      console.log("handle offer: ", offer);
      try {
        let pc = new RTCPeerConnection(configuration);
        let dc = pc.createDataChannel("rtc-data-channel", { negotiated: true, id: 0 });
        let connection = { pc, dc };
        rtcConnections.set(offer.senderId, connection);

        pc.onicecandidate = (e) => {
          throwIfUndefined(socketInstance.id);
          const message: Message = {
            type: "candidate",
            targetId: offer.senderId,
            senderId: socketInstance.id,
            candidate: null
          };
          if (e.candidate) {
            message.candidate = e.candidate.candidate;
            message.sdpMid = e.candidate.sdpMid;
            message.sdpMLineIndex = e.candidate.sdpMLineIndex;
          }
          socketInstance.emit("rtc-message", message);
        };

        dc.onopen = (event) => {
          console.log("Data Channel Open!");
          sendMessage(connection, { command: "talk", value: "Hi you!" });
        };

        dc.onmessage = (event) => {
          const message = JSON.parse(event.data).message;
          if (message.command === "calculate-latency-client-1") {
            console.log(event.data);
            const senderId = message.senderId;
            socketInstance.volatile.emit("calculate-latency-client-2", senderId);
          }
        };

        dc.onclose = (event) => {
          console.log("Data Channel Closed!!");
        };

        await pc.setRemoteDescription({ type: offer.type, sdp: offer.sdp });
        const answer = await pc.createAnswer();
        socketInstance.emit("rtc-message", { type: "answer", sdp: answer.sdp, targetId: offer.senderId, senderId: socketInstance.id });
        // setRtcSocketId(offer.callerId);
        await pc.setLocalDescription(answer);
      } catch (e) {
        console.log(e);
      }
    }

    socketInstance.on("rtc-message", (e) => {
      console.log("rtc-message: ", e);
      switch (e.type) {
        case "offer":
          handleOffer(e);
          break;
        case "answer":
          handleAnswer(e);
          break;
        case "candidate":
          handleCandidate(e);
          break;
        case "bye":
          hangup(e);
          break;
        default:
          console.log("unhandled", e);
          break;
      }
    });

    socketInstance.on("rtc-invite", (e) => {
      console.log("rtc-invite: ", e);
      makeCall(e);
    });

    return () => {
      if (socketInstance) {
        socketInstance.disconnect();
        setSocket(null);
      }
    };
  }, []);

  async function handleAnswer(answer) {
    console.log("handle answer: ", answer);
    let rtcConnection = rtcConnections.get(answer.senderId);
    try {
      if (rtcConnection) {
        await rtcConnection.pc.setRemoteDescription({ type: answer.type, sdp: answer.sdp });
        // console.log(answer.senderId);
      }
    } catch (e) {
      console.log(e);
    }
  }

  async function handleCandidate(candidate) {
    console.log("handle candidate: ", candidate);
    let rtcConnection = rtcConnections.get(candidate.senderId);
    try {
      if (!rtcConnection) {
        console.error("no peerconnection");
        return;
      }
      if (!candidate) {
        await rtcConnection.pc.addIceCandidate(null);
      } else {
        await rtcConnection.pc.addIceCandidate(candidate);
      }
    } catch (e) {
      if (e instanceof TypeError === false) {
        console.log(e);
      }
    }
  }

  async function hangup(disinvitation) {
    console.log("hangup: ", disinvitation);
    let rtcConnection = rtcConnections.get(disinvitation.senderId);
    // console.log("hangup");
    if (rtcConnection) {
      rtcConnection.pc.close();
      rtcConnections.delete(disinvitation.senderId);
    }
  }


  function togglePlayback(play: boolean, time: number = 0, position: string | undefined = undefined) {
    console.log("Toggle Playback: ", play, time, position);
    Tone.getTransport().pause();
    if (play) {
      Tone.getTransport().start(time > Tone.now() ? time : Tone.now(), position);
      setIsPlaying(true);
    } else {
      setIsPlaying(false);
    }
  }

  async function synchronize() {
    function onewaySync(targetId: string, rtcConnection: RTCConnection): Promise<number> {
      let timeout = 10000;
      return new Promise<number>((resolve, reject) => {
        let timer;
        let serverLatency: number, clientLatency: number;

        const start = Tone.immediate() * 1000;
        sendMessage(rtcConnection, { command: "calculate-latency-client-1", senderId: socket.id });
        socket.emit("calculate-latency-server-1", targetId);

        function responseHandler() {
          // resolve promise with the value we got
          if (serverLatency != null && clientLatency != null) {
            const oneWayOffset: number = (serverLatency - clientLatency) / 6;
            resolve(oneWayOffset);
            clearTimeout(timer);
          }
        }

        socket.on(`calculate-latency-client-${targetId}`, () => {
          console.log("calculate-latency-client response received");
          const stop1 = Tone.immediate() * 1000;
          clientLatency = stop1 - start;
          responseHandler();
        });

        rtcConnection.dc.addEventListener('message', event => {
          const message = JSON.parse(event.data).message;
          if (message.command === `calculate-latency-server-${targetId}`) {
            console.log("calculate-latency-server response received");
            const senderId = message.sender;
            const stop2 = Tone.immediate() * 1000;
            serverLatency = stop2 - start;
            responseHandler();

          }
        }, { once: false });

        // set timeout so if a response is not received within a 
        // reasonable amount of time, the promise will reject
        timer = setTimeout(() => {
          reject(new Error("timeout waiting for msg"));
          socket.removeListener('msg', responseHandler);
        }, timeout);

      });
    }

    const oneWayOffsets: number[] = [];

    await Promise.all(
      Array.from(rtcConnections.entries()).filter((c) => c[1].dc.readyState === "open").map(
        async ([id, rtcConnection]) => {
          return onewaySync(id, rtcConnection).then((oneWayOffset) => {
            oneWayOffsets.push(oneWayOffset);
          }).catch((error) => {
            console.error("Synchronization error: ", error);
          });
        }
      )
    )

    const offsetOneWay = oneWayOffsets.length === 0 ? 0 : oneWayOffsets.reduce((a, b) => a + b) / oneWayOffsets.length;
    console.log("One Way Offset: ", offsetOneWay);

    let latencies: number[] = [];
    let serverOffsets: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = Tone.immediate() * 1000;
      // volatile, so the packet will be discarded if the socket is not connected
      socket.volatile.emit("calculate-latency", start, (latencyPlusOffset: number) => {
        const latency = (Tone.immediate() * 1000) - start;
        console.log("Latency: ", latency);
        latencies.push(latency / 2);
        serverOffsets.push((latencyPlusOffset - offsetOneWay - (latency / 2)));
      });
      await timer(500);
    }
    let middleOffsets = serverOffsets.sort().slice(1, -1);
    let meanOffset = middleOffsets.reduce((a, b) => a + b) / (middleOffsets.length);
    serverOffset.current = meanOffset;
    return latencies;
  }

  async function resyncOrchestra() {
    setIsSyncing(true);
    const latencies = await synchronize();
    socket.emit("sync-orchestra", latencies);
    setIsSyncing(false);
    connectionState.current = "Connected";
  }

  async function joinOrchestra() {
    if (connectionState.current === "Connected") {
      resyncOrchestra();
      // connectionState.current = "Disconnected";
      // togglePlayback(false);
      // Tone.getContext().dispose();
      // if (backtrack.current) {
      //   backtrack.current.dispose();
      //   backtrack.current = null;
      // }
      // if (volume.current) {
      //   volume.current.dispose();
      //   volume.current = null;
      // }
      // setColorMode("#61DAFB");
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

      socket.on('start', (targetTime: number, position: string = "0:0:0") => {
        console.log(`start: ${targetTime} at position ${position}`);
        if (connectionState.current === "Connected") {
          const time = convertTime("Client", targetTime, serverOffset);
          togglePlayback(true, time, position);
        }
      });

      socket.on('stop', (data) => {
        console.log(`stop`);
        setIsPlaying(false);
        togglePlayback(false);
      });

      socket.on('change-tempo', (targetTime: number, position: string = "0:0:0", newTempo: number) => {
        if (connectionState.current === "Connected") {
          console.log("change-tempo");
          let time2 = convertTime("Client", targetTime, serverOffset);
          Tone.getTransport().bpm.setValueAtTime(newTempo, time2);
        }
      });

      socket.on("backtrack", (backtrackBuffer: ArrayBuffer | null) => {
        if (backtrack.current) {
          backtrack.current.stop();
          backtrack.current.dispose();
          backtrack.current = null;
        }
        if (backtrackBuffer === null) {
          console.log("Remove Backtrack");
          backtrackBufferTotal = new ArrayBuffer();
          return;
        } else {
          console.log("New Backtrack: ", backtrackBuffer);
          var appendBuffer = function (buffer1: ArrayBuffer, buffer2: ArrayBuffer) {
            var tmp = new Uint8Array(buffer1.byteLength + buffer2.byteLength);
            tmp.set(new Uint8Array(buffer1), 0);
            tmp.set(new Uint8Array(buffer2), buffer1.byteLength);
            return tmp.buffer;
          };

          const newBuffer = appendBuffer(backtrackBufferTotal, backtrackBuffer);
          backtrackBufferTotal = newBuffer;

          // Convert array buffer into audio buffer
          Tone.getContext().decodeAudioData(newBuffer.slice(0)).then((audioBuffer) => {
            backtrack.current?.stop();
            backtrack.current = new Tone.Player(audioBuffer, () => {
              console.log("Backtrack loaded!");
              // if (Tone.getTransport().state === "started") {
              //   backtrack.current.start(Tone.now(), Tone.Time(Tone.getTransport().position).toSeconds()).toDestination();
              // };
            }
            ).sync().start(0).toDestination();

          }).catch((error) => {
            console.error("Error decoding audio data: ", error);
          }
          );
        }
      });

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

      const latencies = await synchronize();
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
    console.log("Volume: ", value);
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
