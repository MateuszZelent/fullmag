//! `**` is the power operator of `field_expr.v1`, with Python's precedence;
//! `^` stays a legacy spelling of the same operator.
//!
//! The table `fixtures/power_operator_cases.json` is shared with the Python test
//! `packages/fullmag-py/tests/test_field_expr_power_cases.py`, which checks every
//! expected value and canonical text against Python's own `eval`.

use fullmag_expr::{
    compile_function, eval_time_program, CompiledFunction, FunctionError, FunctionKind,
    FunctionSource,
};

struct Case {
    name: String,
    parameters: Vec<(String, f64)>,
    locals: Vec<(String, String)>,
    output: String,
    canonical: String,
    samples: Vec<(f64, f64)>,
}

fn cases() -> Vec<Case> {
    let text = include_str!("fixtures/power_operator_cases.json");
    let value: serde_json::Value = serde_json::from_str(text).unwrap();
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|case| Case {
            name: case["name"].as_str().unwrap().to_string(),
            parameters: case["parameters"]
                .as_array()
                .unwrap()
                .iter()
                .map(|pair| {
                    (
                        pair[0].as_str().unwrap().to_string(),
                        pair[1].as_f64().unwrap(),
                    )
                })
                .collect(),
            locals: case["locals"]
                .as_array()
                .unwrap()
                .iter()
                .map(|pair| {
                    (
                        pair[0].as_str().unwrap().to_string(),
                        pair[1].as_str().unwrap().to_string(),
                    )
                })
                .collect(),
            output: case["output"].as_str().unwrap().to_string(),
            canonical: case["canonical"].as_str().unwrap().to_string(),
            samples: case["samples"]
                .as_array()
                .unwrap()
                .iter()
                .map(|pair| (pair[0].as_f64().unwrap(), pair[1].as_f64().unwrap()))
                .collect(),
        })
        .collect()
}

fn time_function(
    parameters: &[(String, f64)],
    locals: &[(String, String)],
    output: &str,
) -> Result<CompiledFunction, FunctionError> {
    let outputs = vec![output.to_string()];
    compile_function(
        &FunctionSource {
            parameters,
            locals,
            outputs: &outputs,
        },
        FunctionKind::Time,
    )
}

fn value(output: &str, t: f64) -> f64 {
    time_function(&[], &[], output)
        .unwrap_or_else(|error| panic!("{output}: {error}"))
        .eval_time(t)
}

/// The legacy spelling of a text: every `**` written as `^`.
fn legacy(text: &str) -> String {
    text.replace("**", "^")
}

/// Values agree to `ulps` units in the last place (libm may differ in the last bit).
fn close_in_ulps(left: f64, right: f64, ulps: u64) -> bool {
    if left == right {
        return true;
    }
    if !left.is_finite() || !right.is_finite() || left.signum() != right.signum() {
        return false;
    }
    left.to_bits().abs_diff(right.to_bits()) <= ulps
}

#[test]
fn shared_cases_evaluate_as_python() {
    let cases = cases();
    assert_eq!(cases.len(), 11);
    for case in &cases {
        let function = time_function(&case.parameters, &case.locals, &case.output)
            .unwrap_or_else(|error| panic!("{}: {error}", case.name));
        for (t, expected) in &case.samples {
            let tree = function.eval_time(*t);
            let program = eval_time_program(&function.time_program().code, *t);
            assert_eq!(tree.to_bits(), program.to_bits(), "{} at {t}", case.name);
            assert!(
                close_in_ulps(tree, *expected, 4),
                "{} at {t}: {tree} vs {expected}",
                case.name
            );
        }
    }
}

#[test]
fn shared_cases_have_python_canonical_text() {
    for case in cases() {
        let function = time_function(&case.parameters, &case.locals, &case.output).unwrap();
        assert_eq!(
            function.canonical_outputs(),
            vec![case.canonical.clone()],
            "{}",
            case.name
        );
        // The canonical text reads back to the same values.
        let reparsed = time_function(&[], &[], &case.canonical).unwrap();
        for (t, _) in &case.samples {
            assert_eq!(
                reparsed.eval_time(*t).to_bits(),
                function.eval_time(*t).to_bits(),
                "{} at {t}",
                case.name
            );
        }
    }
}

/// `^` keeps its meaning: the legacy spelling of every case compiles to the
/// same bytecode and the same canonical text.
#[test]
fn legacy_caret_equals_double_star() {
    for case in cases() {
        let locals: Vec<(String, String)> = case
            .locals
            .iter()
            .map(|(name, text)| (name.clone(), legacy(text)))
            .collect();
        let old = time_function(&case.parameters, &locals, &legacy(&case.output))
            .unwrap_or_else(|error| panic!("{} (legacy): {error}", case.name));
        let new = time_function(&case.parameters, &case.locals, &case.output).unwrap();
        assert_eq!(
            old.time_program().code,
            new.time_program().code,
            "{}",
            case.name
        );
        assert_eq!(old.canonical_outputs(), new.canonical_outputs(), "{}", case.name);
    }
}

#[test]
fn caret_and_double_star_mix_as_one_operator() {
    let expected = 2.0_f64.powf(9.0);
    for text in ["2**3**2", "2^3^2", "2**3^2", "2^3**2"] {
        assert_eq!(value(text, 0.0), expected, "{text}");
    }
    assert_eq!(value("-2^2", 0.0), -4.0);
    assert_eq!(value("2^-1", 0.0), 0.5);
}

#[test]
fn power_binds_tighter_than_unary_minus_on_its_left() {
    assert_eq!(value("-2**2", 0.0), -4.0);
    assert_eq!(value("(-2)**2", 0.0), 4.0);
    assert_eq!(value("-t**2", 3.0), -9.0);
}

#[test]
fn power_accepts_unary_minus_on_its_right() {
    assert_eq!(value("2**-1", 0.0), 0.5);
    assert_eq!(value("2**-t**2", 2.0), 2.0_f64.powf(-4.0));
    assert_eq!(value("2**--1", 0.0), 2.0);
}

#[test]
fn power_is_right_associative() {
    assert_eq!(value("(2**3)**2", 0.0), 64.0);
    assert_eq!(value("2**3**2", 0.0), 512.0);
}

#[test]
fn double_star_needs_touching_stars() {
    let outputs = vec!["x * * 2".to_string(), "0".to_string(), "0".to_string()];
    let error = compile_function(
        &FunctionSource {
            parameters: &[],
            locals: &[],
            outputs: &outputs,
        },
        FunctionKind::Mask,
    )
    .expect_err("`* *` is not a power");
    assert_eq!(error.code, "expr_syntax");
    assert_eq!(error.position, 4);
    for text in ["x ***2", "x ** * 2", "** x"] {
        let outputs = vec![text.to_string(), "0".to_string(), "0".to_string()];
        let error = compile_function(
            &FunctionSource {
                parameters: &[],
                locals: &[],
                outputs: &outputs,
            },
            FunctionKind::Mask,
        )
        .expect_err(text);
        assert_eq!(error.code, "expr_syntax", "{text}");
    }
}

#[test]
fn double_star_error_positions_point_at_the_operator() {
    let error = time_function(&[], &[], "t **").expect_err("missing exponent");
    assert_eq!(error.code, "expr_syntax");
    assert_eq!(error.position, 4);
    let error = time_function(&[], &[], "t ** 2 ** ").expect_err("missing exponent");
    assert_eq!(error.position, 10);
}
