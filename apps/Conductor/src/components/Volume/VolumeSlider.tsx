import { VStack, Slider } from "@chakra-ui/react"
import React from "react"


export const VolumeSlider = ({ volume }) => {

    //const [volume, setVolume] = useState<number>(60);

    return (
        <VStack>
            <Slider.Root minW={250} colorPalette={"blue"} min={0} max={1} step={.01} defaultValue={[0.5]} onValueChange={(e) => volume.current.gain.value = e.value} >
            {/* <Slider.Root minW={250} colorPalette={"blue"} min={0} max={1} > */}
                <Slider.Label>Volume:</Slider.Label>
                <Slider.Control>
                    <Slider.Track>
                        <Slider.Range />
                    </Slider.Track>
                    <Slider.Thumb>
                        <Slider.HiddenInput />
                    </Slider.Thumb>
                    <Slider.MarkerGroup>
                        <Slider.Marker />
                    </Slider.MarkerGroup>
                </Slider.Control>
            </Slider.Root>
        </VStack>
    )
};