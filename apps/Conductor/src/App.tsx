import { ReactComponent as Logo } from "./logo.svg";
import "./styles/App.css";
import * as Tone from "tone";
import { useState, useEffect, useRef } from "react";
import { NetronomeClient } from "@netronome/client";
// import InputDropdown from './components/Inputs';
import React from "react";
import { ConnectionStatus, JoinButton, NetronomePlaybackState, Performer } from "./types";
import { Button, CloseButton, HStack, Spacer, VStack, Tabs } from "@chakra-ui/react";
import ConnectionsDrawer from "./components/Connections/ConnectionsDrawer";
import { TempoSlider } from "./components/Tempo/TempoSlider";
import { getDevices, resetTransport } from "./util";
import { BacktrackButton } from "./components/Backtrack/BacktrackButton";
import { VolumeSlider } from "./components/Volume/VolumeSlider";
import SharePopup from "./components/Connections/SharePopup";
import { initialSocketEvents } from "./SocketIO";
import Peaks, { PeaksInstance } from "peaks.js";
import { Toaster, toaster } from "./components/ui/toaster";
import { TbMetronome } from "react-icons/tb";
import { GiSoundWaves } from "react-icons/gi";
import { FaMicrophone } from "react-icons/fa";
import InputDropdown from "./components/Inputs/Inputs";
import { MicAudioEngine } from "./audio/MicAudioEngine";
import Mixer from "./components/Mixer/Mixer";
import { MicStreamBroadcaster } from "./rtc/MicStreamBroadcaster";
import { ConductorSync } from "./ConductorSync";
import type { Socket } from "socket.io-client";

var peaks: PeaksInstance | undefined = undefined;
var updatePlayhead: number | undefined = undefined;
var backtrack: Tone.Player | null = null;

