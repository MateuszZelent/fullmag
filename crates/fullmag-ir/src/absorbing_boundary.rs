use crate::{
    AbsorbingBoundaryDirectionIR, AbsorbingBoundaryFaceIR, AbsorbingBoundaryIR,
    AbsorbingBoundaryLayerIR, AbsorbingBoundaryProfileIR, SpatialAbsorbingGeometryIR,
    SpatialAbsorbingLayerIR,
};
use std::collections::BTreeSet;

const TOLERANCE: f64 = 1e-12;
const VALIDATION_STEPS: u32 = 256;

/// A scalar ramp ready to be sampled repeatedly by the material planner.
pub struct ResolvedAbsorbingBoundaryProfile {
    kind: AbsorbingBoundaryProfileIR,
    expression: Option<Expression>,
}

impl AbsorbingBoundaryLayerIR {
    pub fn compile_profile(&self) -> Result<ResolvedAbsorbingBoundaryProfile, String> {
        ResolvedAbsorbingBoundaryProfile::compile(self.profile, self.expression.as_deref())
    }
}

impl ResolvedAbsorbingBoundaryProfile {
    pub fn compile(kind: AbsorbingBoundaryProfileIR, source: Option<&str>) -> Result<Self, String> {
        let expression = match (kind, source) {
            (AbsorbingBoundaryProfileIR::Custom, Some(source)) => {
                Some(Parser::parse(source, &["u"])?)
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
        let profile = ResolvedAbsorbingBoundaryProfile { kind, expression };
        if profile.expression.is_some() {
            for step in 0..=VALIDATION_STEPS {
                profile.evaluate(f64::from(step) / f64::from(VALIDATION_STEPS))?;
            }
        }
        Ok(profile)
    }
}

impl ResolvedAbsorbingBoundaryProfile {
    pub fn evaluate(&self, value: f64) -> Result<f64, String> {
        let u = value.clamp(0.0, 1.0);
        if let Some(expression) = &self.expression {
            let weight = expression
                .evaluate(&[u])
                .ok_or_else(|| format!("expression is undefined at u={u}"))?;
            if !(-TOLERANCE..=1.0 + TOLERANCE).contains(&weight) {
                return Err(format!("expression must return a value in [0, 1] at u={u}"));
            }
            if u == 0.0 || u == 1.0 {
                if (weight - u).abs() > TOLERANCE {
                    return Err("expression must equal 0 at u=0 and 1 at u=1".into());
                }
                return Ok(u);
            }
            return Ok(weight.clamp(0.0, 1.0));
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
                unreachable!("compiled custom profile has an expression")
            }
        })
    }
}

/// A restricted spatial expression evaluated in metres in the layer frame.
pub struct AbsorbingBoundaryCoordinate(Expression);

impl AbsorbingBoundaryCoordinate {
    pub fn compile(source: &str) -> Result<Self, String> {
        Parser::parse(source, &["x", "y", "z"]).map(Self)
    }

    pub fn evaluate(&self, point: [f64; 3]) -> Result<f64, String> {
        self.0
            .evaluate(&point)
            .ok_or_else(|| format!("distance expression is undefined at {point:?}"))
    }
}

type UnaryOperation = fn(f64) -> f64;
type BinaryOperation = fn(f64, f64) -> f64;

enum Expression {
    Number(f64),
    Variable(usize),
    Unary(UnaryOperation, Box<Self>),
    Binary(BinaryOperation, Box<Self>, Box<Self>),
}

impl Expression {
    fn evaluate(&self, variables: &[f64]) -> Option<f64> {
        let value = match self {
            Self::Number(value) => *value,
            Self::Variable(index) => variables[*index],
            Self::Unary(operation, operand) => operation(operand.evaluate(variables)?),
            Self::Binary(operation, left, right) => {
                operation(left.evaluate(variables)?, right.evaluate(variables)?)
            }
        };
        value.is_finite().then_some(value)
    }
}

struct Parser<'a> {
    remaining: &'a str,
    variables: &'static [&'static str],
}

