import { Performer } from "./types.js";

/**
 * Cross-connection app state the engine does NOT own: the claimed conductor
 * and the current backtrack buffer. Phase 5 retired everything else — the
 * roster lives in ConnectionRegistry, latencies in SyncService, and the
 * transport truth (tempo/playing/position) in the TransportEngine.
 */
class Orchestra {
    public conductor: Performer | null = null;
    public backtrack: ArrayBuffer | null = null;
}

export default Orchestra;