function App() {
  const [connectionState, setConnectionState] = useState<ConnectionStatus>("Disconnected");
  const [socket, setSocket] = useState<Socket | null>(null);
  const [ipAddress, setIpAddress] = useState("");
  const [members, setMembers] = useState<Performer[]>([]);
  const [isBacktrack, setIsBacktrack] = useState(false);
  const [colorMode, setColorMode] = useState<string>("#61DAFB");
  const volume = useRef<Tone.Gain | null>(null);
  const [tempoValue, setTempoValue] = useState<number>(60);
  const [state, setState] = useState<NetronomePlaybackState>("stopped");
  const [metronomeMode, setMetronomeMode] = useState<string | null>("Static");
  const stateRef = useRef<NetronomePlaybackState>("stopped");

  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [selectedAudioId, setSelectedAudioId] = useState<string | null>(null);

  // Mic mixer engine: ref so sockets/callbacks can reach it inside effects,
  // state so the Mixer UI re-renders when the engine is created/destroyed.
  const mixerRef = useRef<MicAudioEngine | null>(null);
  const [mixer, setMixer] = useState<MicAudioEngine | null>(null);
  const setMixerEngine = (engine: MicAudioEngine | null) => {
    mixerRef.current = engine;
    setMixer(engine);
  };
  // WebRTC broadcaster: lives at mount level so invites can arrive anytime.
  const broadcasterRef = useRef<MicStreamBroadcaster | null>(null);

  // The one connection object: SDK client (socket + clock + envelopes) + sync
  const clientRef = useRef<NetronomeClient | null>(null);
  const syncRef = useRef<ConductorSync | null>(null);
  // Latest committed tempo state (controlled slider mirror).
  const setTempoState = (t: number) => {
    tempoValueRef.current = t;
    setTempoValue(t);
  };
  const setPlaybackState = (s: NetronomePlaybackState) => {
    stateRef.current = s;
    setState(s);
  };

  useEffect(() => {
    const client = new NetronomeClient({
      role: "conductor",
      transports: ["websocket"],
      upgrade: false,
    });
    clientRef.current = client;
    syncRef.current = new ConductorSync(client, { onColor: setColorMode });
    const socketInstance = client.socket;
    setSocket(socketInstance);

    broadcasterRef.current = new MicStreamBroadcaster(socketInstance, () => {
      return mixerRef.current?.getBroadcastStream() ?? null;
    });

    // Add socketIO listeners needed for connection
    initialSocketEvents(socketInstance, setIpAddress, setMembers, (members) =>
      broadcasterRef.current?.onMembersUpdate(members),
    );

    return () => {
      broadcasterRef.current?.dispose();
      broadcasterRef.current = null;
      mixerRef.current?.dispose();
      mixerRef.current = null;
      syncRef.current?.dispose();
      syncRef.current = null;
      client.disconnect();
      clientRef.current = null;
      setSocket(null);
    };
  }, []);

  useEffect(() => {
    if (selectedAudioId && socket) {
      let cancelled = false;
      (async () => {
        try {
          let engine = mixerRef.current;
          if (!engine) {
            engine = new MicAudioEngine();
            setMixerEngine(engine);
          }
          // WebRTC integration: publish/remove the broadcast track on graph changes,
          // and target legacy 1-second chunks only at performers without a flowing channel.
          engine.onStreamChanged = (media) => broadcasterRef.current?.onStreamChanged(media);
          engine.setLegacySink((data) => {
            socket.volatile.emit("audioStream", data, broadcasterRef.current?.legacyTargets());
          });
          await engine.setSource(selectedAudioId);
          if (cancelled) {
            return;
          }
          engine.startStreaming(socket);
        } catch (error) {
          console.error("Mic mixer error:", error);
          mixerRef.current?.teardown();
          toaster.create({
            title: "Error",
            description: "Could not open audio source: " + ((error as Error)?.message ?? error),
          });
        }
      })();
      return () => {
        cancelled = true;
      };
    } else {
      // Source deselected (or no socket): stop streaming and dispose the mixer.
      if (mixerRef.current) {
        mixerRef.current.dispose();
        setMixerEngine(null);
      }
    }
  }, [selectedAudioId]);

  useEffect(() => {
    syncRef.current?.setMuted(metronomeMode === "Off");
  }, [metronomeMode]);

  async function joinOrchestra() {
    const client = clientRef.current;
    const sync = syncRef.current;
    if (!client) {
      console.error("Socket is not connected!");
      setConnectionState("Disconnected");
      return;
    }
    if (connectionState === "Connected") {
      setConnectionState("Disconnected");
      resetTransport();
      setPlaybackState("stopped");
      if (mixerRef.current) {
        mixerRef.current.dispose();
        setMixerEngine(null);
      }
      setSelectedAudioId(null);
      return;
    }

    console.log("Join Orchestra!");
    setConnectionState("Connecting");

    try {
      // 1. unlock audio (user gesture) and hand the volume gain to the slider
      await sync!.unlockAudio();
      volume.current = sync!.getVolumeGain();

      Tone.getTransport().on("start", () => setPlaybackState("started"));
      Tone.getTransport().on("stop", () => setPlaybackState("stopped"));
      Tone.getTransport().on("pause", () => setPlaybackState("paused"));

      // 2. connect + HTTP NTP clock sync (replaces the 5x handshake dance)
      await client.connect();

      // 3. paint the engine truth (tempo baseline + running state)
      const engineState = await client.fetchTransportState();
      setTempoState(engineState.tempo);
      if (engineState.playing) setPlaybackState("paused");

      // 4. claim the podium. server-update gives the initial UI state; if the
      //    orchestra is mid-play, the server unicasts a transport.start
      //    catch-up envelope — ConductorSync schedules it like any performer.
      // eslint-disable-next-line
      client.socket.on("server-update", (tempo: number, _isPlaying: boolean) => {
        setTempoState(tempo);
      });

      // eslint-disable-next-line
      client.socket.on("server-backtrack", (arrayBuffer: ArrayBuffer) => {
        setBacktrack(arrayBuffer, client.socket);
      });

      client.socket.emit("conductor-sync-orchestra", [], (success: boolean) => {
        if (success) {
          console.log("Conductor synced to orchestra!");
          setConnectionState("Connected");
        } else {
          console.error("A conductor is already connected!");
          setConnectionState("Disconnected");
          toaster.create({
            title: "Error",
            description: "A conductor is already connected!",
          });
        }
      });

      getDevices(setAudioInputs);
    } catch (error) {
      console.error("Join failed: ", error);
      setConnectionState("Disconnected");
      resetTransport();
      toaster.create({
        title: "Error",
        description: "Failed to connect: " + ((error as Error)?.message ?? error),
      });
    }
  }

  /**
   * Transport commands now go out through the SDK; the server commits the
   * change and the broadcast envelope drives EVERYONE's local schedules —
   * including this conductor's. No local start-time math anymore.
   */
  async function togglePlayback(
    play: boolean,
    position: string | undefined = undefined,
  ): Promise<boolean> {
    const client = clientRef.current;
    if (!client) return false;
    if (play) {
      setPlaybackState("paused"); // occupied until the envelope arms the transport
      client.sendStart(position && typeof position === "string" ? position : undefined);
    } else {
      client.sendStop();
    }
    return false;
  }

  function setTempo(newTempo: number) {
    setTempoState(newTempo);
    clientRef.current?.sendTempo(newTempo);
  }

  function isPlaying() {
    return Tone.getTransport().state === "started" || Tone.getTransport().state === "paused";
  }

  function setBacktrack(arrayBuffer: ArrayBuffer | null, socket: Socket | null) {
    if (arrayBuffer) {
      setIsBacktrack(true);
      // Convert array buffer into audio buffer
      Tone.getContext()
        .decodeAudioData(arrayBuffer)
        .then((audioBuffer) => {
          backtrack = new Tone.Player(audioBuffer).sync().start(0).toDestination();

          const player = {
            externalPlayer: backtrack,
            eventEmitter: null,

            init: function (eventEmitter) {
              console.log("new backtrack!");
              this.eventEmitter = eventEmitter;
              Tone.getTransport().position = "0:0:0";
              updatePlayhead = Tone.getTransport().scheduleRepeat(() => {
                const time = this.getCurrentTime();
                eventEmitter.emit("player.timeupdate", time);
                if (time >= this.getDuration()) {
                  togglePlayback(false);
                }
              }, 0.5);
              return Promise.resolve();
            },

            destroy: function () {
              console.log("remove backtrack!");
              backtrack?.dispose();
              if (updatePlayhead) {
                Tone.getTransport().clear(updatePlayhead);
              }
              backtrack = null;
              this.externalPlayer = null;
              this.eventEmitter = null;
            },

            setSource: function (opts) {
              if (this.isPlaying()) {
                this.pause();
              }
              // Update the Tone.js Player object with the new AudioBuffer
              this.externalPlayer.buffer.set(opts.webAudio.audioBuffer);
              return Promise.resolve();
            },

            play: async function () {
              this.eventEmitter.emit("player.playing", this.getCurrentTime());
              return Promise.resolve();
            },

            pause: function () {
              this.eventEmitter.emit("player.pause", this.getCurrentTime());
            },

            isPlaying: function () {
              return isPlaying();
            },

            seek: async function (time) {
              if (Tone.getTransport().state !== "paused") {
                this.eventEmitter.emit("player.seeked", time);
                this.eventEmitter.emit("player.timeupdate", time);
              } else {
                this.eventEmitter.emit("player.timeupdate", Tone.getTransport().seconds);
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
            },
          };

          const options = {
            overview: {
              container: document.getElementById("overview-container"),
              waveformColor: "#FFFFFF",
              playheadColor: "#808080",
            },
            player: player,
            webAudio: {
              audioBuffer: audioBuffer,
              scale: 128,
              multiChannel: false,
            },
            keyboard: true,
            showPlayheadTime: true,
            zoomLevels: [128, 256, 512, 1024, 2048, 4096],
          };

          Peaks.init(options, function (err, peaksInstance) {
            if (err || !peaksInstance) {
              console.error(err.message || "No Peaks instance created");
              setIsBacktrack(false);
              return;
            }
            peaksInstance.on("overview.click", async function (event) {
              if (Tone.getTransport().state === "stopped") {
                Tone.getTransport().seconds = event.time;
              } else if (Tone.getTransport().state === "paused") {
                return;
              } else {
                peaksInstance.views.getView("overview")?.enableSeek(false);
                const position = Tone.Time(event.time, "s").toBarsBeatsSixteenths();
                Tone.getTransport().position = position;
                await togglePlayback(true, position);
                peaksInstance.views.getView("overview")?.enableSeek(true);
              }
            });
            peaks = peaksInstance;
          });
        })
        .catch((error) => {
          setIsBacktrack(false);
          console.error("Backtrack error: ", error);
        });
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
    <div className="App">
      <VStack minH="100vh" w="100%" justifyContent="top" alignItems="center" spacing={4} bg="brand.900">
        <header className="App-header">
          <Logo className="App-logo" fill={colorMode} />
          <p>NETRONOME (CONDUCTOR MODE)</p>
          <nav className="App-nav">
            <SharePopup ipAddress={ipAddress} />
            <ConnectionsDrawer members={members} />
          </nav>
        </header>
        <Button
          onClick={() => joinOrchestra()}
          disabled={connectionState === "Connecting"}
          className="Join-button"
          colorPalette="cyan"
        >
          {JoinButton[connectionState]}
          <div className="spinner-3" hidden={connectionState !== "Connecting"}></div>
        </Button>
        <Button
          className="Play-button"
          colorPalette="cyan"
          onClick={async () =>
          await togglePlayback(
            state === "stopped",
            Tone.getTransport().position as unknown as string,
          )
        }
          loading={state === "paused"}
          hidden={connectionState !== "Connected"}
        >
          {state !== "stopped" ? "Stop" : "Play"}
        </Button>
        {connectionState === "Connected" ? (
          <VStack w={"75%"}>
            <VolumeSlider volume={volume} />
            <Spacer />
            <Tabs.Root colorPalette={"cyan"} defaultValue={"metronome"} w={"100%"} size="md" justify={"center"}>
              <Tabs.List>
                <Tabs.Trigger value="metronome" gap={2}>
                  <TbMetronome size={22} />
                  Metronome
                </Tabs.Trigger>
                <Tabs.Trigger value="track" gap={2}>
                  <GiSoundWaves size={22} />
                  Track
                </Tabs.Trigger>
                <Tabs.Trigger value="microphone" gap={2}>
                  <FaMicrophone size={22} />
                  Mic
                </Tabs.Trigger>
              </Tabs.List>
              <Tabs.Content value="metronome">
                <VStack>
                  <TempoSlider
                    tempo={tempoValue}
                    setTempo={setTempo}
                    metronomeMode={metronomeMode}
                    setMetronomeMode={setMetronomeMode}
                  />
                </VStack>
              </Tabs.Content>
              <Tabs.Content value="track">
                <VStack>
                  {!isBacktrack ? (
                    <BacktrackButton setBacktrack={setBacktrack} socket={socket} />
                  ) : (
                    <HStack>
                      <div id="overview-container"></div>
                      <CloseButton
                        variant="ghost"
                        colorPalette="blue"
                        onClick={() => setBacktrack(null, socket)}
                      />
                    </HStack>
                  )}
                </VStack>
              </Tabs.Content>
              <Tabs.Content value="microphone">
                <VStack>
                  <InputDropdown inputs={audioInputs} setSelectedAudioId={setSelectedAudioId}></InputDropdown>
                  <Mixer engine={mixer}></Mixer>
                </VStack>
              </Tabs.Content>
            </Tabs.Root>

            <Spacer />
          </VStack>
        ) : null}
        <Toaster />
      </VStack>
    </div>
  );
}

export default App;
