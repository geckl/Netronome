import * as Tone from "tone";

/**
 * util — Conductor helpers that are not synchronization.
 *
 * The legacy `convertTime` / `synchronize` (and their +500 fudges) are gone:
 * all deadlines now flow through the @netronome/client SDK.
 */

/** Returns a Promise that resolves after "ms" Milliseconds. */
// eslint-disable-next-line
export const timer = (ms: any) => new Promise((res) => setTimeout(res, ms));

export async function getDevices(setAudioInputs: (inputs: MediaDeviceInfo[]) => void) {
  const inputs: MediaDeviceInfo[] = [];
  // Audio inputs are an optional feature: a permission denial must never fail
  // the join flow. On denial we still enumerate (the browser returns masked,
  // unnamed entries) so the Inputs tab stays usable.
  try {
    // Prime device labels by requesting access before enumerating.
    await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (error) {
    console.warn(
      "Audio input access unavailable; device labels may be masked.",
      (error as Error)?.message ?? error,
    );
  }
  if (!navigator.mediaDevices?.enumerateDevices) {
    console.log("enumerateDevices() not supported.");
  } else {
    // List cameras and microphones.
    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        devices.forEach((device) => {
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

export function resetTransport() {
  Tone.getTransport().stop();
  Tone.getTransport().cancel();
}
