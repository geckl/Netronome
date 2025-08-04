import { React, useEffect } from 'react';
import { CloseButton, FileUpload, Input, InputGroup, useFileUpload, VStack } from "@chakra-ui/react"
import { Socket } from 'socket.io-client';
import { setBacktrack } from './BacktrackPlayer';
import { timer } from '../../util';

export const BacktrackButton = ({socket, togglePlayback, setIsBacktrack} : {socket: Socket, togglePlayback: (play: boolean, position?: string) => void, setIsBacktrack: (isBacktrack: boolean) => void}) => {
    const fileUpload = useFileUpload({
        maxFiles: 1,
        accept: ["audio/mpeg", "audio/wav"],
    });

      function readBacktrackFile(audioFile: File | null) {
        if (socket) {
          if (audioFile === null) {
            socket.emit("conductor-backtrack", null);
            console.log("Backtrack cleared");
          } else {
            const stream = audioFile.stream()
            const reader = stream.getReader();
            const readChunk = () => {
              reader.read().then(({ done, value }) => {
                if (done) {
                  console.log("Stream finished");
                  return;
                }
                socket.emit("conductor-backtrack", value);
                // Continue reading the next chunk
                readChunk();
              });
            };
            // Start reading the stream
            readChunk();
          }
        }
      }

    useEffect(() => {
        const file = fileUpload.acceptedFiles[0];
        if (file) {
            console.log("New Backing Track Selected: ", file);
            readBacktrackFile(file);
            const backtrackBlob = file as Blob;
            const fileReader = new FileReader();
            fileReader.onloadend = () => {
                const arrayBuffer = fileReader.result as ArrayBuffer
                setBacktrack(arrayBuffer, setIsBacktrack, socket, togglePlayback);
            }
            fileReader.readAsArrayBuffer(backtrackBlob);
        } else {
            setBacktrack(null, setIsBacktrack, socket);
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
        </VStack>
    )
}