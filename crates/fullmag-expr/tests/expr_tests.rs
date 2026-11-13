//! Grammar, error positions and the time bytecode of `field_expr.v1`.

use fullmag_expr::{
    compile_function, eval_time_program, FunctionError, FunctionKind, FunctionSource,
};

fn time_function(
    parameters: &[(&str, f64)],
    locals: &[(&str, &str)],
    output: &str,
) -> Result<fullmag_expr::CompiledFunction, FunctionError> {
    let parameters: Vec<(String, f64)> = parameters
        .iter()
        .map(|(name, value)| (name.to_string(), *value))
        .collect();
    let locals: Vec<(String, String)> = locals
        .iter()
        .map(|(name, text)| (name.to_string(), text.to_string()))
        .collect();
    let outputs = vec![output.to_string()];
    compile_function(
        &FunctionSource {
            parameters: &parameters,
            locals: &locals,
            outputs: &outputs,
        },
        FunctionKind::Time,
    )
}

fn mask_output_error(output: &str) -> FunctionError {
    let outputs = vec![output.to_string(), "0".to_string(), "0".to_string()];
    compile_function(
        &FunctionSource {
            parameters: &[],
            locals: &[],
            outputs: &outputs,
        },
        FunctionKind::Mask,
    )
    .expect_err("the equation must be rejected")
}

/// Values agree to `ulps` units in the last place (both signs of zero equal).
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
fn parses_precedence() {
    let function = time_function(&[], &[], "2+3*4^2^0.5").unwrap();
    let expected = 2.0 + 3.0 * 4.0_f64.powf(2.0_f64.powf(0.5));
    assert_eq!(function.eval_time(0.0), expected);
}

#[test]
fn unary_minus_binds_looser_than_power() {
    let function = time_function(&[], &[], "-2^2").unwrap();
    assert_eq!(function.eval_time(0.0), -4.0);
}

#[test]
fn spatial_variables() {
    let outputs = vec!["x+2*y-z".to_string(), "0".to_string(), "0".to_string()];
    let function = compile_function(
        &FunctionSource {
            parameters: &[],
            locals: &[],
            outputs: &outputs,
        },
        FunctionKind::Mask,
    )
    .unwrap();
    assert_eq!(function.eval_mask([1.0, 2.0, 3.0]), [2.0, 0.0, 0.0]);
}

#[test]
fn numbers_with_exponents_and_leading_dot() {
    let function = time_function(&[], &[], ".5e1 + 1.e-1 + 2E+2").unwrap();
    assert_eq!(function.eval_time(0.0), 5.0 + 0.1 + 200.0);
}

#[test]
fn rejects_time_in_mask() {
    let error = mask_output_error("sin(t)");
    assert_eq!(error.code, "mask_function_wrong_variable");
    assert_eq!(error.path, "outputs[0]");
    assert_eq!(error.position, 4);
}

#[test]
fn rejects_unknown_function() {
    let error = mask_output_error("sinn(x)");
    assert_eq!(error.code, "expr_unknown_name");
    assert_eq!(error.position, 0);
}

#[test]
fn rejects_unknown_name_with_position() {
    let error = mask_output_error("x + wavelenght");
    assert_eq!(error.code, "expr_unknown_name");
    assert_eq!(error.position, 4);
}

#[test]
fn rejects_arity() {
    let error = mask_output_error("atan2(x)");
    assert_eq!(error.code, "expr_arity");
    let error = mask_output_error("sin(x, y)");
    assert_eq!(error.code, "expr_arity");
}

#[test]
fn rejects_syntax_errors() {
    for (text, position) in [("x +", 3), ("(x", 2), ("x y", 2), ("x $ 1", 2), ("1e", 0)] {
        let error = mask_output_error(text);
        assert_eq!(error.code, "expr_syntax", "{text}");
        assert_eq!(error.position, position, "{text}");
    }
}

#[test]
fn rejects_function_name_without_call() {
    let error = mask_output_error("sin + x");
    assert_eq!(error.code, "expr_syntax");
}

#[test]
fn rejects_too_large() {
    let long = format!("x{}", " ".repeat(4096));
    assert_eq!(mask_output_error(&long).code, "expr_too_large");
    let many = vec!["x"; 300].join("+");
    assert_eq!(mask_output_error(&many).code, "expr_too_large");
}

#[test]
fn constant_function_compiles_to_push_return() {
    let function = time_function(&[], &[], "1").unwrap();
    assert!(!function.depends_on_variables());
    assert_eq!(function.time_program().code, vec![1.0, 1.0, 0.0]);
    assert_eq!(function.time_program().max_stack, 1);
}

#[test]
fn malformed_programs_evaluate_to_nan() {
    for code in [
        vec![],
        vec![2.0],
        vec![3.0, 0.0],
        vec![1.0],
        vec![1.0, 1.0, 0.0, 0.0],
        vec![99.0, 0.0],
        vec![2.5, 0.0],
        vec![2.0, 2.0, 0.0],
    ] {
        assert!(eval_time_program(&code, 1.0).is_nan(), "{code:?}");
    }
}

#[derive(Debug)]
struct GoldenCase {
    name: String,
    parameters: Vec<(String, f64)>,
    locals: Vec<(String, String)>,
    output: String,
    code: Vec<f64>,
    samples: Vec<(f64, f64)>,
}

fn golden_cases() -> Vec<GoldenCase> {
    let text = include_str!("fixtures/time_program_golden.json");
    let value: serde_json::Value = serde_json::from_str(text).unwrap();
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|case| GoldenCase {
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
            code: case["code"]
                .as_array()
                .unwrap()
                .iter()
                .map(|word| word.as_f64().unwrap())
                .collect(),
            samples: case["samples"]
                .as_array()
                .unwrap()
                .iter()
                .map(|pair| (pair[0].as_f64().unwrap(), pair[1].as_f64().unwrap()))
                .collect(),
        })
        .collect()
}

fn compile_golden(case: &GoldenCase) -> fullmag_expr::CompiledFunction {
    let outputs = vec![case.output.clone()];
    compile_function(
        &FunctionSource {
            parameters: &case.parameters,
            locals: &case.locals,
            outputs: &outputs,
        },
        FunctionKind::Time,
    )
    .unwrap_or_else(|error| panic!("{}: {error}", case.name))
}

/// The golden file comes from an independent Python implementation
/// (`fixtures/generate_time_program_golden.py`). Opcodes must match exactly;
/// folded literals and samples to 4 ulp (libm may differ in the last bit).
#[test]
fn golden_file_is_current() {
    let cases = golden_cases();
    assert_eq!(cases.len(), 14);
    let mut opcodes = std::collections::BTreeSet::new();
    for case in &cases {
        let program = compile_golden(case).time_program().clone();
        assert_eq!(program.code.len(), case.code.len(), "{}", case.name);
        let mut index = 0;
        while index < case.code.len() {
            let word = case.code[index];
            assert_eq!(program.code[index], word, "{} opcode at {index}", case.name);
            opcodes.insert(word as u32);
            if word == 1.0 {
                assert!(
                    close_in_ulps(program.code[index + 1], case.code[index + 1], 4),
                    "{} literal at {}: {} vs {}",
                    case.name,
                    index + 1,
                    program.code[index + 1],
                    case.code[index + 1]
                );
                index += 1;
            }
            index += 1;
        }
    }
    assert_eq!(
        opcodes,
        (0..=24).collect::<std::collections::BTreeSet<u32>>(),
        "every opcode is covered"
    );
}

#[test]
fn golden_samples_match_tree_and_bytecode() {
    for case in golden_cases() {
        let function = compile_golden(&case);
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
