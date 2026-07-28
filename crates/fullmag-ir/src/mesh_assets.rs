#[allow(unused_imports)]
use crate::{
    validate_mesh_for_execution, FemDomainMeshModeIR, FemLinearSolverPolicy, MeshIR, MeshQualityIR,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap};

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

    fn mixed_certificate_asset_value() -> Value {
        let nodes = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 1.0],
            [0.0, 1.0, 1.0],
            [3.0, -1.0, 0.0],
            [5.0, -1.0, 0.0],
            [5.0, 1.0, 0.0],
            [3.0, 1.0, 0.0],
            [4.0, 0.0, 1.0],
            [7.0, 0.0, 0.0],
            [8.0, 0.0, 0.0],
            [7.0, 1.0, 0.0],
            [7.0, 0.0, 1.0],
        ];
        let cells = serde_json::from_value(serde_json::json!({
            "types": ["prism6", "pyramid5", "tet4"],
            "offsets": [0, 6, 11, 15],
            "nodes": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
            "global_ordinals": [0, 1, 2],
            "mesh_parts": ["magnetic", "transition_air", "far_air"]
        }))
        .unwrap();
        let mesh = MeshIR {
            mesh_name: "mixed-certificate".to_string(),
            nodes,
            cells,
            element_markers: vec![1, 0, 0],
            facets: crate::FemFacetConnectivityIR {
                types: vec![
                    crate::FemFacetTypeIR::Tri3,
                    crate::FemFacetTypeIR::Quad4,
                    crate::FemFacetTypeIR::Quad4,
                    crate::FemFacetTypeIR::Tri3,
                ],
                roles: vec![
                    crate::FemFacetRoleIR::MaterialInterface,
                    crate::FemFacetRoleIR::Exterior,
                    crate::FemFacetRoleIR::Exterior,
                    crate::FemFacetRoleIR::Exterior,
                ],
                offsets: vec![0, 3, 7, 11, 14],
                nodes: vec![0, 1, 2, 0, 1, 4, 3, 6, 7, 8, 9, 11, 12, 13],
                global_ordinals: vec![0, 1, 2, 3],
            },
            boundary_markers: vec![2, 3, 3, 3],
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            per_domain_quality: HashMap::new(),
        };
        let fingerprint = mesh.topology_fingerprint_v6();
        let mut certificate: Value = serde_json::from_str(
            r#"{
                "schema_version":"mixed_layer_topology_certificate.v1",
                "certificate_status":"accepted",
                "requested_sweep_direction":"z","resolved_sweep_direction":"z",
                "requested_layer_count":1,"realized_layer_count":1,
                "magnetic_plane_coordinates_m":[0.0,1.0],"plane_tolerance_m":1e-12,
                "transition_shell_thickness_m":1.0,"transition_shell_interface_tri3_count":1,
                "interface_marker":2,"outer_boundary_marker":3,
                "magnetic_bounds_min_m":[0.0,0.0,0.0],"magnetic_bounds_max_m":[1.0,1.0,1.0],
                "airbox_bounds_min_m":[-1.0,-1.0,-1.0],"airbox_bounds_max_m":[2.0,2.0,2.0],
                "magnetic_bounds_relative_error":0.0,"airbox_bounds_relative_error":0.0,
                "cell_family_counts_by_marker":{"0":{"pyramid5":1,"tet4":1},"1":{"prism6":1}},
                "cell_family_counts_by_part":{"magnetic":{"prism6":1},"transition_air":{"pyramid5":1},"far_air":{"tet4":1}},
                "facet_family_counts_by_role_marker":{"exterior:3":{"quad4":2,"tri3":1},"material_interface:2":{"tri3":1}},
                "jacobian_minima_m3_by_family":{"prism6":1.0,"pyramid5":1.0,"tet4":1.0},
                "quality_metric":"tetra_decomposition_scaled_jacobian.v1",
                "scaled_jacobian_minima_by_family":{"prism6":1.0,"pyramid5":1.0,"tet4":1.0},
                "scaled_jacobian_p05_by_family":{"prism6":1.0,"pyramid5":1.0,"tet4":1.0},
                "magnetic_volume_m3":1.0,"expected_magnetic_volume_m3":1.0,
                "magnetic_relative_volume_error":0.0,"air_volume_m3":1.0,
                "shared_domain_volume_m3":2.0,"expected_shared_domain_volume_m3":2.0,
                "shared_domain_relative_volume_error":0.0,"marker_coverage_complete":true,
                "nonconforming_face_count":0,"orphan_face_count":0,"nonmanifold_face_count":0,
                "coincident_interface_face_count":0,"topology_fingerprint_version":"v2",
                "topology_fingerprint":"placeholder","gmsh_version":"4.15.2",
                "strategy":"shared_geo_extrusion_partitioned_pyramid_tet.v2",
                "effective_gmsh_thread_count":1,
                "deterministic_inputs":{
                    "algorithm_2d":6,"algorithm_3d":1,"element_order":1,
                    "gmsh_version":"4.15.2","random_factor":0.0,"thread_count":1,
                    "transition_partition":"cartesian_3x3x3_minus_magnetic_center",
                    "transition_volume_count":26,
                    "pyramid_apex_optimizer":"bounded_per_apex_outward_scale_line_search",
                    "pyramid_apex_scale_step":0.001,"pyramid_apex_scale_max":1.25,
                    "scaled_jacobian_p05_min":0.1
                },"fallbacks_triggered":[]
            }"#,
        )
        .unwrap();
        certificate["topology_fingerprint"] = serde_json::json!(fingerprint);
        let report = serde_json::json!({
                "build_mode": "shared_domain",
                "fallbacks_triggered": [],
                "effective_airbox_hmax": null,
                "effective_per_object_targets": {},
                "region_markers": [],
                "object_region_markers": [],
                "used_size_field_kinds": [],
                "size_fields_realized": [],
                "operation_statuses": [],
                "thin_film_diagnostics": [],
                "magnetic_submesh_signatures": [],
                "selector_resolution": [],
                "orphan_entities": [],
                "rejected_element_types": [],
                "degraded": false,
                "authored_regions_count": null,
                "realized_regions_count": null,
                "mixed_layer_topology_certificate": certificate
        });
        serde_json::json!({
            "mesh": mesh,
            "region_markers": [],
            "object_region_markers": [],
            "build_report": report
            }
        )
    }

    #[test]
    fn mixed_certificate_is_typed_preserved_and_bound_to_the_exact_mesh() {
        let value = mixed_certificate_asset_value();
        let asset: FemDomainMeshAssetIR = serde_json::from_value(value).unwrap();
        assert_eq!(
            serde_json::to_value(&asset).unwrap()["build_report"]
                ["mixed_layer_topology_certificate"]["schema_version"],
            serde_json::json!("mixed_layer_topology_certificate.v1")
        );
        assert!(asset.validate().is_ok());

        let mut stale = serde_json::to_value(&asset).unwrap();
        stale["build_report"]["mixed_layer_topology_certificate"]["topology_fingerprint"] =
            serde_json::json!(format!("sha256:{}", "0".repeat(64)));
        let stale: FemDomainMeshAssetIR = serde_json::from_value(stale).unwrap();
        assert!(stale.validate().is_err());
    }

    #[test]
    fn mixed_certificate_rejects_wrong_schema_status_and_fallbacks() {
        for (field, value) in [
            (
                "schema_version",
                serde_json::json!("mixed_layer_topology_certificate.v0"),
            ),
            ("certificate_status", serde_json::json!("rejected")),
            (
                "fallbacks_triggered",
                serde_json::json!(["tetrahedral_fallback"]),
            ),
        ] {
            let mut payload = mixed_certificate_asset_value();
            payload["build_report"]["mixed_layer_topology_certificate"][field] = value;
            let asset: FemDomainMeshAssetIR = serde_json::from_value(payload).unwrap();
            assert!(asset.validate().is_err(), "{field} must fail closed");
        }
    }

    #[test]
    fn mixed_certificate_rejects_invalid_numeric_and_structural_evidence() {
        for (field, value) in [
            ("plane_tolerance_m", serde_json::json!(-1.0)),
            ("magnetic_volume_m3", serde_json::json!(-1.0)),
            ("marker_coverage_complete", serde_json::json!(false)),
            ("nonconforming_face_count", serde_json::json!(1)),
            (
                "scaled_jacobian_p05_by_family",
                serde_json::json!({"prism6": 0.09, "pyramid5": 1.0, "tet4": 1.0}),
            ),
            (
                "cell_family_counts_by_part",
                serde_json::json!({
                    "magnetic": {"prism6": 1},
                    "transition_air": {"pyramid5": 1},
                    "far_air": {"prism6": 1}
                }),
            ),
            ("deterministic_inputs", serde_json::json!({})),
        ] {
            let mut payload = mixed_certificate_asset_value();
            payload["build_report"]["mixed_layer_topology_certificate"][field] = value;
            let asset: FemDomainMeshAssetIR = serde_json::from_value(payload).unwrap();
            assert!(asset.validate().is_err(), "{field} must fail closed");
        }

        let mut asset: FemDomainMeshAssetIR =
            serde_json::from_value(mixed_certificate_asset_value()).unwrap();
        asset
            .build_report
            .as_mut()
            .unwrap()
            .mixed_layer_topology_certificate
            .as_mut()
            .unwrap()
            .jacobian_minima_m3_by_family
            .insert("prism6".to_string(), f64::NAN);
        assert!(
            asset.validate().is_err(),
            "non-finite Jacobian must fail closed"
        );
    }

    #[test]
    fn conflicting_mesh_and_build_report_certificate_copies_fail_deserialization() {
        let mut payload = mixed_certificate_asset_value();
        let mut conflicting = payload["build_report"]["mixed_layer_topology_certificate"].clone();
        conflicting["certificate_status"] = serde_json::json!("rejected");
        payload["mesh"]["mixed_layer_topology_certificate"] = conflicting;

        assert!(serde_json::from_value::<FemDomainMeshAssetIR>(payload).is_err());
    }

    fn inverted_mesh() -> MeshIR {
        MeshIR {
            mesh_name: "inverted".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            cells: crate::FemConnectivityIR::from_tet4(vec![[0, 1, 3, 2]]),
            element_markers: vec![1],
            facets: crate::FemFacetConnectivityIR::empty(),
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

        let errors = asset
            .validate()
            .expect_err("inverted inline mesh must fail");
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
    /// Requested swept cell family: "prism" or "hex".
    #[serde(default = "default_swept_element_family")]
    pub element_family: String,
    /// Requested transition policy: "pyramid_to_tetrahedra" or "reject".
    #[serde(default = "default_swept_transition_policy")]
    pub transition_policy: String,
    /// Whether the realized mesh must preserve the exact requested layer count.
    #[serde(default)]
    pub exact_layer_count: bool,
}

fn default_swept_element_family() -> String {
    "prism".to_string()
}

fn default_swept_transition_policy() -> String {
    "reject".to_string()
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

/// Fail-closed evidence for the qualified single-layer prism/pyramid/tet route.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MixedLayerTopologyCertificateV1IR {
    pub schema_version: String,
    pub certificate_status: String,
    pub requested_sweep_direction: String,
    pub resolved_sweep_direction: String,
    pub requested_layer_count: u32,
    pub realized_layer_count: u32,
    pub magnetic_plane_coordinates_m: Vec<f64>,
    pub plane_tolerance_m: f64,
    pub transition_shell_thickness_m: f64,
    pub transition_shell_interface_tri3_count: u64,
    pub interface_marker: u32,
    pub outer_boundary_marker: u32,
    pub magnetic_bounds_min_m: [f64; 3],
    pub magnetic_bounds_max_m: [f64; 3],
    pub airbox_bounds_min_m: [f64; 3],
    pub airbox_bounds_max_m: [f64; 3],
    pub magnetic_bounds_relative_error: f64,
    pub airbox_bounds_relative_error: f64,
    pub cell_family_counts_by_marker: BTreeMap<String, BTreeMap<String, u64>>,
    pub cell_family_counts_by_part: BTreeMap<String, BTreeMap<String, u64>>,
    pub facet_family_counts_by_role_marker: BTreeMap<String, BTreeMap<String, u64>>,
    pub jacobian_minima_m3_by_family: BTreeMap<String, f64>,
    pub quality_metric: String,
    pub scaled_jacobian_minima_by_family: BTreeMap<String, f64>,
    pub scaled_jacobian_p05_by_family: BTreeMap<String, f64>,
    pub magnetic_volume_m3: f64,
    pub expected_magnetic_volume_m3: f64,
    pub magnetic_relative_volume_error: f64,
    pub air_volume_m3: f64,
    pub shared_domain_volume_m3: f64,
    pub expected_shared_domain_volume_m3: f64,
    pub shared_domain_relative_volume_error: f64,
    pub marker_coverage_complete: bool,
    pub nonconforming_face_count: u64,
    pub orphan_face_count: u64,
    pub nonmanifold_face_count: u64,
    pub coincident_interface_face_count: u64,
    pub topology_fingerprint_version: String,
    pub topology_fingerprint: String,
    pub gmsh_version: String,
    pub strategy: String,
    pub effective_gmsh_thread_count: u32,
    pub deterministic_inputs: BTreeMap<String, Value>,
    #[serde(default)]
    pub fallbacks_triggered: Vec<String>,
}

impl MixedLayerTopologyCertificateV1IR {
    pub fn validate(&self) -> Result<(), Vec<String>> {
        let mut errors = Vec::new();
        if self.schema_version != "mixed_layer_topology_certificate.v1" {
            errors.push("mixed layer topology certificate schema_version must be mixed_layer_topology_certificate.v1".to_string());
        }
        if self.certificate_status != "accepted" {
            errors.push("mixed layer topology certificate status must be accepted".to_string());
        }
        if !matches!(self.requested_sweep_direction.as_str(), "x" | "y" | "z")
            || self.requested_sweep_direction != self.resolved_sweep_direction
        {
            errors.push(
                "mixed layer topology certificate sweep direction is invalid or changed"
                    .to_string(),
            );
        }
        if self.requested_layer_count == 0
            || self.requested_layer_count != self.realized_layer_count
            || self.magnetic_plane_coordinates_m.len() != self.realized_layer_count as usize + 1
        {
            errors.push(
                "mixed layer topology certificate layer count or planes are invalid".to_string(),
            );
        }
        if self
            .magnetic_plane_coordinates_m
            .iter()
            .any(|value| !value.is_finite())
            || self
                .magnetic_plane_coordinates_m
                .windows(2)
                .any(|pair| pair[1] <= pair[0])
        {
            errors.push(
                "mixed layer topology certificate magnetic planes must be finite and increasing"
                    .to_string(),
            );
        }
        for (name, value) in [
            ("plane_tolerance_m", self.plane_tolerance_m),
            (
                "transition_shell_thickness_m",
                self.transition_shell_thickness_m,
            ),
            ("magnetic_volume_m3", self.magnetic_volume_m3),
            (
                "expected_magnetic_volume_m3",
                self.expected_magnetic_volume_m3,
            ),
            ("air_volume_m3", self.air_volume_m3),
            ("shared_domain_volume_m3", self.shared_domain_volume_m3),
            (
                "expected_shared_domain_volume_m3",
                self.expected_shared_domain_volume_m3,
            ),
        ] {
            if !value.is_finite() || value <= 0.0 {
                errors.push(format!(
                    "mixed layer topology certificate {name} must be finite and positive"
                ));
            }
        }
        let relative_error = |actual: f64, expected: f64| {
            if actual.is_finite() && expected.is_finite() && expected > 0.0 {
                ((actual - expected) / expected).abs()
            } else {
                f64::INFINITY
            }
        };
        if relative_error(self.magnetic_volume_m3, self.expected_magnetic_volume_m3)
            > self.magnetic_relative_volume_error + 1.0e-15
            || relative_error(
                self.shared_domain_volume_m3,
                self.expected_shared_domain_volume_m3,
            ) > self.shared_domain_relative_volume_error + 1.0e-15
            || relative_error(
                self.magnetic_volume_m3 + self.air_volume_m3,
                self.shared_domain_volume_m3,
            ) > 1.0e-8
        {
            errors.push(
                "mixed layer topology certificate volume evidence is internally inconsistent"
                    .to_string(),
            );
        }
        if self.transition_shell_interface_tri3_count == 0
            || self.interface_marker == 0
            || self.outer_boundary_marker == 0
            || self.interface_marker == self.outer_boundary_marker
        {
            errors.push(
                "mixed layer topology certificate transition interface and markers are invalid"
                    .to_string(),
            );
        }
        for (name, minimum, maximum) in [
            (
                "magnetic",
                self.magnetic_bounds_min_m,
                self.magnetic_bounds_max_m,
            ),
            ("airbox", self.airbox_bounds_min_m, self.airbox_bounds_max_m),
        ] {
            if minimum
                .iter()
                .chain(maximum.iter())
                .any(|value| !value.is_finite())
                || minimum
                    .iter()
                    .zip(maximum.iter())
                    .any(|(left, right)| right <= left)
            {
                errors.push(format!(
                    "mixed layer topology certificate {name} bounds must be finite and increasing"
                ));
            }
        }
        for (name, value) in [
            (
                "magnetic_bounds_relative_error",
                self.magnetic_bounds_relative_error,
            ),
            (
                "airbox_bounds_relative_error",
                self.airbox_bounds_relative_error,
            ),
            (
                "magnetic_relative_volume_error",
                self.magnetic_relative_volume_error,
            ),
            (
                "shared_domain_relative_volume_error",
                self.shared_domain_relative_volume_error,
            ),
        ] {
            if !value.is_finite() || !(0.0..=1.0e-8).contains(&value) {
                errors.push(format!(
                    "mixed layer topology certificate {name} must be finite and <= 1e-8"
                ));
            }
        }
        if !self.marker_coverage_complete
            || self.nonconforming_face_count != 0
            || self.orphan_face_count != 0
            || self.nonmanifold_face_count != 0
            || self.coincident_interface_face_count != 0
        {
            errors.push(
                "mixed layer topology certificate conformity or marker coverage is invalid"
                    .to_string(),
            );
        }
        if self.topology_fingerprint_version != "v2"
            || !is_sha256_fingerprint(&self.topology_fingerprint)
        {
            errors.push(
                "mixed layer topology certificate requires a valid v2 sha256 fingerprint"
                    .to_string(),
            );
        }
        if self.quality_metric != "tetra_decomposition_scaled_jacobian.v1" {
            errors
                .push("mixed layer topology certificate quality metric is unqualified".to_string());
        }
        if self.strategy != "shared_geo_extrusion_partitioned_pyramid_tet.v2" {
            errors.push("mixed layer topology certificate strategy is unqualified".to_string());
        }
        if self.gmsh_version != "4.15.2" {
            errors.push("mixed layer topology certificate Gmsh version is unqualified".to_string());
        }
        if self.effective_gmsh_thread_count != 1 {
            errors.push(
                "mixed layer topology certificate requires one effective Gmsh thread".to_string(),
            );
        }
        if !self.fallbacks_triggered.is_empty() {
            errors.push("mixed layer topology certificate must not contain fallbacks".to_string());
        }
        let expected_inputs: BTreeMap<String, Value> = serde_json::from_value(serde_json::json!({
            "algorithm_2d": 6,
            "algorithm_3d": 1,
            "element_order": 1,
            "gmsh_version": "4.15.2",
            "random_factor": 0.0,
            "thread_count": 1,
            "transition_partition": "cartesian_3x3x3_minus_magnetic_center",
            "transition_volume_count": 26,
            "pyramid_apex_optimizer": "bounded_per_apex_outward_scale_line_search",
            "pyramid_apex_scale_step": 0.001,
            "pyramid_apex_scale_max": 1.25,
            "scaled_jacobian_p05_min": 0.1
        }))
        .expect("qualified deterministic inputs are valid JSON");
        if self.deterministic_inputs != expected_inputs {
            errors.push(
                "mixed layer topology certificate deterministic inputs are stale".to_string(),
            );
        }

        let magnetic = self.cell_family_counts_by_part.get("magnetic");
        let transition = self.cell_family_counts_by_part.get("transition_air");
        let far = self.cell_family_counts_by_part.get("far_air");
        if self.cell_family_counts_by_part.len() != 3
            || magnetic.is_none_or(|counts| {
                counts.len() != 1 || counts.get("prism6").copied().unwrap_or(0) == 0
            })
            || transition.is_none_or(|counts| {
                counts.get("pyramid5").copied().unwrap_or(0) == 0
                    || counts
                        .keys()
                        .any(|family| !matches!(family.as_str(), "pyramid5" | "tet4"))
            })
            || far.is_none_or(|counts| {
                counts.len() != 1 || counts.get("tet4").copied().unwrap_or(0) == 0
            })
        {
            errors.push(
                "mixed layer topology certificate cell families by part are invalid".to_string(),
            );
        }
        if let (Some(magnetic), Some(transition), Some(far)) = (magnetic, transition, far) {
            let mut air = transition.clone();
            for (family, count) in far {
                *air.entry(family.clone()).or_default() += count;
            }
            if self.cell_family_counts_by_marker.len() != 2
                || self.cell_family_counts_by_marker.get("1") != Some(magnetic)
                || self.cell_family_counts_by_marker.get("0") != Some(&air)
            {
                errors.push(
                    "mixed layer topology certificate marker and part cell counts disagree"
                        .to_string(),
                );
            }
        }
        let families = self
            .cell_family_counts_by_part
            .values()
            .flat_map(|counts| counts.keys().cloned())
            .collect::<BTreeSet<_>>();
        for (name, values, minimum) in [
            (
                "jacobian_minima_m3_by_family",
                &self.jacobian_minima_m3_by_family,
                0.0,
            ),
            (
                "scaled_jacobian_minima_by_family",
                &self.scaled_jacobian_minima_by_family,
                0.0,
            ),
            (
                "scaled_jacobian_p05_by_family",
                &self.scaled_jacobian_p05_by_family,
                0.1,
            ),
        ] {
            if values.keys().cloned().collect::<BTreeSet<_>>() != families
                || values.values().any(|value| {
                    !value.is_finite() || *value < minimum || (minimum == 0.0 && *value == 0.0)
                })
            {
                errors.push(format!(
                    "mixed layer topology certificate {name} is incomplete or unqualified"
                ));
            }
        }
        let interface_key = format!("material_interface:{}", self.interface_marker);
        let outer_key = format!("exterior:{}", self.outer_boundary_marker);
        if self
            .facet_family_counts_by_role_marker
            .get(&interface_key)
            .and_then(|counts| counts.get("tri3"))
            .copied()
            != Some(self.transition_shell_interface_tri3_count)
            || !self
                .facet_family_counts_by_role_marker
                .get(&outer_key)
                .is_some_and(|counts| !counts.is_empty())
        {
            errors.push(
                "mixed layer topology certificate facet family evidence is incomplete".to_string(),
            );
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }
}

fn is_sha256_fingerprint(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|digest| {
        digest.len() == 64
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

fn mixed_certificate_counts_match_mesh(
    certificate: &MixedLayerTopologyCertificateV1IR,
    mesh: &MeshIR,
) -> bool {
    if mesh.cells.mesh_parts.len() != mesh.cells.types.len() {
        return false;
    }
    let mut by_marker: BTreeMap<String, BTreeMap<String, u64>> = BTreeMap::new();
    let mut by_part: BTreeMap<String, BTreeMap<String, u64>> = BTreeMap::new();
    for ((cell_type, mesh_part), marker) in mesh
        .cells
        .types
        .iter()
        .zip(mesh.cells.mesh_parts.iter())
        .zip(mesh.element_markers.iter())
    {
        let family = match cell_type {
            crate::FemCellTypeIR::Tet4 => "tet4",
            crate::FemCellTypeIR::Prism6 => "prism6",
            crate::FemCellTypeIR::Pyramid5 => "pyramid5",
            crate::FemCellTypeIR::Hex8 => "hex8",
        };
        let part = match mesh_part {
            crate::FemCellMeshPartIR::Magnetic => "magnetic",
            crate::FemCellMeshPartIR::TransitionAir => "transition_air",
            crate::FemCellMeshPartIR::FarAir => "far_air",
        };
        *by_marker
            .entry(marker.to_string())
            .or_default()
            .entry(family.to_string())
            .or_default() += 1;
        *by_part
            .entry(part.to_string())
            .or_default()
            .entry(family.to_string())
            .or_default() += 1;
    }
    let mut by_facet: BTreeMap<String, BTreeMap<String, u64>> = BTreeMap::new();
    for ((facet_type, role), marker) in mesh
        .facets
        .types
        .iter()
        .zip(mesh.facets.roles.iter())
        .zip(mesh.boundary_markers.iter())
    {
        let family = match facet_type {
            crate::FemFacetTypeIR::Tri3 => "tri3",
            crate::FemFacetTypeIR::Quad4 => "quad4",
        };
        let role = match role {
            crate::FemFacetRoleIR::Exterior => "exterior",
            crate::FemFacetRoleIR::MaterialInterface => "material_interface",
            crate::FemFacetRoleIR::PeriodicSeam => "periodic_seam",
        };
        *by_facet
            .entry(format!("{role}:{marker}"))
            .or_default()
            .entry(family.to_string())
            .or_default() += 1;
    }
    certificate.cell_family_counts_by_marker == by_marker
        && certificate.cell_family_counts_by_part == by_part
        && certificate.facet_family_counts_by_role_marker == by_facet
}

/// Build report for a shared-domain FEM mesh, propagated from the Python
/// meshing pipeline so the planner / runner can inspect how the mesh was built.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemSharedDomainBuildReportIR {
    pub build_mode: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fallbacks_triggered: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_airbox_target: Option<FemAirboxTargetIR>,
    #[serde(
        rename = "effective_airbox_maximum_element_size",
        alias = "effective_airbox_hmax",
        default,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authored_regions_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub realized_regions_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mixed_layer_topology_certificate: Option<MixedLayerTopologyCertificateV1IR>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
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

impl<'de> Deserialize<'de> for FemDomainMeshAssetIR {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Wire {
            #[serde(default)]
            mesh_source: Option<String>,
            #[serde(default)]
            mesh: Option<Value>,
            #[serde(default)]
            region_markers: Vec<FemDomainRegionMarkerIR>,
            #[serde(default)]
            object_region_markers: Vec<FemDomainRegionMarkerIR>,
            #[serde(default)]
            build_report: Option<FemSharedDomainBuildReportIR>,
        }

        let wire = Wire::deserialize(deserializer)?;
        let mesh_level_certificate = wire
            .mesh
            .as_ref()
            .and_then(|mesh| mesh.get("mixed_layer_topology_certificate"))
            .filter(|value| !value.is_null())
            .cloned()
            .map(serde_json::from_value)
            .transpose()
            .map_err(serde::de::Error::custom)?;
        let mesh = wire
            .mesh
            .map(serde_json::from_value)
            .transpose()
            .map_err(serde::de::Error::custom)?;
        let mut build_report = wire.build_report;
        if let Some(mesh_certificate) = mesh_level_certificate {
            let report = build_report.as_mut().ok_or_else(|| {
                serde::de::Error::custom(
                    "mesh-level mixed certificate requires a shared-domain build report",
                )
            })?;
            match report.mixed_layer_topology_certificate.as_ref() {
                Some(report_certificate) if report_certificate != &mesh_certificate => {
                    return Err(serde::de::Error::custom(
                        "mesh-level and build-report mixed certificates conflict",
                    ));
                }
                Some(_) => {}
                None => report.mixed_layer_topology_certificate = Some(mesh_certificate),
            }
        }
        Ok(Self {
            mesh_source: wire.mesh_source,
            mesh,
            region_markers: wire.region_markers,
            object_region_markers: wire.object_region_markers,
            build_report,
        })
    }
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
        if let Some(certificate) = self
            .build_report
            .as_ref()
            .and_then(|report| report.mixed_layer_topology_certificate.as_ref())
        {
            if let Err(certificate_errors) = certificate.validate() {
                errors.extend(
                    certificate_errors
                        .into_iter()
                        .map(|error| format!("fem_domain_mesh_asset.build_report.{error}")),
                );
            }
            match &self.mesh {
                Some(mesh)
                    if certificate.topology_fingerprint == mesh.topology_fingerprint_v6()
                        && mixed_certificate_counts_match_mesh(certificate, mesh) => {}
                Some(_) => errors.push("fem_domain_mesh_asset mixed layer topology certificate fingerprint or topology evidence is stale".to_string()),
                None => errors.push("fem_domain_mesh_asset mixed layer topology certificate requires an inline mesh for fingerprint binding".to_string()),
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
