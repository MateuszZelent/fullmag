use fullmag_ir::{
    BackendPolicyIR, CurrentModuleIR, EnergyTermIR, MaterialIR, SpinTorqueModuleIR,
    SpinTransportModuleIR, StudyIR,
};
use serde::de::DeserializeOwned;
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../tests/standard_problems/transport/racetrack_m1_v1/fixture.v1.json"
    ))
    .expect("racetrack fixture must be valid JSON")
}

fn parse<T: DeserializeOwned>(lowering: &Value, key: &str) -> T {
    serde_json::from_value(
        lowering
            .get(key)
            .unwrap_or_else(|| panic!("expected_lowering must contain {key}"))
            .clone(),
    )
    .unwrap_or_else(|error| panic!("{key} must parse as current ProblemIR wire type: {error}"))
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

    let current: CurrentModuleIR = parse(lowering, "current_transport");
    let spin: SpinTransportModuleIR = parse(lowering, "spin_transport");
    let torque: SpinTorqueModuleIR = parse(lowering, "spin_torque");
    let material: MaterialIR = parse(lowering, "magnetic_material");
    let relax: StudyIR = parse(lowering, "relax_study");
    let drive: StudyIR = parse(lowering, "drive_study");
    let backend: BackendPolicyIR = parse(lowering, "backend_policy");
    let energy: Vec<EnergyTermIR> = serde_json::from_value(
        lowering
            .get("energy_terms")
            .expect("expected_lowering must contain energy_terms")
            .clone(),
    )
    .expect("energy_terms must parse as current EnergyTermIR values");

    let current_wire = serde_json::to_value(current).expect("current must serialize");
    assert_eq!(current_wire["kind"], "current_transport");
    assert_eq!(current_wire["model"], "ohmic_poisson");
    assert_eq!(current_wire["coupling"], "one_way");
    assert_eq!(
        current_wire["solver"]["operator_version"],
        "fv_charge_harmonic_v1"
    );
    assert_eq!(current_wire["boundaries"][0]["id"], "terminal_x_minus");
    assert_eq!(current_wire["boundaries"][1]["id"], "terminal_x_plus");

    let spin_wire = serde_json::to_value(spin).expect("spin must serialize");
    assert_eq!(spin_wire["current_source_id"], "charge");
    assert_eq!(spin_wire["mode"], "steady");
    assert_eq!(spin_wire["requested_execution"]["device"], "gpu");
    assert_eq!(
        spin_wire["constitutive_version"],
        "transport_constitutive.one_way.fullmag.v1"
    );

    let torque_wire = serde_json::to_value(torque).expect("torque must serialize");
    assert_eq!(torque_wire["kind"], "drift_diffusion_spin_torque");
    assert_eq!(torque_wire["solve_id"], "spin");
    assert_eq!(torque_wire["target"]["object_id"], "fm");
    assert_eq!(material.name, "fm_material");
    assert_eq!(energy.len(), 3);
    assert_eq!(
        serde_json::to_value(&energy[2]).expect("DMI term must serialize"),
        serde_json::json!({
            "kind": "interfacial_dmi",
            "D": 3.0e-3,
            "interface_normal": [0.0, 0.0, 1.0]
        })
    );

    let relax_wire = serde_json::to_value(relax).expect("relax study must serialize");
    let drive_wire = serde_json::to_value(drive).expect("drive study must serialize");
    assert_eq!(relax_wire["dynamics"]["integrator"], "rk4");
    assert_eq!(drive_wire["dynamics"]["integrator"], "rk4");
    assert_eq!(drive_wire["dynamics"]["fixed_timestep"], 1.0e-13);

    let backend_wire = serde_json::to_value(backend).expect("backend must serialize");
    assert_eq!(backend_wire["requested_backend"], "fdm");
    assert_eq!(backend_wire["execution_precision"], "double");
    assert_eq!(
        backend_wire["discretization_hints"]["fdm"]["cell"],
        serde_json::json!([2.0e-9, 2.0e-9, 1.0e-9])
    );
}
