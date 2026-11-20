//! `MaterialParameterFieldIR::Function`: serde shape, round trip and validation
//! (`docs/specs/material-assignment-and-spatial-fields-v0.md`,
//! `docs/specs/mask-function-v1.md`, section 9).

use fullmag_ir::{
    FunctionIR, FunctionParameterIR, MaterialParameterFieldIR, MaterialParameterNameIR as Parameter,
    ProblemIR, RegionFrameIR,
};
use serde_json::{json, Value};

fn alpha_ramp_json() -> Value {
    json!({
        "kind": "function",
        "function": {
            "expression_version": "field_expr.v1",
            "parameters": [
                {"name": "a0", "value": 0.01},
                {"name": "a_max", "value": 0.5},
                {"name": "x_edge", "value": 2e-6},
                {"name": "L", "value": 6e-7}
            ],
            "outputs": ["a0 + a_max*max(0.0, (x - x_edge)/L)**3"]
        },
        "frame": "object"
    })
}

fn problem_with(parameter: Parameter, field: Value) -> ProblemIR {
    let mut problem = ProblemIR::bootstrap_example();
    problem.material_parameter_fields.push(
        serde_json::from_value(json!({
            "assignment_id": "strip:object:field", "owner_object": "strip",
            "parameter": parameter, "value": field
        }))
        .unwrap(),
    );
    problem
}

fn errors(parameter: Parameter, field: Value) -> String {
    format!(
        "{:?}",
        problem_with(parameter, field)
            .validate()
            .expect_err("the field must be rejected")
    )
}

#[test]
fn function_field_deserializes_into_the_typed_variant_and_round_trips() {
    let field: MaterialParameterFieldIR = serde_json::from_value(alpha_ramp_json()).unwrap();
    let MaterialParameterFieldIR::Function {
        function,
        frame,
        unit,
    } = &field
    else {
        panic!("expected a function field, got {field:?}");
    };
    assert_eq!(*frame, RegionFrameIR::Object);
    assert_eq!(*unit, None);
    assert_eq!(function.name, None, "an equation string carries no function name");
    assert_eq!(
        function.parameters[3],
        FunctionParameterIR {
            name: "L".to_string(),
            value: 6e-7,
            source: None
        }
    );
    assert_eq!(serde_json::to_value(&field).unwrap(), alpha_ramp_json());

    // A `def` keeps its name and its locals; the frame defaults to the object.
    let authored_def = json!({
        "kind": "function",
        "function": {
            "expression_version": "field_expr.v1",
            "name": "alpha",
            "parameters": [{"name": "x0", "value": 1e-6, "source": "1 * um"}],
            "locals": [{"name": "s", "expression": "x - x0"}],
            "outputs": ["0.01 + max(0.0, s)"]
        },
        "unit": "1"
    });
    let field: MaterialParameterFieldIR = serde_json::from_value(authored_def.clone()).unwrap();
    let mut expected = authored_def;
    expected["frame"] = json!("object");
    assert_eq!(serde_json::to_value(&field).unwrap(), expected);
}

#[test]
fn function_field_validates_and_compiles_to_the_field_kind() {
    let problem = problem_with(Parameter::Alpha, alpha_ramp_json());
    problem.validate().unwrap();
    let compiled = problem.material_parameter_fields[0]
        .value
        .compile_function(Parameter::Alpha)
        .expect("a function field compiles")
        .unwrap();
    assert_eq!(compiled.kind(), fullmag_expr::FunctionKind::Field);
    assert!((compiled.eval_field([2.3e-6, 0.0, 0.0]) - (0.01 + 0.5 * 0.125)).abs() < 1e-15);
    // Other kinds have no equation.
    let linear: MaterialParameterFieldIR = serde_json::from_value(json!({
        "kind": "linear", "base": 0.01, "gradient": [0.0, 0.0, 0.0]
    }))
    .unwrap();
    assert!(linear.compile_function(Parameter::Alpha).is_none());
}

#[test]
fn function_field_rejects_vector_parameters() {
    let message = errors(Parameter::AnisotropyAxis, alpha_ramp_json());
    assert!(
        message.contains("material_field_function_invalid")
            && message.contains("vector parameter"),
        "{message}"
    );
}

#[test]
fn function_field_reports_engine_errors_with_their_path() {
    let mut field = alpha_ramp_json();
    field["function"]["outputs"] = json!(["a0 + t"]);
    let message = errors(Parameter::Alpha, field);
    assert!(
        message.contains("material_parameter_fields[0]: mask_function_wrong_variable: function.outputs[0] @5"),
        "{message}"
    );

    let mut field = alpha_ramp_json();
    field["function"]["outputs"] = json!(["a0", "a_max", "L"]);
    assert!(errors(Parameter::Alpha, field).contains("expr_arity"));

    let mut field = alpha_ramp_json();
    field["function"]["outputs"] = json!(["a0 + unknown * x"]);
    assert!(errors(Parameter::Alpha, field).contains("expr_unknown_name: function.outputs[0] @5"));
}

#[test]
fn function_field_rejects_bad_versions_values_and_names() {
    let mut field = alpha_ramp_json();
    field["function"]["expression_version"] = json!("field_expr.v0");
    assert!(errors(Parameter::Alpha, field).contains("expression_version must be 'field_expr.v1'"));

    // JSON has no infinity: the value reaches the check through the typed IR.
    let mut problem = problem_with(Parameter::Alpha, alpha_ramp_json());
    let MaterialParameterFieldIR::Function { function, .. } =
        &mut problem.material_parameter_fields[0].value
    else {
        unreachable!()
    };
    function.parameters[0].value = f64::INFINITY;
    let message = format!("{:?}", problem.validate().unwrap_err());
    assert!(message.contains("function.parameters[0] 'a0' must be finite"), "{message}");

    for name in ["max", "not a name", "class"] {
        let mut field = alpha_ramp_json();
        field["function"]["name"] = json!(name);
        let message = errors(Parameter::Alpha, field);
        assert!(message.contains("function.name"), "{name}: {message}");
    }
}

#[test]
fn function_field_in_a_region_override_is_validated_too() {
    let mut problem = ProblemIR::bootstrap_example();
    let mut field = alpha_ramp_json();
    field["function"]["outputs"] = json!(["x^2"]);
    problem.object_regions.push(
        serde_json::from_value(json!({
            "region_id": "strip:core", "owner_object": "strip", "name": "core",
            "shape": {"kind": "box", "size": [1e-9, 1e-9, 1e-9], "center": [0.0, 0.0, 0.0]},
            "enabled": true,
            "material_overrides": [{"parameter": "alpha", "value": field}]
        }))
        .unwrap(),
    );
    let message = format!("{:?}", problem.validate().unwrap_err());
    assert!(
        message.contains("object_regions[0].material_overrides[0]: expr_syntax: function.outputs[0] @1"),
        "{message}"
    );
}

#[test]
fn function_ir_type_is_shared_with_mask_functions() {
    // The variant stores the same `FunctionIR` as a mask or time function.
    let function: FunctionIR =
        serde_json::from_value(alpha_ramp_json()["function"].clone()).unwrap();
    assert_eq!(function.outputs.len(), 1);
}
