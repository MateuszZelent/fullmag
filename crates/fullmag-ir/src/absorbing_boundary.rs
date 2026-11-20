use crate::{
    AbsorbingBoundaryDirectionIR, AbsorbingBoundaryFaceIR, AbsorbingBoundaryIR,
    AbsorbingBoundaryLayerIR, AbsorbingBoundaryProfileIR, SpatialAbsorbingGeometryIR,
    SpatialAbsorbingLayerIR,
};
use fullmag_expr::{
    compile_function, CompiledFunction, FunctionError, FunctionKind, FunctionSource,
};
use std::collections::BTreeSet;

const TOLERANCE: f64 = 1e-12;
const VALIDATION_STEPS: u32 = 256;
/// Longest custom profile or distance formula, in characters.
const MAX_FORMULA_CHARACTERS: usize = 256;

/// Why a custom profile or distance formula is rejected
/// (`docs/specs/mask-function-v1.md`, section 8).
#[derive(Debug, Clone, PartialEq)]
enum FormulaError {
    /// Blank, longer than 256 characters, or not printable ASCII.
    Text(&'static str),
    /// Rejected by the formula language of `fullmag-expr`.
    Syntax(FunctionError),
    /// A profile value that is not finite.
    Undefined { u: f64 },
    /// A finite profile value outside [0, 1].
    Range { u: f64 },
    /// `p(0) != 0` or `p(1) != 1`.
    Endpoint,
}

impl FormulaError {
    /// Category of `tests/fixtures/absorbing_boundary_formula_cases.json`.
    #[cfg(test)]
    fn category(&self) -> &'static str {
        match self {
            Self::Text(_) => "text",
            Self::Syntax(_) => "syntax",
            Self::Undefined { .. } | Self::Range { .. } => "range",
            Self::Endpoint => "endpoint",
        }
    }
}

impl std::fmt::Display for FormulaError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Text(reason) => write!(formatter, "expression {reason}"),
            Self::Syntax(error) => write!(
                formatter,
                "expression error {} at character {}: {}",
                error.code, error.position, error.message
            ),
            Self::Undefined { u } => write!(formatter, "expression is undefined at u={u}"),
            Self::Range { u } => write!(
                formatter,
                "expression must return a value in [0, 1] at u={u}"
            ),
            Self::Endpoint => write!(formatter, "expression must equal 0 at u=0 and 1 at u=1"),
        }
    }
}

/// Compile one formula of `kind` after the text rules of the layer.
fn compile_formula(source: &str, kind: FunctionKind) -> Result<CompiledFunction, FormulaError> {
    if source.trim().is_empty() {
        return Err(FormulaError::Text("must not be blank"));
    }
    if source.len() > MAX_FORMULA_CHARACTERS {
        return Err(FormulaError::Text("must have at most 256 characters"));
    }
    if !source
        .bytes()
        .all(|byte| byte == b'\t' || (b' '..=b'~').contains(&byte))
    {
        return Err(FormulaError::Text(
            "must contain printable ASCII characters only",
        ));
    }
    let outputs = [source.to_string()];
    compile_function(
        &FunctionSource {
            parameters: &[],
            locals: &[],
            outputs: &outputs,
        },
        kind,
    )
    .map_err(FormulaError::Syntax)
}

/// Compile a profile and probe it at `u = k/256`, `k = 0..=256`.
fn compile_profile_formula(source: &str) -> Result<CompiledFunction, FormulaError> {
    let formula = compile_formula(source, FunctionKind::Profile)?;
    for step in 0..=VALIDATION_STEPS {
        checked_profile_value(&formula, f64::from(step) / f64::from(VALIDATION_STEPS))?;
    }
    Ok(formula)
}

