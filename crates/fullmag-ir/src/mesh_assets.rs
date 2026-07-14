#[allow(unused_imports)]
use crate::{
    validate_mesh_for_execution, FemDomainMeshModeIR, FemLinearSolverPolicy, MeshIR,
    MeshQualityIR,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};

// Private spatial helper functions (only used by types in this module)
fn vec3_from_value(value: &Value) -> Option<[f64; 3]> {
    let array = value.as_array()?;
    if array.len() != 3 {
        return None;
    }
    Some([array[0].as_f64()?, array[1].as_f64()?, array[2].as_f64()?])
}

#[cfg(test)]
mod mesh_asset_validation_tests {
    use super::*;

    fn inverted_mesh() -> MeshIR {
        MeshIR {
            mesh_name: "inverted".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            elements: vec![[0, 1, 3, 2]],
            element_markers: vec![1],
            boundary_faces: Vec::new(),
            boundary_markers: Vec::new(),
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            per_domain_quality: HashMap::new(),
        }
    }

    #[test]
    fn fem_mesh_asset_requires_strict_mesh_validation() {
        let asset = FemMeshAssetIR {
            geometry_name: "body".to_string(),
            mesh_source: None,
            mesh: Some(inverted_mesh()),
        };

        let errors = asset.validate().expect_err("inverted inline mesh must fail");
        assert!(errors
            .iter()
            .any(|error| error.contains("negative tetra orientation")));
    }
}

fn normalized_bounds_pair(bounds_min: ([f64; 3], [f64; 3])) -> Option<([f64; 3], [f64; 3])> {
    let (bounds_min, bounds_max) = bounds_min;
    let normalized_min = [
        bounds_min[0].min(bounds_max[0]),
        bounds_min[1].min(bounds_max[1]),
        bounds_min[2].min(bounds_max[2]),
    ];
    let normalized_max = [
        bounds_min[0].max(bounds_max[0]),
        bounds_min[1].max(bounds_max[1]),
        bounds_min[2].max(bounds_max[2]),
    ];
    if normalized_max
        .iter()
        .zip(normalized_min.iter())
        .any(|(max_value, min_value)| *max_value - *min_value <= 0.0)
    {
        return None;
    }
    Some((normalized_min, normalized_max))
}

fn option_bounds_pair(
    bounds_min: Option<[f64; 3]>,
    bounds_max: Option<[f64; 3]>,
) -> Option<([f64; 3], [f64; 3])> {
    normalized_bounds_pair((bounds_min?, bounds_max?))
}

fn bounds_extent(bounds_min: [f64; 3], bounds_max: [f64; 3]) -> [f64; 3] {
    [
        bounds_max[0] - bounds_min[0],
        bounds_max[1] - bounds_min[1],
        bounds_max[2] - bounds_min[2],
    ]
}

