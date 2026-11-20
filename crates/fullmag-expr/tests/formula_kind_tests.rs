//! Profile and distance kinds, `log1p`, the per-kind function table and the
//! leading-zero rule (`docs/specs/mask-function-v1.md`, sections 3 and 8).
//!
//! The accept/reject table of absorbing-boundary formulas is
//! `crates/fullmag-ir/tests/fixtures/absorbing_boundary_formula_cases.json`,
//! checked by `fullmag-ir` and by the Python tests.

use fullmag_expr::{
    compile_function, CompiledFunction, FunctionError, FunctionKind, FunctionSource,
};

fn compile(
    parameters: &[(&str, f64)],
    locals: &[(&str, &str)],
    outputs: &[&str],
    kind: FunctionKind,
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
        kind,
    )
}

fn formula(text: &str, kind: FunctionKind) -> Result<CompiledFunction, FunctionError> {
    compile(&[], &[], &[text], kind)
}

#[test]
fn profile_reads_u_and_evaluates_with_the_shared_functions() {
    let profile = formula("log1p(9*u)/log(10)", FunctionKind::Profile).unwrap();
    assert_eq!(profile.kind(), FunctionKind::Profile);
    assert_eq!(profile.eval_profile(0.5), 4.5_f64.ln_1p() / 10.0_f64.ln());
    assert_eq!(
        profile.eval_profile(0.25),
        (9.0_f64 * 0.25).ln_1p() / 10.0_f64.ln()
    );
    let ramp = formula("min(2*u, 1) * sin(pi*u/2)", FunctionKind::Profile).unwrap();
    assert_eq!(
        ramp.eval_profile(0.25),
        0.5 * (std::f64::consts::PI * 0.25 / 2.0).sin()
    );
    assert_eq!(profile.canonical_outputs(), ["(log1p((9.0 * u)) / log(10.0))"]);
    assert!(profile.depends_on_variables());
}

#[test]
fn distance_reads_x_y_z() {
    let distance = formula("min(5 - sqrt(x*x + y*y), z)", FunctionKind::Distance).unwrap();
    assert_eq!(distance.eval_distance([3.0, 4.0, 1.0]), 0.0);
    assert_eq!(distance.eval_distance([0.0, 0.0, -1.0]), -1.0);
}

#[test]
fn variables_belong_to_their_kind() {
    for (text, kind, position) in [
        ("u + x", FunctionKind::Profile, 4),
        ("u * t", FunctionKind::Profile, 4),
        ("x + t", FunctionKind::Distance, 4),
    ] {
        let error = formula(text, kind).unwrap_err();
        assert_eq!(error.code, "mask_function_wrong_variable", "{text}");
        assert_eq!(error.position, position, "{text}");
    }
    let error = formula("x + u", FunctionKind::Distance).unwrap_err();
    assert_eq!((error.code, error.position), ("expr_unknown_name", 4));
    let error = formula("u", FunctionKind::Mask).unwrap_err();
    assert_eq!(error.code, "expr_arity");
    // `u` stays an ordinary name in a mask or time function.
    let time = compile(&[("u", 2.0)], &[], &["u * t"], FunctionKind::Time).unwrap();
    assert_eq!(time.eval_time(3.0), 6.0);
    let mask = compile(&[], &[("u", "2 * x")], &["u", "0", "0"], FunctionKind::Mask).unwrap();
    assert_eq!(mask.eval_mask([1.5, 0.0, 0.0]), [3.0, 0.0, 0.0]);
    // In a profile it may name neither a parameter nor a local.
    let error = compile(&[("u", 2.0)], &[], &["u"], FunctionKind::Profile).unwrap_err();
    assert_eq!((error.code, error.path.as_str()), ("expr_name_invalid", "parameters[0]"));
    let error = compile(&[], &[("u", "1")], &["u"], FunctionKind::Profile).unwrap_err();
    assert_eq!((error.code, error.path.as_str()), ("expr_name_invalid", "locals[0]"));
}

#[test]
fn log1p_and_heaviside_depend_on_the_kind() {
    formula("log1p(u)", FunctionKind::Profile).unwrap();
    formula("log1p(x)", FunctionKind::Distance).unwrap();
    for kind in [FunctionKind::Time, FunctionKind::Mask] {
        let outputs: &[&str] = if kind == FunctionKind::Time {
            &["log1p(t)"]
        } else {
            &["log1p(x)", "0", "0"]
        };
        let error = compile(&[], &[], outputs, kind).unwrap_err();
        assert_eq!((error.code, error.position), ("expr_unknown_name", 0));
    }
    formula("heaviside(t - 1)", FunctionKind::Time).unwrap();
    compile(&[], &[], &["heaviside(x)", "0", "0"], FunctionKind::Mask).unwrap();
    for (text, kind) in [
        ("heaviside(u)", FunctionKind::Profile),
        ("heaviside(x)", FunctionKind::Distance),
    ] {
        let error = formula(text, kind).unwrap_err();
        assert_eq!((error.code, error.position), ("expr_unknown_name", 0), "{text}");
    }
    // `log1p` is reserved like every function name.
    let error = compile(&[("log1p", 1.0)], &[], &["t"], FunctionKind::Time).unwrap_err();
    assert_eq!(error.code, "expr_name_invalid");
}

#[test]
fn caret_is_a_legacy_power_of_mask_and_time_only() {
    assert_eq!(formula("t ^ 2", FunctionKind::Time).unwrap().eval_time(3.0), 9.0);
    for (text, kind) in [("u^2", FunctionKind::Profile), ("x^2", FunctionKind::Distance)] {
        let error = formula(text, kind).unwrap_err();
        assert_eq!((error.code, error.position), ("expr_syntax", 1), "{text}");
    }
}

#[test]
fn integer_literals_with_a_leading_zero_are_rejected_as_in_python() {
    for (text, position) in [("01", 0), ("t * 007", 4), ("2 + 0010", 4)] {
        let error = formula(text, FunctionKind::Time).unwrap_err();
        assert_eq!((error.code, error.position), ("expr_syntax", position), "{text}");
    }
    for (text, value) in [
        ("0", 0.0),
        ("00", 0.0),
        ("0.5", 0.5),
        ("01.5", 1.5),
        ("01e1", 10.0),
        ("01.", 1.0),
        ("10", 10.0),
    ] {
        assert_eq!(
            formula(text, FunctionKind::Time).unwrap().eval_time(0.0),
            value,
            "{text}"
        );
    }
}

#[test]
fn evaluation_is_ieee_and_unchecked() {
    let profile = formula("u + 1/exp(999)", FunctionKind::Profile).unwrap();
    assert_eq!(profile.eval_profile(0.5), 0.5);
    let pole = formula("1/(u - 0.5)", FunctionKind::Profile).unwrap();
    assert_eq!(pole.eval_profile(0.5), f64::INFINITY);
    assert!(formula("sqrt(u - 1)", FunctionKind::Profile)
        .unwrap()
        .eval_profile(0.0)
        .is_nan());
}

#[test]
#[should_panic(expected = "eval_profile called on a distance function")]
fn eval_profile_panics_for_another_kind() {
    formula("x", FunctionKind::Distance).unwrap().eval_profile(0.5);
}
