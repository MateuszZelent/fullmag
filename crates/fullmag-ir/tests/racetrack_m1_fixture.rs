use fullmag_ir::{
    GeometryIR, ProblemIR, RegionRefIR, ResolvedFdmTorqueTargetMaskIR, ValidationProfileIR,
};
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../tests/standard_problems/transport/racetrack_m1_v1/fixture.v1.json"
    ))
    .expect("racetrack fixture must be valid JSON")
}

fn python_problem_ir() -> Value {
    serde_json::from_str(include_str!(
        "../../../tests/standard_problems/transport/racetrack_m1_v1/python_problem_ir.v1.json"
    ))
    .expect("Python Problem.to_ir golden must be valid JSON")
}

#[test]
fn spin_transport_resolved_target_mask_round_trips_exact_identity() {
    let target = ResolvedFdmTorqueTargetMaskIR {
        torque_module_id: "transport_torque".into(),
        target: RegionRefIR {
            object_id: "fm".into(),
            region_id: None,
        },
        active_mask: vec![false, true],
    };
    let wire = serde_json::to_value(&target).expect("target mask serialization");
    assert_eq!(wire["torque_module_id"], "transport_torque");
    assert_eq!(wire["target"]["object_id"], "fm");
    assert_eq!(
        serde_json::from_value::<ResolvedFdmTorqueTargetMaskIR>(wire)
            .expect("target mask deserialization"),
        target
    );
}

#[test]
fn racetrack_expected_lowering_parses_with_current_problem_ir_types() {
    let fixture = fixture();
    let normalized = fixture
        .get("normalized_problem_ir_contract")
        .expect("fixture must contain normalized_problem_ir_contract");
    assert_eq!(
        normalized.get("contract_kind").and_then(Value::as_str),
        Some("typed_expected_lowering_map")
    );
    let lowering = normalized
        .get("expected_lowering")
        .expect("typed fixture must contain expected_lowering");

    let problem: ProblemIR = serde_json::from_value(lowering.clone())
        .expect("expected_lowering must parse as the current complete ProblemIR");
    let geometry: GeometryIR = serde_json::from_value(lowering["geometry"].clone())
        .expect("geometry must parse as current GeometryIR");
    let validation: ValidationProfileIR =
        serde_json::from_value(lowering["validation_profile"].clone())
            .expect("validation_profile must parse as current ValidationProfileIR");

    let current_wire =
        serde_json::to_value(&problem.current_modules[0]).expect("current must serialize");
    assert_eq!(current_wire["kind"], "current_transport");
    assert_eq!(current_wire["model"], "ohmic_poisson");
    assert_eq!(current_wire["coupling"], "one_way");
    assert_eq!(
        current_wire["solver"]["operator_version"],
        "fv_charge_harmonic_v1"
    );
    assert_eq!(current_wire["boundaries"][0]["id"], "terminal_x_minus");
    assert_eq!(current_wire["boundaries"][1]["id"], "terminal_x_plus");

    let spin_wire =
        serde_json::to_value(&problem.spin_transport_modules[0]).expect("spin must serialize");
    assert_eq!(spin_wire["current_source_id"], "charge");
    assert_eq!(spin_wire["mode"], "steady");
    assert_eq!(
        spin_wire["interfaces"][0]["normal_surface"],
        serde_json::json!({
            "object_id": "hm",
            "surface_id": "z+",
            "orientation": [0.0, 0.0, 1.0]
        })
    );
    assert_eq!(
        spin_wire["interfaces"][0]["ferromagnet_surface"],
        serde_json::json!({
            "object_id": "fm",
            "surface_id": "z-",
            "orientation": [0.0, 0.0, -1.0]
        })
    );
    assert_eq!(spin_wire["requested_execution"]["device"], "gpu");
    assert_eq!(
        spin_wire["constitutive_version"],
        "transport_constitutive.one_way.fullmag.v1"
    );

    let torque_wire =
        serde_json::to_value(&problem.spin_torque_modules[0]).expect("torque must serialize");
    assert_eq!(torque_wire["kind"], "drift_diffusion_spin_torque");
    assert_eq!(torque_wire["solve_id"], "spin");
    assert_eq!(torque_wire["target"]["object_id"], "fm");
    assert_eq!(problem.materials[0].name, "fm_material");
    assert_eq!(problem.energy_terms.len(), 3);
    assert_eq!(
        serde_json::to_value(&problem.energy_terms[2]).expect("DMI term must serialize"),
        serde_json::json!({
            "kind": "interfacial_dmi",
            "D": 3.0e-3,
            "interface_normal": [0.0, 0.0, 1.0]
        })
    );

    let study_wire = serde_json::to_value(&problem.study).expect("study must serialize");
    assert_eq!(study_wire["dynamics"]["integrator"], "rk4");
    assert_eq!(study_wire["dynamics"]["fixed_timestep"], 1.0e-13);

    let backend_wire =
        serde_json::to_value(&problem.backend_policy).expect("backend must serialize");
    assert_eq!(backend_wire["requested_backend"], "fdm");
    assert_eq!(backend_wire["execution_precision"], "double");
    assert_eq!(
        backend_wire["discretization_hints"]["fdm"]["cell"],
        serde_json::json!([2.0e-9, 2.0e-9, 1.0e-9])
    );
    assert_eq!(validation.execution_mode, fullmag_ir::ExecutionMode::Strict);
    assert_eq!(geometry.entries.len(), 2);
    assert_eq!(geometry.entries[0].name(), "fm");
    assert_eq!(geometry.entries[1].name(), "hm");
    assert_eq!(
        problem.problem_meta.runtime_metadata["runtime_selection"],
        serde_json::json!({
            "backend": "fdm",
            "device": "gpu",
            "gpu_count": 1,
            "device_index": 0,
            "cpu_threads": null,
            "execution_mode": "strict",
            "execution_precision": "double"
        })
    );
}

