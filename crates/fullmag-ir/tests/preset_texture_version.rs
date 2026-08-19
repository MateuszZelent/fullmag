use fullmag_ir::InitialMagnetizationIR;

#[test]
fn preset_texture_missing_version_defaults_to_v1() {
    let payload = serde_json::json!({
        "kind": "preset_texture",
        "preset_kind": "uniform",
        "preset_params": {"direction": [1.0, 0.0, 0.0]},
        "mapping": {
            "space": "object",
            "projection": "object_local",
            "clamp_mode": "none"
        },
        "texture_transform": {
            "translation": [0.0, 0.0, 0.0],
            "rotation_quat": [0.0, 0.0, 0.0, 1.0],
            "scale": [1.0, 1.0, 1.0],
            "pivot": [0.0, 0.0, 0.0]
        }
    });

    let parsed: InitialMagnetizationIR = serde_json::from_value(payload).unwrap();
    let InitialMagnetizationIR::PresetTexture { preset_version, .. } = parsed else {
        panic!("expected preset texture");
    };

    assert_eq!(preset_version, 1);
}

#[test]
fn preset_texture_version_round_trips_to_executable_ir() {
    let payload = serde_json::json!({
        "kind": "preset_texture",
        "preset_kind": "vortex",
        "preset_version": 2,
        "preset_params": {
            "circulation": 1,
            "core_polarity": 1,
            "core_radius": 8e-9,
            "plane": "xy"
        }
    });

    let parsed: InitialMagnetizationIR = serde_json::from_value(payload).unwrap();
    let InitialMagnetizationIR::PresetTexture { preset_version, .. } = &parsed else {
        panic!("expected preset texture");
    };

    assert_eq!(*preset_version, 2);
    assert_eq!(
        serde_json::to_value(parsed).unwrap()["preset_version"],
        serde_json::json!(2)
    );
}
