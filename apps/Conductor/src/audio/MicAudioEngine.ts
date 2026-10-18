/**
 * MicAudioEngine — self-contained Web Audio graph for the Conductor's
 * microphone mixer. It is deliberately independent of the Tone.js context
 * (nodes cannot be shared across AudioContexts).
 *
 * Graph:
 *
 *   MediaStreamAudioSourceNode
 *     └─ ChannelSplitterNode(n) ─┬─ [strip 1: Gain → StereoPanner → Analyser] ─┐
 *                                ├─ [strip 2: ...]                             ├─ sum bus
 *                                └─ [strip n: ...]                             ┘ → master Gain
 *                                                                                 ├─ MasterAnalyser → MediaStreamAudioDestinationNode (broadcast)
 *                                                                                 └─ Monitor Gain → speakers
 *
 * - Strip meters are post-fader/post-pan, pre-master.
 * - The master meter is post-master.
 * - The broadcast stream (post-master) feeds the MediaRecorder loop, so
 *   faders/pan/mute/master all shape what performers hear.
 */

import { Socket } from "socket.io-client";

export interface ChannelState {
  /** Fader value, 0..1 */
  gain: number;
  /** Pan position, -1 (left) .. 1 (right) */
  pan: number;
  muted: boolean;
}

export interface MixerState {
  /** Human readable label of the opened input device */
  deviceLabel: string;
  /** Number of input channels currently in the mixer (0 = no source open) */
  channelCount: number;
  channels: ChannelState[];
  /** Master fader, 0..1 */
  master: number;
  /** Local monitor (speaker/headphone) level, 0..1 */
  monitor: number;
  streaming: boolean;
}

/** Safety cap; USB interfaces usually report at most 8 usable channels over WebAudio */
export const MAX_CHANNELS = 8;

const emptyState: MixerState = {
  deviceLabel: "",
  channelCount: 0,
  channels: [],
  master: 1,
  monitor: 0,
  streaming: false,
};

type Listener = () => void;

interface Strip {
  gain: GainNode;
  panner: StereoPannerNode;
  analyser: AnalyserNode;
}

export class MicAudioEngine {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private splitter: ChannelSplitterNode | null = null;
  private strips: Strip[] = [];
  private bus: GainNode | null = null;
  private masterNode: GainNode | null = null;
  private masterAnalyser: AnalyserNode | null = null;
  private monitorNode: GainNode | null = null;
  private broadcastDest: MediaStreamAudioDestinationNode | null = null;

  // Broadcast loop state (MediaRecorder rolling chunks over Socket.IO)
  private socket: Socket | null = null;
  private recorder: MediaRecorder | null = null;
  private recorderTimeout: ReturnType<typeof setTimeout> | null = null;
  private recorderActive = false;

  private listeners = new Set<Listener>();
  private snapshot: MixerState = { ...emptyState, channels: [] };

  /** Invoked whenever the graph is rebuilt or torn down with the current broadcast stream (or null) */
  onStreamChanged: ((media: MediaStream | null) => void) | null = null;
  /** Optional override for how legacy 1-second chunks are shipped (per-peer targeting for WebRTC mixing) */
  private legacySink: ((data: string) => void) | null = null;

  /** Replace how broadcast chunks leave the engine; default is a plain volatile emit to all performers */
  setLegacySink(sink: (data: string) => void) {
    this.legacySink = sink;
  }

  // ---- useSyncExternalStore-compatible store ----

  getState = (): MixerState => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit() {
    this.listeners.forEach((listener) => listener());
  }

  private update(partial: Partial<MixerState>) {
    this.snapshot = { ...this.snapshot, ...partial };
    this.emit();
  }

  // ---- Graph lifecycle ----

  /** Open a device, rebuild the mixer graph for its real channel count and start fresh. */
  async setSource(deviceId: string): Promise<void> {
    this.teardown();

    if (!this.ctx) {
      this.ctx = new AudioContext();
    }
    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }

