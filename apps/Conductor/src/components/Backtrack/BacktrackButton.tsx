import { React, useRef, useEffect } from 'react';
import { Button, CloseButton, FileUpload, Input, InputGroup, useFileUpload, VStack } from "@chakra-ui/react"
import { Socket } from 'socket.io-client';
import { convertTime, streamFile, toBase64 } from '../../util';
import * as Tone from "tone";
import Peaks from 'peaks.js';

// export const BacktrackButton = ({ backtrack, setBacktrack, socket }: { backtrack: MutableRefObject<Tone.Player>, setBacktrack: (p: Tone.Player) => void , socket: Socket | null }) => {
export const BacktrackButton = ({ backtrack, socket, togglePlayback }) => {
    const fileUpload = useFileUpload({
        maxFiles: 1,
        accept: ["audio/mpeg", "audio/wav"],
    });

    const peaks = useRef(null);
    const updatePlayhead = useRef(null);


    useEffect(() => {
        const file = fileUpload.acceptedFiles[0];
        console.log("New Backing Track Selected: ", file);

        if (socket && file) {
            streamFile({ audioFile: file, socket });
        }

        if (file) {
            const backtrackBlob = file as Blob;
            const fileReader = new FileReader();
            fileReader.onloadend = () => {

                const arrayBuffer = fileReader.result as ArrayBuffer

                // Convert array buffer into audio buffer
                Tone.getContext().decodeAudioData(arrayBuffer).then((audioBuffer) => {
                    backtrack.current = new Tone.Player(audioBuffer).sync().start(0).toDestination();

                    const player = {
                        externalPlayer: backtrack.current,
                        eventEmitter: null,

                        init: function (eventEmitter) {
                            console.log("init backtrack!");
                            this.eventEmitter = eventEmitter;

                            // this.externalPlayer.sync();
                            // this.externalPlayer.start();

                           updatePlayhead.current = Tone.getTransport().scheduleRepeat(() => {
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
                            // Tone.getContext().dispose();
                            backtrack.current.dispose();
                            Tone.getTransport().clear(updatePlayhead.current);

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
                            // return Tone.start().then(() => {
                            //     Tone.getTransport().start();

                            //     this.eventEmitter.emit('player.playing', this.getCurrentTime());
                            // });
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
                            togglePlayback(true, position);

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
                            container: document.getElementById('overview-container')
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
                        peaks.current = peaksInstance;
                    });
                }).catch((error) => {
                    console.error("Backtrack error: ", error);
                }
                );
            }
            fileReader.readAsArrayBuffer(backtrackBlob)
        } else {
            if (backtrack.current) {
                peaks.current.destroy();
                socket.emit("conductor-backtrack", null);
            }
        }

    }, [fileUpload.acceptedFiles]);

    return (
        <VStack>
            <FileUpload.RootProvider gap="1" maxWidth="200px" colorPalette="blue" value={fileUpload}>
                <FileUpload.HiddenInput />
                <FileUpload.Label>Upload Backing Track:</FileUpload.Label>
                <InputGroup
                    bg="white"
                    endElement={
                        <FileUpload.ClearTrigger asChild>
                            <CloseButton
                                me="-1"
                                size="xs"
                                variant="plain"
                                focusVisibleRing="inside"
                                focusRingWidth="2px"
                                pointerEvents="auto"
                            />
                        </FileUpload.ClearTrigger>
                    }
                >
                    <Input asChild bg="brand.500">
                        <FileUpload.Trigger>
                            <FileUpload.FileText lineClamp={1} />
                        </FileUpload.Trigger>
                    </Input>
                </InputGroup>
            </FileUpload.RootProvider>
            {/* <div id="zoomview-container"></div> */}
            <div id="overview-container"></div>
        </VStack>
    )
}