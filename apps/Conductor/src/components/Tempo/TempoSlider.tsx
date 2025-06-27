import { HStack, Slider, } from "@chakra-ui/react"
import React, { useState, useEffect } from "react"
import { Socket } from 'socket.io-client';
import * as Tone from "tone";

import { DeviceType } from "../../types";

export const TempoSlider = ({ socket, convertTime }: { socket: Socket; convertTime(destination: DeviceType, time: number): number}) => {

    const [tempo, setTempo] = useState<number>(60);

    useEffect(() => {
        console.log("Change Tempo!");
        if(socket)
        {
            const targetTime = convertTime("Server", Tone.immediate())
            console.log("Target Time: ", targetTime);
            const position = "0:0:0";
            socket.emit("conductor-change-tempo", targetTime, position, tempo, (newTargetTime: number) => {
                console.log("New Target Time: ", newTargetTime);
                let time2 = convertTime("Client", newTargetTime);
                Tone.getTransport().bpm.setValueAtTime(tempo, time2);
            });
        }
    }, [tempo]);

    return (
        <Slider.Root minW={250} colorPalette={"blue"} min={40} max={200} defaultValue={[60]} onValueChangeEnd={(e) => setTempo(e.value)} >
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
    )
};