/// Value of a profile at `u` in [0, 1]: finite, within [0, 1] up to the
/// tolerance, and exactly `u` at the endpoints.
fn checked_profile_value(formula: &CompiledFunction, u: f64) -> Result<f64, FormulaError> {
    let weight = formula.eval_profile(u);
    if !weight.is_finite() {
        return Err(FormulaError::Undefined { u });
    }
    if !(-TOLERANCE..=1.0 + TOLERANCE).contains(&weight) {
        return Err(FormulaError::Range { u });
    }
    if u == 0.0 || u == 1.0 {
        if (weight - u).abs() > TOLERANCE {
            return Err(FormulaError::Endpoint);
        }
        return Ok(u);
    }
    Ok(weight.clamp(0.0, 1.0))
}

/// A scalar ramp ready to be sampled repeatedly by the material planner.
pub struct ResolvedAbsorbingBoundaryProfile {
    kind: AbsorbingBoundaryProfileIR,
    formula: Option<CompiledFunction>,
}

impl AbsorbingBoundaryLayerIR {
    pub fn compile_profile(&self) -> Result<ResolvedAbsorbingBoundaryProfile, String> {
        ResolvedAbsorbingBoundaryProfile::compile(self.profile, self.expression.as_deref())
    }
}

impl ResolvedAbsorbingBoundaryProfile {
    pub fn compile(kind: AbsorbingBoundaryProfileIR, source: Option<&str>) -> Result<Self, String> {
        let formula = match (kind, source) {
            (AbsorbingBoundaryProfileIR::Custom, Some(source)) => {
                Some(compile_profile_formula(source).map_err(|error| error.to_string())?)
            }
            (AbsorbingBoundaryProfileIR::Custom, None) => {
                return Err(
                    "expression is required for a custom absorbing boundary profile".into(),
                );
            }
            (_, None) => None,
            (_, Some(_)) => {
                return Err("expression requires a custom absorbing boundary profile".into());
            }
        };
        Ok(ResolvedAbsorbingBoundaryProfile { kind, formula })
    }

    pub fn evaluate(&self, value: f64) -> Result<f64, String> {
        let u = value.clamp(0.0, 1.0);
        if let Some(formula) = &self.formula {
            return checked_profile_value(formula, u).map_err(|error| error.to_string());
        }
        if u == 0.0 || u == 1.0 {
            return Ok(u);
        }
        Ok(match self.kind {
            AbsorbingBoundaryProfileIR::Linear => u,
            AbsorbingBoundaryProfileIR::Quadratic => u * u,
            AbsorbingBoundaryProfileIR::Smootherstep => u * u * u * (u * (u * 6.0 - 15.0) + 10.0),
            AbsorbingBoundaryProfileIR::Logarithmic => (9.0 * u).ln_1p() / std::f64::consts::LN_10,
            AbsorbingBoundaryProfileIR::Tanh => {
                (1.0 + (4.0 * u - 2.0).tanh() / 2.0_f64.tanh()) / 2.0
            }
            AbsorbingBoundaryProfileIR::Custom => {
                unreachable!("compiled custom profile has a formula")
            }
        })
    }
}

/// A distance formula `d(x, y, z)` evaluated in metres in the layer frame.
pub struct AbsorbingBoundaryCoordinate(CompiledFunction);

impl AbsorbingBoundaryCoordinate {
    pub fn compile(source: &str) -> Result<Self, String> {
        compile_formula(source, FunctionKind::Distance)
            .map(Self)
            .map_err(|error| error.to_string())
    }

    pub fn evaluate(&self, point: [f64; 3]) -> Result<f64, String> {
        let value = self.0.eval_distance(point);
        if value.is_finite() {
            Ok(value)
        } else {
            Err(format!("distance expression is undefined at {point:?}"))
        }
    }
}

/// Append all boundary-layer diagnostics using the owning resource path.
pub fn validate_absorbing_boundary(
    path: &str,
    layer: &AbsorbingBoundaryLayerIR,
    errors: &mut Vec<String>,
) {
    validate_absorbing_parameters(
        path,
        layer.total_width_m,
        layer.ramp_width_m,
        layer.max_damping,
        layer.profile,
        layer.expression.as_deref(),
        errors,
    );
    validate_absorbing_faces(path, &layer.faces, errors);
}

