//! `mask_field_drive.v1` in ProblemIR: wire form and validation.

use fullmag_ir::*;
use serde_json::{json, Value};

fn antenna_mask() -> Value {
    json!({
        "kind": "function",
        "function": {
            "expression_version": "field_expr.v1",
            "parameters": [
                {"name": "B01", "value": 0.0002, "source": "0.2 * mT"},
                {"name": "wavelength", "value": 2.79e-07, "source": "279 * nm"},
                {"name": "fwhm_y", "value": 2.4e-07, "source": "240 * nm"},
                {"name": "xs", "value": 2.608695652173913e-06, "source": "6000 * nm / 2.3"}
            ],
            "locals": [
                {"name": "k", "expression": "2 * pi / wavelength"},
                {"name": "sigma_y", "expression": "fwhm_y / (2 * sqrt(2 * log(2)))"},
                {"name": "g", "expression": "exp(-(x + xs)^2 / (2 * wavelength^2)) * exp(-y^2 / (2 * sigma_y^2))"}
            ],
            "outputs": ["B01 * g * sin(k * x - pi / 2)", "0.0", "B01 * g * sin(k * x)"]
        }
    })
}

fn antenna_time() -> Value {
    json!({
        "expression_version": "field_expr.v1",
        "parameters": [
            {"name": "frequency", "value": 3.6e9, "source": "3.6 * GHz"},
            {"name": "t0", "value": 0.0}
        ],
        "outputs": ["sin(2 * pi * frequency * (t - t0))"]
    })
}

fn antenna_drive() -> Value {
    json!({
        "schema_version": "mask_field_drive.v1",
        "id": "antenna",
        "name": "Antenna",
        "enabled": true,
        "target_object_id": "strip",
        "shape": {"kind": "box", "size": [6e-6, 1e-6, 4.5e-8], "center": [0.0, 0.0, 0.0]},
        "position_m": [0.0, 0.0, -1.5e-8],
        "frame": "world",
        "terms": [
            {"mask": antenna_mask(), "time": antenna_time()},
            {"mask": {
                "kind": "function",
                "function": {"expression_version": "field_expr.v1", "outputs": ["0", "0", "1e-4"]}
            }},
            {"mask": {
                "kind": "sampled",
                "path": "antenna_term2.npy",
                "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                "size": [1200, 200, 15],
                "cell_m": [5e-9, 5e-9, 5e-9],
                "origin_m": [-3e-6, -5e-7, -3.75e-8]
            }, "time": antenna_time(), "origin": {
                "function": "fullmag.antennas.gaussian_k_source",
                "arguments": {"amplitude": 0.0002, "wavelength": 2.79e-07},
                "call_index": 0,
                "output_index": 0
            }}
        ],
        "time_origin": "absolute",
        "activation": {"kind": "all_time_evolution"}
    })
}

fn problem_with(drives: Value) -> Value {
    let mut value = serde_json::to_value(ProblemIR::bootstrap_example()).unwrap();
    value["mask_field_drives"] = drives;
    value
}

fn errors_of(value: Value) -> Vec<String> {
    let problem: ProblemIR = serde_json::from_value(value).unwrap();
    problem.validate().err().unwrap_or_default()
}

fn assert_error(errors: &[String], code: &str, fragment: &str) {
    assert!(
        errors
            .iter()
            .any(|error| error.starts_with(code) && error.contains(fragment)),
        "no '{code}' error containing '{fragment}' in {errors:#?}"
    );
}

#[test]
fn problem_without_mask_drives_serializes_unchanged() {
    let problem = ProblemIR::bootstrap_example();
    let value = serde_json::to_value(&problem).unwrap();
    assert!(value.get("mask_field_drives").is_none());
    let decoded: ProblemIR = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), value);
}

#[test]
fn mask_field_drive_round_trips() {
    let value = problem_with(json!([antenna_drive()]));
    let decoded: ProblemIR = serde_json::from_value(value.clone()).unwrap();
    decoded.validate().expect("the antenna drive is valid");
    assert_eq!(decoded.mask_field_drives.len(), 1);
    assert_eq!(decoded.mask_field_drives[0].terms.len(), 3);
    assert!(decoded.mask_field_drives[0].is_time_dependent());
    assert_eq!(
        serde_json::to_value(&decoded).unwrap()["mask_field_drives"],
        value["mask_field_drives"]
    );
}

#[test]
fn time_origin_defaults_to_stage_local_and_accepts_absolute() {
    let mut drive = antenna_drive();
    drive.as_object_mut().unwrap().remove("time_origin");
    let problem: ProblemIR = serde_json::from_value(problem_with(json!([drive]))).unwrap();
    assert_eq!(
        problem.mask_field_drives[0].time_origin,
        FieldTimeOriginIR::StageLocal
    );
    let problem: ProblemIR =
        serde_json::from_value(problem_with(json!([antenna_drive()]))).unwrap();
    assert_eq!(
        problem.mask_field_drives[0].time_origin,
        FieldTimeOriginIR::Absolute
    );
}

