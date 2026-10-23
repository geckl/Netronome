import * as Tone from "tone";

/**
 * util — Performer helpers that are not synchronization.
 *
 * The legacy `convertTime` / `synchronize` / `cyclicalSync` / `togglePlayback`
 * (and their +500 fudges) are gone: all deadlines now come from `transport.*`
 * envelopes through the @netronome/client SDK (`client.localAudioTime`).
 */

/** Returns a Promise that resolves after "ms" Milliseconds. */
// eslint-disable-next-line
export const timer = (ms: any) => new Promise((res) => setTimeout(res, ms));

/**
 * Play one chunk of the conductor's live mic/mix relay (ogg blob slices).
 * App-level plumbing — has no deadline semantics;
 * the beat itself is scheduled from `beat` envelopes.
 */
// eslint-disable-next-line
export const playAudio = (audioData: any) => {
  console.log("Play audio!");
  var newData = audioData.split(";");
  newData[0] = "data:audio/ogg;";
  newData = newData[0] + newData[1];

  var micAudio = new Tone.Player(newData).toDestination();
  Tone.loaded().then(() => {
    micAudio.start();
  });
  if (!micAudio || document.hidden) {
    return;
  }
};