fn bounds_center(bounds_min: [f64; 3], bounds_max: [f64; 3]) -> [f64; 3] {
    [
        0.5 * (bounds_min[0] + bounds_max[0]),
        0.5 * (bounds_min[1] + bounds_max[1]),
        0.5 * (bounds_min[2] + bounds_max[2]),
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FdmGridAssetIR {
    pub geometry_name: String,
    pub cells: [u32; 3],
    pub cell_size: [f64; 3],
    pub origin: [f64; 3],
    pub active_mask: Vec<bool>,
}

impl FdmGridAssetIR {
    pub fn validate(&self) -> Result<(), Vec<String>> {
        let mut errors = Vec::new();

        if self.geometry_name.trim().is_empty() {
            errors.push("fdm_grid_asset.geometry_name must not be empty".to_string());
        }
        for (axis, value) in ["x", "y", "z"].iter().zip(self.cells.iter()) {
            if *value == 0 {
                errors.push(format!("fdm_grid_asset.cells[{axis}] must be > 0"));
            }
        }
        for (axis, value) in ["x", "y", "z"].iter().zip(self.cell_size.iter()) {
            if *value <= 0.0 {
                errors.push(format!("fdm_grid_asset.cell_size[{axis}] must be positive"));
            }
        }

        let expected = self.cells[0] as usize * self.cells[1] as usize * self.cells[2] as usize;
        if self.active_mask.len() != expected {
            errors.push(format!(
                "fdm_grid_asset.active_mask length ({}) must match cells product ({expected})",
                self.active_mask.len()
            ));
        }
        if !self.active_mask.iter().any(|active| *active) {
            errors.push(
                "fdm_grid_asset.active_mask must contain at least one active cell".to_string(),
            );
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemMeshAssetIR {
    pub geometry_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh: Option<MeshIR>,
}

impl FemMeshAssetIR {
    pub fn validate(&self) -> Result<(), Vec<String>> {
        let mut errors = Vec::new();

        if self.geometry_name.trim().is_empty() {
            errors.push("fem_mesh_asset.geometry_name must not be empty".to_string());
        }
        if self.mesh.is_none() && self.mesh_source.is_none() {
            errors.push(
                "fem_mesh_asset must provide either an inline mesh or mesh_source".to_string(),
            );
        }
        if let Some(mesh) = &self.mesh {
            if let Err(mesh_errors) = validate_mesh_for_execution(mesh) {
                errors.extend(
                    mesh_errors
                        .into_iter()
                        .map(|error| format!("fem_mesh_asset.{}", error)),
                );
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemDomainRegionMarkerIR {
    pub geometry_name: String,
    pub marker: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct FemAirboxTargetIR {
    #[serde(
        rename = "maximum_element_size",
        alias = "hmax",
        skip_serializing_if = "Option::is_none"
    )]
    pub hmax: Option<f64>,
    #[serde(
        rename = "minimum_element_size",
        alias = "hmin",
        skip_serializing_if = "Option::is_none"
    )]
    pub hmin: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub growth_rate: Option<f64>,
}

/// Through-thickness sweep distribution for a single object.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SweepDistributionIR {
    /// Distribution kind: "uniform", "arithmetic", or "geometric".
    pub kind: String,
    /// Number of element layers through the sweep direction.
    pub num_layers: u32,
    /// Growth factor for arithmetic/geometric distributions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub growth_rate: Option<f64>,
}

/// Swept (through-thickness) mesh hints for a per-object mesh recipe.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SweptMeshHintsIR {
    /// Sweep direction: "auto", "x", "y", or "z".
    pub sweep_direction: String,
    /// Layer distribution through the sweep direction.
    pub distribution: SweepDistributionIR,
}

/// Per-object mesh-size target as resolved by the Python meshing pipeline.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemPerObjectTargetIR {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marker: Option<u32>,
    #[serde(
        rename = "maximum_element_size",
        alias = "hmax",
        skip_serializing_if = "Option::is_none"
    )]
    pub hmax: Option<f64>,
    #[serde(
        rename = "interface_maximum_element_size",
        alias = "interface_hmax",
        skip_serializing_if = "Option::is_none"
    )]
    pub interface_hmax: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interface_thickness: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transition_distance: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transition_distance_requested: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transition_distance_effective: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transition_realization: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transition_growth: Option<f64>,
    #[serde(
        rename = "edge_maximum_element_size",
        alias = "edge_hmax",
        skip_serializing_if = "Option::is_none"
    )]
    pub edge_hmax: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edge_thickness: Option<f64>,
    #[serde(
        rename = "corner_maximum_element_size",
        alias = "corner_hmax",
        skip_serializing_if = "Option::is_none"
    )]
    pub corner_hmax: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub corner_extent: Option<f64>,
    #[serde(default)]
    pub source: String,
    /// Optional swept (through-thickness) mesh controls for this object.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub swept: Option<SweptMeshHintsIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemMeshOperationStatusIR {
    pub kind: String,
    pub scope: String,
    pub requested: bool,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub details: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemThinFilmDiagnosticIR {
    pub geometry_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(default)]
    pub is_thin_film: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thickness: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lateral_size: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aspect_ratio: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_layers: Option<u32>,
    #[serde(
        rename = "estimated_layers_from_maximum_element_size",
        alias = "estimated_layers_from_hmax",
        skip_serializing_if = "Option::is_none"
    )]
    pub estimated_layers_from_hmax: Option<u32>,
    #[serde(
        rename = "maximum_element_size_to_thickness_ratio",
        alias = "hmax_to_thickness_ratio",
        skip_serializing_if = "Option::is_none"
    )]
    pub hmax_to_thickness_ratio: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_method: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemMagneticSubmeshSignatureIR {
    pub geometry_name: String,
    pub marker: u32,
    pub node_count: u64,
    pub tetra_count: u64,
    pub edge_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coordinate_quantization_m: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
}

