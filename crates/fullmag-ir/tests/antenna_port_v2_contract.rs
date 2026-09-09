use fullmag_ir::{AntennaPortBranchV2IR, AntennaPortModeIR};

#[test]
fn antenna_port_mode_serializes_versioned_terminal_pairs() {
    let mode = AntennaPortModeIR {
        schema_version: "antenna_port_mode.v2".into(),
        id: "cpw_common".into(),
        source_object_id: "cpw".into(),
        current_transport_id: "cpw_charge".into(),
        branches: vec![
            AntennaPortBranchV2IR {
                id: "signal".into(),
                inlet_terminal_ref: "signal_in".into(),
                outlet_terminal_ref: "signal_out".into(),
                signed_weight: 1.0,
            },
            AntennaPortBranchV2IR {
                id: "ground_left".into(),
                inlet_terminal_ref: "ground_left_in".into(),
                outlet_terminal_ref: "ground_left_out".into(),
                signed_weight: -0.5,
            },
            AntennaPortBranchV2IR {
                id: "ground_right".into(),
                inlet_terminal_ref: "ground_right_in".into(),
                outlet_terminal_ref: "ground_right_out".into(),
                signed_weight: -0.5,
            },
        ],
        normalization_current_a: 1.0,
    };

    let value = serde_json::to_value(&mode).unwrap();
    assert_eq!(value["schema_version"], "antenna_port_mode.v2");
    assert_eq!(value["branches"][0]["inlet_terminal_ref"], "signal_in");
    assert_eq!(value["branches"][0]["outlet_terminal_ref"], "signal_out");
    assert!(value["branches"][0].get("terminal_selector_ref").is_none());
    assert_eq!(serde_json::from_value::<AntennaPortModeIR>(value).unwrap(), mode);
}

#[test]
fn antenna_port_mode_without_discriminator_is_rejected_in_direct_deserialization() {
    let legacy = serde_json::json!({
        "id": "legacy",
        "source_object_id": "cpw",
        "current_transport_id": "cpw_charge",
        "branches": [{
            "terminal_selector_ref": "signal",
            "signed_weight": 1.0
        }, {
            "terminal_selector_ref": "return",
            "signed_weight": -1.0
        }],
        "normalization_current_a": 1.0
    });

    assert!(serde_json::from_value::<AntennaPortModeIR>(legacy).is_err());
}
