import * as Tone from "tone";
import Woodblock from "./sounds/woodblock.wav";
import {
  NetronomeClient,
  formatPosition,
  parsePosition,
  type BeatData,
  type Envelope,
  type TransportSeekData,
  type TransportStartData,
  type TransportStopData,
  type TransportTempoData,
} from "@netronome/client";

/**
 * ConductorSync — the conductor's single synchronization code path.
 *
 * The conductor COMMANDS the transport (Play/Stop/Tempo via the client SDK's
 * sendStart/sendStop/sendTempo) but does NOT schedule anything locally from
 * those commands: the server commits the transition and broadcasts
 * `transport.*` envelopes, and this class consumes them exactly like every
 * performer does. One code path for every app — the +500 fudges, the
 * convertTime round-trips and the scheduleRepeat beat math are all gone.
 *
 * The conversion from server deadline to AudioContext time lives in exactly
 * one place: `client.localAudioTime(env.at, ctx)`.
 */

const FLASH_BACK_S = 0.1;
const PULSE_COLOR = "#61DAFB";
const FLASH_COLOR = "white";

export type ConductorSyncOptions = {
  /** Logo color updates (scheduled against the AudioContext clock). */
  onColor: (color: string) => void;
};

export class ConductorSync {
  readonly client: NetronomeClient;
  private readonly options: ConductorSyncOptions;
  private readonly unsubscribers: Array<() => void> = [];
  private disposed = false;

  private woodblock: AudioBuffer | null = null;
  /** Gain chain: click -> metronomeGain (mute) -> volumeGain (UI slider) -> destination. */
  private metronomeGain: Tone.Gain | null = null;
  private volumeGain: Tone.Gain | null = null;
  private unmutedVolume = 0.5;
  private muted = false;
  private scheduledClicks: Array<{ source: AudioBufferSourceNode; at: number }> = [];
  private pendingSeekTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(client: NetronomeClient, options: ConductorSyncOptions) {
    this.client = client;
    this.options = options;
    const on = <T,>(type: string, handler: (env: Envelope<T>) => void) => {
      this.unsubscribers.push(
        client.on(type, (env) => {
          if (!this.disposed) handler(env as Envelope<T>);
        }),
      );
    };
    on<TransportStartData>("transport.start", (env) => this.onStart(env));
    on<TransportStopData>("transport.stop", () => this.onStop());
    on<TransportTempoData>("transport.tempo", (env) => this.onTempo(env));
    on<TransportSeekData>("transport.seek", (env) => this.onSeek(env));
    on<BeatData>("beat", (env) => this.scheduleBeat(env.at));
  }

  /**
   * User-gesture audio setup (same as the performer's): new Tone context,
   * Tone.start(), gain chain and the decoded click sample.
   */
  async unlockAudio(): Promise<void> {
    const toneContext = new Tone.Context({ lookAhead: 0.5 });
    Tone.setContext(toneContext, true);
    Tone.getTransport().bpm.value = 60;
    Tone.getTransport().position = "0:0:0";
    await Tone.start();

    this.volumeGain = new Tone.Gain(this.unmutedVolume).toDestination();
    this.metronomeGain = new Tone.Gain(this.muted ? 0 : 1).connect(this.volumeGain as Tone.Gain);

    const raw = Tone.getContext().rawContext;
    const response = await fetch(Woodblock);
    this.woodblock = await raw.decodeAudioData(await response.arrayBuffer());
  }

  /** The gain the volume slider drives (legacy `volume.current.gain.value`). */
  getVolumeGain(): Tone.Gain | null {
    return this.volumeGain;
  }

  /** Metronome mode "Off" mutes clicks without touching transport playback. */
  setMuted(mute: boolean): void {
    this.muted = mute;
    if (this.metronomeGain) this.metronomeGain.gain.value = mute ? 0 : 1;
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribers.forEach((off) => off());
    this.unsubscribers.length = 0;
    this.cancelScheduledClicks();
    if (this.pendingSeekTimer !== null) {
      clearTimeout(this.pendingSeekTimer);
      this.pendingSeekTimer = null;
    }
    this.metronomeGain?.dispose();
    this.metronomeGain = null;
    this.volumeGain?.dispose();
    this.volumeGain = null;
  }

