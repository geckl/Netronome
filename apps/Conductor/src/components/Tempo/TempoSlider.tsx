import { Slider, Switch, Spacer, Stack, VStack, SegmentGroup, } from "@chakra-ui/react"
import { Tooltip } from "../ui/tooltip"

export const TempoSlider = ({ setTempo, metronomeMode, setMetronomeMode }: { setTempo: (t: number) => void, metronomeMode: string | null, setMetronomeMode: (s: string | null) => void }) => {

    return (
        <Tooltip content="Fluid Tempo Mode broadcasts a stream of tempo changes">
            <VStack direction={{ base: "column", md: "row" }}>
                <Spacer w={150} h={1} />
                <Slider.Root minW={250} colorPalette={"blue"} min={40} max={200} defaultValue={[60]} onValueChange={(e) => metronomeMode === "Fluid" && setTempo(e.value)} onValueChangeEnd={(e) => metronomeMode !== "Fluid" && setTempo(e.value)} >
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
                <SegmentGroup.Root value={metronomeMode} onValueChange={(e) => setMetronomeMode(e.value)}>
                    <SegmentGroup.Indicator />
                    <SegmentGroup.Items items={["Off", "Static", "Fluid"]} />
                </SegmentGroup.Root>
                {/* <Switch.Root onCheckedChange={(e) => setIsFluidMode(e.checked)} defaultChecked={false} size="md" colorPalette="blue" w={150} >
                    <Switch.HiddenInput />
                    <Stack direction={{ base: "row", md: "row" }} alignItems="center" justifyContent="center" gap={2} mt={5}>
                        <Switch.Label>Fluid Tempo Mode:</Switch.Label>
                        <Switch.Control>
                            <Switch.Thumb />
                        </Switch.Control>
                    </Stack>
                </Switch.Root> */}
            </VStack>
        </Tooltip>
    )
};