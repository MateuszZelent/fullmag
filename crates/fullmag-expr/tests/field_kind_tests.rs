//! The field kind: a material parameter field `(x, y, z) -> number`
//! (`docs/specs/mask-function-v1.md`, sections 3 and 9).

use fullmag_expr::{
    compile_function, CompiledFunction, FunctionError, FunctionKind, FunctionSource,
};

fn compile(
    parameters: &[(&str, f64)],
    locals: &[(&str, &str)],
    outputs: &[&str],
) -> Result<CompiledFunction, FunctionError> {
    let parameters: Vec<(String, f64)> = parameters
        .iter()
        .map(|(name, value)| (name.to_string(), *value))
        .collect();
    let locals: Vec<(String, String)> = locals
        .iter()
        .map(|(name, text)| (name.to_string(), text.to_string()))
        .collect();
    let outputs: Vec<String> = outputs.iter().map(|text| text.to_string()).collect();
    compile_function(
        &FunctionSource {
            parameters: &parameters,
            locals: &locals,
            outputs: &outputs,
        },
        FunctionKind::Field,
    )
}

const ALPHA_RAMP: &str = "a0 + a_max * max(0.0, (x - x_edge) / L) ** 3";
const A0: f64 = 0.01;
const A_MAX: f64 = 0.5;
const X_EDGE: f64 = 2e-6;
const L: f64 = 600e-9;

fn alpha_ramp() -> CompiledFunction {
    compile(
        &[("a0", A0), ("a_max", A_MAX), ("x_edge", X_EDGE), ("L", L)],
        &[],
        &[ALPHA_RAMP],
    )
    .unwrap()
}

fn alpha_ramp_by_hand(x: f64) -> f64 {
    let u = ((x - X_EDGE) / L).max(0.0);
    A0 + A_MAX * u.powf(3.0)
}

#[test]
fn alpha_ramp_matches_the_closed_form() {
    let ramp = alpha_ramp();
    assert_eq!(ramp.kind(), FunctionKind::Field);
    for x in [0.0, 1e-6, 2e-6, 2.3e-6, 2.6e-6, 3e-6] {
        let value = ramp.eval_field([x, 5e-9, -1e-9]);
        assert_eq!(value, alpha_ramp_by_hand(x), "x = {x}");
    }
    assert_eq!(ramp.eval_field([X_EDGE, 0.0, 0.0]), A0);
    // u = 1 at the end of the ramp: a0 + a_max.
    assert!((ramp.eval_field([X_EDGE + L, 0.0, 0.0]) - (A0 + A_MAX)).abs() < 1e-15);
    assert!(ramp.depends_on_variables());
}

#[test]
fn field_reads_x_y_z_with_locals_and_the_mask_functions() {
    let field = compile(
        &[("r0", 2.0)],
        &[("r", "sqrt(x**2 + y**2)")],
        &["heaviside(r0 - r) * cos(pi * z) + min(abs(r - r0), atan2(y, x))"],
    )
    .unwrap();
    let point = [1.0, 1.0, 0.5];
    let r = 2.0_f64.sqrt();
    let expected = (std::f64::consts::PI * 0.5).cos() + (r - 2.0).abs().min(1.0_f64.atan2(1.0));
    assert_eq!(field.eval_field(point), expected);
}

#[test]
fn field_rejects_t_u_log1p_and_caret() {
    let error = compile(&[], &[], &["x + t"]).unwrap_err();
    assert_eq!(
        (error.code, error.path.as_str(), error.position),
        ("mask_function_wrong_variable", "outputs[0]", 4)
    );
    // `u` is an ordinary name outside a profile: unknown here.
    let error = compile(&[], &[], &["x + u"]).unwrap_err();
    assert_eq!((error.code, error.position), ("expr_unknown_name", 4));
    let error = compile(&[], &[], &["log1p(x)"]).unwrap_err();
    assert_eq!((error.code, error.position), ("expr_unknown_name", 0));
    let error = compile(&[], &[], &["x^2"]).unwrap_err();
    assert_eq!((error.code, error.position), ("expr_syntax", 1));
}

#[test]
fn field_has_exactly_one_output() {
    let error = compile(&[], &[], &["x", "y", "z"]).unwrap_err();
    assert_eq!((error.code, error.path.as_str()), ("expr_arity", "outputs"));
    let error = compile(&[], &[], &[]).unwrap_err();
    assert_eq!(error.code, "expr_arity");
}

#[test]
fn field_parameters_follow_the_shared_name_rules() {
    for name in ["x", "pi", "max", "lambda"] {
        let error = compile(&[(name, 1.0)], &[], &["x"]).unwrap_err();
        assert_eq!(
            (error.code, error.path.as_str()),
            ("expr_name_invalid", "parameters[0]"),
            "{name}"
        );
    }
    let error = compile(&[], &[], &["x + a0"]).unwrap_err();
    assert_eq!((error.code, error.position), ("expr_unknown_name", 4));
}

#[test]
fn field_evaluation_is_ieee_and_unchecked() {
    let pole = compile(&[], &[], &["1 / x"]).unwrap();
    assert_eq!(pole.eval_field([0.0, 0.0, 0.0]), f64::INFINITY);
    assert!(compile(&[], &[], &["sqrt(x)"])
        .unwrap()
        .eval_field([-1.0, 0.0, 0.0])
        .is_nan());
}

#[test]
fn canonical_output_of_the_alpha_ramp_is_python() {
    assert_eq!(
        alpha_ramp().canonical_outputs(),
        ["(0.01 + (0.5 * (max(0.0, ((x - 2e-6) / 6e-7))**3.0)))"]
    );
}

#[test]
#[should_panic(expected = "eval_field called on a distance function")]
fn eval_field_panics_for_another_kind() {
    compile_function(
        &FunctionSource {
            parameters: &[],
            locals: &[],
            outputs: &["x".to_string()],
        },
        FunctionKind::Distance,
    )
    .unwrap()
    .eval_field([0.0; 3]);
}