  // ─── Envelope consumers (mirror of PerformerSync — same contract) ────────────

  private onStart(env: Envelope<TransportStartData>): void {
    const data = env.data;
    const transport = Tone.getTransport();
    // Cancel everything pending, then rearm at the envelope's deadline. The
    // stop must be addressed at `Tone.immediate()` (raw ctx time): an
    // argumentless stop() is scheduled at `Transport.now()` = ctx time +
    // lookAhead (~500 ms in the future), which lands AFTER the armed start
    // (dueSec ≈ +250 ms). Tone then processes the stale "stopped" state
    // change ~250 ms later, killing the transport right after it starts.
    transport.stop(Tone.immediate());
    transport.cancel();
    const ctx = Tone.getContext().rawContext;
    const dueSec = this.client.localAudioTime(env.at, ctx);
    const now = Tone.immediate();
    const tempo = data.tempo && data.tempo > 0 ? data.tempo : transport.bpm.value;
    transport.bpm.value = tempo;
    let position = data.position ?? "0:0:0";
    if (dueSec < now) {
      const beats =
        (data.positionBeats ?? parsePosition(position) ?? 0) + (tempo * (now - dueSec)) / 60;
      position = formatPosition(beats);
      transport.start(now, position);
    } else {
      transport.start(dueSec, position);
    }
  }

  private onStop(): void {
    const transport = Tone.getTransport();
    // Address the stop at raw ctx time so it lands NOW (and cancels any still
    // armed start); see the comment in onStart about the +lookAhead trap.
    transport.stop(Tone.immediate());
    transport.cancel();
    this.cancelScheduledClicks();
    if (this.pendingSeekTimer !== null) {
      clearTimeout(this.pendingSeekTimer);
      this.pendingSeekTimer = null;
    }
  }

  private onTempo(env: Envelope<TransportTempoData>): void {
    const ctx = Tone.getContext().rawContext;
    const dueSec = this.client.localAudioTime(env.at, ctx);
    const now = Tone.immediate();
    Tone.getTransport().bpm.setValueAtTime(env.data.bpm, Math.max(dueSec, now));
  }

  private onSeek(env: Envelope<TransportSeekData>): void {
    const ctx = Tone.getContext().rawContext;
    const dueSec = this.client.localAudioTime(env.at, ctx);
    const now = Tone.immediate();
    if (dueSec <= now + 0.002) {
      Tone.getTransport().position = env.data.position;
      return;
    }
    if (this.pendingSeekTimer !== null) clearTimeout(this.pendingSeekTimer);
    this.pendingSeekTimer = setTimeout(() => {
      this.pendingSeekTimer = null;
      Tone.getTransport().position = env.data.position;
    }, (dueSec - now) * 1000);
  }

  private scheduleBeat(atServerMs: number): void {
    if (!this.woodblock || !this.metronomeGain) return;
    const ctx = Tone.getContext().rawContext;
    const localSec = this.client.localAudioTime(atServerMs, ctx);
    const source = ctx.createBufferSource();
    source.buffer = this.woodblock;
    Tone.connect(source, this.metronomeGain);
    source.start(localSec);
    this.scheduledClicks.push({ source, at: localSec });
    if (this.scheduledClicks.length > 8) {
      const now = ctx.currentTime;
      this.scheduledClicks = this.scheduledClicks.filter((c) => c.at > now - 0.25);
    }
    if (!this.muted) {
      Tone.getDraw().schedule(() => this.options.onColor(FLASH_COLOR), localSec);
      Tone.getDraw().schedule(() => this.options.onColor(PULSE_COLOR), localSec + FLASH_BACK_S);
    }
  }

  private cancelScheduledClicks(): void {
    for (const click of this.scheduledClicks) {
      try {
        click.source.stop(0);
      } catch {
        // Already finished.
      }
      try {
        click.source.disconnect();
      } catch {
        // ignore
      }
    }
    this.scheduledClicks = [];
    Tone.getDraw().cancel(0);
  }
}