#[test]
fn native_m1_racetrack_rejects_a_missing_explicit_interface_surface() {
    let mut lowering = fixture()["normalized_problem_ir_contract"]["expected_lowering"].clone();
    lowering["spin_transport_modules"][0]["interfaces"][0]
        .as_object_mut()
        .expect("mixing interface object")
        .remove("ferromagnet_surface");
    let problem: ProblemIR =
        serde_json::from_value(lowering).expect("legacy wire remains readable");

    let errors = problem
        .validate()
        .expect_err("native_m1_v1 must reject a partial oriented interface");

    assert!(
        errors.iter().any(|error| {
            error.contains("normal_surface and ferromagnet_surface")
                && error.contains("native_m1_v1")
        }),
        "{errors:?}"
    );
}

#[test]
fn native_m1_racetrack_rejects_a_surface_selector_that_disagrees_with_its_orientation() {
    let mut lowering = fixture()["normalized_problem_ir_contract"]["expected_lowering"].clone();
    lowering["spin_transport_modules"][0]["interfaces"][0]["normal_surface"]["surface_id"] =
        serde_json::json!("z-");
    let problem: ProblemIR = serde_json::from_value(lowering).expect("wire must deserialize");

    let errors = problem
        .validate()
        .expect_err("native_m1_v1 must bind the selector to its oriented surface");

    assert!(
        errors
            .iter()
            .any(|error| error.contains("normal_surface.surface_id must be 'z+'")),
        "{errors:?}"
    );
}

#[test]
fn live_python_problem_ir_golden_deserializes_and_validates() {
    let problem: ProblemIR = serde_json::from_value(python_problem_ir())
        .expect("live Python Problem.to_ir golden must deserialize as ProblemIR");
    problem
        .validate()
        .expect("live Python Problem.to_ir golden must pass ProblemIR validation");
    assert!(problem
        .object_regions
        .iter()
        .any(|region| { region.owner_object == "hm" && region.region_id == "hm:transport" }));
    let fullmag_ir::CurrentModuleIR::CurrentTransport {
        definition: Some(charge),
        ..
    } = &problem.current_modules[0]
    else {
        panic!("expected typed current transport definition")
    };
    assert!(charge
        .boundaries
        .iter()
        .flat_map(|boundary| boundary.surfaces())
        .any(|surface| surface.object_id == "hm" && surface.surface_id == "x-"));
    assert_eq!(problem.spin_transport_modules[0].id, "spin_solve");
    let torque_edge = problem.physics_graph.as_ref().expect("physics graph")["edges"]
        .as_array()
        .expect("physics graph edges")
        .iter()
        .find(|edge| edge["target_id"] == "tr")
        .expect("transport torque edge");
    assert_eq!(torque_edge["source_id"], "spin_solve");
    assert_eq!(torque_edge["kind"], "spin_transport_to_torque");
    assert_eq!(
        serde_json::to_value(&problem.spin_torque_modules[0]).expect("torque must serialize")
            ["target"],
        serde_json::json!({"object_id": "fm", "region_id": "fm:torque"})
    );
}
