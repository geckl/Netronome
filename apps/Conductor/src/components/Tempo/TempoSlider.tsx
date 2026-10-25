import { useState } from "react"
import { Slider, SegmentGroup, VStack } from "@chakra-ui/react"
import { Tooltip } from "../ui/tooltip"

/**
 * Controlled tempo slider.
 * - `tempo` is the committed value synced with the orchestra (also updated
 *   on server tempo changes, so the thumb always reflects reality).
 * - `dragValue` keeps the thumb glued to the pointer while dragging;
 *   Fluid mode commits live, Static mode commits on release.
 */
export const TempoSlider = ({
  tempo,
  setTempo,
  metronomeMode,
  setMetronomeMode,
}: {
  tempo: number;
  setTempo: (t: number) => void;
  metronomeMode: string | null;
  setMetronomeMode: (s: string | null) => void;
}) => {
    const [dragValue, setDragValue] = useState<number | null>(null);
    const displayTempo = dragValue ?? tempo;

    return (
        <Tooltip content="Fluid Tempo Mode broadcasts a stream of tempo changes">
            <VStack gap={6} align="center">
                <Slider.Root
                    minW={280}
                    colorPalette="cyan"
                    min={40}
                    max={200}
                    value={[displayTempo]}
                    onValueChange={(e) => {
                        setDragValue(e.value[0]);
                        if (metronomeMode === "Fluid") {
                            setTempo(e.value[0]);
                        }
                    }}
                    onValueChangeEnd={(e) => {
                        if (metronomeMode !== "Fluid") {
                            setTempo(e.value[0]);
                        }
                    }}
                >
                    <Slider.Label>Tempo</Slider.Label>
                    <Slider.Control>
                        <Slider.Track>
                            <Slider.Range />
                        </Slider.Track>
                        <Slider.Thumb index={0}>
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
                            <Slider.Marker value={40} />
                        </Slider.MarkerGroup>
                    </Slider.Control>
                </Slider.Root>
                <SegmentGroup.Root size="sm" value={metronomeMode} onValueChange={(e) => setMetronomeMode(e.value)}>
                    <SegmentGroup.Indicator />
                    <SegmentGroup.Items items={["Off", "Static", "Fluid"]} />
                </SegmentGroup.Root>
            </VStack>
        </Tooltip>
    )
};
