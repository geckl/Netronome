import React from "react";

function InputDropdown(props) {

    // const [audioInputs, setAudioinputs] = useState(props.inputs);

    //console.log(props.inputs);

    function changeInput(e) {
        props.setSelectedAudioId(e.target.value)
    }

    return (
        <label hidden={props.isJoined}>
            {"Select an Audio Source:   "}
            <select
                name="Audio Source"
                style={{ width: "300px" }}
                onChange={changeInput}
            >
                <option disabled={true} selected={true}> -- select an option -- </option>
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