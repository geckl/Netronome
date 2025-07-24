import { VStack, Slider, Switch, Spacer, } from "@chakra-ui/react"
import React, { useState, RefObject } from "react"

export const TempoSlider = ({tempo, setTempo }: { tempo: RefObject, setTempo: (t: number) => void }) => {

    const [isFluidMode, setIsFluidMode] = useState(false);

    return (
        <VStack>
            <Slider.Root minW={250} colorPalette={"blue"} min={40} max={200} defaultValue={[60]} onValueChange={(e) => isFluidMode && setTempo(e.value)} onValueChangeEnd={(e) => !isFluidMode && setTempo(e.value)} >
                <Slider.Label>Tempo:</Slider.Label>
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