/// Build report for a shared-domain FEM mesh, propagated from the Python
/// meshing pipeline so the planner / runner can inspect how the mesh was built.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemSharedDomainBuildReportIR {
    pub build_mode: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fallbacks_triggered: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_airbox_target: Option<FemAirboxTargetIR>,
    #[serde(
        rename = "effective_airbox_maximum_element_size",
        alias = "effective_airbox_hmax",
        skip_serializing_if = "Option::is_none"
    )]
    pub effective_airbox_hmax: Option<f64>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub effective_per_object_targets: HashMap<String, FemPerObjectTargetIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub region_markers: Vec<FemDomainRegionMarkerIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub object_region_markers: Vec<FemDomainRegionMarkerIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub used_size_field_kinds: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub size_fields_realized: Vec<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub operation_statuses: Vec<FemMeshOperationStatusIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub thin_film_diagnostics: Vec<FemThinFilmDiagnosticIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub magnetic_submesh_signatures: Vec<FemMagneticSubmeshSignatureIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub selector_resolution: Vec<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub orphan_entities: Vec<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rejected_element_types: Vec<Value>,
    /// ``true`` when the mesh was built via a degraded path (fallback, simplified
    /// size fields, or lost component identity).
    #[serde(default)]
    pub degraded: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authored_regions_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub realized_regions_count: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemDomainMeshAssetIR {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh: Option<MeshIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub region_markers: Vec<FemDomainRegionMarkerIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub object_region_markers: Vec<FemDomainRegionMarkerIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build_report: Option<FemSharedDomainBuildReportIR>,
}

