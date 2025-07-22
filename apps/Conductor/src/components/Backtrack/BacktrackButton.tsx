import { React, useState, useEffect, useRef } from 'react';
import { Button, CloseButton, FileUpload, Input, InputGroup, useFileUpload } from "@chakra-ui/react"
import { Socket } from 'socket.io-client';
import { streamFile, toBase64 } from '../../util';
import * as Tone from "tone";

// export const BacktrackButton = ({ backtrack, setBacktrack, socket }: { backtrack: MutableRefObject<Tone.Player>, setBacktrack: (p: Tone.Player) => void , socket: Socket | null }) => {
export const BacktrackButton = ({ backtrack, socket }) => {
    const fileUpload = useFileUpload({
        maxFiles: 1,
        accept: ["audio/mpeg", "audio/wav"],
    });

    useEffect(() => {
        console.log("New Backing Track Selected: ", fileUpload.acceptedFiles[0]);
        const file = fileUpload.acceptedFiles[0];
        console.log("File: ", file);

        if (socket && file) {
            streamFile({ audioFile: file, socket });
        }

        if (file) {
            console.log("read file!");
            const backtrackBlob = file as Blob;
            const fileReader = new FileReader();
            fileReader.onloadend = () => {

                const arrayBuffer = fileReader.result as ArrayBuffer

                // Convert array buffer into audio buffer
                Tone.getContext().decodeAudioData(arrayBuffer).then((audioBuffer) => {
                    backtrack.current = new Tone.Player(audioBuffer).sync().start("1m").toDestination();
                }).catch((error) => {
                    console.error("Error decoding audio data: ", error);
                }
                );
            }
            fileReader.readAsArrayBuffer(backtrackBlob)
        } else {
            if (backtrack.current) {
                backtrack.current.dispose();
                socket.emit("conductor-backtrack", null);
            }
        }

    }, [fileUpload.acceptedFiles]);

    console.log(fileUpload.acceptedFiles);

    return (
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
    )
}