import { VStack, Slider } from "@chakra-ui/react"
import React from "react"
import * as Tone from "tone";





export const VolumeSlider = ({ volume }: { volume: React.RefObject<Tone.Gain | null> }) => {

    //const [volume, setVolume] = useState<number>(60);

    return (
        <VStack>
            <Slider.Root minW={250} colorPalette={"cyan"} min={0} max={1} step={.01} defaultValue={[0.5]} onValueChange={(e) => { if (volume.current) volume.current.gain.value = e.value[0]; }} >
            {/* <Slider.Root minW={250} colorPalette={"blue"} min={0} max={1} > */}
                <Slider.Label>Volume:</Slider.Label>
                <Slider.Control>
                    <Slider.Track>
                        <Slider.Range />
                    </Slider.Track>
                    <Slider.Thumb index={0}>
                        <Slider.HiddenInput />
                    </Slider.Thumb>
                    <Slider.MarkerGroup>
                        <Slider.Marker value={0.5} />
                    </Slider.MarkerGroup>
                </Slider.Control>
            </Slider.Root>
        </VStack>
    )
};