impl FemDomainMeshAssetIR {
    pub fn validate(&self) -> Result<(), Vec<String>> {
        let mut errors = Vec::new();
        if self.mesh.is_none() && self.mesh_source.is_none() {
            errors.push(
                "fem_domain_mesh_asset must provide either an inline mesh or mesh_source"
                    .to_string(),
            );
        }
        if let Some(mesh) = &self.mesh {
            if let Err(mesh_errors) = validate_mesh_for_execution(mesh) {
                errors.extend(
                    mesh_errors
                        .into_iter()
                        .map(|error| format!("fem_domain_mesh_asset.{error}")),
                );
            }
        }
        let mut seen_markers = BTreeSet::new();
        let mut seen_geometries = BTreeSet::new();
        for region in &self.region_markers {
            if region.geometry_name.trim().is_empty() {
                errors.push(
                    "fem_domain_mesh_asset.region_markers geometry_name must not be empty"
                        .to_string(),
                );
            }
            if region.marker == 0 {
                errors.push("fem_domain_mesh_asset.region_markers markers must be > 0".to_string());
            }
            if !seen_markers.insert(region.marker) {
                errors.push(format!(
                    "fem_domain_mesh_asset.region_markers marker {} is duplicated",
                    region.marker
                ));
            }
            if !seen_geometries.insert(region.geometry_name.as_str()) {
                errors.push(format!(
                    "fem_domain_mesh_asset.region_markers geometry '{}' is duplicated",
                    region.geometry_name
                ));
            }
        }
        let mut seen_object_region_markers = BTreeSet::new();
        let mut seen_object_region_geometries = BTreeSet::new();
        for region in &self.object_region_markers {
            if region.geometry_name.trim().is_empty() {
                errors.push(
                    "fem_domain_mesh_asset.object_region_markers geometry_name must not be empty"
                        .to_string(),
                );
            }
            if region.marker == 0 {
                errors.push(
                    "fem_domain_mesh_asset.object_region_markers markers must be > 0".to_string(),
                );
            }
            if seen_markers.contains(&region.marker) {
                errors.push(format!(
                    "fem_domain_mesh_asset.object_region_markers marker {} duplicates a region_markers marker",
                    region.marker
                ));
            }
            if !seen_object_region_markers.insert(region.marker) {
                errors.push(format!(
                    "fem_domain_mesh_asset.object_region_markers marker {} is duplicated",
                    region.marker
                ));
            }
            if !seen_object_region_geometries.insert(region.geometry_name.as_str()) {
                errors.push(format!(
                    "fem_domain_mesh_asset.object_region_markers geometry '{}' is duplicated",
                    region.geometry_name
                ));
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct GeometryAssetsIR {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fdm_grid_assets: Vec<FdmGridAssetIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fem_mesh_assets: Vec<FemMeshAssetIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fem_domain_mesh_asset: Option<FemDomainMeshAssetIR>,
}

impl GeometryAssetsIR {
    pub fn validate(&self) -> Result<(), Vec<String>> {
        let mut errors = Vec::new();
        for asset in &self.fdm_grid_assets {
            if let Err(asset_errors) = asset.validate() {
                errors.extend(
                    asset_errors
                        .into_iter()
                        .map(|error| format!("geometry_assets.{error}")),
                );
            }
        }
        for asset in &self.fem_mesh_assets {
            if let Err(asset_errors) = asset.validate() {
                errors.extend(
                    asset_errors
                        .into_iter()
                        .map(|error| format!("geometry_assets.{error}")),
                );
            }
        }
        if let Some(asset) = &self.fem_domain_mesh_asset {
            if let Err(asset_errors) = asset.validate() {
                errors.extend(
                    asset_errors
                        .into_iter()
                        .map(|error| format!("geometry_assets.{error}")),
                );
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DeclaredUniverseIR {
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub center: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub padding: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub airbox_hmax: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub airbox_hmin: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub airbox_growth_rate: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub airbox_grading: Option<String>,
}

impl Default for DeclaredUniverseIR {
    fn default() -> Self {
        Self {
            mode: "auto".to_string(),
            size: None,
            center: None,
            padding: None,
            airbox_hmax: None,
            airbox_hmin: None,
            airbox_growth_rate: None,
            airbox_grading: None,
        }
    }
}

impl DeclaredUniverseIR {
    pub fn from_study_universe_value(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        Some(Self {
            mode: match object
                .get("mode")
                .and_then(|candidate| candidate.as_str())
                .unwrap_or("auto")
            {
                "box" => "manual",
                other => other,
            }
            .to_string(),
            size: object.get("size").and_then(vec3_from_value),
            center: object.get("center").and_then(vec3_from_value),
            padding: object.get("padding").and_then(vec3_from_value),
            airbox_hmax: object
                .get("airbox_hmax")
                .and_then(|candidate| candidate.as_f64()),
            airbox_hmin: object
                .get("airbox_hmin")
                .and_then(|candidate| candidate.as_f64()),
            airbox_growth_rate: object
                .get("airbox_growth_rate")
                .and_then(|candidate| candidate.as_f64()),
            airbox_grading: object
                .get("airbox_grading")
                .and_then(|candidate| candidate.as_str())
                .map(str::to_string),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct UniverseMeshConfigIR {
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub center: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub padding: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub airbox_hmax: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub airbox_hmin: Option<f64>,
}

impl From<&DeclaredUniverseIR> for UniverseMeshConfigIR {
    fn from(value: &DeclaredUniverseIR) -> Self {
        Self {
            mode: value.mode.clone(),
            size: value.size,
            center: value.center,
            padding: value.padding,
            airbox_hmax: value.airbox_hmax,
            airbox_hmin: value.airbox_hmin,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PerObjectMeshConfigIR {
    pub object_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marker: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hmax: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interface_hmax: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition_distance: Option<f64>,
    #[serde(default)]
    pub source: String,
}

impl PerObjectMeshConfigIR {
    pub fn from_effective_target(
        object_id: impl Into<String>,
        target: &FemPerObjectTargetIR,
    ) -> Self {
        Self {
            object_id: object_id.into(),
            marker: target.marker,
            hmax: target.hmax,
            interface_hmax: target.interface_hmax,
            transition_distance: target.transition_distance,
            source: target.source.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SolverMeshArtifactRefIR {
    pub mesh_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh_source: Option<String>,
    pub domain_mesh_mode: FemDomainMeshModeIR,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build_report: Option<FemSharedDomainBuildReportIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct MeshSemanticsIR {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub universe_mesh_config: Option<UniverseMeshConfigIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub per_object_mesh_configs: Vec<PerObjectMeshConfigIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub solver_mesh: Option<SolverMeshArtifactRefIR>,
}

impl MeshSemanticsIR {
    pub fn validate(&self) -> Result<(), Vec<String>> {
        let mut errors = Vec::new();

        if let Some(universe) = &self.universe_mesh_config {
            if universe.mode.trim().is_empty() {
                errors.push("universe_mesh_config.mode must not be empty".to_string());
            }
            if universe
                .size
                .is_some_and(|size| size.iter().any(|component| *component <= 0.0))
            {
                errors.push(
                    "universe_mesh_config.size components must be positive when provided"
                        .to_string(),
                );
            }
            if universe.airbox_hmax.is_some_and(|value| value <= 0.0) {
                errors.push("universe_mesh_config.airbox_hmax must be positive".to_string());
            }
            if universe.airbox_hmin.is_some_and(|value| value <= 0.0) {
                errors.push("universe_mesh_config.airbox_hmin must be positive".to_string());
            }
            if let (Some(hmin), Some(hmax)) = (universe.airbox_hmin, universe.airbox_hmax) {
                if hmin > hmax {
                    errors.push(
                        "universe_mesh_config.airbox_hmin must be <= airbox_hmax".to_string(),
                    );
                }
            }
        }

        let mut seen_object_ids: BTreeSet<&str> = BTreeSet::new();
        for object in &self.per_object_mesh_configs {
            if object.object_id.trim().is_empty() {
                errors.push("per_object_mesh_configs.object_id must not be empty".to_string());
            }
            if !seen_object_ids.insert(object.object_id.as_str()) {
                errors.push(format!(
                    "per_object_mesh_configs contains duplicated object_id '{}'",
                    object.object_id
                ));
            }
            if object.hmax.is_some_and(|value| value <= 0.0) {
                errors.push(format!(
                    "per_object_mesh_configs '{}' has non-positive hmax",
                    object.object_id
                ));
            }
            if object.interface_hmax.is_some_and(|value| value <= 0.0) {
                errors.push(format!(
                    "per_object_mesh_configs '{}' has non-positive interface_hmax",
                    object.object_id
                ));
            }
            if object.transition_distance.is_some_and(|value| value <= 0.0) {
                errors.push(format!(
                    "per_object_mesh_configs '{}' has non-positive transition_distance",
                    object.object_id
                ));
            }
        }

        if let Some(solver_mesh) = &self.solver_mesh {
            if solver_mesh.mesh_name.trim().is_empty() {
                errors.push("solver_mesh.mesh_name must not be empty".to_string());
            }
            if solver_mesh
                .mesh_source
                .as_ref()
                .is_some_and(|source| source.trim().is_empty())
            {
                errors.push("solver_mesh.mesh_source must not be empty when provided".to_string());
            }
            if solver_mesh
                .generation_id
                .as_ref()
                .is_some_and(|generation| generation.trim().is_empty())
            {
                errors
                    .push("solver_mesh.generation_id must not be empty when provided".to_string());
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct DomainFrameIR {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub declared_universe: Option<DeclaredUniverseIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_bounds_min: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_bounds_max: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh_bounds_min: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh_bounds_max: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_extent: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_center: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_source: Option<String>,
}

impl DomainFrameIR {
    pub fn with_mesh_bounds(mut self, mesh_bounds: Option<([f64; 3], [f64; 3])>) -> Self {
        if let Some((bounds_min, bounds_max)) = mesh_bounds.and_then(normalized_bounds_pair) {
            self.mesh_bounds_min = Some(bounds_min);
            self.mesh_bounds_max = Some(bounds_max);
        }
        self
    }

    pub fn finalized(mut self) -> Option<Self> {
        let object_bounds = option_bounds_pair(self.object_bounds_min, self.object_bounds_max);
        let mesh_bounds = option_bounds_pair(self.mesh_bounds_min, self.mesh_bounds_max);
        let declared_universe = self.declared_universe.clone();

        if self.effective_extent.is_none() {
            if let Some(declared) = declared_universe.as_ref() {
                if declared.mode == "manual" {
                    if let Some(size) = declared.size {
                        self.effective_extent = Some(size);
                        self.effective_source
                            .get_or_insert_with(|| "declared_universe_manual".to_string());
                    }
                    if self.effective_center.is_none() {
                        self.effective_center = declared
                            .center
                            .or_else(|| {
                                object_bounds.map(|bounds| bounds_center(bounds.0, bounds.1))
                            })
                            .or_else(|| {
                                mesh_bounds.map(|bounds| bounds_center(bounds.0, bounds.1))
                            });
                    }
                } else {
                    let base_bounds = object_bounds.or(mesh_bounds);
                    if let Some((bounds_min, bounds_max)) = base_bounds {
                        let padding = declared.padding.unwrap_or([0.0, 0.0, 0.0]);
                        let base_extent = bounds_extent(bounds_min, bounds_max);
                        if padding.iter().any(|component| component.abs() > 0.0) {
                            self.effective_extent = Some([
                                base_extent[0] + 2.0 * padding[0],
                                base_extent[1] + 2.0 * padding[1],
                                base_extent[2] + 2.0 * padding[2],
                            ]);
                            self.effective_source.get_or_insert_with(|| {
                                "declared_universe_auto_padding".to_string()
                            });
                        } else {
                            self.effective_extent = Some(base_extent);
                            self.effective_source.get_or_insert_with(|| {
                                if object_bounds.is_some() {
                                    "object_union_bounds".to_string()
                                } else {
                                    "mesh_bounds".to_string()
                                }
                            });
                        }
                        if self.effective_center.is_none() {
                            self.effective_center = Some(bounds_center(bounds_min, bounds_max));
                        }
                    }
                }
            } else if let Some((bounds_min, bounds_max)) = object_bounds {
                self.effective_extent = Some(bounds_extent(bounds_min, bounds_max));
                self.effective_center = Some(bounds_center(bounds_min, bounds_max));
                self.effective_source
                    .get_or_insert_with(|| "object_union_bounds".to_string());
            } else if let Some((bounds_min, bounds_max)) = mesh_bounds {
                self.effective_extent = Some(bounds_extent(bounds_min, bounds_max));
                self.effective_center = Some(bounds_center(bounds_min, bounds_max));
                self.effective_source
                    .get_or_insert_with(|| "mesh_bounds".to_string());
            }
        }

        if self.declared_universe.is_none()
            && self.object_bounds_min.is_none()
            && self.object_bounds_max.is_none()
            && self.mesh_bounds_min.is_none()
            && self.mesh_bounds_max.is_none()
            && self.effective_extent.is_none()
            && self.effective_center.is_none()
            && self.effective_source.is_none()
        {
            None
        } else {
            Some(self)
        }
    }
}
