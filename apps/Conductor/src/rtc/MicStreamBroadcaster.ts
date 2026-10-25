import type { Socket } from "@netronome/client";
import { Performer } from "../types";

/**
 * MicStreamBroadcaster — maintains one RTCPeerConnection per performer and
 * sends the mixer's post-fader broadcast track over WebRTC. Audio flows
 * device-to-device directly; the Socket.IO server only relays signaling.
 *
 * Invites arrive from performers ("rtc-invite"); if no stream is open yet the
 * invite is parked and answered as soon as the mixer publishes a track
 * (onStreamChanged). Track swaps on device change use replaceTrack so no
 * renegotiation is needed.
 *
 * Signaling verbs (relayed by the backend):
 *   conductor -> performer : rtc-offer (targetId, offer), rtc-ice (targetId, candidate)
 *   performer -> conductor : rtc-answer (performerId, answer), rtc-ice (performerId, candidate)
 */

const configuration: RTCConfiguration = {
  // Netronome runs on a LAN — host candidates are enough, no STUN/TURN.
  iceServers: [],
  iceCandidatePoolSize: 2,
};

interface PeerSession {
  pc: RTCPeerConnection;
  /** ICE candidates that arrived before the remote description was applied */
  iceQueue: RTCIceCandidateInit[];
}

export class MicStreamBroadcaster {
  private peers = new Map<string, PeerSession>();
  /** Peer IDs whose audio track is flowing (used to trim legacy chunk targets) */
  private flowing = new Set<string>();
  /** Invites parked until a track is available */
  private parkedInvites = new Set<string>();
  /** Latest roster from update-members; null = never received one (legacy-wide fallback) */
  private roster: string[] | null = null;

  private handlers: Array<[string, (...args: any[]) => void]> = [];

  constructor(
    private socket: Socket,
    private getMedia: () => MediaStream | null
  ) {
    const on = (event: string, fn: (...args: any[]) => void) => {
      this.socket.on(event, fn);
      this.handlers.push([event, fn]);
    };
    on("rtc-invite", (performerId: string) => this.handleInvite(performerId));
    on("rtc-answer", (performerId: string, answer: { sdp?: string }) => this.handleAnswer(performerId, answer));
    on("rtc-ice", (performerId: string, candidate: RTCIceCandidateInit) => this.handleIce(performerId, candidate));
  }

  dispose() {
    [...this.peers.keys()].forEach((id) => this.closePeer(id));
    this.handlers.forEach(([event, fn]) => this.socket.off(event, fn));
    this.handlers = [];
    this.flowing.clear();
    this.parkedInvites.clear();
    this.roster = null;
  }

  // ---- Events ----

  handleInvite(performerId: string) {
    if (typeof RTCPeerConnection === "undefined") {
      console.warn("MicStreamBroadcaster: WebRTC unavailable — performer keeps the legacy chunk stream");
      return;
    }
    // Re-invites (retries, reconnects) always yield a fresh session for that peer.
    this.closePeer(performerId);

    const media = this.getMedia();
    if (!media || media.getAudioTracks().length === 0) {
      this.parkedInvites.add(performerId);
      return;
    }
    this.establishPeer(performerId, media);
  }

  /** Mixer graph (re)built or torn down — publish the current audio track to all senders. */
  onStreamChanged(media: MediaStream | null) {
    const track = media?.getAudioTracks()[0] ?? null;
    if (track) {
      trySetContentHint(track);
    }

    // Hot-swap the track on all existing sessions without renegotiation
    this.peers.forEach((session) => {
      const sender = session.pc.getSenders().find((s) => s.track?.kind === "audio") ?? session.pc.getSenders()[0];
      if (sender && typeof sender.replaceTrack === "function") {
        sender.replaceTrack(track).catch((err) => console.warn("MicStreamBroadcaster: replaceTrack failed", err));
      }
    });

    // Answer parked invites now that a track exists
    if (track && this.parkedInvites.size > 0 && media) {
      const waiting = [...this.parkedInvites];
      this.parkedInvites.clear();
      waiting.forEach((id) => this.establishPeer(id, media));
    }
  }

