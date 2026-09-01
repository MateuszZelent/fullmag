use crate::RegionRefIR;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

pub const FEM_MESH_POLICY_SCHEMA_VERSION: &str = "fem_mesh_policy.v1";
pub const FEM_MESH_POLICY_FINGERPRINT_DOMAIN: &[u8] = b"fullmag.fem_mesh_policy.v1\0";
pub const ADJACENT_SIZE_GROWTH_DEFINITION_ID: &str = "adjacent_size_growth.v1";
pub const CELL_MAX_EDGE_SIZE_DEFINITION_ID: &str = "cell.max_edge.v1";
pub const FEM_MESH_QUALITY_METRIC_IDS: &[&str] = &[
    "topology.manifold.v1",
    "topology.exact_layers.v1",
    "cell.strict_scale.max_pairwise_vertex_distance.v1",
    "cell.det_jacobian.v1",
    "gmsh.min_sicn.v1",
    "gmsh.gamma.v1",
    "mixed_topology_scaled_jacobian.v1",
    "cell.volume.v1",
    "cell.max_edge.v1",
    "adjacent_size_growth.v1",
    "airbox.regular_tet_equivalent_size.v1",
    "airbox.distance_bands.v1",
    "evidence.identity.v1",
];

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum FemAirboxGradingLawIR {
    Uniform,
    Linear,
    Geometric,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum FemMeshTransitionDistanceIR {
    Metres(f64),
    Boundary(FemMeshTransitionBoundaryIR),
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FemMeshTransitionBoundaryIR {
    AirboxBoundary,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum FemMeshStrategyIntentIR {
    Tetrahedral,
    ThinFilmTetrahedral,
    Swept,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum FemMeshTopologyIntentIR {
    Tetrahedral,
    Prismatic,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum FemSweepAxisIR {
    Auto,
    X,
    Y,
    Z,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum FemSweepDistributionIR {
    Fixed,
    Linear,
    Exponential,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum FemSweepFaceTopologyIR {
    Triangular,
    Quadrilateral,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum FemElementFamilyIR {
    Tet4,
    Prism6,
    Pyramid5,
    Hex8,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum FemTransitionPolicyIR {
    PyramidToTetrahedra,
    Reject,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum FemMeshQualityScopeIR {
    MagneticBulk,
    MaterialInterface,
    ObjectSurface,
    ObjectEdge,
    ObjectCorner,
    TransitionAir,
    FarAir,
    BoundaryLayer,
    SweptLayer,
    SharedDomain,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FemMaterialMeshPolicyIR {
    pub target: RegionRefIR,
    pub strategy_intent: FemMeshStrategyIntentIR,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub topology_intent: Option<FemMeshTopologyIntentIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maximum_element_size: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minimum_element_size: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub curvature_factor: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub narrow_region_resolution: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edge_maximum_element_size: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edge_thickness: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edge_transition_distance: Option<FemMeshTransitionDistanceIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub corner_maximum_element_size: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub corner_extent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub corner_transition_distance: Option<FemMeshTransitionDistanceIR>,
}

impl Default for FemMaterialMeshPolicyIR {
    fn default() -> Self {
        Self {
            target: RegionRefIR {
                object_id: String::new(),
                region_id: None,
            },
            strategy_intent: FemMeshStrategyIntentIR::Tetrahedral,
            topology_intent: None,
            maximum_element_size: None,
            minimum_element_size: None,
            curvature_factor: None,
            narrow_region_resolution: None,
            edge_maximum_element_size: None,
            edge_thickness: None,
            edge_transition_distance: None,
            corner_maximum_element_size: None,
            corner_extent: None,
            corner_transition_distance: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FemInterfaceMeshPolicyIR {
    pub target: RegionRefIR,
    pub maximum_element_size: f64,
    pub thickness: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition_distance: Option<FemMeshTransitionDistanceIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FemAirboxMeshPolicyIR {
    pub law: FemAirboxGradingLawIR,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub near_element_size: Option<f64>,
    pub far_element_size: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition_distance: Option<FemMeshTransitionDistanceIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub element_ratio: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FemSweepPolicyIR {
    pub target: RegionRefIR,
    pub requested_axis: FemSweepAxisIR,
    pub layers: u32,
    pub distribution: FemSweepDistributionIR,
    pub element_ratio: f64,
    pub symmetric: bool,
    pub face_topology: FemSweepFaceTopologyIR,
    pub family_intent: FemElementFamilyIR,
    pub transition: FemTransitionPolicyIR,
    pub exact_layers: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct MeshGrowthPolicyIR {
    pub definition_id: String,
    pub cell_size_definition_id: String,
    pub max_neighbor_ratio: f64,
    pub relative_tolerance: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct MeshQualityThresholdIR {
    pub metric_id: String,
    pub family: FemElementFamilyIR,
    pub scope: FemMeshQualityScopeIR,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minimum: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maximum: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub p05_minimum: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub p95_maximum: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(deny_unknown_fields)]
pub struct MeshQualityPolicyIR {
    #[serde(default)]
    pub compute_summary: bool,
    #[serde(default)]
    pub per_element: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub thresholds: Vec<MeshQualityThresholdIR>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct FemMeshPolicyIR {
    pub schema_version: String,
    pub geometric_element_order: u8,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub materials: Vec<FemMaterialMeshPolicyIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub interfaces: Vec<FemInterfaceMeshPolicyIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub airbox: Option<FemAirboxMeshPolicyIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sweeps: Vec<FemSweepPolicyIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub growth: Option<MeshGrowthPolicyIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quality: Option<MeshQualityPolicyIR>,
}

impl Default for FemMeshPolicyIR {
    fn default() -> Self {
        Self {
            schema_version: FEM_MESH_POLICY_SCHEMA_VERSION.to_string(),
            geometric_element_order: 1,
            materials: Vec::new(),
            interfaces: Vec::new(),
            airbox: None,
            sweeps: Vec::new(),
            growth: None,
            quality: None,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FemMeshPolicyWire {
    schema_version: String,
    geometric_element_order: u8,
    #[serde(default)]
    materials: Vec<FemMaterialMeshPolicyIR>,
    #[serde(default)]
    interfaces: Vec<FemInterfaceMeshPolicyIR>,
    #[serde(default)]
    airbox: Option<FemAirboxMeshPolicyIR>,
    #[serde(default)]
    sweeps: Vec<FemSweepPolicyIR>,
    #[serde(default)]
    growth: Option<MeshGrowthPolicyIR>,
    #[serde(default)]
    quality: Option<MeshQualityPolicyIR>,
}

impl From<FemMeshPolicyWire> for FemMeshPolicyIR {
    fn from(wire: FemMeshPolicyWire) -> Self {
        Self {
            schema_version: wire.schema_version,
            geometric_element_order: wire.geometric_element_order,
            materials: wire.materials,
            interfaces: wire.interfaces,
            airbox: wire.airbox,
            sweeps: wire.sweeps,
            growth: wire.growth,
            quality: wire.quality,
        }
    }
}

impl<'de> Deserialize<'de> for FemMeshPolicyIR {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        Self::from_json_value(value).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MeshPolicyValidationCode {
    FemMeshPolicyUnknownField,
    FemMeshPolicyMalformedValue,
    FemMeshPolicyInvalidSchemaVersion,
    FemMeshPolicyUnsupportedElementOrder,
    FemMeshPolicyNonFiniteValue,
    FemMeshPolicyInvalidValue,
    FemMeshPolicyConflictingBounds,
    FemMeshPolicyIncompleteRefinement,
    FemMeshPolicyIncompleteAirboxLaw,
    FemMeshPolicyInvalidAirboxLaw,
    FemMeshPolicyInvalidSweep,
    FemMeshPolicyDuplicateTarget,
    FemMeshPolicyInvalidGrowth,
    FemMeshPolicyInvalidQualityThreshold,
}

impl MeshPolicyValidationCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::FemMeshPolicyUnknownField => "fem_mesh_policy_unknown_field",
            Self::FemMeshPolicyMalformedValue => "fem_mesh_policy_malformed_value",
            Self::FemMeshPolicyInvalidSchemaVersion => "fem_mesh_policy_invalid_schema_version",
            Self::FemMeshPolicyUnsupportedElementOrder => {
                "fem_mesh_policy_unsupported_element_order"
            }
            Self::FemMeshPolicyNonFiniteValue => "fem_mesh_policy_non_finite_value",
            Self::FemMeshPolicyInvalidValue => "fem_mesh_policy_invalid_value",
            Self::FemMeshPolicyConflictingBounds => "fem_mesh_policy_conflicting_bounds",
            Self::FemMeshPolicyIncompleteRefinement => "fem_mesh_policy_incomplete_refinement",
            Self::FemMeshPolicyIncompleteAirboxLaw => "fem_mesh_policy_incomplete_airbox_law",
            Self::FemMeshPolicyInvalidAirboxLaw => "fem_mesh_policy_invalid_airbox_law",
            Self::FemMeshPolicyInvalidSweep => "fem_mesh_policy_invalid_sweep",
            Self::FemMeshPolicyDuplicateTarget => "fem_mesh_policy_duplicate_target",
            Self::FemMeshPolicyInvalidGrowth => "fem_mesh_policy_invalid_growth",
            Self::FemMeshPolicyInvalidQualityThreshold => {
                "fem_mesh_policy_invalid_quality_threshold"
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MeshPolicyValidationError {
    code: MeshPolicyValidationCode,
    pointer: String,
    message: String,
}

impl MeshPolicyValidationError {
    fn new(
        code: MeshPolicyValidationCode,
        pointer: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            code,
            pointer: pointer.into(),
            message: message.into(),
        }
    }

    pub const fn code(&self) -> MeshPolicyValidationCode {
        self.code
    }

    pub fn pointer(&self) -> &str {
        &self.pointer
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn with_pointer_prefix(mut self, prefix: &str) -> Self {
        self.pointer = if self.pointer == "/" {
            prefix.to_string()
        } else {
            format!("{prefix}{}", self.pointer)
        };
        self
    }
}

impl fmt::Display for MeshPolicyValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{} at {}: {}",
            self.code.as_str(),
            self.pointer,
            self.message
        )
    }
}

impl std::error::Error for MeshPolicyValidationError {}

fn target_key(target: &RegionRefIR) -> (&str, &str) {
    (
        target.object_id.as_str(),
        target.region_id.as_deref().unwrap_or(""),
    )
}

fn error(
    code: MeshPolicyValidationCode,
    pointer: impl Into<String>,
    message: impl Into<String>,
) -> MeshPolicyValidationError {
    MeshPolicyValidationError::new(code, pointer, message)
}

fn require_finite(value: f64, pointer: &str) -> Result<(), MeshPolicyValidationError> {
    if value.is_finite() {
        Ok(())
    } else {
        Err(error(
            MeshPolicyValidationCode::FemMeshPolicyNonFiniteValue,
            pointer,
            "present numeric value must be finite",
        ))
    }
}

fn require_positive(value: f64, pointer: &str) -> Result<(), MeshPolicyValidationError> {
    require_finite(value, pointer)?;
    if value > 0.0 {
        Ok(())
    } else {
        Err(error(
            MeshPolicyValidationCode::FemMeshPolicyInvalidValue,
            pointer,
            "value must be greater than zero",
        ))
    }
}

fn validate_optional_positive(
    value: Option<f64>,
    pointer: &str,
) -> Result<(), MeshPolicyValidationError> {
    if let Some(value) = value {
        require_positive(value, pointer)?;
    }
    Ok(())
}

fn validate_optional_transition_distance(
    value: Option<FemMeshTransitionDistanceIR>,
    pointer: &str,
    allow_zero: bool,
) -> Result<(), MeshPolicyValidationError> {
    let Some(value) = value else {
        return Ok(());
    };
    match value {
        FemMeshTransitionDistanceIR::Boundary(FemMeshTransitionBoundaryIR::AirboxBoundary) => {
            Ok(())
        }
        FemMeshTransitionDistanceIR::Metres(value) => {
            require_finite(value, pointer)?;
            if value > 0.0 || (allow_zero && value == 0.0) {
                Ok(())
            } else {
                Err(error(
                    MeshPolicyValidationCode::FemMeshPolicyInvalidValue,
                    pointer,
                    if allow_zero {
                        "transition distance must be non-negative"
                    } else {
                        "transition distance must be greater than zero"
                    },
                ))
            }
        }
    }
}

fn validate_target(target: &RegionRefIR, pointer: &str) -> Result<(), MeshPolicyValidationError> {
    if target.object_id.trim().is_empty() {
        return Err(error(
            MeshPolicyValidationCode::FemMeshPolicyInvalidValue,
            format!("{pointer}/object_id"),
            "object_id must not be empty",
        ));
    }
    if target
        .region_id
        .as_ref()
        .is_some_and(|region| region.trim().is_empty())
    {
        return Err(error(
            MeshPolicyValidationCode::FemMeshPolicyInvalidValue,
            format!("{pointer}/region_id"),
            "region_id must not be empty when present",
        ));
    }
    Ok(())
}

fn validate_pair(
    first: Option<f64>,
    second: Option<f64>,
    first_pointer: &str,
    second_pointer: &str,
) -> Result<(), MeshPolicyValidationError> {
    if first.is_some() != second.is_some() {
        return Err(error(
            MeshPolicyValidationCode::FemMeshPolicyIncompleteRefinement,
            if first.is_none() {
                first_pointer
            } else {
                second_pointer
            },
            "paired refinement values must be present together",
        ));
    }
    Ok(())
}

fn normalize_signed_zero(value: &mut f64) {
    if *value == 0.0 {
        *value = 0.0;
    }
}

fn normalize_optional_signed_zero(value: &mut Option<f64>) {
    if let Some(value) = value {
        normalize_signed_zero(value);
    }
}

fn normalize_transition_signed_zero(value: &mut Option<FemMeshTransitionDistanceIR>) {
    if let Some(FemMeshTransitionDistanceIR::Metres(value)) = value {
        normalize_signed_zero(value);
    }
}

impl FemMeshPolicyIR {
    pub fn from_json_value(value: Value) -> Result<Self, MeshPolicyValidationError> {
        preflight_policy_value(&value)?;
        let wire =
            serde_path_to_error::deserialize::<_, FemMeshPolicyWire>(value).map_err(|cause| {
                error(
                    MeshPolicyValidationCode::FemMeshPolicyMalformedValue,
                    serde_path_to_json_pointer(cause.path()),
                    cause.to_string(),
                )
            })?;
        let policy = Self::from(wire);
        policy.validate()?;
        Ok(policy)
    }

    pub fn validate(&self) -> Result<(), MeshPolicyValidationError> {
        if self.schema_version != FEM_MESH_POLICY_SCHEMA_VERSION {
            return Err(error(
                MeshPolicyValidationCode::FemMeshPolicyInvalidSchemaVersion,
                "/schema_version",
                format!("expected '{FEM_MESH_POLICY_SCHEMA_VERSION}'"),
            ));
        }
        if self.geometric_element_order != 1 {
            return Err(error(
                MeshPolicyValidationCode::FemMeshPolicyUnsupportedElementOrder,
                "/geometric_element_order",
                "only first-order geometric elements are supported",
            ));
        }

        let mut targets = BTreeSet::new();
        for (index, material) in self.materials.iter().enumerate() {
            let base = format!("/materials/{index}");
            validate_target(&material.target, &format!("{base}/target"))?;
            if !targets.insert(target_key(&material.target)) {
                return Err(error(
                    MeshPolicyValidationCode::FemMeshPolicyDuplicateTarget,
                    format!("{base}/target"),
                    "material target is duplicated",
                ));
            }
            for (field, value) in [
                ("maximum_element_size", material.maximum_element_size),
                ("minimum_element_size", material.minimum_element_size),
                ("curvature_factor", material.curvature_factor),
                (
                    "narrow_region_resolution",
                    material.narrow_region_resolution,
                ),
                (
                    "edge_maximum_element_size",
                    material.edge_maximum_element_size,
                ),
                ("edge_thickness", material.edge_thickness),
                (
                    "corner_maximum_element_size",
                    material.corner_maximum_element_size,
                ),
                ("corner_extent", material.corner_extent),
            ] {
                validate_optional_positive(value, &format!("{base}/{field}"))?;
            }
            validate_optional_transition_distance(
                material.edge_transition_distance,
                &format!("{base}/edge_transition_distance"),
                false,
            )?;
            validate_optional_transition_distance(
                material.corner_transition_distance,
                &format!("{base}/corner_transition_distance"),
                false,
            )?;
            if material.minimum_element_size.is_some_and(|minimum| {
                material
                    .maximum_element_size
                    .is_some_and(|maximum| minimum > maximum)
            }) {
                return Err(error(
                    MeshPolicyValidationCode::FemMeshPolicyConflictingBounds,
                    format!("{base}/minimum_element_size"),
                    "minimum_element_size must not exceed maximum_element_size",
                ));
            }
            if matches!(
                (material.strategy_intent, material.topology_intent),
                (
                    FemMeshStrategyIntentIR::Tetrahedral
                        | FemMeshStrategyIntentIR::ThinFilmTetrahedral,
                    Some(FemMeshTopologyIntentIR::Prismatic)
                ) | (
                    FemMeshStrategyIntentIR::Swept,
                    Some(FemMeshTopologyIntentIR::Tetrahedral)
                )
            ) {
                return Err(error(
                    MeshPolicyValidationCode::FemMeshPolicyInvalidSweep,
                    format!("{base}/topology_intent"),
                    "strategy_intent and topology_intent are incompatible",
                ));
            }
            validate_pair(
                material.edge_maximum_element_size,
                material.edge_thickness,
                &format!("{base}/edge_maximum_element_size"),
                &format!("{base}/edge_thickness"),
            )?;
            validate_pair(
                material.corner_maximum_element_size,
                material.corner_extent,
                &format!("{base}/corner_maximum_element_size"),
                &format!("{base}/corner_extent"),
            )?;
        }

        let mut interface_targets = BTreeSet::new();
        for (index, interface) in self.interfaces.iter().enumerate() {
            let base = format!("/interfaces/{index}");
            validate_target(&interface.target, &format!("{base}/target"))?;
            if !interface_targets.insert(target_key(&interface.target)) {
                return Err(error(
                    MeshPolicyValidationCode::FemMeshPolicyDuplicateTarget,
                    format!("{base}/target"),
                    "interface target is duplicated",
                ));
            }
            require_positive(
                interface.maximum_element_size,
                &format!("{base}/maximum_element_size"),
            )?;
            require_positive(interface.thickness, &format!("{base}/thickness"))?;
            validate_optional_transition_distance(
                interface.transition_distance,
                &format!("{base}/transition_distance"),
                true,
            )?;
        }

        if let Some(airbox) = &self.airbox {
            require_positive(airbox.far_element_size, "/airbox/far_element_size")?;
            validate_optional_positive(airbox.near_element_size, "/airbox/near_element_size")?;
            validate_optional_transition_distance(
                airbox.transition_distance,
                "/airbox/transition_distance",
                false,
            )?;
            validate_optional_positive(airbox.element_ratio, "/airbox/element_ratio")?;
            if airbox
                .near_element_size
                .is_some_and(|near| near > airbox.far_element_size)
            {
                return Err(error(
                    MeshPolicyValidationCode::FemMeshPolicyConflictingBounds,
                    "/airbox/near_element_size",
                    "near_element_size must not exceed far_element_size",
                ));
            }
            match airbox.law {
                FemAirboxGradingLawIR::Uniform => {
                    if airbox.transition_distance.is_some() || airbox.element_ratio.is_some() {
                        return Err(error(
                            MeshPolicyValidationCode::FemMeshPolicyInvalidAirboxLaw,
                            "/airbox/law",
                            "uniform law forbids transition_distance and element_ratio",
                        ));
                    }
                }
                FemAirboxGradingLawIR::Linear => {
                    if airbox.near_element_size.is_none() {
                        return Err(error(
                            MeshPolicyValidationCode::FemMeshPolicyIncompleteAirboxLaw,
                            "/airbox/near_element_size",
                            "linear law requires near_element_size",
                        ));
                    }
                    if airbox.transition_distance.is_none() {
                        return Err(error(
                            MeshPolicyValidationCode::FemMeshPolicyIncompleteAirboxLaw,
                            "/airbox/transition_distance",
                            "linear law requires transition_distance",
                        ));
                    }
                    if airbox.element_ratio.is_some() {
                        return Err(error(
                            MeshPolicyValidationCode::FemMeshPolicyInvalidAirboxLaw,
                            "/airbox/element_ratio",
                            "linear law forbids element_ratio",
                        ));
                    }
                }
                FemAirboxGradingLawIR::Geometric => {
                    if airbox.near_element_size.is_none() {
                        return Err(error(
                            MeshPolicyValidationCode::FemMeshPolicyIncompleteAirboxLaw,
                            "/airbox/near_element_size",
                            "geometric law requires near_element_size",
                        ));
                    }
                    if airbox.transition_distance.is_none() {
                        return Err(error(
                            MeshPolicyValidationCode::FemMeshPolicyIncompleteAirboxLaw,
                            "/airbox/transition_distance",
                            "geometric law requires transition_distance",
                        ));
                    }
                    let Some(ratio) = airbox.element_ratio else {
                        return Err(error(
                            MeshPolicyValidationCode::FemMeshPolicyIncompleteAirboxLaw,
                            "/airbox/element_ratio",
                            "geometric law requires element_ratio",
                        ));
                    };
                    if ratio <= 1.0 || ratio > 2.5 {
                        return Err(error(
                            MeshPolicyValidationCode::FemMeshPolicyInvalidAirboxLaw,
                            "/airbox/element_ratio",
                            "geometric element_ratio must satisfy 1 < ratio <= 2.5",
                        ));
                    }
                }
            }
        }

        let mut sweep_targets = BTreeSet::new();
        for (index, sweep) in self.sweeps.iter().enumerate() {
            let base = format!("/sweeps/{index}");
            validate_target(&sweep.target, &format!("{base}/target"))?;
            if !sweep_targets.insert(target_key(&sweep.target)) {
                return Err(error(
                    MeshPolicyValidationCode::FemMeshPolicyDuplicateTarget,
                    format!("{base}/target"),
                    "sweep target is duplicated",
                ));
            }
            let material = self
                .materials
                .iter()
                .find(|material| target_key(&material.target) == target_key(&sweep.target))
                .ok_or_else(|| {
                    error(
                        MeshPolicyValidationCode::FemMeshPolicyInvalidSweep,
                        format!("{base}/target"),
                        "sweep target must reference a material policy target",
                    )
                })?;
            match (material.strategy_intent, sweep.family_intent) {
                (FemMeshStrategyIntentIR::Swept, FemElementFamilyIR::Prism6)
                | (FemMeshStrategyIntentIR::Swept, FemElementFamilyIR::Hex8)
                | (FemMeshStrategyIntentIR::ThinFilmTetrahedral, FemElementFamilyIR::Tet4) => {}
                (FemMeshStrategyIntentIR::Tetrahedral, _) => {
                    return Err(error(
                        MeshPolicyValidationCode::FemMeshPolicyInvalidSweep,
                        format!("{base}/target"),
                        "tetrahedral strategy does not accept a through-thickness sweep policy",
                    ));
                }
                _ => {
                    return Err(error(
                        MeshPolicyValidationCode::FemMeshPolicyInvalidSweep,
                        format!("{base}/family_intent"),
                        "strategy_intent and sweep family_intent are incompatible",
                    ));
                }
            }
            if sweep.layers == 0 {
                return Err(error(
                    MeshPolicyValidationCode::FemMeshPolicyInvalidSweep,
                    format!("{base}/layers"),
                    "layers must be at least one",
                ));
            }
            require_positive(sweep.element_ratio, &format!("{base}/element_ratio"))?;
            if sweep.exact_layers
                && (sweep.distribution != FemSweepDistributionIR::Fixed
                    || sweep.element_ratio != 1.0
                    || sweep.symmetric)
            {
                return Err(error(
                    MeshPolicyValidationCode::FemMeshPolicyInvalidSweep,
                    format!("{base}/exact_layers"),
                    "exact layers require fixed distribution, unit ratio, and symmetric=false",
                ));
            }
            match (sweep.face_topology, sweep.family_intent, sweep.transition) {
                (
                    FemSweepFaceTopologyIR::Triangular,
                    FemElementFamilyIR::Prism6,
                    FemTransitionPolicyIR::PyramidToTetrahedra | FemTransitionPolicyIR::Reject,
                )
                | (
                    FemSweepFaceTopologyIR::Quadrilateral,
                    FemElementFamilyIR::Hex8,
                    FemTransitionPolicyIR::Reject,
                )
                | (
                    FemSweepFaceTopologyIR::Triangular,
                    FemElementFamilyIR::Tet4,
                    FemTransitionPolicyIR::Reject,
                ) => {}
                _ => {
                    return Err(error(
                        MeshPolicyValidationCode::FemMeshPolicyInvalidSweep,
                        format!("{base}/family_intent"),
                        "face topology, family intent, and transition are incompatible",
                    ));
                }
            }
        }
        for (index, material) in self.materials.iter().enumerate() {
            if material.strategy_intent == FemMeshStrategyIntentIR::Swept
                && !sweep_targets.contains(&target_key(&material.target))
            {
                return Err(error(
                    MeshPolicyValidationCode::FemMeshPolicyInvalidSweep,
                    format!("/materials/{index}/strategy_intent"),
                    "swept strategy requires one matching sweep policy",
                ));
            }
        }

        if let Some(growth) = &self.growth {
            if growth.definition_id != ADJACENT_SIZE_GROWTH_DEFINITION_ID {
                return Err(error(
                    MeshPolicyValidationCode::FemMeshPolicyInvalidGrowth,
                    "/growth/definition_id",
                    format!("expected '{ADJACENT_SIZE_GROWTH_DEFINITION_ID}'"),
                ));
            }
            if growth.cell_size_definition_id != CELL_MAX_EDGE_SIZE_DEFINITION_ID {
                return Err(error(
                    MeshPolicyValidationCode::FemMeshPolicyInvalidGrowth,
                    "/growth/cell_size_definition_id",
                    format!("expected '{CELL_MAX_EDGE_SIZE_DEFINITION_ID}'"),
                ));
            }
            require_finite(growth.max_neighbor_ratio, "/growth/max_neighbor_ratio")?;
            if growth.max_neighbor_ratio <= 1.0 || growth.max_neighbor_ratio > 2.5 {
                return Err(error(
                    MeshPolicyValidationCode::FemMeshPolicyInvalidGrowth,
                    "/growth/max_neighbor_ratio",
                    "max_neighbor_ratio must satisfy 1 < ratio <= 2.5",
                ));
            }
            require_finite(growth.relative_tolerance, "/growth/relative_tolerance")?;
            if !(0.0..1.0).contains(&growth.relative_tolerance) {
                return Err(error(
                    MeshPolicyValidationCode::FemMeshPolicyInvalidGrowth,
                    "/growth/relative_tolerance",
                    "relative_tolerance must satisfy 0 <= tolerance < 1",
                ));
            }
        }

        if let Some(quality) = &self.quality {
            let mut identities = BTreeSet::new();
            for (index, threshold) in quality.thresholds.iter().enumerate() {
                let base = format!("/quality/thresholds/{index}");
                if !FEM_MESH_QUALITY_METRIC_IDS.contains(&threshold.metric_id.as_str()) {
                    return Err(error(
                        MeshPolicyValidationCode::FemMeshPolicyInvalidQualityThreshold,
                        format!("{base}/metric_id"),
                        "metric_id must identify a supported versioned FEM mesh quality metric",
                    ));
                }
                if !identities.insert((
                    threshold.metric_id.as_str(),
                    threshold.family,
                    threshold.scope,
                )) {
                    return Err(error(
                        MeshPolicyValidationCode::FemMeshPolicyInvalidQualityThreshold,
                        base,
                        "metric/family/scope threshold is duplicated",
                    ));
                }
                for (field, value) in [
                    ("minimum", threshold.minimum),
                    ("maximum", threshold.maximum),
                    ("p05_minimum", threshold.p05_minimum),
                    ("p95_maximum", threshold.p95_maximum),
                ] {
                    if let Some(value) = value {
                        require_finite(value, &format!("{base}/{field}"))?;
                    }
                }
                if threshold.minimum.is_none()
                    && threshold.maximum.is_none()
                    && threshold.p05_minimum.is_none()
                    && threshold.p95_maximum.is_none()
                {
                    return Err(error(
                        MeshPolicyValidationCode::FemMeshPolicyInvalidQualityThreshold,
                        base,
                        "at least one threshold bound is required",
                    ));
                }
                if threshold.minimum.is_some_and(|minimum| {
                    threshold.maximum.is_some_and(|maximum| minimum > maximum)
                }) {
                    return Err(error(
                        MeshPolicyValidationCode::FemMeshPolicyInvalidQualityThreshold,
                        format!("{base}/minimum"),
                        "minimum must not exceed maximum",
                    ));
                }
            }
        }
        Ok(())
    }

    pub fn canonical_json(&self) -> Result<Vec<u8>, MeshPolicyValidationError> {
        self.validate()?;
        let mut canonical = self.clone();
        for material in &mut canonical.materials {
            normalize_optional_signed_zero(&mut material.maximum_element_size);
            normalize_optional_signed_zero(&mut material.minimum_element_size);
            normalize_optional_signed_zero(&mut material.curvature_factor);
            normalize_optional_signed_zero(&mut material.narrow_region_resolution);
            normalize_optional_signed_zero(&mut material.edge_maximum_element_size);
            normalize_optional_signed_zero(&mut material.edge_thickness);
            normalize_transition_signed_zero(&mut material.edge_transition_distance);
            normalize_optional_signed_zero(&mut material.corner_maximum_element_size);
            normalize_optional_signed_zero(&mut material.corner_extent);
            normalize_transition_signed_zero(&mut material.corner_transition_distance);
        }
        for interface in &mut canonical.interfaces {
            normalize_signed_zero(&mut interface.maximum_element_size);
            normalize_signed_zero(&mut interface.thickness);
            normalize_transition_signed_zero(&mut interface.transition_distance);
        }
        if let Some(airbox) = &mut canonical.airbox {
            normalize_optional_signed_zero(&mut airbox.near_element_size);
            normalize_signed_zero(&mut airbox.far_element_size);
            normalize_transition_signed_zero(&mut airbox.transition_distance);
            normalize_optional_signed_zero(&mut airbox.element_ratio);
        }
        for sweep in &mut canonical.sweeps {
            normalize_signed_zero(&mut sweep.element_ratio);
        }
        if let Some(growth) = &mut canonical.growth {
            normalize_signed_zero(&mut growth.max_neighbor_ratio);
            normalize_signed_zero(&mut growth.relative_tolerance);
        }
        if let Some(quality) = &mut canonical.quality {
            for threshold in &mut quality.thresholds {
                normalize_optional_signed_zero(&mut threshold.minimum);
                normalize_optional_signed_zero(&mut threshold.maximum);
                normalize_optional_signed_zero(&mut threshold.p05_minimum);
                normalize_optional_signed_zero(&mut threshold.p95_maximum);
            }
        }
        canonical
            .materials
            .sort_by(|left, right| target_key(&left.target).cmp(&target_key(&right.target)));
        canonical
            .interfaces
            .sort_by(|left, right| target_key(&left.target).cmp(&target_key(&right.target)));
        canonical
            .sweeps
            .sort_by(|left, right| target_key(&left.target).cmp(&target_key(&right.target)));
        if let Some(quality) = &mut canonical.quality {
            quality.thresholds.sort_by(|left, right| {
                (&left.metric_id, left.family, left.scope).cmp(&(
                    &right.metric_id,
                    right.family,
                    right.scope,
                ))
            });
        }
        serde_json::to_vec(&canonical).map_err(|cause| {
            error(
                MeshPolicyValidationCode::FemMeshPolicyMalformedValue,
                "/",
                cause.to_string(),
            )
        })
    }

    pub fn policy_fingerprint(&self) -> Result<String, MeshPolicyValidationError> {
        let canonical = self.canonical_json()?;
        let mut hasher = Sha256::new();
        hasher.update(FEM_MESH_POLICY_FINGERPRINT_DOMAIN);
        hasher.update(canonical);
        Ok(format!("sha256:{:x}", hasher.finalize()))
    }

    pub(crate) fn from_legacy_mesh_workflow(
        workflow: &Value,
        study_universe: Option<&Value>,
        object_ids: &BTreeMap<String, String>,
    ) -> Result<Option<Self>, String> {
        let root = workflow.as_object().ok_or_else(|| {
            "/problem_meta/runtime_metadata/mesh_workflow: expected an object".to_string()
        })?;
        for field in [
            "domain_mesh_source",
            "domain_region_markers",
            "domain_object_region_markers",
            "frozen_magnetic_submesh_source",
        ] {
            if root.get(field).is_some_and(legacy_value_is_effective) {
                return Err(format!(
                    "fem_mesh_policy_unsupported_legacy_control at /problem_meta/runtime_metadata/mesh_workflow/{field}: domain mesh input must migrate through its typed V04 asset contract"
                ));
            }
        }
        if root
            .get("operations")
            .is_some_and(legacy_value_is_effective)
        {
            return Err(
                "fem_mesh_policy_unsupported_legacy_control at /problem_meta/runtime_metadata/mesh_workflow/operations: OCC operations must migrate through typed V04 geometry"
                    .to_string(),
            );
        }
        let mut policy = Self::default();
        let mut has_policy = false;
        let fem_base = "/problem_meta/runtime_metadata/mesh_workflow/fem";
        let fem = legacy_optional_object(root.get("fem"), fem_base)?;
        if let Some(fem) = fem {
            reject_explicit_null_legacy_fields(fem, &["order", "hmax"], fem_base)?;
        }
        let mut requested_order = fem
            .map(|fem| legacy_u8(fem, "order", fem_base))
            .transpose()?
            .flatten();
        let mut growth_candidates = Vec::new();
        let mesh_options_base = "/problem_meta/runtime_metadata/mesh_workflow/mesh_options";
        let default_mesh_base = "/problem_meta/runtime_metadata/mesh_workflow/default_mesh";
        let mesh_options = legacy_optional_object(root.get("mesh_options"), mesh_options_base)?;
        let default_mesh = legacy_optional_object(root.get("default_mesh"), default_mesh_base)?;
        if let Some(mesh_options) = mesh_options {
            reject_explicit_null_legacy_fields(
                mesh_options,
                LEGACY_MATERIAL_POLICY_FIELDS,
                mesh_options_base,
            )?;
            reject_explicit_null_legacy_fields(
                mesh_options,
                LEGACY_AUXILIARY_POLICY_FIELDS,
                mesh_options_base,
            )?;
            reject_unsupported_legacy_mesh_controls(mesh_options, mesh_options_base)?;
        }
        if let Some(default_mesh) = default_mesh {
            reject_explicit_null_legacy_fields(
                default_mesh,
                LEGACY_MATERIAL_POLICY_FIELDS,
                default_mesh_base,
            )?;
            reject_explicit_null_legacy_fields(
                default_mesh,
                LEGACY_AUXILIARY_POLICY_FIELDS,
                default_mesh_base,
            )?;
            reject_unsupported_legacy_mesh_controls(default_mesh, default_mesh_base)?;
        }
        let has_explicit_per_geometry = root
            .get("per_geometry")
            .and_then(Value::as_array)
            .is_some_and(|entries| !entries.is_empty());
        let all_per_geometry_inherit = root
            .get("per_geometry")
            .and_then(Value::as_array)
            .filter(|entries| !entries.is_empty())
            .is_some_and(|entries| {
                entries.iter().all(|entry| {
                    entry
                        .as_object()
                        .and_then(|entry| entry.get("mode"))
                        .and_then(Value::as_str)
                        == Some("inherit")
                })
            });
        let mut effective_defaults = if all_per_geometry_inherit {
            legacy_overlay(default_mesh, mesh_options)
        } else {
            default_mesh.cloned().unwrap_or_default()
        };
        if !has_explicit_per_geometry && effective_defaults.is_empty() {
            effective_defaults = mesh_options.cloned().unwrap_or_default();
        }
        if let Some(fem) = fem {
            if !effective_defaults.contains_key("order") {
                if let Some(order) = fem.get("order").filter(|value| !value.is_null()) {
                    effective_defaults.insert("order".to_string(), order.clone());
                }
            }
            if !effective_defaults.contains_key("maximum_element_size")
                && !effective_defaults.contains_key("hmax")
            {
                if let Some(hmax) = fem.get("hmax").filter(|value| !value.is_null()) {
                    effective_defaults.insert("maximum_element_size".to_string(), hmax.clone());
                }
            }
        }

        let mut entries_to_migrate = Vec::new();
        if let Some(entries) = root.get("per_geometry") {
            let entries = entries.as_array().ok_or_else(|| {
                "/problem_meta/runtime_metadata/mesh_workflow/per_geometry: expected an array"
                    .to_string()
            })?;
            for (index, entry) in entries.iter().enumerate() {
                let base =
                    format!("/problem_meta/runtime_metadata/mesh_workflow/per_geometry/{index}");
                let entry = entry
                    .as_object()
                    .ok_or_else(|| format!("{base}: expected an object"))?;
                reject_explicit_null_legacy_fields(entry, LEGACY_MATERIAL_POLICY_FIELDS, &base)?;
                reject_explicit_null_legacy_fields(entry, LEGACY_AUXILIARY_POLICY_FIELDS, &base)?;
                reject_unsupported_legacy_mesh_controls(entry, &base)?;
                entries_to_migrate.push((entry.clone(), base));
            }
        }
        if entries_to_migrate.is_empty()
            && legacy_has_any_field(&effective_defaults, LEGACY_MATERIAL_POLICY_FIELDS)
        {
            let object_ids = object_ids.values().cloned().collect::<BTreeSet<_>>();
            if object_ids.is_empty() {
                return Err(
                    "/problem_meta/runtime_metadata/mesh_workflow/default_mesh: global material mesh controls require at least one migrated object"
                        .to_string(),
                );
            }
            for object_id in object_ids {
                entries_to_migrate.push((
                    serde_json::Map::from_iter([(
                        "geometry".to_string(),
                        Value::String(object_id),
                    )]),
                    "/problem_meta/runtime_metadata/mesh_workflow/default_mesh".to_string(),
                ));
            }
        }
        for (entry, base) in entries_to_migrate {
            let geometry = legacy_string(&entry, "geometry", &base)?
                .ok_or_else(|| format!("{base}/geometry: expected a non-empty string"))?;
            let effective_entry = legacy_overlay(Some(&effective_defaults), Some(&entry));
            let entry = &effective_entry;
            let object_id = object_ids.get(&geometry).ok_or_else(|| {
                format!("{base}/geometry: unresolved migrated object '{geometry}'")
            })?;
            let order = legacy_u8(entry, "order", &base)?.unwrap_or(1);
            if let Some(previous) = requested_order {
                if previous != order {
                    return Err(format!(
                            "{base}/order: all migrated material policies must request one geometric element order"
                        ));
                }
            }
            requested_order = Some(order);
            if let Some(maximum_neighbor_ratio) = legacy_f64(
                entry,
                &["maximum_element_growth_rate", "growth_rate"],
                &base,
            )? {
                growth_candidates.push(maximum_neighbor_ratio);
            }

            let strategy = match legacy_string(entry, "mesh_strategy", &base)?.as_deref() {
                None | Some("tetrahedral") | Some("free_tetrahedral") => {
                    FemMeshStrategyIntentIR::Tetrahedral
                }
                Some("thin_film_tetrahedral") => FemMeshStrategyIntentIR::ThinFilmTetrahedral,
                Some("swept") | Some("swept_prism") => FemMeshStrategyIntentIR::Swept,
                Some(other) => {
                    return Err(format!("{base}/mesh_strategy: unsupported value '{other}'"));
                }
            };
            let topology_intent = match legacy_string(entry, "topology", &base)?.as_deref() {
                None => None,
                Some("tetrahedral") => Some(FemMeshTopologyIntentIR::Tetrahedral),
                Some("prismatic") => Some(FemMeshTopologyIntentIR::Prismatic),
                Some(other) => {
                    return Err(format!("{base}/topology: unsupported value '{other}'"));
                }
            };
            let target = RegionRefIR {
                object_id: object_id.clone(),
                region_id: None,
            };
            let interface_maximum_element_size = legacy_f64(
                entry,
                &["interface_maximum_element_size", "interface_hmax"],
                &base,
            )?;
            let interface_thickness = legacy_f64(entry, &["interface_thickness"], &base)?;
            if interface_maximum_element_size.is_some() != interface_thickness.is_some() {
                return Err(format!(
                        "{base}/interface_thickness: migrated interface size and thickness must be present together"
                    ));
            }
            if let (Some(maximum_element_size), Some(thickness)) =
                (interface_maximum_element_size, interface_thickness)
            {
                policy.interfaces.push(FemInterfaceMeshPolicyIR {
                    target: target.clone(),
                    maximum_element_size,
                    thickness,
                    transition_distance: legacy_transition_distance(
                        entry,
                        &["transition_distance"],
                        &base,
                    )?,
                });
            }
            policy.materials.push(FemMaterialMeshPolicyIR {
                target: target.clone(),
                strategy_intent: strategy,
                topology_intent,
                maximum_element_size: legacy_f64(entry, &["maximum_element_size", "hmax"], &base)?,
                minimum_element_size: legacy_f64(entry, &["minimum_element_size", "hmin"], &base)?,
                curvature_factor: legacy_f64(entry, &["curvature_factor"], &base)?,
                narrow_region_resolution: legacy_f64(entry, &["narrow_region_resolution"], &base)?,
                edge_maximum_element_size: legacy_f64(
                    entry,
                    &["edge_maximum_element_size", "edge_hmax"],
                    &base,
                )?,
                edge_thickness: legacy_f64(entry, &["edge_thickness"], &base)?,
                edge_transition_distance: legacy_transition_distance(
                    entry,
                    &["edge_transition_distance"],
                    &base,
                )?,
                corner_maximum_element_size: legacy_f64(
                    entry,
                    &["corner_maximum_element_size", "corner_hmax"],
                    &base,
                )?,
                corner_extent: legacy_f64(entry, &["corner_extent"], &base)?,
                corner_transition_distance: legacy_transition_distance(
                    entry,
                    &["corner_transition_distance"],
                    &base,
                )?,
            });

            let has_layer_policy = legacy_has_any_field(entry, LEGACY_LAYER_POLICY_FIELDS);
            if strategy == FemMeshStrategyIntentIR::Tetrahedral && has_layer_policy {
                return Err(format!(
                        "{base}/mesh_strategy: through-thickness controls require thin_film_tetrahedral or swept"
                    ));
            }
            if strategy == FemMeshStrategyIntentIR::Swept
                || (strategy == FemMeshStrategyIntentIR::ThinFilmTetrahedral && has_layer_policy)
            {
                let face_topology =
                    match legacy_string(entry, "sweep_face_meshing", &base)?.as_deref() {
                        None | Some("triangular") => FemSweepFaceTopologyIR::Triangular,
                        Some("quadrilateral") => FemSweepFaceTopologyIR::Quadrilateral,
                        Some(other) => {
                            return Err(format!(
                                "{base}/sweep_face_meshing: unsupported value '{other}'"
                            ));
                        }
                    };
                let family_intent = match legacy_string(entry, "element_family", &base)?.as_deref()
                {
                    None if strategy == FemMeshStrategyIntentIR::ThinFilmTetrahedral => {
                        FemElementFamilyIR::Tet4
                    }
                    None | Some("prism") | Some("prism6") => FemElementFamilyIR::Prism6,
                    Some("tetrahedral") | Some("tet") | Some("tet4") => FemElementFamilyIR::Tet4,
                    Some("hex") | Some("hex8") => FemElementFamilyIR::Hex8,
                    Some(other) => {
                        return Err(format!(
                            "{base}/element_family: unsupported value '{other}'"
                        ));
                    }
                };
                let transition = match legacy_string(entry, "transition_policy", &base)?.as_deref()
                {
                    None if family_intent == FemElementFamilyIR::Prism6 => {
                        FemTransitionPolicyIR::PyramidToTetrahedra
                    }
                    None => FemTransitionPolicyIR::Reject,
                    Some("pyramid_to_tetrahedra") => FemTransitionPolicyIR::PyramidToTetrahedra,
                    Some("reject") => FemTransitionPolicyIR::Reject,
                    Some(other) => {
                        return Err(format!(
                            "{base}/transition_policy: unsupported value '{other}'"
                        ));
                    }
                };
                let requested_axis =
                    match legacy_string(entry, "sweep_direction", &base)?.as_deref() {
                        None | Some("auto") => FemSweepAxisIR::Auto,
                        Some("x") => FemSweepAxisIR::X,
                        Some("y") => FemSweepAxisIR::Y,
                        Some("z") => FemSweepAxisIR::Z,
                        Some(other) => {
                            return Err(format!(
                                "{base}/sweep_direction: unsupported value '{other}'"
                            ));
                        }
                    };
                let distribution =
                    match legacy_string(entry, "through_thickness_distribution", &base)?.as_deref()
                    {
                        None | Some("fixed") => FemSweepDistributionIR::Fixed,
                        Some("linear") => FemSweepDistributionIR::Linear,
                        Some("exponential") => FemSweepDistributionIR::Exponential,
                        Some(other) => {
                            return Err(format!(
                                "{base}/through_thickness_distribution: unsupported value '{other}'"
                            ));
                        }
                    };
                policy.sweeps.push(FemSweepPolicyIR {
                    target,
                    requested_axis,
                    layers: legacy_u32(entry, "through_thickness_elements", &base)?.unwrap_or(1),
                    distribution,
                    element_ratio: legacy_f64(entry, &["through_thickness_element_ratio"], &base)?
                        .unwrap_or(1.0),
                    symmetric: legacy_bool(entry, "through_thickness_symmetric", &base)?
                        .unwrap_or(false),
                    face_topology,
                    family_intent,
                    transition,
                    exact_layers: legacy_bool(entry, "exact_layer_count", &base)?.unwrap_or(true),
                });
            }

            let compute_summary = legacy_bool(entry, "compute_quality", &base)?.unwrap_or(false);
            let per_element = legacy_bool(entry, "per_element_quality", &base)?.unwrap_or(false);
            if compute_summary || per_element {
                let quality = policy.quality.get_or_insert_with(Default::default);
                quality.compute_summary |= compute_summary;
                quality.per_element |= per_element;
            }
            has_policy = true;
        }

        let defaults_base = "/problem_meta/runtime_metadata/mesh_workflow/mesh_options";
        if let Some(maximum_neighbor_ratio) = legacy_f64(
            &effective_defaults,
            &["maximum_element_growth_rate", "growth_rate"],
            defaults_base,
        )? {
            growth_candidates.push(maximum_neighbor_ratio);
            has_policy = true;
        }
        let compute_summary =
            legacy_bool(&effective_defaults, "compute_quality", defaults_base)?.unwrap_or(false);
        let per_element = legacy_bool(&effective_defaults, "per_element_quality", defaults_base)?
            .unwrap_or(false);
        if compute_summary || per_element {
            let quality = policy.quality.get_or_insert_with(Default::default);
            quality.compute_summary |= compute_summary;
            quality.per_element |= per_element;
            has_policy = true;
        }

        let mut migrated_airbox: Option<(serde_json::Map<String, Value>, String, bool)> = None;
        let workflow_airbox_base = "/problem_meta/runtime_metadata/mesh_workflow/airbox";
        if let Some(airbox) = legacy_optional_object(root.get("airbox"), workflow_airbox_base)? {
            reject_explicit_null_legacy_fields(
                airbox,
                LEGACY_AIRBOX_POLICY_FIELDS,
                workflow_airbox_base,
            )?;
            migrated_airbox = Some((airbox.clone(), workflow_airbox_base.to_string(), false));
        } else if let Some(study_universe) = legacy_optional_object(
            study_universe,
            "/problem_meta/runtime_metadata/study_universe",
        )? {
            let base = "/problem_meta/runtime_metadata/study_universe";
            reject_explicit_null_legacy_fields(
                study_universe,
                LEGACY_STUDY_UNIVERSE_POLICY_FIELDS,
                base,
            )?;
            let mut airbox = serde_json::Map::new();
            for (source, destination) in [
                ("airbox_hmin", "near_element_size"),
                ("airbox_hmax", "far_element_size"),
                ("airbox_growth_rate", "element_ratio"),
                ("airbox_grading", "grading"),
            ] {
                if let Some(value) = study_universe.get(source) {
                    airbox.insert(destination.to_string(), value.clone());
                }
            }
            if !airbox.is_empty() {
                migrated_airbox = Some((airbox, base.to_string(), true));
            }
        }

        if let Some((airbox, base, from_study_universe)) = migrated_airbox {
            let near = legacy_f64(
                &airbox,
                &["near_element_size", "minimum_element_size", "hmin"],
                &base,
            )?;
            let far = legacy_f64(
                &airbox,
                &["far_element_size", "maximum_element_size", "hmax"],
                &base,
            )?;
            let transition_distance =
                legacy_transition_distance(&airbox, &["transition_distance"], &base)?;
            let ratio = legacy_f64(
                &airbox,
                &[
                    "element_ratio",
                    "maximum_element_growth_rate",
                    "growth_rate",
                ],
                &base,
            )?;
            let law = match legacy_string(&airbox, "grading", &base)?.as_deref() {
                None | Some("auto") if from_study_universe => FemAirboxGradingLawIR::Geometric,
                None | Some("uniform") => FemAirboxGradingLawIR::Uniform,
                Some("linear") => FemAirboxGradingLawIR::Linear,
                Some("geometric") => FemAirboxGradingLawIR::Geometric,
                Some(other) => return Err(format!("{base}/grading: unsupported value '{other}'")),
            };
            if let Some(far_element_size) = far {
                let near_element_size = near.or_else(|| {
                    policy
                        .interfaces
                        .iter()
                        .map(|interface| interface.maximum_element_size)
                        .chain(
                            policy
                                .materials
                                .iter()
                                .filter_map(|material| material.maximum_element_size),
                        )
                        .min_by(f64::total_cmp)
                });
                let transition_distance = match law {
                    FemAirboxGradingLawIR::Uniform => transition_distance,
                    FemAirboxGradingLawIR::Linear | FemAirboxGradingLawIR::Geometric => Some(
                        transition_distance.unwrap_or(FemMeshTransitionDistanceIR::Boundary(
                            FemMeshTransitionBoundaryIR::AirboxBoundary,
                        )),
                    ),
                };
                let element_ratio = match law {
                    FemAirboxGradingLawIR::Geometric => Some(ratio.unwrap_or(1.3)),
                    FemAirboxGradingLawIR::Uniform | FemAirboxGradingLawIR::Linear => None,
                };
                policy.airbox = Some(FemAirboxMeshPolicyIR {
                    law,
                    near_element_size,
                    far_element_size,
                    transition_distance,
                    element_ratio,
                });
                has_policy = true;
            } else if near.is_some() || transition_distance.is_some() || ratio.is_some() {
                return Err(format!(
                    "{base}/maximum_element_size: far-air maximum is required when airbox policy is present"
                ));
            }
            if let Some(maximum_neighbor_ratio) = ratio {
                growth_candidates.push(maximum_neighbor_ratio);
            }
        }

        if let Some(maximum_neighbor_ratio) = growth_candidates.into_iter().min_by(f64::total_cmp) {
            policy.growth = Some(MeshGrowthPolicyIR {
                definition_id: ADJACENT_SIZE_GROWTH_DEFINITION_ID.to_string(),
                cell_size_definition_id: CELL_MAX_EDGE_SIZE_DEFINITION_ID.to_string(),
                max_neighbor_ratio: maximum_neighbor_ratio,
                relative_tolerance: 0.05,
            });
        }

        if let Some(order) = requested_order {
            policy.geometric_element_order = order;
        }
        if !has_policy {
            return Ok(None);
        }
        Ok(Some(policy))
    }
}

fn preflight_policy_value(value: &Value) -> Result<(), MeshPolicyValidationError> {
    let root = value.as_object().ok_or_else(|| {
        error(
            MeshPolicyValidationCode::FemMeshPolicyMalformedValue,
            "/",
            "policy must be an object",
        )
    })?;
    reject_unknown(
        root,
        &[
            "schema_version",
            "geometric_element_order",
            "materials",
            "interfaces",
            "airbox",
            "sweeps",
            "growth",
            "quality",
        ],
        "",
    )?;
    preflight_object_array(
        root.get("materials"),
        "/materials",
        &[
            "target",
            "strategy_intent",
            "topology_intent",
            "maximum_element_size",
            "minimum_element_size",
            "curvature_factor",
            "narrow_region_resolution",
            "edge_maximum_element_size",
            "edge_thickness",
            "edge_transition_distance",
            "corner_maximum_element_size",
            "corner_extent",
            "corner_transition_distance",
        ],
        &[
            "maximum_element_size",
            "minimum_element_size",
            "curvature_factor",
            "narrow_region_resolution",
            "edge_maximum_element_size",
            "edge_thickness",
            "corner_maximum_element_size",
            "corner_extent",
        ],
    )?;
    preflight_target_fields(root.get("materials"), "/materials")?;
    preflight_transition_fields(
        root.get("materials"),
        "/materials",
        &["edge_transition_distance", "corner_transition_distance"],
    )?;
    preflight_object_array(
        root.get("interfaces"),
        "/interfaces",
        &[
            "target",
            "maximum_element_size",
            "thickness",
            "transition_distance",
        ],
        &["maximum_element_size", "thickness"],
    )?;
    preflight_target_fields(root.get("interfaces"), "/interfaces")?;
    preflight_transition_fields(
        root.get("interfaces"),
        "/interfaces",
        &["transition_distance"],
    )?;
    preflight_object_array(
        root.get("sweeps"),
        "/sweeps",
        &[
            "target",
            "requested_axis",
            "layers",
            "distribution",
            "element_ratio",
            "symmetric",
            "face_topology",
            "family_intent",
            "transition",
            "exact_layers",
        ],
        &["element_ratio"],
    )?;
    preflight_target_fields(root.get("sweeps"), "/sweeps")?;
    if let Some(airbox) = root.get("airbox") {
        let airbox = object_value(airbox, "/airbox")?;
        reject_unknown(
            airbox,
            &[
                "law",
                "near_element_size",
                "far_element_size",
                "transition_distance",
                "element_ratio",
            ],
            "/airbox",
        )?;
        if let Some(value) = airbox.get("transition_distance") {
            preflight_transition_distance(value, "/airbox/transition_distance")?;
        }
        preflight_numbers(
            airbox,
            &["near_element_size", "far_element_size", "element_ratio"],
            "/airbox",
        )?;
    }
    if let Some(growth) = root.get("growth") {
        let growth = object_value(growth, "/growth")?;
        reject_unknown(
            growth,
            &[
                "definition_id",
                "cell_size_definition_id",
                "max_neighbor_ratio",
                "relative_tolerance",
            ],
            "/growth",
        )?;
        preflight_numbers(
            growth,
            &["max_neighbor_ratio", "relative_tolerance"],
            "/growth",
        )?;
    }
    if let Some(quality) = root.get("quality") {
        let quality = object_value(quality, "/quality")?;
        reject_unknown(
            quality,
            &["compute_summary", "per_element", "thresholds"],
            "/quality",
        )?;
        preflight_object_array(
            quality.get("thresholds"),
            "/quality/thresholds",
            &[
                "metric_id",
                "family",
                "scope",
                "minimum",
                "maximum",
                "p05_minimum",
                "p95_maximum",
            ],
            &["minimum", "maximum", "p05_minimum", "p95_maximum"],
        )?;
    }
    Ok(())
}

fn serde_path_to_json_pointer(path: &serde_path_to_error::Path) -> String {
    use serde_path_to_error::Segment;

    let mut pointer = String::new();
    for segment in path {
        match segment {
            Segment::Seq { index } => pointer.push_str(&format!("/{index}")),
            Segment::Map { key } => {
                pointer.push('/');
                pointer.push_str(&escape_json_pointer_token(key));
            }
            Segment::Enum { .. } | Segment::Unknown => {}
        }
    }
    if pointer.is_empty() {
        "/".to_string()
    } else {
        pointer
    }
}

fn escape_json_pointer_token(token: &str) -> String {
    token.replace('~', "~0").replace('/', "~1")
}

fn object_value<'a>(
    value: &'a Value,
    pointer: &str,
) -> Result<&'a serde_json::Map<String, Value>, MeshPolicyValidationError> {
    value.as_object().ok_or_else(|| {
        error(
            MeshPolicyValidationCode::FemMeshPolicyMalformedValue,
            pointer,
            "expected an object",
        )
    })
}

fn preflight_target_fields(
    value: Option<&Value>,
    pointer: &str,
) -> Result<(), MeshPolicyValidationError> {
    let Some(entries) = value.and_then(Value::as_array) else {
        return Ok(());
    };
    for (index, entry) in entries.iter().enumerate() {
        let Some(target) = entry.as_object().and_then(|entry| entry.get("target")) else {
            continue;
        };
        let target_pointer = format!("{pointer}/{index}/target");
        let target = object_value(target, &target_pointer)?;
        reject_unknown(target, &["object_id", "region_id"], &target_pointer)?;
    }
    Ok(())
}

fn reject_unknown(
    object: &serde_json::Map<String, Value>,
    allowed: &[&str],
    base: &str,
) -> Result<(), MeshPolicyValidationError> {
    if let Some(field) = object
        .keys()
        .find(|field| !allowed.contains(&field.as_str()))
    {
        return Err(error(
            MeshPolicyValidationCode::FemMeshPolicyUnknownField,
            format!("{base}/{}", escape_json_pointer_token(field)),
            format!("unknown field '{field}'"),
        ));
    }
    Ok(())
}

fn preflight_object_array(
    value: Option<&Value>,
    pointer: &str,
    allowed: &[&str],
    numeric: &[&str],
) -> Result<(), MeshPolicyValidationError> {
    let Some(value) = value else {
        return Ok(());
    };
    let array = value.as_array().ok_or_else(|| {
        error(
            MeshPolicyValidationCode::FemMeshPolicyMalformedValue,
            pointer,
            "expected an array",
        )
    })?;
    for (index, value) in array.iter().enumerate() {
        let base = format!("{pointer}/{index}");
        let object = object_value(value, &base)?;
        reject_unknown(object, allowed, &base)?;
        preflight_numbers(object, numeric, &base)?;
    }
    Ok(())
}

fn preflight_numbers(
    object: &serde_json::Map<String, Value>,
    fields: &[&str],
    base: &str,
) -> Result<(), MeshPolicyValidationError> {
    for field in fields {
        if let Some(value) = object.get(*field) {
            if value.as_f64().is_none() {
                return Err(error(
                    MeshPolicyValidationCode::FemMeshPolicyMalformedValue,
                    format!("{base}/{field}"),
                    "present numeric field must be a JSON number",
                ));
            }
        }
    }
    Ok(())
}

fn preflight_transition_fields(
    value: Option<&Value>,
    pointer: &str,
    fields: &[&str],
) -> Result<(), MeshPolicyValidationError> {
    let Some(value) = value else {
        return Ok(());
    };
    let array = value.as_array().ok_or_else(|| {
        error(
            MeshPolicyValidationCode::FemMeshPolicyMalformedValue,
            pointer,
            "expected an array",
        )
    })?;
    for (index, value) in array.iter().enumerate() {
        let base = format!("{pointer}/{index}");
        let object = object_value(value, &base)?;
        for field in fields {
            if let Some(value) = object.get(*field) {
                preflight_transition_distance(value, &format!("{base}/{field}"))?;
            }
        }
    }
    Ok(())
}

fn preflight_transition_distance(
    value: &Value,
    pointer: &str,
) -> Result<(), MeshPolicyValidationError> {
    if value.as_f64().is_some() || value.as_str() == Some("airbox_boundary") {
        return Ok(());
    }
    Err(error(
        MeshPolicyValidationCode::FemMeshPolicyMalformedValue,
        pointer,
        "present transition distance must be a JSON number or 'airbox_boundary'",
    ))
}

fn legacy_optional_object<'a>(
    value: Option<&'a Value>,
    pointer: &str,
) -> Result<Option<&'a serde_json::Map<String, Value>>, String> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_object()
            .map(Some)
            .ok_or_else(|| format!("{pointer}: expected an object or null")),
    }
}

const LEGACY_UNSUPPORTED_MESH_CONTROL_FIELDS: &[&str] = &[
    "source",
    "calibrate_for",
    "size_preset",
    "build_requested",
    "algorithm_2d",
    "algorithm_3d",
    "optimize",
    "optimize_iterations",
    "smoothing_steps",
    "size_factor",
    "size_from_curvature",
    "narrow_regions",
    "transition_growth",
    "boundary_layer_count",
    "boundary_layer_thickness",
    "boundary_layer_stretching",
    "boundary_layer_target_surface_tags",
    "boundary_layer_target_curve_tags",
    "boundary_layer_target_surface_selectors",
    "boundary_layer_target_curve_selectors",
    "size_fields",
    "periodic_pair_ids",
    "operations",
];

const LEGACY_MATERIAL_POLICY_FIELDS: &[&str] = &[
    "maximum_element_size",
    "hmax",
    "minimum_element_size",
    "hmin",
    "order",
    "mesh_strategy",
    "topology",
    "interface_maximum_element_size",
    "interface_hmax",
    "interface_thickness",
    "transition_distance",
    "curvature_factor",
    "narrow_region_resolution",
    "edge_maximum_element_size",
    "edge_hmax",
    "edge_thickness",
    "edge_transition_distance",
    "corner_maximum_element_size",
    "corner_hmax",
    "corner_extent",
    "corner_transition_distance",
    "through_thickness_elements",
    "through_thickness_distribution",
    "through_thickness_element_ratio",
    "through_thickness_symmetric",
    "sweep_face_meshing",
    "sweep_direction",
    "element_family",
    "transition_policy",
    "exact_layer_count",
];

const LEGACY_LAYER_POLICY_FIELDS: &[&str] = &[
    "through_thickness_elements",
    "through_thickness_distribution",
    "through_thickness_element_ratio",
    "through_thickness_symmetric",
    "sweep_face_meshing",
    "sweep_direction",
    "element_family",
    "transition_policy",
    "exact_layer_count",
];

const LEGACY_AUXILIARY_POLICY_FIELDS: &[&str] = &[
    "mode",
    "maximum_element_growth_rate",
    "growth_rate",
    "compute_quality",
    "per_element_quality",
];

const LEGACY_AIRBOX_POLICY_FIELDS: &[&str] = &[
    "near_element_size",
    "minimum_element_size",
    "hmin",
    "far_element_size",
    "maximum_element_size",
    "hmax",
    "transition_distance",
    "element_ratio",
    "maximum_element_growth_rate",
    "growth_rate",
    "grading",
];

const LEGACY_STUDY_UNIVERSE_POLICY_FIELDS: &[&str] = &[
    "airbox_hmin",
    "airbox_hmax",
    "airbox_growth_rate",
    "airbox_grading",
];

fn reject_explicit_null_legacy_fields(
    object: &serde_json::Map<String, Value>,
    fields: &[&str],
    base: &str,
) -> Result<(), String> {
    if let Some(field) = fields
        .iter()
        .find(|field| object.get(**field).is_some_and(Value::is_null))
    {
        return Err(format!(
            "fem_mesh_policy_malformed_value at {base}/{field}: present legacy mesh-policy field must not be null"
        ));
    }
    Ok(())
}

fn reject_unsupported_legacy_mesh_controls(
    object: &serde_json::Map<String, Value>,
    base: &str,
) -> Result<(), String> {
    for field in LEGACY_UNSUPPORTED_MESH_CONTROL_FIELDS {
        if object.get(*field).is_some_and(legacy_value_is_effective) {
            return Err(format!(
                "fem_mesh_policy_unsupported_legacy_control at {base}/{field}: control cannot be represented by fem_mesh_policy.v1"
            ));
        }
    }
    Ok(())
}

fn legacy_value_is_effective(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::String(value) => !value.trim().is_empty(),
        Value::Array(value) => !value.is_empty(),
        Value::Object(value) => !value.is_empty(),
        Value::Number(_) => true,
    }
}

fn legacy_has_any_field(object: &serde_json::Map<String, Value>, fields: &[&str]) -> bool {
    fields
        .iter()
        .any(|field| object.get(*field).is_some_and(legacy_value_is_effective))
}

fn legacy_overlay(
    base: Option<&serde_json::Map<String, Value>>,
    overlay: Option<&serde_json::Map<String, Value>>,
) -> serde_json::Map<String, Value> {
    let mut merged = base.cloned().unwrap_or_default();
    if let Some(overlay) = overlay {
        for (key, value) in overlay {
            if !value.is_null() {
                merged.insert(key.clone(), value.clone());
            }
        }
    }
    merged
}

fn legacy_string(
    object: &serde_json::Map<String, Value>,
    key: &str,
    base: &str,
) -> Result<Option<String>, String> {
    let Some(value) = object.get(key) else {
        return Ok(None);
    };
    value
        .as_str()
        .map(|value| Some(value.to_string()))
        .ok_or_else(|| format!("{base}/{key}: expected a string"))
}

fn legacy_bool(
    object: &serde_json::Map<String, Value>,
    key: &str,
    base: &str,
) -> Result<Option<bool>, String> {
    let Some(value) = object.get(key) else {
        return Ok(None);
    };
    value
        .as_bool()
        .map(Some)
        .ok_or_else(|| format!("{base}/{key}: expected a boolean"))
}

fn legacy_u8(
    object: &serde_json::Map<String, Value>,
    key: &str,
    base: &str,
) -> Result<Option<u8>, String> {
    let Some(value) = object.get(key) else {
        return Ok(None);
    };
    value
        .as_u64()
        .and_then(|value| u8::try_from(value).ok())
        .map(Some)
        .ok_or_else(|| format!("{base}/{key}: expected an unsigned 8-bit integer"))
}

fn legacy_u32(
    object: &serde_json::Map<String, Value>,
    key: &str,
    base: &str,
) -> Result<Option<u32>, String> {
    let Some(value) = object.get(key) else {
        return Ok(None);
    };
    value
        .as_u64()
        .and_then(|value| u32::try_from(value).ok())
        .map(Some)
        .ok_or_else(|| format!("{base}/{key}: expected an unsigned 32-bit integer"))
}

fn legacy_f64(
    object: &serde_json::Map<String, Value>,
    keys: &[&str],
    base: &str,
) -> Result<Option<f64>, String> {
    let mut resolved: Option<(&str, f64)> = None;
    for key in keys {
        let Some(value) = object.get(*key) else {
            continue;
        };
        if value.is_string() {
            return Err(format!(
                "fem_mesh_policy_unsupported_legacy_control at {base}/{key}: symbolic numeric values must be resolved to SI before V04 migration"
            ));
        }
        let value = value
            .as_f64()
            .filter(|value| value.is_finite())
            .ok_or_else(|| format!("{base}/{key}: expected a finite JSON number"))?;
        if let Some((resolved_key, resolved_value)) = resolved {
            if value != resolved_value {
                return Err(format!(
                    "{base}/{key}: conflicts with alias {base}/{resolved_key}"
                ));
            }
        } else {
            resolved = Some((key, value));
        }
    }
    Ok(resolved.map(|(_, value)| value))
}

fn legacy_transition_distance(
    object: &serde_json::Map<String, Value>,
    keys: &[&str],
    base: &str,
) -> Result<Option<FemMeshTransitionDistanceIR>, String> {
    let mut resolved: Option<(&str, FemMeshTransitionDistanceIR)> = None;
    for key in keys {
        let Some(value) = object.get(*key) else {
            continue;
        };
        let parsed = if let Some(value) = value.as_f64().filter(|value| value.is_finite()) {
            FemMeshTransitionDistanceIR::Metres(value)
        } else if let Some(value) = value.as_str() {
            match value.trim().to_ascii_lowercase().as_str() {
                "airbox_boundary" | "airbox-boundary" | "auto_boundary" => {
                    FemMeshTransitionDistanceIR::Boundary(
                        FemMeshTransitionBoundaryIR::AirboxBoundary,
                    )
                }
                _ => {
                    return Err(format!(
                        "{base}/{key}: expected a finite JSON number or 'airbox_boundary'"
                    ));
                }
            }
        } else {
            return Err(format!(
                "{base}/{key}: expected a finite JSON number or 'airbox_boundary'"
            ));
        };
        if let Some((resolved_key, resolved_value)) = resolved {
            if parsed != resolved_value {
                return Err(format!(
                    "{base}/{key}: conflicts with alias {base}/{resolved_key}"
                ));
            }
        } else {
            resolved = Some((key, parsed));
        }
    }
    Ok(resolved.map(|(_, value)| value))
}
