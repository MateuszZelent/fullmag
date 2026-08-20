use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub const SELECTION_EXPR_SCHEMA_VERSION: &str = "selection_expr.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CartesianComponentIR {
    X,
    Y,
    Z,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComparisonOpIR {
    Lt,
    Le,
    Gt,
    Ge,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClosedIntervalIR {
    None,
    Left,
    Right,
    Both,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ComparisonToleranceIR {
    #[serde(default)]
    pub atol: f64,
    #[serde(default)]
    pub rtol: f64,
}

impl ComparisonToleranceIR {
    pub fn is_exact(&self) -> bool {
        self.atol == 0.0 && self.rtol == 0.0
    }
}

impl Default for ComparisonToleranceIR {
    fn default() -> Self {
        Self {
            atol: 0.0,
            rtol: 0.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SelectionFrameIR {
    World {},
    Object { object_id: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SelectionSamplingIR {
    DofPoint {},
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum BoundaryMembershipIR {
    Inclusive {
        absolute_tolerance_m: f64,
        relative_tolerance: f64,
    },
    Exclusive {
        absolute_tolerance_m: f64,
        relative_tolerance: f64,
    },
}

impl Default for BoundaryMembershipIR {
    fn default() -> Self {
        Self::Inclusive {
            absolute_tolerance_m: 0.0,
            relative_tolerance: 1.0e-12,
        }
    }
}

fn deserialize_unit_vector3<'de, D>(deserializer: D) -> Result<[f64; 3], D::Error>
where
    D: Deserializer<'de>,
{
    let vector = <[f64; 3]>::deserialize(deserializer)?;
    normalize_vector3(vector).map_err(serde::de::Error::custom)
}

fn deserialize_unit_vector4<'de, D>(deserializer: D) -> Result<[f64; 4], D::Error>
where
    D: Deserializer<'de>,
{
    let vector = <[f64; 4]>::deserialize(deserializer)?;
    normalize_vector4(vector).map_err(serde::de::Error::custom)
}

pub(crate) fn normalize_vector3(vector: [f64; 3]) -> Result<[f64; 3], String> {
    if vector.iter().any(|component| !component.is_finite()) {
        return Err("axis must contain finite values".to_string());
    }
    let largest = vector
        .iter()
        .map(|component| component.abs())
        .fold(0.0_f64, f64::max);
    if largest == 0.0 {
        return Err("axis must be non-zero".to_string());
    }
    let scaled_norm = vector
        .iter()
        .map(|component| (component / largest).powi(2))
        .sum::<f64>()
        .sqrt();
    Ok(vector.map(|component| component / largest / scaled_norm))
}

fn normalize_vector4(vector: [f64; 4]) -> Result<[f64; 4], String> {
    if vector.iter().any(|component| !component.is_finite()) {
        return Err("rotation_xyzw must contain finite values".to_string());
    }
    let largest = vector
        .iter()
        .map(|component| component.abs())
        .fold(0.0_f64, f64::max);
    if largest == 0.0 {
        return Err("rotation_xyzw must be non-zero".to_string());
    }
    let scaled_norm = vector
        .iter()
        .map(|component| (component / largest).powi(2))
        .sum::<f64>()
        .sqrt();
    Ok(vector.map(|component| component / largest / scaled_norm))
}

/// Canonical geometry nodes required by the V1 selection authoring surface.
/// Planner-side occupancy compilation consumes this type; it is deliberately
/// separate from named scene geometry entries.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum GeometryPredicateIR {
    Box {
        center_m: [f64; 3],
        size_m: [f64; 3],
    },
    Cylinder {
        center_m: [f64; 3],
        #[serde(deserialize_with = "deserialize_unit_vector3")]
        axis: [f64; 3],
        radius_m: f64,
        height_m: f64,
    },
    Sphere {
        center_m: [f64; 3],
        radius_m: f64,
    },
    Ellipsoid {
        center_m: [f64; 3],
        radii_m: [f64; 3],
    },
    Union {
        a: Box<GeometryPredicateIR>,
        b: Box<GeometryPredicateIR>,
    },
    Intersection {
        a: Box<GeometryPredicateIR>,
        b: Box<GeometryPredicateIR>,
    },
    Difference {
        base: Box<GeometryPredicateIR>,
        tool: Box<GeometryPredicateIR>,
    },
    Xor {
        a: Box<GeometryPredicateIR>,
        b: Box<GeometryPredicateIR>,
    },
    Complement {
        geometry: Box<GeometryPredicateIR>,
        domain: Box<GeometryPredicateIR>,
    },
    Affine {
        geometry: Box<GeometryPredicateIR>,
        translation_m: [f64; 3],
        #[serde(deserialize_with = "deserialize_unit_vector4")]
        rotation_xyzw: [f64; 4],
        scale: [f64; 3],
        pivot_m: [f64; 3],
    },
    ImportedSolid {
        asset_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SelectionScalarExprIR {
    Constant {
        value: f64,
    },
    Coordinate {
        component: CartesianComponentIR,
        frame: SelectionFrameIR,
    },
    MagnetizationComponent {
        component: CartesianComponentIR,
    },
    MagnetizationNorm {},
    MagnetizationDot {
        #[serde(deserialize_with = "deserialize_unit_vector3")]
        axis: [f64; 3],
    },
    Abs {
        value: Box<SelectionScalarExprIR>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SelectionExprIR {
    AllMagnetic {},
    InObject {
        object_id: String,
    },
    InRegion {
        object_id: String,
        region_id: String,
    },
    InsideGeometry {
        geometry: GeometryPredicateIR,
        frame: SelectionFrameIR,
        sampling: SelectionSamplingIR,
        boundary: BoundaryMembershipIR,
    },
    Compare {
        lhs: SelectionScalarExprIR,
        op: ComparisonOpIR,
        rhs: SelectionScalarExprIR,
        #[serde(default, skip_serializing_if = "ComparisonToleranceIR::is_exact")]
        tolerance: ComparisonToleranceIR,
    },
    Approx {
        value: SelectionScalarExprIR,
        target: SelectionScalarExprIR,
        atol: f64,
        rtol: f64,
    },
    Between {
        value: SelectionScalarExprIR,
        lower: f64,
        upper: f64,
        closed: ClosedIntervalIR,
    },
    And {
        expressions: Vec<SelectionExprIR>,
    },
    Or {
        expressions: Vec<SelectionExprIR>,
    },
    Xor {
        expressions: Vec<SelectionExprIR>,
    },
    Not {
        expression: Box<SelectionExprIR>,
    },
    Ref {
        selection_id: String,
    },
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum SelectionExprIRWire {
    AllMagnetic {},
    InObject {
        object_id: String,
    },
    InRegion {
        object_id: String,
        region_id: String,
    },
    InsideGeometry {
        geometry: GeometryPredicateIR,
        frame: SelectionFrameIR,
        sampling: SelectionSamplingIR,
        boundary: BoundaryMembershipIR,
    },
    Compare {
        lhs: SelectionScalarExprIR,
        op: ComparisonOpIR,
        rhs: SelectionScalarExprIR,
        #[serde(default)]
        tolerance: ComparisonToleranceIR,
    },
    Approx {
        value: SelectionScalarExprIR,
        target: SelectionScalarExprIR,
        atol: f64,
        rtol: f64,
    },
    Between {
        value: SelectionScalarExprIR,
        lower: f64,
        upper: f64,
        closed: ClosedIntervalIR,
    },
    And {
        expressions: Vec<SelectionExprIR>,
    },
    Or {
        expressions: Vec<SelectionExprIR>,
    },
    Xor {
        expressions: Vec<SelectionExprIR>,
    },
    Not {
        expression: Box<SelectionExprIR>,
    },
    Ref {
        selection_id: String,
    },
}

impl From<SelectionExprIRWire> for SelectionExprIR {
    fn from(value: SelectionExprIRWire) -> Self {
        match value {
            SelectionExprIRWire::AllMagnetic {} => Self::AllMagnetic {},
            SelectionExprIRWire::InObject { object_id } => Self::InObject { object_id },
            SelectionExprIRWire::InRegion {
                object_id,
                region_id,
            } => Self::InRegion {
                object_id,
                region_id,
            },
            SelectionExprIRWire::InsideGeometry {
                geometry,
                frame,
                sampling,
                boundary,
            } => Self::InsideGeometry {
                geometry,
                frame,
                sampling,
                boundary,
            },
            SelectionExprIRWire::Compare {
                lhs,
                op,
                rhs,
                tolerance,
            } => Self::Compare {
                lhs,
                op,
                rhs,
                tolerance,
            },
            SelectionExprIRWire::Approx {
                value,
                target,
                atol,
                rtol,
            } => Self::Approx {
                value,
                target,
                atol,
                rtol,
            },
            SelectionExprIRWire::Between {
                value,
                lower,
                upper,
                closed,
            } => Self::Between {
                value,
                lower,
                upper,
                closed,
            },
            SelectionExprIRWire::And { expressions } => Self::And { expressions },
            SelectionExprIRWire::Or { expressions } => Self::Or { expressions },
            SelectionExprIRWire::Xor { expressions } => Self::Xor { expressions },
            SelectionExprIRWire::Not { expression } => Self::Not { expression },
            SelectionExprIRWire::Ref { selection_id } => Self::Ref { selection_id },
        }
        .canonicalized()
    }
}

impl<'de> Deserialize<'de> for SelectionExprIR {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        SelectionExprIRWire::deserialize(deserializer).map(Into::into)
    }
}

impl SelectionExprIR {
    fn canonicalized(self) -> Self {
        match self {
            Self::And { expressions } => Self::And {
                expressions: flatten_boolean(expressions, BooleanKind::And),
            },
            Self::Or { expressions } => Self::Or {
                expressions: flatten_boolean(expressions, BooleanKind::Or),
            },
            Self::Xor { expressions } => Self::Xor {
                expressions: flatten_boolean(expressions, BooleanKind::Xor),
            },
            Self::Not { expression } => Self::Not {
                expression: Box::new(expression.canonicalized()),
            },
            other => other,
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum BooleanKind {
    And,
    Or,
    Xor,
}

fn flatten_boolean(expressions: Vec<SelectionExprIR>, kind: BooleanKind) -> Vec<SelectionExprIR> {
    let mut flattened = Vec::new();
    for expression in expressions {
        let canonical = expression.canonicalized();
        match (kind, canonical) {
            (BooleanKind::And, SelectionExprIR::And { expressions })
            | (BooleanKind::Or, SelectionExprIR::Or { expressions })
            | (BooleanKind::Xor, SelectionExprIR::Xor { expressions }) => {
                flattened.extend(expressions)
            }
            (_, expression) => flattened.push(expression),
        }
    }
    flattened
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SelectionDefinitionIR {
    pub schema_version: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub expression: SelectionExprIR,
}

impl SelectionDefinitionIR {
    pub fn new(id: impl Into<String>, expression: SelectionExprIR) -> Self {
        Self {
            schema_version: SELECTION_EXPR_SCHEMA_VERSION.to_string(),
            id: id.into(),
            name: None,
            expression,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SelectionLimits {
    pub max_depth: usize,
    pub max_nodes: usize,
    pub max_references: usize,
}

impl Default for SelectionLimits {
    fn default() -> Self {
        Self {
            max_depth: 64,
            max_nodes: 4096,
            max_references: 1024,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SelectionValidationContext {
    pub object_ids: BTreeSet<String>,
    pub region_ids: BTreeSet<(String, String)>,
}

impl SelectionValidationContext {
    pub fn new<O, RO, R, ObjectIds, RegionIds>(object_ids: ObjectIds, region_ids: RegionIds) -> Self
    where
        O: Into<String>,
        RO: Into<String>,
        R: Into<String>,
        ObjectIds: IntoIterator<Item = O>,
        RegionIds: IntoIterator<Item = (RO, R)>,
    {
        Self {
            object_ids: object_ids.into_iter().map(Into::into).collect(),
            region_ids: region_ids
                .into_iter()
                .map(|(object_id, region_id)| (object_id.into(), region_id.into()))
                .collect(),
        }
    }
}

pub fn validate_selection_definitions(
    definitions: &[SelectionDefinitionIR],
    limits: SelectionLimits,
) -> Result<(), Vec<String>> {
    crate::validation::validate_selection_definitions_impl(definitions, limits, None)
}

pub fn validate_selection_definitions_with_context(
    definitions: &[SelectionDefinitionIR],
    limits: SelectionLimits,
    context: &SelectionValidationContext,
) -> Result<(), Vec<String>> {
    crate::validation::validate_selection_definitions_impl(definitions, limits, Some(context))
}

pub fn canonical_standalone_selection_sha256(
    definition: &SelectionDefinitionIR,
) -> Result<String, String> {
    canonical_selection_sha256(definition.id.as_str(), std::slice::from_ref(definition))
}

pub fn canonical_selection_sha256(
    root_id: &str,
    definitions: &[SelectionDefinitionIR],
) -> Result<String, String> {
    validate_selection_definitions(definitions, SelectionLimits::default())
        .map_err(|errors| errors.join("\n"))?;
    let mut by_id = BTreeMap::new();
    for definition in definitions {
        if by_id.insert(definition.id.as_str(), definition).is_some() {
            return Err(format!("duplicate selection id '{}'", definition.id));
        }
    }
    if !by_id.contains_key(root_id) {
        return Err(format!("selection '{root_id}' does not exist"));
    }

    let mut reachable = BTreeSet::new();
    let mut visiting = BTreeSet::new();
    collect_reachable_selections(root_id, &by_id, &mut visiting, &mut reachable)?;
    let ordered: Vec<_> = reachable
        .into_iter()
        .map(|id| *by_id.get(id).expect("reachable id came from selection map"))
        .collect();
    let payload = canonical_hash_payload(root_id, &ordered);
    let mut value = serde_json::to_value(payload).map_err(|error| error.to_string())?;
    canonicalize_hash_numbers(&mut value)?;
    let bytes = serde_json::to_vec(&value).map_err(|error| error.to_string())?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

#[derive(Serialize)]
struct CanonicalSelectionHashPayload {
    hash_encoding: &'static str,
    schema_version: &'static str,
    root_id: String,
    definitions: Vec<CanonicalSelectionHashDefinition>,
}

#[derive(Serialize)]
struct CanonicalSelectionHashDefinition {
    schema_version: String,
    id: String,
    expression: SelectionExprIR,
}

fn canonical_hash_payload(
    root_id: &str,
    definitions: &[&SelectionDefinitionIR],
) -> CanonicalSelectionHashPayload {
    let mut definitions: Vec<_> = definitions
        .iter()
        .map(|definition| CanonicalSelectionHashDefinition {
            schema_version: definition.schema_version.clone(),
            id: definition.id.clone(),
            expression: definition.expression.clone().canonicalized(),
        })
        .collect();
    definitions.sort_by(|left, right| left.id.cmp(&right.id));
    CanonicalSelectionHashPayload {
        hash_encoding: "selection_hash.f64_bits.v1",
        schema_version: SELECTION_EXPR_SCHEMA_VERSION,
        root_id: root_id.to_string(),
        definitions,
    }
}

fn canonicalize_hash_numbers(value: &mut serde_json::Value) -> Result<(), String> {
    match value {
        serde_json::Value::Number(number) => {
            let float = number.as_f64().ok_or_else(|| {
                format!("selection hash number '{number}' is not representable as f64")
            })?;
            *value = serde_json::json!({
                "$fullmag_f64_bits": format!("{:016x}", float.to_bits())
            });
        }
        serde_json::Value::Array(values) => {
            for child in values {
                canonicalize_hash_numbers(child)?;
            }
        }
        serde_json::Value::Object(fields) => {
            for child in fields.values_mut() {
                canonicalize_hash_numbers(child)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn collect_reachable_selections<'a>(
    selection_id: &'a str,
    by_id: &BTreeMap<&'a str, &'a SelectionDefinitionIR>,
    visiting: &mut BTreeSet<&'a str>,
    reachable: &mut BTreeSet<&'a str>,
) -> Result<(), String> {
    if reachable.contains(selection_id) {
        return Ok(());
    }
    if !visiting.insert(selection_id) {
        return Err(format!("selection reference cycle at '{selection_id}'"));
    }
    let definition = by_id
        .get(selection_id)
        .ok_or_else(|| format!("selection '{selection_id}' does not exist"))?;
    let mut references = Vec::new();
    collect_hash_references(&definition.expression, &mut references);
    for reference in references {
        collect_reachable_selections(reference, by_id, visiting, reachable)?;
    }
    visiting.remove(selection_id);
    reachable.insert(selection_id);
    Ok(())
}

fn collect_hash_references<'a>(expression: &'a SelectionExprIR, references: &mut Vec<&'a str>) {
    match expression {
        SelectionExprIR::And { expressions }
        | SelectionExprIR::Or { expressions }
        | SelectionExprIR::Xor { expressions } => {
            for child in expressions {
                collect_hash_references(child, references);
            }
        }
        SelectionExprIR::Not { expression } => collect_hash_references(expression, references),
        SelectionExprIR::Ref { selection_id } => references.push(selection_id),
        _ => {}
    }
}
