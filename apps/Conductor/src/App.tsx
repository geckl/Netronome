import logo from './logo.svg';
import './App.css';
import * as Tone from "tone";
import Woodblock from './sounds/woodblock.wav'
import { useState, useEffect } from 'react';
import io, { Socket } from 'socket.io-client';
import InputDropdown from './components/Inputs';
import React from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Connection, JoinButton, Performer } from './types';
import { Button, Spacer} from "@chakra-ui/react"
import Demo from "./components/Connections/ConnectionsDrawer"
import ConnectionsDrawer from './components/Connections/ConnectionsDrawer';



// Record monotonic clock's initial value
//const baseTime = window.performance.timeOrigin;
//console.log(baseTime);
//console.log(Tone.getContext().now());
let timeDiff = 0;


function App() {

  const [connectionState, setConnectionState] = useState<Connection>("Disconnected");
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isPlaying, setIsPlaying] = useState(false)
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]); //MediaDeviceInfo
  const [selectedAudioId, setSelectedAudioId] = useState(null);
  const [timeOrigin, setTimeOrigin] = useState(window.performance.timeOrigin);
  const [ipAddress, setIpAddress] = useState("");
  const [members, setMembers] = useState<Performer>([]);

  // useEffect(() => {
  //   console.log("static time origin: ", window.performance.timeOrigin, " variable time origin: ", timeOrigin);
  // }, [timeOrigin]);

  useEffect(() => {
    console.log("static time origin: ", window.performance.timeOrigin, " variable time origin: ", timeOrigin);
  }, [ipAddress]);

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

    // socketInstance.on('start', (data) => {
    //   console.log(`start`);
    //   togglePlayback(true);
    // });

    socketInstance.on("server-ip", (ipAddress: string) => {
      console.log("Server IP Address: ", ipAddress);
      setIpAddress(`http://${ipAddress}:3000`);
    })

    socketInstance.on("starttime", (data: Date) => {
      console.log("Backend Start Time: ");
      console.log(new Date(data));
    }
    );

    socketInstance.on("update-members", (members: Performer) => {
      setMembers(members);
      console.log(members);
    })

    // socketInstance.on('audioStream', (audioData) => {
    //   var newData = audioData.split(";");
    //   newData[0] = "data:audio/ogg;";
    //   newData = newData[0] + newData[1];

    //   var audio = new Audio(newData);
    //   if (!audio || document.hidden) {
    //     return;
    //   }
    //   audio.play();
    // });

    // socketInstance.on('ping', function(ms) {
    //   console.log(ms)
    //   //const latency = ms;
    //   //console.log(latency);
    // });

    getDevices();

    // client-side
    setInterval(() => {
      const start = Date.now();
      setTimeOrigin(start - window.performance.now());

      // volatile, so the packet will be discarded if the socket is not connected
      socketInstance.volatile.emit("ping", start, () => {
        const latency = Date.now() - start;
        console.log("Conductor latency: ", latency);
      });
    }, 5000);

    return () => {
      if (socketInstance) {
        socketInstance.disconnect();
      }
    };
  }, []);

  useEffect(() => {
    if (selectedAudioId && socket) {
      console.log("New Audio Source Selected: " + selectedAudioId);
      navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: {
            exact: selectedAudioId,
          },
        },
        video: false
      })
        .then((stream) => {
          var madiaRecorder = new MediaRecorder(stream);
          var audioChunks: Blob[] = [];

          madiaRecorder.addEventListener("dataavailable", function (event) {
            audioChunks.push(event.data);
          });

          madiaRecorder.addEventListener("stop", function () {
            var audioBlob = new Blob(audioChunks);
            audioChunks = [];
            var fileReader = new FileReader();
            fileReader.readAsDataURL(audioBlob);
            fileReader.onloadend = function () {
              var base64String = fileReader.result;
              socket.volatile.emit("audioStream", base64String);
            };

            madiaRecorder.start();
            setTimeout(function () {
              madiaRecorder.stop();
            }, 1000);
          });

          madiaRecorder.start();
          setTimeout(function () {
            madiaRecorder.stop();
          }, 1000);
        })
        .catch((error) => {
          console.error('Error capturing audio.', error);
        });
    }

    return;
  }, [selectedAudioId]);

  async function joinOrchestra() {
    if (connectionState === "Connected") {
      setConnectionState("Disconnected");
    } else {
      console.log("Join Orchestra!");
      setConnectionState("Connecting")

      const audioContext = new Tone.Context();
      //baseTime = Date.now();
      timeDiff = window.performance.now();
      Tone.setContext(audioContext, true);

      // This must be called on a button click for mobile compatibility
      await Tone.start();

      //create a synth and connect it to the main output (your speakers)
      var player = new Tone.Player(Woodblock).toDestination();
      Tone.getTransport().scheduleRepeat((time) => {
        player.start(time);
      }, "4n", 0);

      setConnectionState("Connected");
    }
  }

  function togglePlayback(play: boolean, position: string = "0:0:0") {
    if (socket) {
      if (play) {
        const targetTime = Date.now();
        socket.emit('conductor-start', targetTime, position, (newTargetTime: number) => {
          let time = getAbsoluteTime(newTargetTime);
          console.log("Timeline Time: ", time);
          console.log("Target Time: ", newTargetTime);
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


  function getDevices() {
    const inputs: MediaDeviceInfo[] = [];
    if (!navigator.mediaDevices?.enumerateDevices) {
      console.log("enumerateDevices() not supported.");
    } else {
      // List cameras and microphones.
      navigator.mediaDevices
        .enumerateDevices()
        .then((devices) => {
          devices.forEach((device) => {
            //console.log(`${device.kind}: ${device.label} id = ${device.deviceId}`);
            if (device.kind == "audioinput") {
              inputs.push(device);
            }
          });
          setAudioInputs(inputs);
        })
        .catch((err) => {
          console.error(`${err.name}: ${err.message}`);
        });
    }
  }

  function getAbsoluteTime(targetTime: number) {
    return (targetTime - timeOrigin - timeDiff) / 1000;
  }

  return (
    <div className="App">
      <header className="App-header">
        <img src={logo} className="App-logo" alt="logo" />
        <p>
          NETRONOME (CONDUCTOR MODE)
        </p>
        <Button onClick={() => joinOrchestra()} disabled={connectionState === "Connecting"} className="Join-button" bg="brand.300">
          {JoinButton[connectionState]}
          <div className="spinner-3" hidden={(connectionState !== "Connecting")}></div>
        </Button>
        <Button class="controls" onClick={() => togglePlayback(!isPlaying)} hidden={connectionState !== "Connected"} >{isPlaying ? "Stop" : "Play"}</Button>
        {/* <InputDropdown class="controls" inputs={audioInputs} setSelectedAudioId={setSelectedAudioId} isJoined={!isJoined} ></InputDropdown> */}
        <p>Connect to Netronome here:</p>
        <QRCodeSVG value={ipAddress} ></QRCodeSVG>
        <Spacer />
        <ConnectionsDrawer members={members}></ConnectionsDrawer>
      </header>
    </div>
  );
}

export default App;
