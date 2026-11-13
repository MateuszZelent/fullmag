//! Mask and time functions: parameters, locals, outputs and their errors.

use std::f64::consts::PI;

use fullmag_expr::{compile_function, CompiledFunction, FunctionKind, FunctionSource};

fn owned(parameters: &[(&str, f64)], locals: &[(&str, &str)], outputs: &[&str]) -> Owned {
    Owned {
        parameters: parameters
            .iter()
            .map(|(name, value)| (name.to_string(), *value))
            .collect(),
        locals: locals
            .iter()
            .map(|(name, text)| (name.to_string(), text.to_string()))
            .collect(),
        outputs: outputs.iter().map(|text| text.to_string()).collect(),
    }
}

struct Owned {
    parameters: Vec<(String, f64)>,
    locals: Vec<(String, String)>,
    outputs: Vec<String>,
}

impl Owned {
    fn compile(&self, kind: FunctionKind) -> Result<CompiledFunction, fullmag_expr::FunctionError> {
        compile_function(
            &FunctionSource {
                parameters: &self.parameters,
                locals: &self.locals,
                outputs: &self.outputs,
            },
            kind,
        )
    }
}

const B01: f64 = 2e-4;
const WAVELENGTH: f64 = 279e-9;
const FWHM_Y: f64 = 240e-9;
const XS: f64 = 6e-6 / 2.3;

/// The antenna of the mumax3 reference script, as the transpiler writes it.
fn antenna_mask() -> Owned {
    owned(
        &[
            ("B01", B01),
            ("wavelength", WAVELENGTH),
            ("fwhm_y", FWHM_Y),
            ("xs", XS),
        ],
        &[
            ("k", "2 * pi / wavelength"),
            ("sigma_y", "fwhm_y / (2 * sqrt(2 * log(2)))"),
            (
                "g",
                "exp(-(x + xs)^2 / (2 * wavelength^2)) * exp(-y^2 / (2 * sigma_y^2))",
            ),
        ],
        &[
            "B01 * g * sin(k * x - pi / 2)",
            "0.0",
            "B01 * g * sin(k * x)",
        ],
    )
}

fn antenna_closed_form(point: [f64; 3]) -> [f64; 3] {
    let [x, y, _] = point;
    let k = 2.0 * PI / WAVELENGTH;
    let sigma_y = FWHM_Y / (2.0 * (2.0 * 2.0_f64.ln()).sqrt());
    let g = (-(x + XS).powf(2.0) / (2.0 * WAVELENGTH.powf(2.0))).exp()
        * (-(y.powf(2.0)) / (2.0 * sigma_y.powf(2.0))).exp();
    [
        B01 * g * (k * x - PI / 2.0).sin(),
        0.0,
        B01 * g * (k * x).sin(),
    ]
}

#[test]
fn user_antenna_mask_matches_closed_form() {
    let mask = antenna_mask().compile(FunctionKind::Mask).unwrap();
    for point in [
        [-2.6e-6, 1e-8, 0.0],
        [-2.5e-6, -1.2e-7, 5e-9],
        [-2.75e-6, 3e-7, -2e-8],
        [0.0, 0.0, 0.0],
        [1.5e-6, 4.9e-7, 1e-8],
    ] {
        let value = mask.eval_mask(point);
        let expected = antenna_closed_form(point);
        for component in 0..3 {
            let scale = expected[component].abs().max(1e-30);
            assert!(
                (value[component] - expected[component]).abs() <= 1e-15 * scale,
                "{point:?}[{component}]: {} vs {}",
                value[component],
                expected[component]
            );
        }
        assert_eq!(value[1], 0.0);
    }
}

#[test]
fn user_antenna_time_matches_sine() {
    let time = owned(
        &[("frequency", 3.6e9), ("t0", 0.0)],
        &[],
        &["sin(2 * pi * frequency * (t - t0))"],
    )
    .compile(FunctionKind::Time)
    .unwrap();
    for t in [0.0, 1e-12, 7.3e-11, 2.5e-9, 1.5e-8] {
        let expected = (2.0 * PI * 3.6e9 * (t - 0.0)).sin();
        assert_eq!(time.eval_time(t).to_bits(), expected.to_bits(), "{t}");
        assert_eq!(
            fullmag_expr::eval_time_program(&time.time_program().code, t).to_bits(),
            expected.to_bits(),
            "{t}"
        );
    }
}