fn validate_absorbing_parameters(
    path: &str,
    total_width_m: f64,
    ramp_width_m: f64,
    max_damping: f64,
    profile: AbsorbingBoundaryProfileIR,
    expression: Option<&str>,
    errors: &mut Vec<String>,
) {
    if !total_width_m.is_finite() || total_width_m <= 0.0 {
        errors.push(format!("{path}.total_width_m must be finite and > 0"));
    }
    if !ramp_width_m.is_finite() || ramp_width_m <= 0.0 {
        errors.push(format!("{path}.ramp_width_m must be finite and > 0"));
    }
    if total_width_m.is_finite() && ramp_width_m.is_finite() && ramp_width_m > total_width_m {
        errors.push(format!("{path}.ramp_width_m must be <= total_width_m"));
    }
    if !max_damping.is_finite() || max_damping < 0.0 {
        errors.push(format!("{path}.max_damping must be finite and >= 0"));
    }
    if let Err(error) = ResolvedAbsorbingBoundaryProfile::compile(profile, expression) {
        errors.push(format!("{path}: {error}"));
    }
}

fn validate_absorbing_faces(
    path: &str,
    selected: &[AbsorbingBoundaryFaceIR],
    errors: &mut Vec<String>,
) {
    if selected.is_empty() {
        errors.push(format!("{path}.faces must contain at least one face"));
    }
    let mut faces = BTreeSet::new();
    for face in selected {
        if !faces.insert(*face) {
            errors.push(format!("{path}.faces must not contain duplicates"));
            break;
        }
    }
}

impl AbsorbingBoundaryIR {
    pub fn referenced_regions(&self) -> impl Iterator<Item = &str> {
        let layers: &[SpatialAbsorbingLayerIR] = match self {
            Self::Legacy(_) => &[],
            Self::Layers(config) => &config.layers,
        };
        layers.iter().flat_map(|layer| {
            let boundary = match &layer.geometry {
                SpatialAbsorbingGeometryIR::RegionBoundary { region_id } => {
                    Some(region_id.as_str())
                }
                _ => None,
            };
            layer.region_id.as_deref().into_iter().chain(boundary)
        })
    }
}

