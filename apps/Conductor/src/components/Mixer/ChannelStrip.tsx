import React from "react";
import { Button, HStack, Text, Slider, VStack } from "@chakra-ui/react";
import { ChannelState, MicAudioEngine } from "../../audio/MicAudioEngine";
import Meter from "./Meter";

/** Human-friendly pan position: center, or L/R with tenths */
function panDisplay(pan: number): string {
  if (Math.abs(pan) < 0.05) {
    return "C";
  }
  return pan < 0 ? `L${Math.round(-pan * 10)}` : `R${Math.round(pan * 10)}`;
}

export const ChannelStrip = ({
  index,
  label,
  channel,
  engine,
  master = false,
  onMonitorChange,
}: {
  index: number;
  label: string;
  channel: ChannelState;
  engine: MicAudioEngine;
  master?: boolean;
  onMonitorChange?: (value: number) => void;
}) => {
  const faderHeight = master ? 170 : 140;

  return (
    <VStack
      minW={master ? 90 : 76}
      p={2}
      border="1px solid #1b2830"
      borderRadius="md"
      bg="#0d151b"
      opacity={channel.muted ? 0.55 : 1}
      gap={2}
    >
      <Text
        fontSize={master ? "sm" : "xs"}
        fontWeight="bold"
        color="white"
        style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
      >
        {label}
      </Text>

      <HStack gap={1} align="end">
        <Meter getAnalyser={master ? () => engine.getMasterAnalyser() : () => engine.getChannelAnalyser(index)} width={master ? 16 : 12} height={faderHeight} />
        {/* Fader */}
        <Slider.Root
          orientation="vertical"
          h={`${faderHeight}px`}
          minW={20}
          colorPalette={channel.muted && !master ? "red" : "blue"}
          min={0}
          max={1}
          step={0.01}
          value={[channel.gain]}
          onValueChange={(e) =>
            master ? engine.setMaster(e.value[0]) : engine.setChannelGain(index, e.value[0])
          }
        >
          <Slider.Control>
            <Slider.Track>
              <Slider.Range />
            </Slider.Track>
            <Slider.Thumb index={0}>
              <Slider.HiddenInput />
            </Slider.Thumb>
          </Slider.Control>
        </Slider.Root>
      </HStack>

      {/* Pan (strips only; master has the monitor level instead) */}
      {master ? (
        <HStack w="100%" gap={1}>
          <Text fontSize="2xs" color="gray.400">
            Mon
          </Text>
          <Slider.Root
            w="100%"
            colorPalette="green"
            min={0}
            max={1}
            step={0.01}
            value={[engine.getState().monitor]}
            onValueChange={(e) =>
              onMonitorChange
                ? onMonitorChange(e.value[0])
                : engine.setMonitor(e.value[0])
            }
          >
            <Slider.Control>
              <Slider.Track>
                <Slider.Range />
              </Slider.Track>
              <Slider.Thumb index={0}>
                <Slider.HiddenInput />
              </Slider.Thumb>
            </Slider.Control>
          </Slider.Root>
        </HStack>
      ) : (
        <Slider.Root
          w="100%"
          colorPalette="cyan"
          min={-1}
          max={1}
          step={0.1}
          value={[channel.pan]}
          onValueChange={(e) => engine.setChannelPan(index, e.value[0])}
        >
          <Slider.Control>
            <Slider.Track>
              <Slider.Range />
            </Slider.Track>
            <Slider.Thumb index={0}>
              <Slider.HiddenInput />
            </Slider.Thumb>
          </Slider.Control>
        </Slider.Root>
      )}

      <HStack w="100%" gap={1}>
        {master ? (
          <Text fontSize="2xs" color="gray.400">
            Master
          </Text>
        ) : (
          <Button
            flex={1}
            size="2xs"
            variant={channel.muted ? "solid" : "outline"}
            colorPalette={channel.muted ? "red" : "blue"}
            onClick={() => engine.toggleChannelMute(index)}
          >
            Mute
          </Button>
        )}
        {!master && (
          <Text fontSize="2xs" color="gray.400" minW={7} textAlign="right">
            {panDisplay(channel.pan)}
          </Text>
        )}
      </HStack>
    </VStack>
  );
};

export default ChannelStrip;
