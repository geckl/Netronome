import { VStack, Slider, Switch, Spacer, } from "@chakra-ui/react"
import React, { useState, useEffect } from "react"
import { Socket } from 'socket.io-client';
import * as Tone from "tone";

import { DeviceType, TempoMode } from "../../types";
import { convertTime } from "../../util";

export const TempoSlider = ({ socket, serverOffset }: { socket: Socket; serverOffset: any }) => {

    const [tempo, setTempo] = useState<number>(60);
    const [isFluidMode, setIsFluidMode] = useState(false);

    useEffect(() => {
        console.log("Change Tempo!");
        if (socket) {
            const targetTime = convertTime("Server", Tone.immediate(), serverOffset)
            console.log("Target Time: ", targetTime);
            const position = "0:0:0";
            socket.emit("conductor-change-tempo", targetTime, position, tempo, (newTargetTime: number) => {
                console.log("New Target Time: ", newTargetTime);
                let time2 = convertTime("Client", newTargetTime, serverOffset);
                Tone.getTransport().bpm.setValueAtTime(tempo, time2);
            });
        }
    }, [tempo]);

    return (
        <VStack>
            <Slider.Root minW={250} colorPalette={"blue"} min={40} max={200} defaultValue={[60]} onValueChange={(e) => isFluidMode && setTempo(e.value)} onValueChangeEnd={(e) => !isFluidMode && setTempo(e.value)} >
                <Slider.Label>Tempo: {tempo}</Slider.Label>
                <Slider.Control>
                    <Slider.Track>
                        <Slider.Range />
                    </Slider.Track>
                    <Slider.Thumb>
                        <Slider.DraggingIndicator
                            layerStyle="fill.solid"
                            top="6"
                            rounded="sm"
                            px="1.5"
                        >
                            <Slider.ValueText />
                        </Slider.DraggingIndicator>
                        <Slider.HiddenInput />
                    </Slider.Thumb>
                    <Slider.MarkerGroup>
                        <Slider.Marker />
                    </Slider.MarkerGroup>
                </Slider.Control>
            </Slider.Root>
            <Spacer minH={5}/>
            <Switch.Root onCheckedChange={(e) => setIsFluidMode(e.checked)} defaultChecked={false} size="md" colorPalette="blue">
                <Switch.HiddenInput />
                <Switch.Control>
                    <Switch.Thumb />
                </Switch.Control>
                <Switch.Label>{isFluidMode ? "Fluid" : "Static"} Tempo Mode</Switch.Label>
            </Switch.Root>
        </VStack>
    )
};