import { createListCollection, Select } from "@chakra-ui/react";

/**
 * Audio source picker built on Chakra Select (themed with the rest of the
 * conductor UI). Choosing "-- No Microphone --" sends null upstream, which
 * tears the mic down — mirroring the previous native-select behavior.
 */
function InputDropdown(props: {
  inputs: MediaDeviceInfo[];
  setSelectedAudioId: (id: string | null) => void;
}) {
    const collection = createListCollection({
        items: [
            { value: "none", label: "-- No Microphone --" },
            ...props.inputs.map((input, i) => ({
                value: input.deviceId || `device-${i}`,
                label: input.label || `Device ${i + 1}`,
            })),
        ],
    });

    function changeInput(e: { value: string[] }) {
        const value = e.value[0] ?? "none";
        props.setSelectedAudioId(value === "none" ? null : value);
    }

    return (
        <Select.Root
            className="Audio-source"
            collection={collection}
            width="min(320px, 80vw)"
            defaultValue={["none"]}
            onValueChange={changeInput}
        >
            <Select.Label>Audio Source</Select.Label>
            <Select.HiddenSelect />
            <Select.Control>
                <Select.Trigger>
                    <Select.ValueText placeholder="-- No Microphone --" />
                </Select.Trigger>
                <Select.IndicatorGroup>
                    <Select.Indicator />
                </Select.IndicatorGroup>
            </Select.Control>
            <Select.Positioner>
                <Select.Content>
                    {collection.items.map((item) => (
                        <Select.Item item={item} key={item.value}>
                            <Select.ItemText>{item.label}</Select.ItemText>
                            <Select.ItemIndicator />
                        </Select.Item>
                    ))}
                </Select.Content>
            </Select.Positioner>
        </Select.Root>
    );
}

export default InputDropdown;
