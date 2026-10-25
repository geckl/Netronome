import { ReactComponent as Logo } from "./logo.svg";
import "./styles/App.css";
import { useState, useEffect, useRef, type ChangeEvent, type MouseEvent as ReactMouseEvent } from "react";
import { NetronomeClient } from "@netronome/client";
import { resetTransport, toast } from "./compat";
import { ConnectionStatus, JoinButton } from "./types";
import { initialSocketEvents, connectedSocketEvents } from "./SocketIO";
import { MicReceiver } from "./rtc/MicReceiver";
import { PerformerSync } from "./Sync";
import { ToastContainer } from "react-toastify";

function App() {
  const connectionState = useRef<ConnectionStatus>("Disconnected");
  const [isSyncing, setIsSyncing] = useState(false);
  const volume = useRef<number>(0.5);
  const delay = useRef<number>(0);
  const [delayDisplay, setDelayDisplay] = useState<number>(0);
  const [colorMode, setColorMode] = useState<string>("#61DAFB");
  // WebRTC receiver for the conductor's live mic/mix + its volume
  const receiverRef = useRef<MicReceiver | null>(null);
  const lastVolume = useRef<number>(0.5);
  // Mean measured one-way latency from the SDK's HTTP NTP loop (UI readout)
  const [latencyDisplay, setLatencyDisplay] = useState<number | null>(null);
  const lastLatency = useRef<number | null>(null);

  // The one connection object: socket (app plumbing) + clock sync + envelopes
  const clientRef = useRef<NetronomeClient | null>(null);
  const syncRef = useRef<PerformerSync | null>(null);

  useEffect(() => {
    const client = new NetronomeClient({ role: "performer" });
    clientRef.current = client;
    syncRef.current = new PerformerSync(client, { onColor: setColorMode });
    const socketInstance = client.socket;

    receiverRef.current = new MicReceiver(socketInstance, {
      isActive: () => connectionState.current === "Connected",
    });

    // App-level socket plumbing (no deadlines ride this file)
    initialSocketEvents(socketInstance, connectionState);
    connectedSocketEvents(socketInstance);

    // Latency readout: refreshed alongside the 1s HTTP NTP loop
    const statsTimer = setInterval(() => {
      const estimate = client.estimate();
      const oneway = estimate ? Math.round(estimate.oneway) : null;
      if (oneway !== lastLatency.current) {
        lastLatency.current = oneway;
        setLatencyDisplay(oneway);
      }
    }, 1000);

    return () => {
      clearInterval(statsTimer);
      receiverRef.current?.dispose();
      receiverRef.current = null;
      syncRef.current?.dispose();
      syncRef.current = null;
      client.disconnect();
      clientRef.current = null;
    };
  }, []);

  function showLatency() {
    const estimate = clientRef.current?.estimate();
    const oneway = estimate ? Math.round(estimate.oneway) : null;
    lastLatency.current = oneway;
    setLatencyDisplay(oneway);
  }

  async function resyncOrchestra() {
    console.log("Resync Orchestra!");
    const client = clientRef.current;
    if (clientRef.current && client && client.socket) {
      try {
        setIsSyncing(true);
        receiverRef.current?.primeAudio(); // user gesture — unlocks autoplay for the WebRTC stream
        await client.connect();
        await client.clock.syncOnce().catch(() => null); // fresh probe on demand
        showLatency();
        client.socket.emit("sync-orchestra", []);
        setIsSyncing(false);
      } catch (error) {
        console.error("Resync failed: ", error);
        connectionState.current = "Disconnected";
        setIsSyncing(false);
        setLatencyDisplay(null);
        resetTransport();
        toast("Failed To Connect: " + (error instanceof Error ? error.message : String(error)));
      }
    }
  }

  async function joinOrchestra() {
    console.log("Join Orchestra!");
    const client = clientRef.current;
    const sync = syncRef.current;
    if (!client) {
      console.error("Client is not connected!");
      connectionState.current = "Disconnected";
      resetTransport();
      return;
    }
    if (connectionState.current === "Connected") {
      await resyncOrchestra();
      return;
    }

    setIsSyncing(true);
    connectionState.current = "Connecting";
    receiverRef.current?.primeAudio(); // user gesture — unlocks autoplay for WebRTC

    try {
      // 1. unlock audio (user gesture) — creates the Tone context + decodes the click
      await sync!.unlockAudio();
      sync!.setClickVolume(volume.current);
      sync!.setDelay(delay.current);

      // 2. connect + HTTP NTP clock sync (replaces the old 5x calculate-latency dance)
      await client.connect();

      // 3. join roster. Server-side catch-up (if playing) arrives as a unicast
      //    transport.start envelope — no client-side math.
      client.socket.emit("request-join");
      client.socket.emit("sync-orchestra", []);

      connectionState.current = "Connected";
      setIsSyncing(false);
      showLatency();
    } catch (error) {
      console.error("Join failed: ", error);
      connectionState.current = "Disconnected";
      setIsSyncing(false);
      setLatencyDisplay(null);
      resetTransport();
      toast("Failed To Connect: " + (error instanceof Error ? error.message : String(error)));
    }
  }

  function onVolumeChange(e: ChangeEvent<HTMLInputElement>) {
    const value = parseFloat(e.target.value);
    volume.current = value;
    syncRef.current?.setClickVolume(value);
    lastVolume.current = value;
    receiverRef.current?.setVolume(value); // live mic/mix volume
  }

  function onDelayChange(e: ChangeEvent<HTMLInputElement>) {
    const value = parseInt(e.target.value);
    delay.current = value;
    setDelayDisplay(value);
    syncRef.current?.setDelay(value);
  }

  function resetValue(e: ReactMouseEvent<HTMLInputElement>) {
    e.currentTarget.value = "0";
    delay.current = 0;
    setDelayDisplay(0);
    syncRef.current?.setDelay(0);
  }

  return (
    <div className="App">
      <header className="App-header">
        <p>NETRONOME</p>
        <Logo className="App-logo" fill={colorMode} />
      </header>
      <button onClick={() => joinOrchestra()} disabled={isSyncing} className="Join-button">
        {!isSyncing && JoinButton[connectionState.current]}
        <div className="spinner-3" hidden={!isSyncing}></div>
      </button>
      {connectionState.current === "Connected" && (
        <div className="Performer-controls">
          <div className="Volume-slider">
            <label htmlFor="volume">Volume:</label>
            <input
              type="range"
              id="volume"
              min={0}
              max={1}
              step={0.01}
              defaultValue={0.5}
              onChange={onVolumeChange}
            />
          </div>
          <div className="Delay-slider">
            <label htmlFor="delay">
              Delay:{" "}
              <span
                className={
                  "Delay-value" +
                  (delayDisplay > 0 ? " positive" : delayDisplay < 0 ? " negative" : "")
                }
              >
                {delayDisplay > 0 ? "+" : ""}
                {delayDisplay}
              </span>{" "}
              ms
            </label>
            <input
              type="range"
              id="delay"
              min={-500}
              max={500}
              step={1}
              defaultValue={0}
              onChange={onDelayChange}
              onDoubleClick={resetValue}
            />
            <span className="Slider-hint">Double-click to reset</span>
          </div>
          <div className="Performer-stats">
            <span
              className="Stat-chip"
              title="Mean one-way latency measured by the HTTP NTP clock sync"
            >
              Latency ≈ {latencyDisplay === null ? "—" : `${latencyDisplay} ms`}
            </span>
          </div>
        </div>
      )}
      <ToastContainer theme="dark" />
    </div>
  );
}

export default App;