#[test]
fn locals_are_evaluated_in_order() {
    let time = owned(&[("a", 2.0)], &[("b", "a * t"), ("c", "b + 1")], &["c * c"])
        .compile(FunctionKind::Time)
        .unwrap();
    assert_eq!(time.eval_time(3.0), 49.0);
}

#[test]
fn local_refers_to_later_local() {
    let error = owned(&[], &[("b", "c + 1"), ("c", "t")], &["b"])
        .compile(FunctionKind::Time)
        .unwrap_err();
    assert_eq!(error.code, "expr_unknown_name");
    assert_eq!(error.path, "locals[0]");
    assert_eq!(error.position, 0);
}

#[test]
fn mask_rejects_t_in_a_local() {
    let error = owned(&[], &[("phase", "x - 3 * t")], &["phase", "0", "0"])
        .compile(FunctionKind::Mask)
        .unwrap_err();
    assert_eq!(error.code, "mask_function_wrong_variable");
    assert_eq!(error.path, "locals[0]");
    assert_eq!(error.position, 8);
}

#[test]
fn time_rejects_x() {
    let error = owned(&[], &[], &["sin(x)"])
        .compile(FunctionKind::Time)
        .unwrap_err();
    assert_eq!(error.code, "mask_function_wrong_variable");
    assert_eq!(error.path, "outputs[0]");
    assert_eq!(error.position, 4);
}

#[test]
fn mask_needs_three_outputs_and_time_one() {
    let error = owned(&[], &[], &["x", "y"])
        .compile(FunctionKind::Mask)
        .unwrap_err();
    assert_eq!((error.code, error.path.as_str()), ("expr_arity", "outputs"));
    let error = owned(&[], &[], &["t", "t"])
        .compile(FunctionKind::Time)
        .unwrap_err();
    assert_eq!((error.code, error.path.as_str()), ("expr_arity", "outputs"));
}

#[test]
fn parameter_shadowing_variable_or_function_is_rejected() {
    for name in ["x", "t", "sin", "pi", "atan2", "1a", "a-b", ""] {
        let error = owned(&[(name, 1.0)], &[], &["1"])
            .compile(FunctionKind::Time)
            .unwrap_err();
        assert_eq!(error.code, "expr_name_invalid", "{name:?}");
        assert_eq!(error.path, "parameters[0]", "{name:?}");
    }
}

#[test]
fn duplicate_names_are_rejected() {
    let error = owned(&[("a", 1.0), ("a", 2.0)], &[], &["a"])
        .compile(FunctionKind::Time)
        .unwrap_err();
    assert_eq!(
        (error.code, error.path.as_str()),
        ("expr_name_invalid", "parameters[1]")
    );
    let error = owned(&[("a", 1.0)], &[("a", "t")], &["a"])
        .compile(FunctionKind::Time)
        .unwrap_err();
    assert_eq!(
        (error.code, error.path.as_str()),
        ("expr_name_invalid", "locals[0]")
    );
}

#[test]
fn constant_time_function_does_not_depend_on_time() {
    let time = owned(&[("a", 2.0)], &[("b", "a * 3")], &["b + 1"])
        .compile(FunctionKind::Time)
        .unwrap();
    assert!(!time.depends_on_variables());
    assert_eq!(time.time_program().code, vec![1.0, 7.0, 0.0]);
}

#[test]
fn canonical_outputs_substitute_locals() {
    let mask = owned(&[("a", 2.0)], &[("u", "a * x")], &["u + 1", "-u", "u ^ 2"])
        .compile(FunctionKind::Mask)
        .unwrap();
    assert_eq!(
        mask.canonical_outputs(),
        vec![
            "((2.0 * x) + 1.0)".to_string(),
            "(-(2.0 * x))".to_string(),
            "((2.0 * x)^2.0)".to_string(),
        ]
    );
}

#[test]
fn eval_never_panics_on_non_finite_values() {
    let mask = owned(&[], &[], &["log(x)", "1 / y", "sqrt(z)"])
        .compile(FunctionKind::Mask)
        .unwrap();
    let value = mask.eval_mask([-1.0, 0.0, -1.0]);
    assert!(value[0].is_nan());
    assert!(value[1].is_infinite());
    assert!(value[2].is_nan());
}