impl<'a> Parser<'a> {
    fn parse(source: &'a str, variables: &'static [&'static str]) -> Result<Expression, String> {
        if source.is_empty()
            || source.len() > 256
            || !source
                .bytes()
                .all(|ch| ch.is_ascii_alphanumeric() || b".+*/(), \t-".contains(&ch))
        {
            return Err("expression must contain 1 to 256 ASCII math characters".into());
        }
        let mut parser = Self {
            remaining: source,
            variables,
        };
        let expression = parser.parse_expression(0)?;
        if !parser.remaining.trim_ascii().is_empty() {
            return Err(parser.expected("end of expression"));
        }
        Ok(expression)
    }

    fn parse_expression(&mut self, minimum_precedence: u8) -> Result<Expression, String> {
        let mut left = self.parse_operand()?;
        loop {
            self.skip_whitespace();
            let Some((token, operation, precedence, right_precedence)) = self.operator() else {
                return Ok(left);
            };
            if precedence < minimum_precedence {
                return Ok(left);
            }
            self.remaining = &self.remaining[token.len()..];
            let right = self.parse_expression(right_precedence)?;
            left = Expression::Binary(operation, Box::new(left), Box::new(right));
        }
    }

    fn parse_operand(&mut self) -> Result<Expression, String> {
        if self.consume("+") {
            return self.parse_expression(3);
        }
        if self.consume("-") {
            let operand = self.parse_expression(3)?;
            return Ok(Expression::Unary(|value| -value, Box::new(operand)));
        }
        if self.consume("(") {
            return self.parenthesized();
        }
        if self
            .remaining
            .starts_with(|ch: char| ch.is_ascii_digit() || ch == '.')
        {
            return self.number();
        }
        let name = self.take_while(|ch| ch.is_ascii_alphanumeric());
        if let Some(index) = self.variables.iter().position(|&var| var == name) {
            return Ok(Expression::Variable(index));
        }
        if self.variables.len() == 3 && matches!(name, "min" | "max") {
            if !self.consume("(") {
                return Err(self.expected("'(' after the function name"));
            }
            let left = self.parse_expression(0)?;
            if !self.consume(",") {
                return Err(self.expected("two arguments separated by ','"));
            }
            let right = self.parenthesized()?;
            let operation = if name == "min" { f64::min } else { f64::max };
            return Ok(Expression::Binary(
                operation,
                Box::new(left),
                Box::new(right),
            ));
        }
        let function: UnaryOperation = match name {
            "abs" => f64::abs,
            "sqrt" => f64::sqrt,
            "exp" => f64::exp,
            "log" => f64::ln,
            "log1p" => f64::ln_1p,
            "tanh" => f64::tanh,
            "sin" => f64::sin,
            "cos" => f64::cos,
            _ => return Err(self.expected("a coordinate, a number, or a supported math function")),
        };
        if !self.consume("(") {
            return Err(self.expected("'(' after the function name"));
        }
        Ok(Expression::Unary(function, Box::new(self.parenthesized()?)))
    }

    fn parenthesized(&mut self) -> Result<Expression, String> {
        let expression = self.parse_expression(0)?;
        if !self.consume(")") {
            return Err(self.expected("')'"));
        }
        Ok(expression)
    }

    fn number(&mut self) -> Result<Expression, String> {
        let source = self.remaining;
        let integer = self.take_while(|ch| ch.is_ascii_digit());
        let mut integer_only = true;
        if let Some(after_dot) = self.remaining.strip_prefix('.') {
            self.remaining = after_dot;
            self.take_while(|ch| ch.is_ascii_digit());
            integer_only = false;
        }
        if self.remaining.starts_with(['e', 'E']) {
            self.remaining = &self.remaining[1..];
            if self.remaining.starts_with(['+', '-']) {
                self.remaining = &self.remaining[1..];
            }
            self.take_while(|ch| ch.is_ascii_digit());
            integer_only = false;
        }
        if integer_only && integer.starts_with('0') && integer.bytes().any(|ch| ch != b'0') {
            return Err(self.expected("an integer without a leading zero"));
        }
        source[..source.len() - self.remaining.len()]
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite())
            .map(Expression::Number)
            .ok_or_else(|| self.expected("a finite decimal number"))
    }

    fn operator(&self) -> Option<(&'static str, BinaryOperation, u8, u8)> {
        if self.remaining.starts_with("**") {
            return Some(("**", f64::powf, 4, 4));
        }
        match self.remaining.as_bytes().first()? {
            b'+' => Some(("+", |left, right| left + right, 1, 2)),
            b'-' => Some(("-", |left, right| left - right, 1, 2)),
            b'*' => Some(("*", |left, right| left * right, 2, 3)),
            b'/' => Some(("/", |left, right| left / right, 2, 3)),
            _ => None,
        }
    }

    fn skip_whitespace(&mut self) {
        self.remaining = self.remaining.trim_ascii_start();
    }

    fn consume(&mut self, token: &str) -> bool {
        self.skip_whitespace();
        if let Some(rest) = self.remaining.strip_prefix(token) {
            self.remaining = rest;
            return true;
        }
        false
    }

    fn take_while(&mut self, predicate: impl Fn(u8) -> bool) -> &'a str {
        let length = self
            .remaining
            .bytes()
            .take_while(|ch| predicate(*ch))
            .count();
        let (taken, rest) = self.remaining.split_at(length);
        self.remaining = rest;
        taken
    }

    fn expected(&self, expected: &str) -> String {
        format!("invalid expression: expected {expected}")
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

    #[test]
    fn scalar_expression_obeys_precedence_and_rejects_unbounded_operations() {
        for (source, expected) in [
            ("-u**2", -0.25),
            ("u**2**2", 0.0625),
            ("2e-1 + (u - .1) * 2", 1.0),
            ("sqrt(u * u)", 0.5),
            ("2**-u**2", 2.0_f64.powf(-0.25)),
        ] {
            let output = Parser::parse(source, &["u"])
                .unwrap()
                .evaluate(&[0.5])
                .unwrap();
            assert!((output - expected).abs() < 1e-12, "{source}");
        }
        for source in [
            "u # comment",
            "u**1_0",
            "01*u",
            "u.real",
            "(sqrt)(u)",
            "((abs))(u)",
            "other(u)",
            "u/ /u",
            "u 2",
            "u**0x2",
            "u**0o2",
            "u**0b10",
        ] {
            assert!(Parser::parse(source, &["u"]).is_err(), "{source}");
        }
        assert_eq!(
            Parser::parse("1/exp(999)", &["u"])
                .unwrap()
                .evaluate(&[0.5]),
            None
        );
    }
}