pub fn validate_absorbing_boundary_config(
    path: &str,
    config: &AbsorbingBoundaryIR,
    errors: &mut Vec<String>,
) {
    let layers = match config {
        AbsorbingBoundaryIR::Legacy(layer) => {
            return validate_absorbing_boundary(path, layer, errors);
        }
        AbsorbingBoundaryIR::Layers(config) => &config.layers,
    };
    let mut ids = BTreeSet::new();
    for (i, layer) in layers.iter().enumerate() {
        let path = format!("{path}.layers[{i}]");
        if layer.layer_id.trim().is_empty()
            || layer.layer_id.trim() != layer.layer_id
            || !ids.insert(&layer.layer_id)
        {
            errors.push(format!(
                "{path}.layer_id must be trimmed, non-empty and unique on the object"
            ));
        }
        if layer.name.trim().is_empty() {
            errors.push(format!("{path}.name must be non-empty"));
        }
        if layer
            .region_id
            .as_deref()
            .is_some_and(|id| id.trim().is_empty() || id.trim() != id)
        {
            errors.push(format!("{path}.region_id must be non-empty"));
        }
        validate_absorbing_parameters(
            &path,
            layer.total_width_m,
            layer.ramp_width_m,
            layer.max_damping,
            layer.profile,
            layer.expression.as_deref(),
            errors,
        );
        let finite = |p: &[f64; 3]| p.iter().all(|v| v.is_finite());
        let axis_ok = |p: &[f64; 3]| finite(p) && p.iter().any(|v| *v != 0.0);
        match &layer.geometry {
            SpatialAbsorbingGeometryIR::Faces { faces } => {
                validate_absorbing_faces(&path, faces, errors)
            }
            SpatialAbsorbingGeometryIR::Plane { origin, normal } => {
                if !finite(origin) || !axis_ok(normal) {
                    errors.push(format!(
                        "{path}.geometry requires a finite origin and finite nonzero normal"
                    ));
                }
            }
            SpatialAbsorbingGeometryIR::Sphere {
                center,
                radius_m,
                direction,
            }
            | SpatialAbsorbingGeometryIR::Cylinder {
                center,
                radius_m,
                direction,
                ..
            } => {
                if let SpatialAbsorbingGeometryIR::Cylinder { axis, .. } = &layer.geometry {
                    if !axis_ok(axis) {
                        errors.push(format!("{path}.geometry.axis must be finite and nonzero"));
                    }
                }
                if !finite(center) || !radius_m.is_finite() || *radius_m <= 0.0 {
                    errors.push(format!(
                        "{path}.geometry requires a finite center and a finite positive radius_m"
                    ));
                }
                if *direction == AbsorbingBoundaryDirectionIR::Outward
                    && layer.total_width_m > *radius_m
                {
                    errors.push(format!(
                        "{path}.total_width_m must fit inside the outward radius_m"
                    ));
                }
            }
            SpatialAbsorbingGeometryIR::RegionBoundary { region_id }
                if region_id.trim().is_empty() || region_id.trim() != region_id =>
            {
                errors.push(format!("{path}.geometry.region_id must be non-empty"))
            }
            SpatialAbsorbingGeometryIR::Expression { expression } => {
                if let Err(reason) = AbsorbingBoundaryCoordinate::compile(expression) {
                    errors.push(format!("{path}.geometry.expression: {reason}"));
                }
            }
            SpatialAbsorbingGeometryIR::RegionBoundary { .. } => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spatial_config_validates_identity_geometry_and_owner() {
        use serde_json::json;
        let valid = json!({"layer_id":"shell", "name":"Shell", "enabled":true, "frame":"universe",
            "geometry":{"kind":"sphere","center":[0.,0.,0.],"direction":"outward","radius_m":2.},
            "profile":"custom","expression":"u**2","max_damping":0.5,"total_width_m":2.,"ramp_width_m":1.});
        let config = json!({"layers":[valid.clone()]});
        let mut problem = crate::ProblemIR::bootstrap_example();
        problem.magnets[0].absorbing_boundary =
            Some(serde_json::from_value(config.clone()).unwrap());
        problem.validate().unwrap();
        assert_eq!(
            serde_json::to_value(&problem.magnets[0].absorbing_boundary).unwrap(),
            config
        );
        for (field, value, diag) in [
            ("layer_id", json!(" bad"), "layer_id"),
            ("region_id", json!("foreign"), "missing region"),
            ("total_width_m", json!(3.0), "radius_m"),
            (
                "geometry",
                json!({"kind":"region_boundary","region_id":"gone"}),
                "missing region",
            ),
            (
                "geometry",
                json!({"kind":"plane","origin":[0.,0.,0.],"normal":[0.,0.,0.]}),
                "normal",
            ),
            (
                "geometry",
                json!({"kind":"expression","expression":"max(u,0)"}),
                "expression",
            ),
            ("expression", json!("x"), "expression"),
        ] {
            let mut invalid = valid.clone();
            invalid[field] = value;
            problem.magnets[0].absorbing_boundary =
                Some(serde_json::from_value(json!({"layers":[invalid]})).unwrap());
            assert!(
                problem
                    .validate()
                    .unwrap_err()
                    .iter()
                    .any(|msg| msg.contains(diag)),
                "{field}"
            );
        }
        problem.magnets[0].absorbing_boundary =
            Some(serde_json::from_value(json!({"layers":[valid.clone(),valid]})).unwrap());
        assert!(
            problem
                .validate()
                .unwrap_err()
                .iter()
                .any(|msg| msg.contains("unique"))
        );
    }

    #[test]
    fn migrated_spatial_module_preserves_identity_and_checks_references() {
        use serde_json::json;
        let mut problem = crate::ProblemIR::bootstrap_example();
        problem.object_regions.push(
            serde_json::from_value(json!({
                "owner_object":"strip","region_id":"rim","name":"Original",
                "shape":{"kind":"sphere","center":[0.,0.,0.],"radius":1.}
            }))
            .unwrap(),
        );
        let config = json!({"layers":[{"layer_id":"boundary","name":"Boundary","enabled":true,
            "frame":"object","total_width_m":1.,"ramp_width_m":1.,"max_damping":0.2,
            "region_id":"rim","profile":"linear","geometry":{"kind":"region_boundary","region_id":"rim"}}]});
        problem.magnets[0].absorbing_boundary =
            Some(serde_json::from_value(config.clone()).unwrap());
        let mut value = serde_json::to_value(problem).unwrap();
        crate::migrate_v0_3_problem_ir_to_v0_4(&mut value).unwrap();
        assert_eq!(
            value["magnetization_modules"][0]["absorbing_boundary"],
            config
        );
        let mut migrated: crate::ProblemIRV04 = serde_json::from_value(value).unwrap();
        migrated.validate().unwrap();
        migrated.object_regions.clear();
        assert!(
            migrated
                .validate()
                .unwrap_err()
                .iter()
                .any(|e| e.contains("absorbing_boundary") && e.contains("rim"))
        );
    }

    const CASES: &str = include_str!("../tests/fixtures/absorbing_boundary_formula_cases.json");
    /// Values of the Python evaluator that preceded the shared formula language.
    const BASELINE: &str =
        include_str!("../tests/fixtures/absorbing_boundary_formula_baseline.json");

    /// Equal, or adjacent binary64 values of the same sign.
    fn within_one_ulp(a: f64, b: f64) -> bool {
        a == b || (a.is_sign_negative() == b.is_sign_negative() && a.to_bits().abs_diff(b.to_bits()) <= 1)
    }

    fn close(a: f64, b: f64) -> bool {
        within_one_ulp(a, b) || (a - b).abs() <= 1e-14 * a.abs().max(b.abs())
    }

    fn check_rejection(name: &str, case: &serde_json::Value, error: &FormulaError) {
        assert_eq!(
            error.category(),
            case["error"].as_str().unwrap(),
            "{name}: {error}"
        );
        if let Some(code) = case.get("code") {
            match error {
                FormulaError::Syntax(error) => {
                    assert_eq!(error.code, code.as_str().unwrap(), "{name}: {}", error.message)
                }
                other => panic!("{name}: expected {code}, got {other}"),
            }
        }
    }

    #[test]
    fn shared_profile_formula_cases_and_old_values() {
        let cases: serde_json::Value = serde_json::from_str(CASES).unwrap();
        let baseline: serde_json::Value = serde_json::from_str(BASELINE).unwrap();
        let mut compared = 0;
        for case in cases["profile"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let text = case["text"].as_str().unwrap();
            let public = ResolvedAbsorbingBoundaryProfile::compile(
                AbsorbingBoundaryProfileIR::Custom,
                Some(text),
            );
            match compile_profile_formula(text) {
                Ok(formula) => {
                    assert!(case["accept"].as_bool().unwrap(), "{name}: accepted {text:?}");
                    for sample in case["samples"].as_array().unwrap() {
                        let u = sample[0].as_f64().unwrap();
                        let expected = sample[1].as_f64().unwrap();
                        let value = checked_profile_value(&formula, u).unwrap();
                        assert!(close(value, expected), "{name} at u={u}: {value} != {expected}");
                    }
                    let profile = public.unwrap();
                    if let Some(old) = baseline["profile"].get(name) {
                        for (step, old) in old.as_array().unwrap().iter().enumerate() {
                            let u = step as f64 / 256.0;
                            let value = profile.evaluate(u).unwrap();
                            let old = old.as_f64().unwrap();
                            assert!(within_one_ulp(value, old), "{name} at u={u}: {value} != {old}");
                        }
                        compared += 1;
                    }
                }
                Err(error) => {
                    assert!(!case["accept"].as_bool().unwrap(), "{name}: {error}");
                    check_rejection(name, case, &error);
                    assert_eq!(public.err(), Some(error.to_string()), "{name}");
                }
            }
        }
        assert_eq!(compared, baseline["profile"].as_object().unwrap().len());
    }

    #[test]
    fn shared_distance_formula_cases_and_old_values() {
        let cases: serde_json::Value = serde_json::from_str(CASES).unwrap();
        let baseline: serde_json::Value = serde_json::from_str(BASELINE).unwrap();
        let points: Vec<[f64; 3]> = cases["distance_points"]
            .as_array()
            .unwrap()
            .iter()
            .map(|point| {
                [
                    point[0].as_f64().unwrap(),
                    point[1].as_f64().unwrap(),
                    point[2].as_f64().unwrap(),
                ]
            })
            .collect();
        let mut compared = 0;
        for case in cases["distance"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let text = case["text"].as_str().unwrap();
            let public = AbsorbingBoundaryCoordinate::compile(text);
            match compile_formula(text, FunctionKind::Distance) {
                Ok(_) => {
                    assert!(case["accept"].as_bool().unwrap(), "{name}: accepted {text:?}");
                    let coordinate = public.unwrap();
                    let samples = case["samples"].as_array().unwrap();
                    assert_eq!(samples.len(), points.len(), "{name}");
                    for (point, expected) in points.iter().zip(samples) {
                        let expected = expected.as_f64().unwrap();
                        let value = coordinate.evaluate(*point).unwrap();
                        assert!(close(value, expected), "{name} at {point:?}: {value} != {expected}");
                    }
                    if let Some(old) = baseline["distance"].get(name) {
                        for (point, old) in points.iter().zip(old.as_array().unwrap()) {
                            let value = coordinate.evaluate(*point).unwrap();
                            let old = old.as_f64().unwrap();
                            assert!(within_one_ulp(value, old), "{name} at {point:?}: {value} != {old}");
                        }
                        compared += 1;
                    }
                }
                Err(error) => {
                    assert!(!case["accept"].as_bool().unwrap(), "{name}: {error}");
                    check_rejection(name, case, &error);
                    assert_eq!(public.err(), Some(error.to_string()), "{name}");
                }
            }
        }
        assert_eq!(compared, baseline["distance"].as_object().unwrap().len());
    }

    #[test]
    fn formula_errors_carry_the_engine_code_and_position() {
        let profile = ResolvedAbsorbingBoundaryProfile::compile(
            AbsorbingBoundaryProfileIR::Custom,
            Some("u + 01*u"),
        )
        .err()
        .unwrap();
        assert!(
            profile.starts_with("expression error expr_syntax at character 4: "),
            "{profile}"
        );
        let distance = AbsorbingBoundaryCoordinate::compile("x + t").err().unwrap();
        assert!(
            distance.starts_with("expression error mask_function_wrong_variable at character 4: "),
            "{distance}"
        );
        // An intermediate infinity is IEEE arithmetic; only the value is checked.
        let profile = ResolvedAbsorbingBoundaryProfile::compile(
            AbsorbingBoundaryProfileIR::Custom,
            Some("u + 1/exp(999)"),
        )
        .unwrap();
        assert_eq!(profile.evaluate(0.5), Ok(0.5));
        assert_eq!(
            AbsorbingBoundaryCoordinate::compile("1/(y-3)")
                .unwrap()
                .evaluate([0.0, 3.0, 0.0])
                .unwrap_err(),
            "distance expression is undefined at [0.0, 3.0, 0.0]"
        );
    }
}