  /** Called whenever the conductor receives a roster update (performers join/leave). */
  onMembersUpdate(members: Performer[]) {
    this.roster = members.map((member) => member.id);
    const ids = new Set(this.roster);
    [...this.peers.keys()].forEach((id) => {
      if (!ids.has(id)) {
        this.closePeer(id);
      }
    });
  }

  /**
   * Performer IDs that should keep receiving the legacy 1-second chunk stream
   * (everyone whose WebRTC channel is not established yet).
   * Returns undefined when no roster is known yet — the server then falls back
   * to relaying chunks to everyone (previous behaviour).
   */
  legacyTargets(): string[] | undefined {
    if (this.roster === null) {
      return undefined;
    }
    return this.roster.filter((id) => !this.flowing.has(id));
  }

  async handleAnswer(performerId: string, answer: { sdp?: string }) {
    const session = this.peers.get(performerId);
    if (!session || !answer.sdp) {
      console.warn("MicStreamBroadcaster: answer from unknown peer or missing sdp", performerId);
      return;
    }
    try {
      await session.pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    } catch (err) {
      console.error("MicStreamBroadcaster: failed to apply answer", err);
      return;
    }
    // Flush ICE candidates that arrived before the remote description
    const queue = session.iceQueue.splice(0);
    for (const candidate of queue) {
      try {
        await session.pc.addIceCandidate(candidate);
      } catch (err) {
        console.warn("MicStreamBroadcaster: queued ICE candidate failed", err);
      }
    }
  }

  async handleIce(performerId: string, candidate: RTCIceCandidateInit) {
    const session = this.peers.get(performerId);
    if (!session) {
      return;
    }
    if (!session.pc.remoteDescription) {
      session.iceQueue.push(candidate);
      return;
    }
    try {
      await session.pc.addIceCandidate(candidate);
    } catch (err) {
      console.warn("MicStreamBroadcaster: ICE candidate failed (out of order?)", err);
    }
  }

  // ---- internals ----

  private establishPeer(performerId: string, media: MediaStream) {
    const track = media.getAudioTracks()[0];
    if (!track) {
      this.parkedInvites.add(performerId);
      return;
    }
    const pc = new RTCPeerConnection(configuration);
    const session: PeerSession = { pc, iceQueue: [] };
    this.peers.set(performerId, session);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit("rtc-ice", performerId, {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
        });
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      console.log(`MicStreamBroadcaster: peer ${performerId} → ${state}`);
      if (state === "connected") {
        this.flowing.add(performerId);
      } else {
        this.flowing.delete(performerId);
      }
      if (state === "failed" || state === "closed") {
        this.closePeer(performerId);
        // The performer's retry loop will invite again; legacy chunks cover them meanwhile.
      }
    };

    try {
      pc.addTrack(track, media);
      pc.createOffer()
        .then(async (offer) => {
          await pc.setLocalDescription(offer);
          this.socket.emit("rtc-offer", performerId, {
            type: "offer",
            sdp: pc.localDescription?.sdp,
            createdAt: performance.now(),
          });
        })
        .catch((err: unknown) => {
          console.error("MicStreamBroadcaster: offer creation failed", err);
          this.closePeer(performerId);
        });
    } catch (err) {
      console.error("MicStreamBroadcaster: failed to start streaming session", err);
      this.closePeer(performerId);
    }
  }

  private closePeer(performerId: string) {
    const session = this.peers.get(performerId);
    if (!session) {
      return;
    }
    this.peers.delete(performerId);
    this.flowing.delete(performerId);
    try {
      session.pc.close();
    } catch {
      // already closed
    }
  }
}

/** contentHint is a Chromium nicety; guard it for Safari. */
function trySetContentHint(track: MediaStreamTrack) {
  try {
    (track as MediaStreamTrack & { contentHint?: string }).contentHint = "music";
  } catch {
    // not supported — fine
  }
}
