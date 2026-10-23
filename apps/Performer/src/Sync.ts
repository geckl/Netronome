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
 * PerformerSync — the performer's single synchronization code path.
 *
 * Every deadline comes straight from the server in a `transport.*` envelope
 * (`{ at, lead, data }` on the server clock); there is NO offset math, no
 * +500 fudge, no convertTime, no client-side beat formulas left anywhere.
 * The conversion from server-clock deadline to AudioContext seconds lives in
 * exactly one place: `client.localAudioTime(env.at, ctx)`.
 *
 * Audio stays Tone.js on top of the shared context: the woodblock click is
 * scheduled as a raw BufferSource at `localAudioTime(env.at)` (+ the user's
 * trim slider), and the logo pulse rides Tone.Draw scheduled to the same
 * AudioContext instant.
 */

const FLASH_BACK_S = 0.1; // logo pulse: dark for this long after each beat
const PULSE_COLOR = "#61DAFB";
const FLASH_COLOR = "white";

export type PerformerSyncOptions = {
  /** Logo color updates (scheduled against the AudioContext clock). */
  onColor: (color: string) => void;
};

export class PerformerSync {
  readonly client: NetronomeClient;
  private readonly options: PerformerSyncOptions;
  private readonly unsubscribers: Array<() => void> = [];
  private disposed = false;

  /** The decoded woodblock click (native AudioBuffer for exact scheduling). */
  private woodblock: AudioBuffer | null = null;
  /** Native gain node feeding the destination; the raw BufferSources connect here. */
  private clickGain: GainNode | null = null;
  private clickVolume = 0.5;
  /** User trim (ms): audible-only offset, never used for any clock conversion. */
  private delayMs = 0;
  /** Future-scheduled click sources + their local start seconds (cancel bookkeeping). */
  private scheduledClicks: Array<{ source: AudioBufferSourceNode; at: number }> = [];
  private pendingSeekTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(client: NetronomeClient, options: PerformerSyncOptions) {
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
   * User-gesture audio setup: creates the Tone context, unlocks playback and
   * decodes the click sound. Must run inside a click handler (browser policy).
   */
  async unlockAudio(): Promise<void> {
    const toneContext = new Tone.Context({ lookAhead: 0.5 });
    Tone.setContext(toneContext, true);
    Tone.getTransport().bpm.value = 60;
    await Tone.start();
    const raw = Tone.getContext().rawContext();
    this.clickGain = raw.createGain();
    this.clickGain.gain.value = this.clickVolume;
    this.clickGain.connect(raw.destination);
    const response = await fetch(Woodblock);
    this.woodblock = await raw.decodeAudioData(await response.arrayBuffer());
  }

  setClickVolume(value: number): void {
    this.clickVolume = value;
    if (this.clickGain) this.clickGain.gain.value = value;
  }

  setDelay(valueMs: number): void {
    this.delayMs = valueMs;
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
  }

  // ─── Envelope consumers ──────────────────────────────────────────────────────

  private onStart(env: Envelope<TransportStartData>): void {
    const data = env.data;
    const transport = Tone.getTransport();
    transport.stop(); // fresh start: restarts kill any pending local scheduling
    transport.cancel();
    const ctx = Tone.getContext().rawContext();
    const dueSec = this.client.localAudioTime(env.at, ctx);
    const now = Tone.immediate();
    const tempo = data.tempo && data.tempo > 0 ? data.tempo : transport.bpm.value;
    transport.bpm.value = tempo;
    let position = data.position ?? "0:0:0";
    if (dueSec < now) {
      // Late envelope: fire immediately from a fast-forwarded position.
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
    transport.stop();
    transport.cancel();
    this.cancelScheduledClicks();
    if (this.pendingSeekTimer !== null) {
      clearTimeout(this.pendingSeekTimer);
      this.pendingSeekTimer = null;
    }
  }

  private onTempo(env: Envelope<TransportTempoData>): void {
    const ctx = Tone.getContext().rawContext();
    const dueSec = this.client.localAudioTime(env.at, ctx);
    const now = Tone.immediate();
    Tone.getTransport().bpm.setValueAtTime(env.data.bpm, Math.max(dueSec, now));
  }

  private onSeek(env: Envelope<TransportSeekData>): void {
    const ctx = Tone.getContext().rawContext();
    const dueSec = this.client.localAudioTime(env.at, ctx);
    const now = Tone.immediate();
    if (dueSec <= now + 0.002) {
      Tone.getTransport().position = env.data.position;
      return;
    }
    // Rare path (no seek UI on performers): a small timer is plenty.
    if (this.pendingSeekTimer !== null) clearTimeout(this.pendingSeekTimer);
    this.pendingSeekTimer = setTimeout(() => {
      this.pendingSeekTimer = null;
      Tone.getTransport().position = env.data.position;
    }, (dueSec - now) * 1000);
  }

  private scheduleBeat(atServerMs: number): void {
    if (!this.woodblock || !this.clickGain) return;
    const ctx = Tone.getContext().rawContext();
    const localSec = this.client.localAudioTime(atServerMs, ctx) + this.delayMs / 1000;
    const source = ctx.createBufferSource();
    source.buffer = this.woodblock;
    source.connect(this.clickGain);
    source.start(localSec);
    this.scheduledClicks.push({ source, at: localSec });
    if (this.scheduledClicks.length > 8) {
      // Drop bookkeeping for reads that already fired.
      const now = ctx.currentTime;
      this.scheduledClicks = this.scheduledClicks.filter((c) => c.at > now - 0.25);
    }
    Tone.getDraw().schedule(() => this.options.onColor(FLASH_COLOR), localSec);
    Tone.getDraw().schedule(() => this.options.onColor(PULSE_COLOR), localSec + FLASH_BACK_S);
  }

  private cancelScheduledClicks(): void {
    for (const click of this.scheduledClicks) {
      try {
        click.source.stop(0); // stop-before-start cancels the scheduled play
      } catch {
        // Already finished — nothing to do.
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
