import React from "react";
import { useRef, useSyncExternalStore } from "react";
import { Badge, HStack, Spacer, Text, VStack } from "@chakra-ui/react";
import { MicAudioEngine } from "../../audio/MicAudioEngine";
import ChannelStrip from "./ChannelStrip";
import { toaster } from "../ui/toaster";

/**
 * Mixer UI for the selected audio source. Pure presentation:
 * it subscribes to the MicAudioEngine snapshot store, while the graph
 * itself lives in App so the broadcast keeps running when another
 * tab is active.
 */
export const Mixer = ({ engine }: { engine: MicAudioEngine | null }) => {
  const monitorWarned = useRef(false);

  const state = useSyncExternalStore(
    engine ? engine.subscribe : () => () => undefined,
    engine ? engine.getState : () => null,
    () => null
  );

  if (!engine || !state) {
    return null;
  }

  const labels =
    state.channelCount === 2
      ? ["Left", "Right"]
      : Array.from({ length: state.channelCount }, (_, i) => `${i + 1}`);

  const handleMonitorChange = (value: number) => {
    engine.setMonitor(value);
    if (value > 0 && !monitorWarned.current) {
      monitorWarned.current = true;
      toaster.create({
        title: "Monitor enabled",
        description: "The input is now audible on this machine — wear headphones to avoid feedback!",
        type: "warning",
      });
    }
  };

  return (
    <VStack gap={2} align="start">
      <HStack gap={3}>
        <Text
          maxW="400px"
          fontSize="sm"
          color="white"
          title={state.deviceLabel}
          style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
        >
          {state.deviceLabel}
        </Text>
        <Spacer />
        <HStack>
          <Badge colorPalette="blue">{state.channelCount} ch</Badge>
          {state.streaming && <Badge colorPalette="green">Broadcasting</Badge>}
        </HStack>
      </HStack>
      <HStack gap={2} align="start" overflowX="auto" maxW="100%">
        {labels.map((label, i) => (
          <ChannelStrip key={i} index={i} label={label} channel={state.channels[i]} engine={engine} />
        ))}
        <ChannelStrip
          index={-1}
          label="Master"
          channel={{
            gain: state.master,
            pan: 0,
            muted: false,
          }}
          engine={engine}
          master
          onMonitorChange={handleMonitorChange}
        />
      </HStack>
    </VStack>
  );
};

export default Mixer;
