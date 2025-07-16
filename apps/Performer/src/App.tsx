import { ReactComponent as Logo } from './logo.svg';
import './styles/App.css';
import * as Tone from "tone";
import Woodblock from './sounds/woodblock.wav'
import { useState, useEffect, useRef } from 'react';
import io, { connect, Socket } from 'socket.io-client';
import React from 'react';
import { convertTime, playAudio, timer } from './util';
import { Connection, ConnectionStatus, DeviceType, JoinButton, LatencyData, Message, RTCConnectionStatus } from './types';

let pc: RTCPeerConnection | null;
let dc: RTCDataChannel;
let localStream: MediaStream | null;
// let startButton;
// let hangupButton;
// let muteAudButton;
// let remoteVideo;
// let localVideo;

const configuration = {
  iceServers: [
    {
      urls: ["stun:stun1.l.google.com:19302", "stun:stun2.l.google.com:19302"],
    },
  ],
  iceCandidatePoolSize: 10,
};

function App() {

  const connectionState = useRef<ConnectionStatus>("Disconnected");
  const rtcConnectionState = useRef<RTCConnectionStatus>("Disconnected");
  const [isLoading, setIsLoading] = useState(false);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [rtcSocketId, setRtcSocketId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const serverOffset = useRef<number>(0);
  const [colorMode, setColorMode] = useState<string>("#61DAFB");
  // const [currentTime, setCurrentTime] = useState(0);
  //const [timeOrigin, setTimeOrigin] = useState(window.performance.timeOrigin);

  console.log(pc?.connectionState);


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

    socketInstance.on("calculate-latency-server", (socketId: string) => {
      sendMessage({ command: "calculate-latency-server", value: socketId });
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

    async function makeCall() {
      // console.log("makeCall");
      try {
        pc = new RTCPeerConnection(configuration);
        dc = pc.createDataChannel("rtc-data-channel", { negotiated: true, id: 0 });
        pc.onicecandidate = (e) => {
          const message: Message = {
            type: "candidate",
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
          sendMessage({ command: "talk", value: "Hi you!" });
          rtcConnectionState.current = "Connected";
        };
        dc.onmessage = (event) => {
          console.log(event.data);
          const message = JSON.parse(event.data).message;
          if (message.command === "calculate-latency-client") {
            const source = message.value;
            socketInstance.volatile.emit("calculate-latency-client", source);
          }
        };
        dc.onclose = (event) => {
          rtcConnectionState.current = "Disconnected";
        };
        // pc.ontrack = (e) => (remoteVideo.current.srcObject = e.streams[0]);
        // localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
        const offer = await pc.createOffer();
        socketInstance.emit("rtc-message", { type: "offer", sdp: offer.sdp, socketId: socketInstance.id });
        await pc.setLocalDescription(offer);
      } catch (e) {
        console.log(e);
      }
    }

    async function handleOffer(offer) {
      // console.log("handle offer: ", offer);
      if (pc) {
        console.error("existing peerconnection");
        return;
      }
      try {
        pc = new RTCPeerConnection(configuration);
        dc = pc.createDataChannel("rtc-data-channel", { negotiated: true, id: 0 });
        pc.onicecandidate = (e) => {
          const message: Message = {
            type: "candidate",
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
          sendMessage({ command: "talk", value: "Hi you!" });
          rtcConnectionState.current = "Connected";
        };
        dc.onmessage = (event) => {
          console.log(event.data);
          const message = JSON.parse(event.data).message;
          if (message.command === "calculate-latency-client") {
            const source = message.value;
            socketInstance.volatile.emit("calculate-latency-client", source);
          }
        };
        dc.onclose = (event) => {
          rtcConnectionState.current = "Disconnected";
        };
        // pc.ontrack = (e) => (remoteVideo.current.srcObject = e.streams[0]);
        // localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

        await pc.setRemoteDescription({ type: offer.type, sdp: offer.sdp });
        const answer = await pc.createAnswer();
        socketInstance.emit("rtc-message", { type: "answer", sdp: answer.sdp, socketId: socketInstance.id });
        setRtcSocketId(offer.socketId);
        await pc.setLocalDescription(answer);
      } catch (e) {
        console.log(e);
      }
    }

    socketInstance.on("rtc-message", (e) => {
      // if (!localStream) {
      //   console.log("not ready yet");
      //   return;
      // }
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
        case "ready":
          // A second tab joined. This tab will initiate a call unless in a call already.
          if (pc) {
            console.log("already in call, ignoring");
            return;
          }
          makeCall();
          break;
        case "bye":
          if (pc) {
            hangup();
          }
          break;
        default:
          console.log("unhandled", e);
          break;
      }
    });

    socketInstance.emit("rtc-message", { type: "ready" });

    return () => {
      if (socketInstance) {
        socketInstance.disconnect();
      }
    };
  }, []);

  async function handleAnswer(answer) {
    // console.log("handle answer: ", answer);
    if (!pc) {
      console.error("no peerconnection");
      return;
    }
    try {
      await pc.setRemoteDescription({ type: answer.type, sdp: answer.sdp });
      console.log(answer.socketId);
      setRtcSocketId(answer.socketId);
    } catch (e) {
      console.log(e);
    }
  }

  async function handleCandidate(candidate) {
    // console.log("handle candidate: ", candidate);
    try {
      if (!pc) {
        console.error("no peerconnection");
        return;
      }
      if (!candidate) {
        await pc.addIceCandidate(null);
      } else {
        await pc.addIceCandidate(candidate);
      }
    } catch (e) {
      if (e instanceof TypeError === false) {
        console.log(e);
      }
    }
  }

  async function hangup() {
    // console.log("hangup");
    if (pc) {
      pc.close();
      pc = null;
    }
    // localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
    // startButton.current.disabled = false;
    // hangupButton.current.disabled = true;
    // muteAudButton.current.disabled = true;
  }

  function sendMessage(msg) {
    const obj = {
      message: msg,
      timestamp: new Date(),
    };
    if (dc) {
      dc.send(JSON.stringify(obj));
    }
  }


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
      hangup();
      socket.emit("rtc-message", { type: "bye" });
    } else if (dc.readyState !== "open") {
      console.log("Not connected to RTC yet, waiting for connection...");
      return;
    } else {
      setIsLoading(true);
      console.log("Join Orchestra!");
      connectionState.current = "Connecting"

      const audioContext = new Tone.Context();
      Tone.setContext(audioContext, true);
      Tone.getTransport().bpm.value = 60;

      // This must be called on a button click for browser compatibility
      await Tone.start();

      // async function synchronize() {
      //   for (let i = 0; i < 10; i++) {
      //     const start = Tone.immediate() * 1000;
      //     // volatile, so the packet will be discarded if the socket is not connected
      //     socket.volatile.emit("calculate-latency", start, (latencyPlusOffset: number) => {
      //       const latency = (Tone.immediate() * 1000) - start;
      //       latencies.push(latency / 2);
      //       serverOffsets.push((latencyPlusOffset - (latency / 2)));
      //       console.log("Performer latency: ", latency);
      //       console.log("Server Offset: ", (latencyPlusOffset - (latency / 2)));
      //     });
      //     await timer(500);
      //   }
      //   let middleOffsets = serverOffsets.sort().slice(1, -1);
      //   let meanOffset = middleOffsets.reduce((a, b) => a + b) / (middleOffsets.length);
      //   console.log("Mean: ", meanOffset);
      //   serverOffset.current = meanOffset;
      //   socket.emit("join-orchestra", latencies);
      // }

      function synchronize(timeout = 10000) {
        return new Promise<LatencyData>((resolve, reject) => {
          let timer;
          let serverLatency: number, clientLatency: number;

          const start = Tone.immediate() * 1000;
          sendMessage({ command: "calculate-latency-client", value: socket.id });
          console.log(rtcSocketId);
          socket.volatile.emit("calculate-latency-server", rtcSocketId);

          function responseHandler() {
            // resolve promise with the value we got
            if (serverLatency != null && clientLatency != null) {
              resolve({ serverLatency: serverLatency, clientLatency: clientLatency });
              clearTimeout(timer);
            }
          }

          socket.once("calculate-latency-client", () => {
            console.log("calculate-latency-client response received");
            const stop1 = Tone.immediate() * 1000;
            clientLatency = stop1 - start;
            console.log("Client Latency: ", clientLatency);
            responseHandler();
          });

          dc.addEventListener('message', event => {
            console.log("calculate-latency-server response received");
            const message = JSON.parse(event.data).message;
            if (message.command === "calculate-latency-server") {
              const stop2 = Tone.immediate() * 1000;
              serverLatency = stop2 - start;
              console.log("Server Latency: ", serverLatency);
              responseHandler();

            }
          }, { once: true });

          // set timeout so if a response is not received within a 
          // reasonable amount of time, the promise will reject
          timer = setTimeout(() => {
            reject(new Error("timeout waiting for msg"));
            socket.removeListener('msg', responseHandler);
          }, timeout);

        });
      }


      await synchronize().then(async ({ serverLatency, clientLatency }) => {
        let latencies: number[] = [];
        let serverOffsets: number[] = [];
        console.log("Server Latency: ", serverLatency);
        console.log("Client Latency: ", clientLatency);
        const offsetOneWay = (serverLatency - clientLatency) / 3;
        console.log("Offset One Way: ", offsetOneWay);
        for (let i = 0; i < 5; i++) {
          const start = Tone.immediate() * 1000;
          // volatile, so the packet will be discarded if the socket is not connected
          socket.volatile.emit("calculate-latency", start, (latencyPlusOffset: number) => {
            const latency = (Tone.immediate() * 1000) - start;
            latencies.push(latency / 2);
            serverOffsets.push((latencyPlusOffset + offsetOneWay - (latency / 2)));
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
      });

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

  // async function joinOrchestra() {
  //   if (connectionState.current === "Connected") {
  //     connectionState.current = "Disconnected";
  //     socket.emit("leave-orchestra");
  //   } else {
  //     setIsLoading(true);
  //     console.log("Join Orchestra!");
  //     socket.emit("request-join");
  //     connectionState.current = "Connecting"

  //     const audioContext = new Tone.Context();
  //     Tone.setContext(audioContext, true);
  //     Tone.getTransport().bpm.value = 60;

  //     // This must be called on a button click for browser compatibility
  //     await Tone.start();

  //     let latencies: number[] = [];
  //     let serverOffsets: number[] = [];

  //     async function synchronize() {
  //       for (let i = 0; i < 10; i++) {
  //         const start = Tone.immediate() * 1000;
  //         // volatile, so the packet will be discarded if the socket is not connected
  //         socket.volatile.emit("calculate-latency", start, (latencyPlusOffset: number) => {
  //           const latency = (Tone.immediate() * 1000) - start;
  //           latencies.push(latency / 2);
  //           serverOffsets.push((latencyPlusOffset - (latency / 2)));
  //           console.log("Performer latency: ", latency);
  //           console.log("Server Offset: ", (latencyPlusOffset - (latency / 2)));
  //         });
  //         await timer(500);
  //       }
  //       let middleOffsets = serverOffsets.sort().slice(1, -1);
  //       let meanOffset = middleOffsets.reduce((a, b) => a + b) / (middleOffsets.length);
  //       console.log("Mean: ", meanOffset);
  //       serverOffset.current = meanOffset;
  //       socket.emit("join-orchestra", latencies);
  //     }
  //     await synchronize();
  //     connectionState.current = "Connected";

  //     //create a synth and connect it to the main output (your speakers)
  //     var player = new Tone.Player(Woodblock).toDestination();
  //     Tone.getTransport().scheduleRepeat((time) => {
  //       player.start(time);
  //       Tone.getDraw().schedule(function () {
  //         setColorMode("white");
  //       }, time)
  //       Tone.getDraw().schedule(function () {
  //         setColorMode("#61DAFB");
  //       }, time + .1)
  //     }, "4n", 0);

  //     // Tone.getTransport().scheduleRepeat((time) => {
  //     //   const start = window.performance.now();
  //     //   //setTimeOrigin(start - window.performance.now());

  //     //   // volatile, so the packet will be discarded if the socket is not connected
  //     //   // socket.volatile.emit("calculate-latency", start, (latencyPlusOffset: number) => {
  //     //   //   const latency = Date.now() - start;
  //     //   //   setServerOffset((latencyPlusOffset - (latency / 2)) / 1000);
  //     //   //   console.log("Performer latency: ", latency);
  //     //   //   console.log("Server Offset: ", (latencyPlusOffset - (latency / 2)) / 1000);
  //     //   //   console.log("Variable Time Origin: ", start - window.performance.now());
  //     //   // });
  //     // }, "1m", 0);

  //     setIsLoading(false);
  //   };
  // }

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
