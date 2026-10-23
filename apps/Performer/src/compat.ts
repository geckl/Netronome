import { toast } from "react-toastify";
import { teardownTransport } from "./SocketIO";

export { toast };

/**
 * A failed join/resync must leave no half-armed transport around. The next
 * join recreates the Tone context fresh (unlockAudio), so stopping/canceling
 * here is enough.
 */
export const resetTransport = teardownTransport;