    // Raw capture: disable the browser's voice DSP chain — essential for music.
    // channelCount "ideal" lets the browser hand us as many channels as it can.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: deviceId },
        channelCount: { ideal: MAX_CHANNELS },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });

    this.buildGraph(stream);
  }

  private buildGraph(stream: MediaStream) {
    const ctx = this.ctx!;
    this.stream = stream;

    const track = stream.getAudioTracks()[0];
    const settings = track.getSettings();

    const source = ctx.createMediaStreamSource(stream);
    // Chrome reports the track's real channel count in getSettings() — that is
    // the number of channels actually captured (1 for the MacBook's built-in
    // mic, even though the OS device is a stereo beam pair and the source node
    // therefore reports 2). Some Chromium builds omit it from getSettings();
    // in that case fall back to the source node, with a warn so the mismatch
    // is diagnosable from the console.
    const settingsCount = settings.channelCount;
    const fallbackCount = source.channelCount;
    const reportedCount =
      typeof settingsCount === "number" && settingsCount > 0
        ? settingsCount
        : fallbackCount;
    const count = Math.max(1, Math.min(MAX_CHANNELS, Number.isFinite(reportedCount) ? reportedCount : 1));
    if (typeof settingsCount !== "number") {
      console.warn("MicAudioEngine: settings.channelCount missing — falling back to source node count", {
        settings,
        sourceChannelCount: fallbackCount,
        resultingCount: count,
      });
    }

    const splitter = ctx.createChannelSplitter(count);
    const bus = ctx.createGain();

    const strips: Strip[] = [];
    for (let i = 0; i < count; i++) {
      const gain = ctx.createGain();
      const panner = ctx.createStereoPanner();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;

      splitter.connect(gain, i);
      gain.connect(panner);
      panner.connect(analyser);
      // AnalyserNode passes audio through unchanged, so this sums into the bus.
      analyser.connect(bus);

      strips.push({ gain, panner, analyser });
    }

    const master = ctx.createGain();
    const masterAnalyser = ctx.createAnalyser();
    masterAnalyser.fftSize = 1024;
    const monitor = ctx.createGain();
    const broadcastDest = ctx.createMediaStreamDestination();

    bus.connect(master);
    master.connect(monitor);
    monitor.connect(ctx.destination);
    master.connect(masterAnalyser);
    masterAnalyser.connect(broadcastDest);

    this.source = source;
    this.splitter = splitter;
    this.strips = strips;
    this.bus = bus;
    this.masterNode = master;
    this.masterAnalyser = masterAnalyser;
    this.monitorNode = monitor;
    this.broadcastDest = broadcastDest;
    source.connect(splitter);

    // Defaults: unity faders, centered pans — except for stereo sources, where
    // hard L/R keeps the original stereo image (we split channels, so without
    // panning L+R would sum into a mono-ish center).
    const channels: ChannelState[] = strips.map((_, i) => ({
      gain: 1,
      pan: count === 2 ? (i === 0 ? -1 : 1) : 0,
      muted: false,
    }));
    channels.forEach((channel, i) => this.applyStrip(i, channel));

    // Preserve user-set master/monitor levels across device switches
    // (snapshot defaults are master 1, monitor 0 on first use).
    monitor.gain.value = this.snapshot.monitor;
    master.gain.value = this.snapshot.master;

    this.update({
      deviceLabel: track.label,
      channelCount: count,
      channels,
    });

    this.onStreamChanged?.(broadcastDest.stream);
  }

  /** Stop the broadcast loop, tear the graph down and stop the device stream. */
  teardown() {
    this.stopStreaming();

    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;    this.source?.disconnect();
    this.splitter?.disconnect();
    this.strips.forEach((strip) => {
      strip.gain.disconnect();
      strip.panner.disconnect();
      strip.analyser.disconnect();
    });
    this.bus?.disconnect();
    this.masterNode?.disconnect();
    this.masterAnalyser?.disconnect();
    this.broadcastDest?.disconnect();
    this.monitorNode?.disconnect();
    this.source = null;
    this.splitter = null;
    this.strips = [];
    this.bus = null;
    this.masterNode = null;
    this.masterAnalyser = null;
    this.broadcastDest = null;
    this.monitorNode = null;

    this.onStreamChanged?.(null);

    this.update({
      deviceLabel: "",
      channelCount: 0,
      channels: [],
      streaming: false,
    });
  }

  /** Full disposal: tear down and also close the AudioContext. */
  dispose() {
    this.teardown();
    this.ctx?.close();
    this.ctx = null;
  }

  // ---- Broadcast (rolling MediaRecorder chunks, identical protocol to before) ----

  /** Start streaming the post-fader master mix to all performers. */
  startStreaming(socket: Socket) {
    this.stopStreaming();
    this.socket = socket;
    this.recorderActive = true;
    this.cycleRecorder();
    this.update({ streaming: true });
  }

  /** Stop broadcasting (mixer stays usable for monitoring/meters). */
  stopStreaming() {
    this.recorderActive = false;
    if (this.recorderTimeout !== null) {
      clearTimeout(this.recorderTimeout);
      this.recorderTimeout = null;
    }
    if (this.recorder && this.recorder.state !== "inactive") {
      try {
        this.recorder.stop();
      } catch {
        // already stopped
      }
    }
    this.recorder = null;
    this.socket = null;
    this.update({ streaming: false });
  }

  private cycleRecorder = () => {
    if (!this.recorderActive || !this.broadcastDest || !this.socket) {
      return;
    }
    const recorder = new MediaRecorder(this.broadcastDest.stream);
    const chunks: Blob[] = [];
    this.recorder = recorder;

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    });

    recorder.addEventListener("stop", () => {
      const blob = new Blob(chunks);
      chunks.length = 0;
      const reader = new FileReader();
      reader.readAsDataURL(blob);
      reader.onloadend = () => {
        if (this.recorderActive && this.socket) {
          const data = reader.result as string;
          if (this.legacySink) {
            this.legacySink(data);
          } else {
            this.socket.volatile.emit("audioStream", data);
          }
        }
      };
      if (this.recorderActive) {
        this.cycleRecorder();
      }
    });

    recorder.start();
    this.recorderTimeout = setTimeout(() => {
      if (recorder.state !== "inactive") {
        recorder.stop();
      }
    }, 1000);
  };

  getBroadcastStream(): MediaStream | null {
    return this.broadcastDest ? this.broadcastDest.stream : null;
  }

  // ---- Meter taps ----

  getChannelAnalyser(index: number): AnalyserNode | null {
    return this.strips[index]?.analyser ?? null;
  }

  getMasterAnalyser(): AnalyserNode | null {
    return this.masterAnalyser;
  }

  // ---- Controls ----

  setChannelGain(index: number, value: number) {
    this.mutateChannel(index, (channel) => ({ ...channel, gain: clamp(value) }));
  }

  setChannelPan(index: number, value: number) {
    this.mutateChannel(index, (channel) => ({ ...channel, pan: clampPan(value) }));
  }

  toggleChannelMute(index: number) {
    this.mutateChannel(index, (channel) => ({ ...channel, muted: !channel.muted }));
  }

  setMaster(value: number) {
    value = clamp(value);
    if (this.masterNode) {
      ramp(this.masterNode.gain, value, this.ctx);
    }
    this.update({ master: value });
  }

  setMonitor(value: number) {
    value = clamp(value);
    if (this.monitorNode) {
      ramp(this.monitorNode.gain, value, this.ctx);
    }
    this.update({ monitor: value });
  }

  // ---- internals ----

  private mutateChannel(index: number, mutate: (channel: ChannelState) => ChannelState) {
    const channels = [...this.snapshot.channels];
    if (!channels[index]) {
      return;
    }
    const channel = mutate(channels[index]);
    channels[index] = channel;
    this.applyStrip(index, channel);
    this.update({ channels });
  }

  private applyStrip(index: number, channel: ChannelState) {
    const strip = this.strips[index];
    if (!strip || !this.ctx) {
      return;
    }
    ramp(strip.gain.gain, channel.muted ? 0 : channel.gain, this.ctx);
    strip.panner.pan.setTargetAtTime(channel.pan, this.ctx.currentTime, 0.01);
  }
}

function ramp(param: AudioParam, value: number, ctx: AudioContext | null) {
  if (ctx) {
    param.setTargetAtTime(value, ctx.currentTime, 0.01);
  } else {
    param.value = value;
  }
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampPan(value: number): number {
  return Math.max(-1, Math.min(1, value));
}
