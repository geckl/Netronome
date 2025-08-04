import Peaks, { PeaksInstance } from 'peaks.js';
import * as Tone from "tone";
import { Socket } from 'socket.io-client';

var peaks: PeaksInstance | undefined = undefined;
var updatePlayhead: number | undefined = undefined;
var backtrack: Tone.Player | null = null;

export function setBacktrack(arrayBuffer: ArrayBuffer | null, setIsBacktrack: (isBacktrack: boolean) => void, socket: Socket, togglePlayback?: (play: boolean, position?: string) => void) {
    if (arrayBuffer && togglePlayback) {
        setIsBacktrack(true);
        // Convert array buffer into audio buffer
        Tone.getContext().decodeAudioData(arrayBuffer).then((audioBuffer) => {
            backtrack = new Tone.Player(audioBuffer).sync().start(0).toDestination();

            const player = {
                externalPlayer: backtrack,
                eventEmitter: null,

                init: function (eventEmitter) {
                    console.log("init backtrack!");
                    this.eventEmitter = eventEmitter;

                    Tone.getTransport().position = "0:0:0";

                    updatePlayhead = Tone.getTransport().scheduleRepeat(() => {
                        const time = this.getCurrentTime();
                        eventEmitter.emit('player.timeupdate', time);

                        if (time >= this.getDuration()) {
                            Tone.getTransport().stop();
                        }
                    }, 0.25);

                    return Promise.resolve();
                },

                destroy: function () {
                    console.log("destroy backtrack!");
                    backtrack?.dispose();
                    if (updatePlayhead) {
                        Tone.getTransport().clear(updatePlayhead);
                    }
                    // if (peaks.current) {
                    //   peaks.current.destroy();
                    // }
                    backtrack = null;
                    this.externalPlayer = null;
                    this.eventEmitter = null;
                },

                setSource: function (opts) {
                    console.log("setSource backtrack!");
                    if (this.isPlaying()) {
                        this.pause();
                    }

                    // Update the Tone.js Player object with the new AudioBuffer
                    this.externalPlayer.buffer.set(opts.webAudio.audioBuffer);
                    return Promise.resolve();
                },

                play: async function () {
                    console.log("play backtrack!");
                    togglePlayback(true)
                    this.eventEmitter.emit('player.playing', this.getCurrentTime());
                    return Promise.resolve();
                },

                pause: function () {
                    console.log("pause backtrack!");
                    // Tone.getTransport().pause();

                    this.eventEmitter.emit('player.pause', this.getCurrentTime());
                },

                isPlaying: function () {
                    return Tone.getTransport().state === "started";
                },

                seek: async function (time) {
                    console.log("seek backtrack! ");
                    const position = Tone.Time(time, "s").toBarsBeatsSixteenths();
                    if (Tone.getTransport().state === "started") {
                        togglePlayback(true, position);
                    } else {
                        Tone.getTransport().position = position;
                    }

                    this.eventEmitter.emit('player.seeked', this.getCurrentTime());
                    this.eventEmitter.emit('player.timeupdate', this.getCurrentTime());
                },

                isSeeking: function () {
                    return false;
                },

                getCurrentTime: function () {
                    return Tone.getTransport().seconds;
                },

                getDuration: function () {
                    return this.externalPlayer.buffer.duration;
                }
            };

            const options = {
                // zoomview: {
                //     container: document.getElementById('zoomview-container')
                // },
                overview: {
                    container: document.getElementById('overview-container'),
                    waveformColor: "#FFFFFF",
                    playheadColor: "#808080"
                },
                player: player,
                webAudio: {
                    audioBuffer: audioBuffer,
                    scale: 128,
                    multiChannel: false
                },
                keyboard: true,
                showPlayheadTime: true,
                zoomLevels: [128, 256, 512, 1024, 2048, 4096]
            };

            Peaks.init(options, function (err, peaksInstance) {
                if (err) {
                    console.error(err.message);
                    return;
                }
                peaks = peaksInstance;
            });
        }).catch((error) => {
            setIsBacktrack(false);
            console.error("Backtrack error: ", error);
        }
        );
    } else {
        if (backtrack) {
            peaks?.destroy();
            socket.emit("conductor-backtrack", null);
            setIsBacktrack(false);
        }
    }
}