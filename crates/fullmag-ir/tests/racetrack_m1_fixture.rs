use fullmag_ir::{
    GeometryIR, ProblemIR, ValidationProfileIR,
};
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../tests/standard_problems/transport/racetrack_m1_v1/fixture.v1.json"
    ))
    .expect("racetrack fixture must be valid JSON")
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

    let current_wire = serde_json::to_value(&problem.current_modules[0])
        .expect("current must serialize");
    assert_eq!(current_wire["kind"], "current_transport");
    assert_eq!(current_wire["model"], "ohmic_poisson");
    assert_eq!(current_wire["coupling"], "one_way");
    assert_eq!(
        current_wire["solver"]["operator_version"],
        "fv_charge_harmonic_v1"
    );
    assert_eq!(current_wire["boundaries"][0]["id"], "terminal_x_minus");
    assert_eq!(current_wire["boundaries"][1]["id"], "terminal_x_plus");

    let spin_wire = serde_json::to_value(&problem.spin_transport_modules[0])
        .expect("spin must serialize");
    assert_eq!(spin_wire["current_source_id"], "charge");
    assert_eq!(spin_wire["mode"], "steady");
    assert_eq!(spin_wire["requested_execution"]["device"], "gpu");
    assert_eq!(
        spin_wire["constitutive_version"],
        "transport_constitutive.one_way.fullmag.v1"
    );

    let torque_wire = serde_json::to_value(&problem.spin_torque_modules[0])
        .expect("torque must serialize");
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
