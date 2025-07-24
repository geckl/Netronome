import { React, useEffect } from 'react';
import { CloseButton, FileUpload, Input, InputGroup, useFileUpload, VStack } from "@chakra-ui/react"

// export const BacktrackButton = ({ backtrack, setBacktrack, socket }: { backtrack: MutableRefObject<Tone.Player>, setBacktrack: (p: Tone.Player) => void , socket: Socket | null }) => {
export const BacktrackButton = ({ setBacktrack, readBacktrackFile }: { setBacktrack: (b: ArrayBuffer | null) => void; readBacktrackFile: (f: File | null) => void }) => {
    const fileUpload = useFileUpload({
        maxFiles: 1,
        accept: ["audio/mpeg", "audio/wav"],
    });

    useEffect(() => {
        const file = fileUpload.acceptedFiles[0];
        if (file) {
            console.log("New Backing Track Selected: ", file);
            readBacktrackFile(file);
            const backtrackBlob = file as Blob;
            const fileReader = new FileReader();
            fileReader.onloadend = () => {
                const arrayBuffer = fileReader.result as ArrayBuffer
                setBacktrack(arrayBuffer);
            }
            fileReader.readAsArrayBuffer(backtrackBlob)
        } else {
            setBacktrack(null);
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