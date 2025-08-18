import { Slider, Switch, Spacer, Stack, VStack, } from "@chakra-ui/react"
import React, { useState, RefObject } from "react"

export const TempoSlider = ({ tempo, setTempo }: { tempo: RefObject, setTempo: (t: number) => void }) => {

    const [isFluidMode, setIsFluidMode] = useState(false);

    return (
        <Stack direction={{ base: "column", md: "row" }}>
            <Spacer w={150} h={1} />
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
            <Switch.Root onCheckedChange={(e) => setIsFluidMode(e.checked)} defaultChecked={false} size="md" colorPalette="blue" w={150} >
                <Switch.HiddenInput />
                <Stack direction={{ base: "row", md: "column" }} alignItems="center" justifyContent="center" gap={2} mt={5}>
                <Switch.Label>{isFluidMode ? "Fluid" : "Static"} Tempo Mode:</Switch.Label>
                <Switch.Control>
                    <Switch.Thumb />
                </Switch.Control>
                </Stack>
            </Switch.Root>
        </Stack>
    )
};