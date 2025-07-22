import { ReactComponent as Logo } from './logo.svg';
import './styles/App.css';
import * as Tone from "tone";
import Woodblock from './sounds/woodblock.wav'
import React, { useState, useEffect, useRef } from 'react';
import io, { connect, Socket } from 'socket.io-client';
import { convertTime, playAudio, throwIfUndefined, timer } from './util';
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

var backtrack: Tone.Player | null = null;
var backtrackBufferTotal: ArrayBuffer = new ArrayBuffer();

//const backtrack = new Tone.Player().sync().start("1m").toDestination();

function App() {

  const connectionState = useRef<ConnectionStatus>("Disconnected");
  const [isLoading, setIsLoading] = useState(false);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const serverOffset = useRef<number>(0);
  const volume = useRef<Tone.Gain>(null);
  // const backtrack = useRef<Tone.Player>(null);
  const [colorMode, setColorMode] = useState<string>("#61DAFB");


  // const [currentTime, setCurrentTime] = useState(0);
  //const [timeOrigin, setTimeOrigin] = useState(window.performance.timeOrigin);

  // console.log(backtrack);


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

    // socketInstance.on("backtrack", (backtrackBlob: Blob) => {
    //   console.log("New Backing Track Selected: ", backtrackBlob);
    //   // backtrack.current = new Audio("data:audio/wav;base64," + backtrackData);
    //   const fileReader = new FileReader();
    //   fileReader.onloadend = () => {

    //     const arrayBuffer = fileReader.result as ArrayBuffer

    //     // Convert array buffer into audio buffer
    //     Tone.getContext().decodeAudioData(arrayBuffer).then((audioBuffer) => {
    //       backtrack.current = new Tone.Player(audioBuffer).sync().start("1m").toDestination();
    //     }).catch((error) => {
    //       console.error("Error decoding audio data: ", error);
    //     }
    //     );
    //   }
    //   fileReader.readAsArrayBuffer(backtrackBlob);

    //   playAudio(backtrackBlob);
    // });

    socketInstance.on("backtrack", (backtrackBuffer: ArrayBuffer) => {
      console.log("New Backing Track Data: ", backtrackBuffer);
      // console.log(typeof backtrackBuffer);

      // backtrack.current = new Audio("data:audio/wav;base64," + backtrackData);

      // function appendBuffer(buffer1: AudioBuffer, buffer2: AudioBuffer) {
      //   console.log("Appending buffers: ", buffer1.length, buffer2.length);
      //   var numberOfChannels = Math.min(buffer1.numberOfChannels, buffer2.numberOfChannels);
      //   var tmp = Tone.getContext().createBuffer(numberOfChannels, (buffer1.length + buffer2.length), buffer1.sampleRate);
      //   for (var i = 0; i < numberOfChannels; i++) {
      //     var channel = tmp.getChannelData(i);
      //     channel.set(buffer1.getChannelData(i), 0);
      //     channel.set(buffer2.getChannelData(i), buffer1.length);
      //   }
      //   return tmp;
      // }

      if (!backtrackBuffer || backtrackBuffer.byteLength === 0) {
        console.log("dispose backtrack");
        backtrack?.dispose();
      } else {
        console.log("add backtrack");
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
          if (backtrack) {
            backtrack.dispose();
          }
          backtrack = new Tone.Player(audioBuffer).sync().start("1m").toDestination();
        }).catch((error) => {
          console.error("Error decoding audio data: ", error);
        }
        );
      }
    });


    socketInstance.on("ping", (callback) => {
      callback();
    });

    socketInstance.on("calculate-latency-server-2", (targetId: string) => {
      const connection = rtcConnections.get(targetId);
      if (connection) {
        sendMessage(connection, { command: `calculate-latency-server-${socketInstance.id}` });
      }
    });

    socketInstance.on('disconnect', function () {
      socket.emit("rtc-message", { type: "bye", senderId: socketInstance.id });
      connectionState.current = "Disconnected";

    });


    socketInstance.on('audioStream', async (audioData) => {
      playAudio(audioData);
    });

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

        // pc.ondatachannel = event => dc = event.channel;

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

        // pc.ontrack = (e) => (remoteVideo.current.srcObject = e.streams[0]);
        // localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
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

        // pc.ondatachannel = event => dc = event.channel;

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
        // pc.ontrack = (e) => (remoteVideo.current.srcObject = e.streams[0]);
        // localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

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
    // localStream.getTracks().forEach((track) => track.stop());
    // localStream = null;
    // startButton.current.disabled = false;
    // hangupButton.current.disabled = true;
    // muteAudButton.current.disabled = true;
  }

  function sendMessage(rtcConnection: RTCConnection, msg) {
    const obj = {
      message: msg,
      timestamp: new Date(),
    };
    if (rtcConnection.dc.readyState === "open") {
      rtcConnection.dc.send(JSON.stringify(obj));
    } else {
      console.error("Data channel is not open. Cannot send message.");
    }
  }


  function togglePlayback(play: boolean, time: number | string = 0, position: string = "0:0:0") {
    if (play) {
      Tone.getTransport().start(time);
      setIsPlaying(true);
    } else {
      Tone.getTransport().stop();
      setIsPlaying(false);
    }
  }

  async function joinOrchestra() {
    if (connectionState.current === "Connected") {
      connectionState.current = "Disconnected";
      // hangup();
      // socket.emit("rtc-message", { type: "bye" });
      // } else if (dc.readyState !== "open") {
      //   console.log("Not connected to RTC yet, waiting for connection...");
      //   return;
    } else {
      setIsLoading(true);
      console.log("Join Orchestra!");
      connectionState.current = "Connecting"

      const audioContext = new Tone.Context();
      Tone.setContext(audioContext, true);
      Tone.getTransport().bpm.value = 60;
      volume.current = new Tone.Gain(0.5).toDestination();

      // This must be called on a button click for browser compatibility
      await Tone.start();

      function synchronize(targetId: string, rtcConnection: RTCConnection): Promise<number> {
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
            return synchronize(id, rtcConnection).then((oneWayOffset) => {
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
          // console.log("Performer latency: ", latency);
          // console.log("Server Offset: ", (latencyPlusOffset - (latency / 2)));
        });
        await timer(500);
      }
      let middleOffsets = serverOffsets.sort().slice(1, -1);
      let meanOffset = middleOffsets.reduce((a, b) => a + b) / (middleOffsets.length);
      serverOffset.current = meanOffset;
      socket.emit("join-orchestra", latencies);

      connectionState.current = "Connected";

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

  function onVolumeChange(e) {
    const value = parseFloat(e.target.value);
    if (volume.current) {
      volume.current.gain.value = value;
    }
    console.log("Volume: ", value);
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
