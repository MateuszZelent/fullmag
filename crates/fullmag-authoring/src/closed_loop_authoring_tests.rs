//! Regression inputs emitted by the actual MicrostripGeometryEditorModel transaction.
//! These tests are intentionally not compiled during the source-contract work.
use super::*;

fn authored_scene() -> SceneDocument {
    serde_json::from_str(r#"{"version":"scene.v2","objects":[{"id":"object","name":"loop","role":"antenna","geometry":{"geometry_kind":"MicrostripAntennaLayout","geometry_params":{"length_m":2e-06,"thickness_m":2e-07,"conductivity_s_per_m":58000000,"stations":[{"s":0,"signal_width_m":3e-07},{"s":0.5,"signal_width_m":1e-07},{"s":1,"signal_width_m":3e-07}],"return_width_m":1e-06,"return_offset_m":4e-07,"conductors":[{"id":"signal","kind":"signal"},{"id":"return","kind":"return"}],"terminal_faces":{"signal":{"inlet":"local_u_min","outlet":"local_u_max"},"return":{"inlet":"local_u_min","outlet":"local_u_max"}},"transform":{"rotation_matrix":[[0,-1,0],[1,0,0],[0,0,1]],"translation_m":[0,-1e-06,0]},"loop":{"enabled":true,"inlet_connection_length_m":2e-07,"inlet_connection_width_m":4e-07,"inlet_connection_offset_v_m":0,"inlet_connection_part_id":"inlet","inlet_connection_conductivity_s_per_m":30000000,"outlet_connection_length_m":2e-07,"outlet_connection_width_m":4e-07,"outlet_connection_offset_v_m":0,"outlet_connection_part_id":"outlet","outlet_connection_conductivity_s_per_m":30000000}}},"material_ref":"","magnetization_ref":null,"physics_stack":[],"transform":{"translation":[0,0,0],"rotation":[0,0,0],"scale":[1,1,1]}}],"current_transports":[{"kind":"current_transport","name":"charge","model":"ohmic_poisson","coupling":"one_way","domain":[{"object_id":"object"}],"materials":[{"region":{"object_id":"object","region_id":"signal"},"material":{"sigma_Spm":58000000}},{"region":{"object_id":"object","region_id":"return"},"material":{"sigma_Spm":58000000}},{"region":{"object_id":"object","region_id":"inlet"},"material":{"sigma_Spm":30000000}},{"region":{"object_id":"object","region_id":"outlet"},"material":{"sigma_Spm":30000000}}],"boundaries":[],"gauge":"zero_mean","solver":{"engine":"cg","linear":{"relative_tolerance":1e-12,"absolute_tolerance":0,"max_iterations":10000},"operator_version":"fem_charge_conforming_h1_p1.transparent.v1","physical_residual_version":"charge_balance_integrated_l2.v1"},"structured_current_closure":{"schema_version":"structured_current_closure.v2","closure_id":"object:closed-loop","kind":"closed_geometry","source_cuts":[{"source_cut_id":"object:source-cut:inlet","circuit_id":"object:circuit","region":{"object_id":"object","region_id":"inlet"},"plane":{"coordinate_frame":"object","axis":"z","offset_m":-3e-07,"normal":"positive_axis"},"drive":{"schema_version":"impressed_potential_jump.v1","kind":"impressed_potential_jump","drive_id":"object:source-drive","potential_jump_V":0.25}}]}}]}"#).unwrap()
}

fn check(scene: &SceneDocument) -> Result<(), SceneDocumentValidationError> {
    validate_spin_authoring(scene, &scene.objects.iter().map(|object| object.id.clone()).collect())
}

fn mutate_current(scene: &mut SceneDocument, update: impl FnOnce(&mut Value)) {
    let mut current = serde_json::to_value(&scene.current_transports[0]).unwrap();
    update(&mut current);
    scene.current_transports[0] = serde_json::from_value(current).unwrap();
}

#[test]
fn actual_ui_closed_loop_has_a_valid_authoring_lane_and_preserves_object_frame() {
    let scene = authored_scene();
    check(&scene).unwrap();
    let current = &scene.current_transports[0];
    let serialized = serde_json::to_value(current).unwrap();
    assert_eq!(serialized["structured_current_closure"]["source_cuts"][0]["plane"]["coordinate_frame"], "object");
    let builder = crate::scene_document_to_script_builder(&scene).unwrap();
    let roundtrip = crate::scene_document_from_script_builder(&builder);
    assert_eq!(roundtrip.current_transports, scene.current_transports);
}

#[test]
fn invalid_closed_loop_versions_gauges_operators_and_domains_fail_closed() {
    for (path, value) in [
        ("/structured_current_closure/schema_version", serde_json::json!("structured_current_closure.v9")),
        ("/structured_current_closure/source_cuts/0/plane/coordinate_frame", serde_json::json!("world")),
        ("/structured_current_closure/source_cuts/0/plane/axis", serde_json::json!("x")),
        ("/structured_current_closure/source_cuts/0/region/region_id", serde_json::json!("return")),
        ("/structured_current_closure/source_cuts/0/region/object_id", serde_json::json!("missing")),
        ("/structured_current_closure/source_cuts/0/plane/offset_m", serde_json::json!(0.0)),
        ("/structured_current_closure/source_cuts/0/drive/potential_jump_V", serde_json::json!(0.0)),
        ("/gauge", serde_json::json!("terminal_reference")),
        ("/solver/operator_version", serde_json::json!("fv_charge_harmonic_source_cut_v1")),
        ("/domain/0/region_id", serde_json::json!("signal")),
        ("/materials/0/material/sigma_Spm", serde_json::json!(1.0)),
    ] {
        let mut scene = authored_scene();
        mutate_current(&mut scene, |current| {
            if path == "/domain/0/region_id" { current["domain"][0]["region_id"] = value; }
            else { *current.pointer_mut(path).unwrap_or_else(|| panic!("missing regression path {path}")) = value; }
        });
        assert!(check(&scene).is_err(), "invalid input accepted: {path}");
    }
}

#[test]
fn closed_loop_materials_require_complete_nonoverlapping_owner_parts() {
    let mut scene = authored_scene();
    mutate_current(&mut scene, |current| { current["materials"].as_array_mut().unwrap().pop(); });
    assert!(check(&scene).is_err());
    let mut scene = authored_scene();
    mutate_current(&mut scene, |current| { current["materials"][1] = current["materials"][0].clone(); });
    assert!(check(&scene).is_err());
    let mut scene = authored_scene();
    mutate_current(&mut scene, |current| current["materials"][0]["region"]["object_id"] = serde_json::json!("other"));
    assert!(check(&scene).is_err());
}

#[test]
fn legacy_world_plane_remains_omitted_and_unknown_frame_is_rejected() {
    let plane = serde_json::json!({"axis":"x","offset_m":0.0,"normal":"positive_axis"});
    let decoded: crate::SceneStructuredCutPlane = serde_json::from_value(plane.clone()).unwrap();
    assert_eq!(decoded.coordinate_frame.unwrap_or_default(), crate::SceneStructuredCutCoordinateFrame::World);
    assert_eq!(serde_json::to_value(decoded).unwrap(), plane);
    assert!(serde_json::from_value::<crate::SceneStructuredCutPlane>(serde_json::json!({"axis":"z","offset_m":0.0,"normal":"positive_axis","coordinate_frame":"unknown"})).is_err());
}