#[test]
fn unknown_fields_are_rejected() {
    let mut drive = antenna_drive();
    drive["amplitude_B_T"] = json!(1.0);
    assert!(serde_json::from_value::<ProblemIR>(problem_with(json!([drive]))).is_err());
}

#[test]
fn rejects_mask_using_t() {
    let mut drive = antenna_drive();
    drive["terms"][0]["mask"]["function"]["outputs"][0] = json!("B01 * sin(t)");
    assert_error(
        &errors_of(problem_with(json!([drive]))),
        "mask_function_wrong_variable",
        "mask_field_drives[0].terms[0].mask.outputs[0] @10",
    );
}

#[test]
fn rejects_time_using_x() {
    let mut drive = antenna_drive();
    drive["terms"][0]["time"]["outputs"][0] = json!("sin(x)");
    assert_error(
        &errors_of(problem_with(json!([drive]))),
        "mask_function_wrong_variable",
        "mask_field_drives[0].terms[0].time.outputs[0] @4",
    );
}

#[test]
fn rejects_unknown_target() {
    let mut drive = antenna_drive();
    drive["target_object_id"] = json!("nope");
    assert_error(
        &errors_of(problem_with(json!([drive]))),
        "mask_target_unknown",
        "'nope'",
    );
}

#[test]
fn rejects_non_finite_parameter() {
    let mut value = problem_with(json!([antenna_drive()]));
    let mut problem: ProblemIR = serde_json::from_value(value.take()).unwrap();
    let MaskSourceIR::Function { function } = &mut problem.mask_field_drives[0].terms[0].mask
    else {
        panic!("function mask expected");
    };
    function.parameters[0].value = f64::NAN;
    let errors = problem.validate().unwrap_err();
    assert!(
        errors
            .iter()
            .any(|error| error.contains("parameters[0] 'B01' must be finite")),
        "{errors:#?}"
    );
}

#[test]
fn rejects_zero_or_nine_terms() {
    let mut drive = antenna_drive();
    drive["terms"] = json!([]);
    assert_error(
        &errors_of(problem_with(json!([drive]))),
        "mask_too_many_terms",
        "0 terms",
    );
    let mut drive = antenna_drive();
    let term = drive["terms"][1].clone();
    drive["terms"] = Value::Array(vec![term; 9]);
    assert_error(
        &errors_of(problem_with(json!([drive]))),
        "mask_too_many_terms",
        "9 terms",
    );
}

#[test]
fn rejects_duplicate_ids_also_against_regional_drives() {
    let errors = errors_of(problem_with(json!([antenna_drive(), antenna_drive()])));
    assert_error(
        &errors,
        "mask_field_drive_invalid",
        "'antenna' is already used",
    );
}

#[test]
fn rejects_bad_shape_and_sampled_lattice() {
    let mut drive = antenna_drive();
    drive["shape"]["size"][0] = json!(0.0);
    assert_error(
        &errors_of(problem_with(json!([drive]))),
        "mask_shape_invalid",
        "mask_field_drives[0].shape",
    );
    let mut drive = antenna_drive();
    drive["terms"][2]["mask"]["sha256"] = json!("xyz");
    assert_error(
        &errors_of(problem_with(json!([drive]))),
        "mask_array_invalid",
        "mask_field_drives[0].terms[2].mask",
    );
}

#[test]
fn drive_active_in_relax_requires_constant_time() {
    let mut value = problem_with(json!([antenna_drive()]));
    value["mask_field_drives"][0]["activation"] =
        json!({"kind": "stage_ids", "stage_ids": ["relax"]});
    let mut problem: ProblemIR = serde_json::from_value(value).unwrap();
    let sampling = problem.study.sampling().clone();
    problem.study = StudyIR::Relaxation {
        algorithm: RelaxationAlgorithmIR::ProjectedGradientBb,
        dynamics: None,
        stop: RelaxStopIR {
            torque_tolerance_apm: None,
            energy_tolerance_j: None,
            max_steps: Some(100),
            max_relaxation_time_s: None,
        },
        sampling,
    };
    problem
        .problem_meta
        .runtime_metadata
        .insert("active_stage_id".into(), json!("relax"));
    let errors = problem.validate().unwrap_err();
    assert!(
        errors
            .iter()
            .any(|error| error.starts_with("mask_field_drive_invalid")
                && error.contains("active in a relaxation stage")),
        "{errors:#?}"
    );
}
