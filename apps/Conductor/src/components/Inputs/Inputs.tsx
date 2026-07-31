import React from "react";

function InputDropdown(props) {

    // const [audioInputs, setAudioinputs] = useState(props.inputs);
    function changeInput(e) {
        props.setSelectedAudioId(e.target.value)
    }

    return (
        <label >
            {"Select an Audio Source:   "}
            <select
                name="Audio Source"
                style={{ width: "300px", color: "black", backgroundColor: "white" }}
                onChange={changeInput}
            >
                <option disabled={false} selected={true}> -- No Microphone -- </option>
                {props.inputs.map((input, i) =>
                (
                    <option
                        key={i}
                        value={input.deviceId}>
                        {input.label}
                    </option>
                ))}
            </select>
        </label>
    );
}

export default InputDropdown;