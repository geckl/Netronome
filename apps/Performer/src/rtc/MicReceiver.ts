import { Socket } from "socket.io-client";

/**
 * MicReceiver — answers the conductor's WebRTC offer and plays the incoming
 * live mic/mix stream. The remote track is attached to a muted, primed
 * <audio> element (iOS Safari pattern: the element is created and .play()'d
 * inside a user gesture, then un-muted only once a stream is attached).
 *
 * The receiver re-invites every 10 s while the orchestra is connected and no
 * track is flowing — this covers "conductor picks a source later", dead ICE
 * attempts, and reconnects. Invites are cheap (a single socket event) and the
 * conductor answers them (or parks them) idempotently.
 */

const configuration: RTCConfiguration = {
  // LAN-only: host candidates are enough.
  iceServers: [],
  iceCandidatePoolSize: 2,
};

const INVITE_INTERVAL_MS = 10000;

export class MicReceiver {
  private pc: RTCPeerConnection | null = null;
  private iceQueue: RTCIceCandidateInit[] = [];
  private audioEl: HTMLAudioElement | null = null;
  private volume = 0.5;
  private handlers: Array<[string, (...args: any[]) => void]> = [];
  private inviteTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private socket: Socket,
    private opts: {
      /** True while the performer is connected to the orchestra */
      isActive: () => boolean;
      /** Notified when remote audio starts (for UI state); attaching is handled internally */
      onRemoteStream?: (stream: MediaStream) => void;
    }
  ) {
    const on = (event: string, fn: (...args: any[]) => void) => {
      this.socket.on(event, fn);
      this.handlers.push([event, fn]);
    };
    on("rtc-offer", (conductorId: string, offer: RTCSessionDescriptionInit) => this.handleOffer(conductorId, offer));
    on("rtc-ice", (candidate: RTCIceCandidateInit) => this.handleIce(candidate));

    this.inviteTimer = setInterval(() => {
      if (!this.isTransportLive() && this.opts.isActive()) {
        this.socket.emit("rtc-invite");
      }
    }, INVITE_INTERVAL_MS);
  }

  dispose() {
    if (this.inviteTimer !== null) {
      clearInterval(this.inviteTimer);
      this.inviteTimer = null;
    }
    this.closePeer();
    this.handlers.forEach(([event, fn]) => this.socket.off(event, fn));
    this.handlers = [];
  }

  /** Call from a user gesture (Join/Resync) before any stream arrives — unlocks autoplay on iOS. */
  primeAudio() {
    if (!this.audioEl) {
      this.audioEl = document.createElement("audio");
      this.audioEl.autoplay = true;
      this.audioEl.muted = true;
      this.audioEl.style.display = "none";
      document.body.appendChild(this.audioEl);
    }
    this.audioEl.play().catch(() => {
      // Priming can fail silently if play() is rejected; streams re-attach later anyway.
    });
  }

  /** Local monitoring volume for the WebRTC stream. */
  setVolume(value: number) {
    this.volume = value;
    if (this.audioEl) {
      this.audioEl.volume = value;
    }
  }

  // ---- internals ----

  private isTransportLive(): boolean {
    return this.pc !== null && (this.pc.connectionState === "connected" || this.pc.connectionState === "connecting");
  }
  private async handleOffer(conductorId: string, offer: RTCSessionDescriptionInit) {
    if (typeof RTCPeerConnection === "undefined") {
      console.warn("MicReceiver: WebRTC unavailable — staying on the legacy chunk stream");
      return;
    }
    try {
      const offerStart = performance.now();
      log(`offer received from ${conductorId}`);

      this.closePeer(); // fresh session for a (re)connected conductor
      const pc = this.pc = new RTCPeerConnection(configuration);

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          this.socket.emit("rtc-ice", {
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
          });
        }
      };

      pc.ontrack = (event) => {
        const [stream] = event.streams;
        log(`audio track received — establishing took ${(performance.now() - offerStart).toFixed(0)} ms (offer start)`);
        if (stream) {
          this.onRemoteStream(stream);
        }
      };

      pc.onconnectionstatechange = () => {
        log(`connection state: ${pc.connectionState}`);
      };

      await pc.setRemoteDescription(offer);

      // Answer + flush candidates queued before the remote description existed
      for (const candidate of this.iceQueue.splice(0)) {
        try {
          await pc.addIceCandidate(candidate);
        } catch (err) {
          log("queued ICE candidate failed");
          console.warn("MicReceiver: queued ICE candidate failed", err);
        }
      }

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.socket.emit("rtc-answer", { type: "answer", sdp: pc.localDescription?.sdp });
      log(`answer sent in ${(performance.now() - offerStart).toFixed(0)} ms`);
    } catch (err) {
      console.error("MicReceiver: offer handling failed", err);
      this.closePeer();
    }
  }

  private async handleIce(candidate: RTCIceCandidateInit) {
    if (!this.pc || !this.pc.remoteDescription) {
      this.iceQueue.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (err) {
      console.warn("MicReceiver: ICE candidate failed (out of order?)", err);
    }
  }

  private attachRemoteStream(stream: MediaStream) {
    this.primeAudio();
    const el = this.audioEl;
    if (!el) {
      return;
    }
    el.srcObject = stream;
    el.muted = false;
    el.volume = this.volume;
    // Element was already .play()'ed (muted) from the Join gesture; it keeps
    // playing with the new source. A second play() is harmless and helps Safari.
    el.play().catch(() => {
      // Ignore: on some browsers play() resumes by itself when audio flows.
    });
  }

  private onRemoteStream(stream: MediaStream) {
    this.attachRemoteStream(stream);
    this.opts.onRemoteStream?.(stream);
  }

  private closePeer() {
    if (this.pc) {
      try {
        this.pc.close();
      } catch {
        // already closed
      }
      this.pc = null;
    }
    this.iceQueue = [];
  }
}

function log(message: string) {
  console.log(`MicReceiver: ${message}`);
}
