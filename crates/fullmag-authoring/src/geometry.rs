use crate::{SceneDocument, SceneGeometry, SceneObject, Transform3D};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum GeometryBackendTarget {
    Fem,
    Fdm,
}

impl GeometryBackendTarget {
    pub fn from_scene(scene: &SceneDocument) -> Self {
        let backend = scene
            .study
            .backend
            .as_deref()
            .unwrap_or(scene.study.requested_backend.as_str())
            .trim()
            .to_ascii_lowercase();
        if backend == "fdm" {
            Self::Fdm
        } else {
            Self::Fem
        }
    }

    fn as_str(&self) -> &'static str {
        match self {
            Self::Fem => "fem",
            Self::Fdm => "fdm",
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum GeometrySupportStatus {
    Production,
    Preview,
    Unsupported,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum GeometryDiagnosticSeverity {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, ToSchema)]
pub struct GeometryDiagnostic {
    pub id: String,
    pub severity: GeometryDiagnosticSeverity,
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub geometry_path: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blocks: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, ToSchema)]
pub struct PrimitiveGeometryCapability {
    pub id: String,
    pub label: String,
    pub category: String,
    pub fem: bool,
    pub fdm: bool,
    pub dsl: bool,
    pub boolean: bool,
    pub status: GeometrySupportStatus,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, ToSchema)]
pub struct BooleanGeometryCapability {
    pub op: String,
    pub fem: bool,
    pub fdm: bool,
    pub dsl: bool,
    pub status: GeometrySupportStatus,
    pub notes: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, ToSchema)]
pub struct GeometryCapabilitiesResource {
    pub revision: u64,
    pub primitive_capabilities: Vec<PrimitiveGeometryCapability>,
    pub csg_capabilities: Vec<BooleanGeometryCapability>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, ToSchema)]
pub struct GeometryValidationResource {
    pub scene_revision: u64,
    pub backend_target: GeometryBackendTarget,
    pub status: String,
    pub dirty: bool,
    pub diagnostics: Vec<GeometryDiagnostic>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, ToSchema)]
pub struct GeometryDiagnosticsResource {
    pub scene_revision: u64,
    pub backend_target: GeometryBackendTarget,
    pub status: String,
    pub diagnostics: Vec<GeometryDiagnostic>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct GeometryWorkspace {
    pub scene_revision: u64,
    pub backend_target: GeometryBackendTarget,
    #[serde(default)]
    pub bodies: Vec<GeometryBody>,
    #[serde(default)]
    pub diagnostics: Vec<GeometryDiagnostic>,
    #[serde(default)]
    pub provenance: Vec<GeometryProvenanceEntry>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct GeometryBody {
    pub body_id: String,
    pub object_id: String,
    pub object_name: String,
    pub geometry_kind: String,
    pub geometry_path: String,
    pub transform: Transform3D,
    pub bounds_min: [f64; 3],
    pub bounds_max: [f64; 3],
    pub material_ref: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub magnetization_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region_hint: Option<String>,
    pub visible: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct GeometryRealizationSnapshot {
    pub source_scene_revision: u64,
    pub realization_revision: u64,
    pub backend_target: GeometryBackendTarget,
    pub status: String,
    #[serde(default)]
    pub bodies: Vec<RealizedGeometryBody>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bounds_min: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bounds_max: Option<[f64; 3]>,
    #[serde(default)]
    pub diagnostics: Vec<GeometryDiagnostic>,
    #[serde(default)]
    pub region_candidates: Vec<GeometryRegionCandidate>,
    #[serde(default)]
    pub provenance: Vec<GeometryProvenanceEntry>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct RealizedGeometryBody {
    pub body_id: String,
    pub object_id: String,
    pub object_name: String,
    pub geometry_kind: String,
    pub material_ref: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub magnetization_ref: Option<String>,
    pub visible: bool,
    pub status: String,
    pub bounds_min: [f64; 3],
    pub bounds_max: [f64; 3],
    #[serde(default)]
    pub provenance: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct GeometryRegionCandidate {
    pub id: String,
    pub object_id: String,
    pub source_body_id: String,
    #[serde(default)]
    pub source_body_ids: Vec<String>,
    pub material_ref: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub magnetization_ref: Option<String>,
    pub bounds_min: [f64; 3],
    pub bounds_max: [f64; 3],
    pub source_geometry_path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, ToSchema)]
pub struct GeometryProvenanceEntry {
    pub body_id: String,
    pub object_id: String,
    pub geometry_path: String,
    pub source: String,
}

pub fn geometry_capabilities(revision: u64) -> GeometryCapabilitiesResource {
    GeometryCapabilitiesResource {
        revision,
        primitive_capabilities: vec![
            primitive(
                "box",
                "Box",
                "core",
                true,
                true,
                true,
                true,
                GeometrySupportStatus::Production,
            ),
            primitive(
                "cylinder",
                "Cylinder",
                "core",
                true,
                true,
                true,
                true,
                GeometrySupportStatus::Production,
            ),
            primitive(
                "sphere",
                "Sphere",
                "mumax",
                true,
                true,
                true,
                true,
                GeometrySupportStatus::Production,
            ),
            primitive(
                "ellipsoid",
                "Ellipsoid",
                "mumax",
                true,
                true,
                true,
                true,
                GeometrySupportStatus::Production,
            ),
            primitive(
                "ellipse",
                "Ellipse",
                "core",
                true,
                true,
                true,
                true,
                GeometrySupportStatus::Production,
            ),
            primitive(
                "disk",
                "Disk",
                "core",
                true,
                true,
                true,
                true,
                GeometrySupportStatus::Production,
            ),
            primitive(
                "thin_film",
                "Thin Film",
                "mumax",
                true,
                true,
                true,
                true,
                GeometrySupportStatus::Production,
            ),
            primitive(
                "pillar",
                "Pillar",
                "mumax",
                true,
                true,
                true,
                true,
                GeometrySupportStatus::Production,
            ),
            primitive(
                "nanowire",
                "Nanowire",
                "mumax",
                true,
                true,
                true,
                true,
                GeometrySupportStatus::Production,
            ),
            primitive(
                "ring",
                "Ring",
                "mumax",
                true,
                true,
                true,
                true,
                GeometrySupportStatus::Production,
            ),
            primitive(
                "arch_waveguide",
                "Arch Waveguide",
                "core",
                true,
                true,
                true,
                false,
                GeometrySupportStatus::Production,
            ),
            // Closed local STL volumes are executable FEM authoring inputs.
            // Workload/runtime qualification remains distinct from this flag.
            primitive(
                "imported_geometry",
                "Imported STL",
                "import",
                true,
                false,
                true,
                false,
                GeometrySupportStatus::Preview,
            ),
            primitive(
                "microstrip_antenna_layout",
                "Microstrip Antenna Layout",
                "antenna",
                true,
                false,
                true,
                false,
                GeometrySupportStatus::Preview,
            ),
            primitive(
                "cpw_antenna_layout",
                "CPW Antenna Layout",
                "antenna",
                true,
                false,
                true,
                false,
                GeometrySupportStatus::Preview,
            ),
            primitive(
                "triangular_prism",
                "Triangular Prism",
                "core",
                false,
                false,
                false,
                true,
                GeometrySupportStatus::Preview,
            ),
            primitive(
                "cone",
                "Cone",
                "dcc",
                true,
                true,
                true,
                true,
                GeometrySupportStatus::Production,
            ),
            primitive(
                "torus",
                "Torus",
                "dcc",
                true,
                true,
                true,
                true,
                GeometrySupportStatus::Production,
            ),
            primitive(
                "capsule",
                "Capsule",
                "dcc",
                false,
                false,
                false,
                true,
                GeometrySupportStatus::Preview,
            ),
            primitive(
                "tube",
                "Tube",
                "dcc",
                false,
                false,
                false,
                true,
                GeometrySupportStatus::Preview,
            ),
            primitive(
                "wedge",
                "Wedge",
                "dcc",
                false,
                false,
                false,
                true,
                GeometrySupportStatus::Preview,
            ),
            primitive(
                "polygon_prism",
                "Polygon Prism",
                "dcc",
                true,
                true,
                true,
                true,
                GeometrySupportStatus::Production,
            ),
        ],
        csg_capabilities: vec![
            boolean(
                "union",
                true,
                true,
                true,
                GeometrySupportStatus::Production,
                "Union combines two or more solid operands into a single body.",
            ),
            boolean(
                "subtract",
                true,
                true,
                true,
                GeometrySupportStatus::Production,
                "Difference subtracts one or more tool operands from the base body.",
            ),
            boolean(
                "intersect",
                true,
                true,
                true,
                GeometrySupportStatus::Production,
                "Intersection retains the common volume shared by all enabled operands.",
            ),
            boolean(
                "xor",
                true,
                true,
                true,
                GeometrySupportStatus::Production,
                "Symmetric difference (XOR) keeps regions belonging to an odd number of operands.",
            ),
            boolean(
                "slice_plane",
                true,
                true,
                true,
                GeometrySupportStatus::Production,
                "SlicePlane cuts a solid along an authored plane keeping positive or negative half-space.",
            ),
            boolean(
                "transform",
                true,
                true,
                true,
                GeometrySupportStatus::Production,
                "Nested affine Transform (translation, rotation_quat, scale, pivot) on any solid operand.",
            ),
            boolean(
                "array_3d",
                true,
                true,
                true,
                GeometrySupportStatus::Production,
                "Parametric 3D lattice Array3D (X/Y/Z counts, +/-/± directions, Bravais skew, step rotation/scale).",
            ),
        ],
    }
}

pub fn validate_geometry_scene(
    scene: &SceneDocument,
    backend_target: GeometryBackendTarget,
) -> GeometryValidationResource {
    let diagnostics = collect_geometry_diagnostics(scene, &backend_target);
    GeometryValidationResource {
        scene_revision: scene.revision,
        backend_target,
        status: workspace_status(&diagnostics),
        dirty: scene_has_dirty_mesh_tags(scene),
        diagnostics,
    }
}

pub fn realize_geometry_scene(
    scene: &SceneDocument,
    backend_target: GeometryBackendTarget,
) -> GeometryRealizationSnapshot {
    let workspace = build_geometry_workspace(scene, backend_target);
    let mut bounds: Option<([f64; 3], [f64; 3])> = None;
    let mut bodies = Vec::new();
    let mut region_candidates = Vec::new();

    for body in &workspace.bodies {
        bodies.push(RealizedGeometryBody {
            body_id: body.body_id.clone(),
            object_id: body.object_id.clone(),
            object_name: body.object_name.clone(),
            geometry_kind: body.geometry_kind.clone(),
            material_ref: body.material_ref.clone(),
            magnetization_ref: body.magnetization_ref.clone(),
            visible: body.visible,
            status: if body.visible { "ready" } else { "hidden" }.to_string(),
            bounds_min: body.bounds_min,
            bounds_max: body.bounds_max,
            provenance: vec![body.geometry_path.clone()],
        });
        region_candidates.push(GeometryRegionCandidate {
            id: body
                .region_hint
                .clone()
                .unwrap_or_else(|| format!("region:{}", body.object_id)),
            object_id: body.object_id.clone(),
            source_body_id: body.body_id.clone(),
            source_body_ids: vec![body.body_id.clone()],
            material_ref: body.material_ref.clone(),
            magnetization_ref: body.magnetization_ref.clone(),
            bounds_min: body.bounds_min,
            bounds_max: body.bounds_max,
            source_geometry_path: body.geometry_path.clone(),
        });
        bounds = Some(match bounds {
            Some((current_min, current_max)) => (
                min_vec3(current_min, body.bounds_min),
                max_vec3(current_max, body.bounds_max),
            ),
            None => (body.bounds_min, body.bounds_max),
        });
    }

    let (bounds_min, bounds_max) = bounds
        .map(|(min, max)| (Some(min), Some(max)))
        .unwrap_or((None, None));
    GeometryRealizationSnapshot {
        source_scene_revision: scene.revision,
        realization_revision: scene.revision,
        backend_target: workspace.backend_target,
        status: workspace_status(&workspace.diagnostics),
        bodies,
        bounds_min,
        bounds_max,
        diagnostics: workspace.diagnostics,
        region_candidates,
        provenance: workspace.provenance,
    }
}

pub fn build_geometry_workspace(
    scene: &SceneDocument,
    backend_target: GeometryBackendTarget,
) -> GeometryWorkspace {
    let diagnostics = collect_geometry_diagnostics(scene, &backend_target);
    let mut bodies = Vec::new();
    let mut provenance = Vec::new();
    for object in &scene.objects {
        let Some((bounds_min, bounds_max)) = derive_object_bounds(object) else {
            continue;
        };
        let geometry_path = format!("objects/{}/geometry", object.id);
        let body_id = stable_body_id(&object.id, &geometry_path);
        let region_id = object
            .region_name
            .clone()
            .unwrap_or_else(|| format!("region:{}", object.id));
        let magnetization_ref = object
            .region_overrides
            .get(&region_id)
            .and_then(|override_entry| override_entry.magnetization_ref.clone())
            .or_else(|| object.magnetization_ref.clone());
        bodies.push(GeometryBody {
            body_id: body_id.clone(),
            object_id: object.id.clone(),
            object_name: object.name.clone(),
            geometry_kind: object.geometry.geometry_kind.clone(),
            geometry_path: geometry_path.clone(),
            transform: object.transform.clone(),
            bounds_min,
            bounds_max,
            material_ref: object.material_ref.clone(),
            magnetization_ref,
            region_hint: Some(region_id),
            visible: object.visible,
        });
        provenance.push(GeometryProvenanceEntry {
            body_id,
            object_id: object.id.clone(),
            geometry_path,
            source: object.geometry.geometry_kind.clone(),
        });
    }
    GeometryWorkspace {
        scene_revision: scene.revision,
        backend_target,
        bodies,
        diagnostics,
        provenance,
    }
}

pub fn geometry_blocks_mesh_build(
    scene: &SceneDocument,
    backend_target: GeometryBackendTarget,
) -> Option<String> {
    let validation = validate_geometry_scene(scene, backend_target);
    validation
        .diagnostics
        .into_iter()
        .find(|diagnostic| diagnostic.blocks.iter().any(|block| block == "build_mesh"))
        .map(|diagnostic| diagnostic.message)
}

pub fn geometry_blocks_solver_run(
    scene: &SceneDocument,
    backend_target: GeometryBackendTarget,
) -> Option<String> {
    let validation = validate_geometry_scene(scene, backend_target);
    if validation.dirty {
        return Some("Mesh out of date - build mesh before compute".to_string());
    }
    validation
        .diagnostics
        .into_iter()
        .find(|diagnostic| diagnostic.blocks.iter().any(|block| block == "run_solver"))
        .map(|diagnostic| diagnostic.message)
}

fn collect_geometry_diagnostics(
    scene: &SceneDocument,
    backend_target: &GeometryBackendTarget,
) -> Vec<GeometryDiagnostic> {
    let mut diagnostics = Vec::new();
    for object in &scene.objects {
        validate_object_geometry(scene, object, backend_target, &mut diagnostics);
    }
    if let Some(universe) = scene
        .study
        .universe_mesh
        .as_ref()
        .or(scene.universe.as_ref())
    {
        if universe.mode.eq_ignore_ascii_case("manual")
            && (!universe
                .size
                .is_some_and(|size| size.iter().all(|value| value.is_finite() && *value > 0.0))
                || universe
                    .center
                    .is_some_and(|center| center.iter().any(|value| !value.is_finite())))
        {
            diagnostics.push(error(
                "GEOMETRY_UNIVERSE_INVALID_BOUNDS",
                "Manual Universe requires positive finite size and a finite center. Configure Universe bounds before building or running.".to_string(),
                None, Some("study.universe_mesh".to_string()), &["build_mesh", "run_solver"],
            ));
        }
    }
    validate_region_names(scene, &mut diagnostics);
    validate_object_overlaps(scene, &mut diagnostics);
    diagnostics
}

fn workspace_status(diagnostics: &[GeometryDiagnostic]) -> String {
    if diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == GeometryDiagnosticSeverity::Error)
    {
        "blocked".to_string()
    } else if diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == GeometryDiagnosticSeverity::Warning)
    {
        "warning".to_string()
    } else {
        "ready".to_string()
    }
}

fn validate_object_geometry(
    scene: &SceneDocument,
    object: &SceneObject,
    backend_target: &GeometryBackendTarget,
    diagnostics: &mut Vec<GeometryDiagnostic>,
) {
    let object_path = format!("objects/{}/geometry", object.id);
    if object.id.trim().is_empty() {
        diagnostics.push(error(
            "GEOMETRY_OBJECT_ID_EMPTY",
            "Scene object id must not be empty.",
            Some(object.id.clone()),
            Some(object_path.clone()),
            &["realize_geometry", "build_mesh", "run_solver"],
        ));
    }
    // Material and initial state are physics inputs: a mesh is realized from
    // geometry, universe and mesh policies alone (ADR 0074), so these
    // references gate Compute only.
    let requires_magnetic_refs = object.role == "magnet";
    if (requires_magnetic_refs || !object.material_ref.trim().is_empty())
        && (object.material_ref.trim().is_empty()
            || !scene
                .materials
                .iter()
                .any(|material| material.id == object.material_ref))
    {
        diagnostics.push(error(
            "GEOMETRY_OBJECT_MATERIAL_MISSING",
            format!("Object '{}' references a missing material.", object.id),
            Some(object.id.clone()),
            Some(object_path.clone()),
            &["run_solver"],
        ));
    }
    if requires_magnetic_refs || object.magnetization_ref.is_some() {
        match object
            .magnetization_ref
            .as_ref()
            .filter(|value| !value.trim().is_empty())
        {
            Some(reference)
                if scene
                    .magnetization_assets
                    .iter()
                    .any(|asset| asset.id == *reference) => {}
            _ => diagnostics.push(error(
                "GEOMETRY_OBJECT_MAGNETIZATION_MISSING",
                format!(
                    "Object '{}' must reference a magnetization asset before compute.",
                    object.id
                ),
                Some(object.id.clone()),
                Some(object_path.clone()),
                &["run_solver"],
            )),
        }
    }
    if !transform_is_valid(&object.transform) {
        diagnostics.push(error(
            "GEOMETRY_TRANSFORM_INVALID",
            format!(
                "Object '{}' has a non-finite or degenerate transform.",
                object.id
            ),
            Some(object.id.clone()),
            Some(format!("objects/{}/transform", object.id)),
            &["realize_geometry", "build_mesh", "run_solver"],
        ));
    }
    if object.geometry.geometry_kind == "ImportedGeometry"
        && *backend_target == GeometryBackendTarget::Fem
    {
        validate_imported_stl_geometry(&object.geometry, &object.id, &object_path, diagnostics);
    } else {
        validate_geometry_node(
            &object.geometry, backend_target, &object.id, &object_path, diagnostics,
        );
    }
    validate_tiny_features(scene, object, &object_path, diagnostics);
    if let (Some((bounds_min, bounds_max)), Some(universe)) = (
        derive_object_bounds(object),
        scene
            .study
            .universe_mesh
            .as_ref()
            .or(scene.universe.as_ref()),
    ) {
        if let Some(universe_size) = universe.size {
            let universe_center = universe.center.unwrap_or([0.0; 3]);
            let universe_min = [
                universe_center[0] - universe_size[0] / 2.0,
                universe_center[1] - universe_size[1] / 2.0,
                universe_center[2] - universe_size[2] / 2.0,
            ];
            let universe_max = [
                universe_center[0] + universe_size[0] / 2.0,
                universe_center[1] + universe_size[1] / 2.0,
                universe_center[2] + universe_size[2] / 2.0,
            ];
            if (0..3).any(|axis| {
                // Bounds and transforms can reach the same authored face by
                // different floating-point operations. Admit only roundoff
                // at that axis' coordinate scale, never a physical padding.
                let scale = universe_size[axis].abs()
                    .max(universe_min[axis].abs())
                    .max(universe_max[axis].abs())
                    .max(bounds_min[axis].abs())
                    .max(bounds_max[axis].abs());
                let roundoff = 8.0 * f64::EPSILON * scale;
                bounds_min[axis] < universe_min[axis] - roundoff
                    || bounds_max[axis] > universe_max[axis] + roundoff
            }) {
                let manual = universe.mode.eq_ignore_ascii_case("manual");
                diagnostics.push(diagnostic(
                    if manual {
                        GeometryDiagnosticSeverity::Error
                    } else {
                        GeometryDiagnosticSeverity::Warning
                    },
                    "GEOMETRY_OBJECT_OUTSIDE_UNIVERSE",
                    format!(
                        "Object '{}' extends outside the declared Universe bounds.",
                        object.id
                    ),
                    Some(object.id.clone()),
                    Some(object_path),
                    if manual {
                        &["build_mesh", "run_solver"]
                    } else {
                        &[]
                    },
                ));
            }
        }
    }
}

fn validate_region_names(scene: &SceneDocument, diagnostics: &mut Vec<GeometryDiagnostic>) {
    let mut seen: Vec<(String, String)> = Vec::new();
    for object in scene.objects.iter().filter(|object| object.visible) {
        let region_name = object
            .region_name
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(object.name.as_str())
            .trim()
            .to_string();
        if let Some((first_object_id, _)) = seen
            .iter()
            .find(|(_, existing)| existing.eq_ignore_ascii_case(&region_name))
        {
            diagnostics.push(warning(
                "GEOMETRY_REGION_NAME_DUPLICATE",
                format!(
                    "Region name '{}' is used by both '{}' and '{}'.",
                    region_name, first_object_id, object.id
                ),
                Some(object.id.clone()),
                Some(format!("objects/{}/region_name", object.id)),
                &["build_mesh", "run_solver"],
            ));
        } else {
            seen.push((object.id.clone(), region_name));
        }
    }
}

fn validate_object_overlaps(scene: &SceneDocument, diagnostics: &mut Vec<GeometryDiagnostic>) {
    let realized: Vec<_> = scene
        .objects
        .iter()
        .filter(|object| object.visible)
        .filter_map(|object| derive_object_bounds(object).map(|bounds| (object, bounds)))
        .collect();
    for left_index in 0..realized.len() {
        for right_index in (left_index + 1)..realized.len() {
            let (left, (left_min, left_max)) = realized[left_index];
            let (right, (right_min, right_max)) = realized[right_index];
            if aabb_overlap(left_min, left_max, right_min, right_max) {
                diagnostics.push(warning(
                    "GEOMETRY_OBJECT_OVERLAPS_OBJECT",
                    format!("Object '{}' overlaps object '{}'.", left.id, right.id),
                    Some(left.id.clone()),
                    Some(format!("objects/{}/geometry", left.id)),
                    &["build_mesh"],
                ));
            }
        }
    }
}

fn validate_tiny_features(
    scene: &SceneDocument,
    object: &SceneObject,
    object_path: &str,
    diagnostics: &mut Vec<GeometryDiagnostic>,
) {
    let Some(mesh_size) = mesh_reference_size(scene) else {
        return;
    };
    let Some((bounds_min, bounds_max)) = derive_object_bounds(object) else {
        return;
    };
    let smallest_extent = (0..3)
        .map(|axis| bounds_max[axis] - bounds_min[axis])
        .filter(|value| value.is_finite() && *value > 0.0)
        .fold(f64::INFINITY, f64::min);
    if smallest_extent.is_finite() && smallest_extent < mesh_size {
        diagnostics.push(warning(
            "GEOMETRY_TINY_FEATURE_BELOW_MESH_SIZE",
            format!(
                "Object '{}' has feature size {:.3e} m below mesh size {:.3e} m.",
                object.id, smallest_extent, mesh_size
            ),
            Some(object.id.clone()),
            Some(object_path.to_string()),
            &["build_mesh"],
        ));
    }
}

fn validate_imported_stl_geometry(
    geometry: &SceneGeometry,
    object_id: &str,
    path: &str,
    diagnostics: &mut Vec<GeometryDiagnostic>,
) {
    match crate::imported_stl_parameters(&geometry.geometry_params) {
        Ok(parameters) if !parameters.surface_only => {},
        Ok(_) => diagnostics.push(error(
            "GEOMETRY_IMPORTED_SURFACE_ONLY",
            "STL source surface is available for preview; volume='full' is required for FEM meshing.".to_string(),
            Some(object_id.to_string()), Some(path.to_string()),
            &["build_mesh", "run_solver"],
        )),
        Err(message) => diagnostics.push(error(
            "GEOMETRY_IMPORTED_SOURCE_INVALID", message,
            Some(object_id.to_string()), Some(path.to_string()),
            &["realize_geometry", "build_mesh", "run_solver"],
        )),
    }
}

const MAX_GEOMETRY_TREE_DEPTH: usize = 16;
const MAX_CSG_OPERANDS: usize = 256;

fn validate_geometry_node(
    geometry: &SceneGeometry,
    backend_target: &GeometryBackendTarget,
    object_id: &str,
    path: &str,
    diagnostics: &mut Vec<GeometryDiagnostic>,
) {
    validate_geometry_node_depth(geometry, backend_target, object_id, path, 0, diagnostics);
}

fn validate_geometry_node_depth(
    geometry: &SceneGeometry,
    backend_target: &GeometryBackendTarget,
    object_id: &str,
    path: &str,
    depth: usize,
    diagnostics: &mut Vec<GeometryDiagnostic>,
) {
    if depth > MAX_GEOMETRY_TREE_DEPTH {
        diagnostics.push(error(
            "GEOMETRY_TREE_DEPTH_EXCEEDED",
            format!(
                "Geometry tree exceeds maximum nesting depth ({MAX_GEOMETRY_TREE_DEPTH})."
            ),
            Some(object_id.to_string()),
            Some(path.to_string()),
            &["realize_geometry", "build_mesh", "run_solver"],
        ));
        return;
    }
    match geometry.geometry_kind.as_str() {
        "Box" => validate_positive_vec3_param(
            &geometry.geometry_params,
            "size",
            object_id,
            path,
            diagnostics,
        ),
        "Cylinder" => {
            validate_positive_number_param(
                &geometry.geometry_params,
                "radius",
                object_id,
                path,
                diagnostics,
            );
            validate_positive_number_param(
                &geometry.geometry_params,
                "height",
                object_id,
                path,
                diagnostics,
            );
            validate_optional_nonzero_vec3_param(
                &geometry.geometry_params,
                "axis",
                object_id,
                path,
                diagnostics,
            );
        }
        "SinWaveguide" => {
            for key in ["length", "width", "height", "period"] {
                validate_positive_number_param(
                    &geometry.geometry_params,
                    key,
                    object_id,
                    path,
                    diagnostics,
                );
            }
            validate_finite_number_param(
                &geometry.geometry_params,
                "amplitude",
                object_id,
                path,
                diagnostics,
            );
            validate_optional_finite_number_param(
                &geometry.geometry_params,
                "phase",
                object_id,
                path,
                diagnostics,
            );
            validate_optional_finite_number_param(
                &geometry.geometry_params,
                "z0",
                object_id,
                path,
                diagnostics,
            );
        }
        "ArchWaveguide" => {
            validate_positive_number_param(
                &geometry.geometry_params,
                "length",
                object_id,
                path,
                diagnostics,
            );
            validate_positive_number_param(
                &geometry.geometry_params,
                "width",
                object_id,
                path,
                diagnostics,
            );
            validate_positive_number_param(
                &geometry.geometry_params,
                "height",
                object_id,
                path,
                diagnostics,
            );
            validate_finite_number_param(
                &geometry.geometry_params,
                "arch_height",
                object_id,
                path,
                diagnostics,
            );
            validate_optional_finite_number_param(
                &geometry.geometry_params,
                "z0",
                object_id,
                path,
                diagnostics,
            );
        }
        "MicrostripAntennaLayout" => {
            if *backend_target != GeometryBackendTarget::Fem {
                diagnostics.push(error(
                    "GEOMETRY_KIND_UNSUPPORTED",
                    "MicrostripAntennaLayout requires the FEM geometry pipeline.".to_string(),
                    Some(object_id.to_string()),
                    Some(path.to_string()),
                    &["realize_geometry", "build_mesh", "run_solver"],
                ));
            }
            if let Err(reason) = parse_microstrip_layout(&geometry.geometry_params) {
                diagnostics.push(error(
                    "GEOMETRY_PARAM_INVALID",
                    format!("Invalid MicrostripAntennaLayout: {reason}"),
                    Some(object_id.to_string()),
                    Some(path.to_string()),
                    &["realize_geometry", "build_mesh", "run_solver"],
                ));
            }
        }
        "CPWAntennaLayout" => {
            if *backend_target != GeometryBackendTarget::Fem {
                diagnostics.push(error(
                    "GEOMETRY_KIND_UNSUPPORTED",
                    "CPWAntennaLayout requires the FEM geometry pipeline.".to_string(),
                    Some(object_id.to_string()),
                    Some(path.to_string()),
                    &["realize_geometry", "build_mesh", "run_solver"],
                ));
            }
            if let Err(reason) = parse_cpw_layout(&geometry.geometry_params) {
                diagnostics.push(error(
                    "GEOMETRY_PARAM_INVALID",
                    format!("Invalid CPWAntennaLayout: {reason}"),
                    Some(object_id.to_string()),
                    Some(path.to_string()),
                    &["realize_geometry", "build_mesh", "run_solver"],
                ));
            }
        }
        "MeanderAntennaLayout" => {
            if *backend_target != GeometryBackendTarget::Fem {
                diagnostics.push(error(
                    "GEOMETRY_KIND_UNSUPPORTED",
                    "MeanderAntennaLayout requires the FEM geometry pipeline.".to_string(),
                    Some(object_id.to_string()),
                    Some(path.to_string()),
                    &["realize_geometry", "build_mesh", "run_solver"],
                ));
            }
            if let Err(reason) = parse_meander_layout(&geometry.geometry_params) {
                diagnostics.push(error(
                    "GEOMETRY_PARAM_INVALID",
                    format!("Invalid MeanderAntennaLayout: {reason}"),
                    Some(object_id.to_string()),
                    Some(path.to_string()),
                    &["realize_geometry", "build_mesh", "run_solver"],
                ));
            }
        }
        "InductiveLoopLayout" => {
            if *backend_target != GeometryBackendTarget::Fem {
                diagnostics.push(error(
                    "GEOMETRY_KIND_UNSUPPORTED",
                    "InductiveLoopLayout requires the FEM geometry pipeline.".to_string(),
                    Some(object_id.to_string()),
                    Some(path.to_string()),
                    &["realize_geometry", "build_mesh", "run_solver"],
                ));
            }
            if let Err(reason) = parse_inductive_loop_layout(&geometry.geometry_params) {
                diagnostics.push(error(
                    "GEOMETRY_PARAM_INVALID",
                    format!("Invalid InductiveLoopLayout: {reason}"),
                    Some(object_id.to_string()),
                    Some(path.to_string()),
                    &["realize_geometry", "build_mesh", "run_solver"],
                ));
            }
        }
        "PiecewisePath3DLayout" => {
            if *backend_target != GeometryBackendTarget::Fem {
                diagnostics.push(error(
                    "GEOMETRY_KIND_UNSUPPORTED",
                    "PiecewisePath3DLayout requires the FEM geometry pipeline.".to_string(),
                    Some(object_id.to_string()),
                    Some(path.to_string()),
                    &["realize_geometry", "build_mesh", "run_solver"],
                ));
            }
            if let Err(reason) = parse_piecewise_path_3d_layout(&geometry.geometry_params) {
                diagnostics.push(error(
                    "GEOMETRY_PARAM_INVALID",
                    format!("Invalid PiecewisePath3DLayout: {reason}"),
                    Some(object_id.to_string()),
                    Some(path.to_string()),
                    &["realize_geometry", "build_mesh", "run_solver"],
                ));
            }
        }
        "Union" | "Difference" | "Intersection" | "Xor" => validate_boolean_node(
            geometry.geometry_kind.as_str(),
            &geometry.geometry_params,
            backend_target,
            object_id,
            path,
            depth,
            diagnostics,
        ),
        "Csg" => validate_csg_node(
            &geometry.geometry_params,
            backend_target,
            object_id,
            path,
            depth,
            diagnostics,
        ),
        "Translate" => validate_translate_node(
            &geometry.geometry_params,
            backend_target,
            object_id,
            path,
            depth,
            diagnostics,
        ),
        "Transform" => validate_transform_node(
            &geometry.geometry_params,
            backend_target,
            object_id,
            path,
            depth,
            diagnostics,
        ),
        "SlicePlane" => validate_slice_plane_node(
            &geometry.geometry_params,
            backend_target,
            object_id,
            path,
            depth,
            diagnostics,
        ),
        "Sphere" => validate_positive_number_param(
            &geometry.geometry_params,
            "radius",
            object_id,
            path,
            diagnostics,
        ),
        "Ellipsoid" => {
            if geometry.geometry_params.get("radii").is_some() {
                validate_positive_vec3_param(
                    &geometry.geometry_params,
                    "radii",
                    object_id,
                    path,
                    diagnostics,
                );
            } else {
                for key in ["rx", "ry", "rz"] {
                    validate_positive_number_param(
                        &geometry.geometry_params,
                        key,
                        object_id,
                        path,
                        diagnostics,
                    );
                }
            }
        }
        "Ellipse" => {
            if geometry.geometry_params.get("radii").is_some() {
                validate_positive_vec2_param(
                    &geometry.geometry_params,
                    "radii",
                    object_id,
                    path,
                    diagnostics,
                );
            } else {
                for key in ["rx", "ry"] {
                    validate_positive_number_param(
                        &geometry.geometry_params,
                        key,
                        object_id,
                        path,
                        diagnostics,
                    );
                }
            }
            validate_positive_number_param(
                &geometry.geometry_params,
                "height",
                object_id,
                path,
                diagnostics,
            );
        }
        "Cone" => {
            let r_bottom = number_param(&geometry.geometry_params, "radius_bottom");
            let r_top = number_param(&geometry.geometry_params, "radius_top");
            if !r_bottom.is_some_and(|v| v.is_finite() && v >= 0.0) {
                diagnostics.push(error(
                    "GEOMETRY_PARAM_INVALID",
                    "Cone parameter 'radius_bottom' must be finite and >= 0.".to_string(),
                    Some(object_id.to_string()),
                    Some(path.to_string()),
                    &["realize_geometry", "build_mesh", "run_solver"],
                ));
            }
            if !r_top.is_some_and(|v| v.is_finite() && v >= 0.0) {
                diagnostics.push(error(
                    "GEOMETRY_PARAM_INVALID",
                    "Cone parameter 'radius_top' must be finite and >= 0.".to_string(),
                    Some(object_id.to_string()),
                    Some(path.to_string()),
                    &["realize_geometry", "build_mesh", "run_solver"],
                ));
            }
            if r_bottom.unwrap_or(0.0) <= 0.0 && r_top.unwrap_or(0.0) <= 0.0 {
                diagnostics.push(error(
                    "GEOMETRY_PARAM_INVALID",
                    "Cone requires at least one positive radius (radius_bottom or radius_top)."
                        .to_string(),
                    Some(object_id.to_string()),
                    Some(path.to_string()),
                    &["realize_geometry", "build_mesh", "run_solver"],
                ));
            }
            let height_key = if geometry.geometry_params.get("height").is_some() {
                "height"
            } else {
                "length"
            };
            validate_positive_number_param(
                &geometry.geometry_params,
                height_key,
                object_id,
                path,
                diagnostics,
            );
            validate_optional_nonzero_vec3_param(
                &geometry.geometry_params,
                "axis",
                object_id,
                path,
                diagnostics,
            );
        }
        "Torus" => {
            validate_positive_number_param(
                &geometry.geometry_params,
                "major_radius",
                object_id,
                path,
                diagnostics,
            );
            validate_positive_number_param(
                &geometry.geometry_params,
                "minor_radius",
                object_id,
                path,
                diagnostics,
            );
            if let (Some(major), Some(minor)) = (
                number_param(&geometry.geometry_params, "major_radius"),
                number_param(&geometry.geometry_params, "minor_radius"),
            ) {
                if major.is_finite() && minor.is_finite() && minor >= major {
                    diagnostics.push(error(
                        "GEOMETRY_PARAM_INVALID",
                        "Torus requires minor_radius < major_radius.".to_string(),
                        Some(object_id.to_string()),
                        Some(path.to_string()),
                        &["realize_geometry", "build_mesh", "run_solver"],
                    ));
                }
            }
            validate_optional_nonzero_vec3_param(
                &geometry.geometry_params,
                "axis",
                object_id,
                path,
                diagnostics,
            );
        }
        "PolygonPrism" => {
            validate_polygon_prism_params(
                &geometry.geometry_params,
                object_id,
                path,
                diagnostics,
            );
        }
        "Array3D" => {
            validate_array_3d_node(
                &geometry.geometry_params,
                backend_target,
                object_id,
                path,
                depth,
                diagnostics,
            );
        }
        other => diagnostics.push(error(
            "GEOMETRY_KIND_UNSUPPORTED",
            format!("Unsupported geometry kind '{other}'."),
            Some(object_id.to_string()),
            Some(path.to_string()),
            &["realize_geometry", "build_mesh", "run_solver"],
        )),
    }
    if let (Some(min), Some(max)) = (geometry.bounds_min, geometry.bounds_max) {
        if !finite_vec3(min) || !finite_vec3(max) || (0..3).any(|axis| max[axis] <= min[axis]) {
            diagnostics.push(warning(
                "GEOMETRY_BOUNDS_INVALID",
                "Stored geometry bounds are invalid; backend will derive bounds from parameters where possible.",
                Some(object_id.to_string()),
                Some(path.to_string()),
                &[],
            ));
        }
    }
}

fn validate_csg_operand_id(
    operand_id: &str,
    seen_ids: &mut std::collections::BTreeSet<String>,
    object_id: &str,
    path: &str,
    diagnostics: &mut Vec<GeometryDiagnostic>,
) {
    if operand_id.trim().is_empty() {
        diagnostics.push(error(
            "GEOMETRY_CSG_OPERAND_ID_INVALID",
            "Canonical CSG operand IDs must not be empty.",
            Some(object_id.to_string()),
            Some(path.to_string()),
            &["realize_geometry", "build_mesh", "run_solver"],
        ));
    } else if !seen_ids.insert(operand_id.to_string()) {
        diagnostics.push(error(
            "GEOMETRY_CSG_OPERAND_ID_DUPLICATE",
            format!("Canonical CSG operand ID '{operand_id}' is duplicated."),
            Some(object_id.to_string()),
            Some(path.to_string()),
            &["realize_geometry", "build_mesh", "run_solver"],
        ));
    }
}

fn validate_boolean_node(
    kind: &str,
    params: &Value,
    backend_target: &GeometryBackendTarget,
    object_id: &str,
    path: &str,
    depth: usize,
    diagnostics: &mut Vec<GeometryDiagnostic>,
) {
    if let Some(raw_operands) = params.get("operands").and_then(Value::as_array) {
        if raw_operands.is_empty() {
            diagnostics.push(error(
                "GEOMETRY_CSG_OPERANDS_EMPTY",
                format!("{kind} geometry must provide at least one operand."),
                Some(object_id.to_string()),
                Some(path.to_string()),
                &["realize_geometry", "build_mesh", "run_solver"],
            ));
            return;
        }
        if raw_operands.len() > MAX_CSG_OPERANDS {
            diagnostics.push(error(
                "GEOMETRY_CSG_OPERAND_LIMIT_EXCEEDED",
                format!(
                    "{kind} geometry exceeds maximum operand count ({MAX_CSG_OPERANDS})."
                ),
                Some(object_id.to_string()),
                Some(path.to_string()),
                &["realize_geometry", "build_mesh", "run_solver"],
            ));
            return;
        }
        let mut enabled_count = 0usize;
        let mut operand_ids = std::collections::BTreeSet::new();
        for (index, raw_operand) in raw_operands.iter().enumerate() {
            let op_path = format!("{path}/operands[{index}]");
            match serde_json::from_value::<crate::SceneBooleanOperand>(raw_operand.clone()) {
                Ok(operand) => {
                    validate_csg_operand_id(
                        &operand.operand_id,
                        &mut operand_ids,
                        object_id,
                        &op_path,
                        diagnostics,
                    );
                    if operand.enabled {
                        enabled_count += 1;
                    }
                    if let Some(transform) = operand.transform.as_ref() {
                        if !transform_is_valid(transform) {
                            diagnostics.push(error(
                                "GEOMETRY_TRANSFORM_INVALID",
                                format!("Operand '{}' has an invalid transform.", operand.operand_id),
                                Some(object_id.to_string()),
                                Some(format!("{op_path}/transform")),
                                &["realize_geometry", "build_mesh", "run_solver"],
                            ));
                        }
                    }
                    validate_geometry_node_depth(
                        &operand.geometry,
                        backend_target,
                        object_id,
                        &format!("{op_path}/geometry"),
                        depth + 1,
                        diagnostics,
                    );
                }
                Err(_) => {
                    // Also allow plain SceneGeometry entries inside operands for compatibility.
                    if let Some(geometry) = parse_geometry_value(raw_operand) {
                        enabled_count += 1;
                        validate_geometry_node_depth(
                            &geometry,
                            backend_target,
                            object_id,
                            &op_path,
                            depth + 1,
                            diagnostics,
                        );
                    } else {
                        diagnostics.push(error(
                            "GEOMETRY_CSG_OPERAND_INVALID",
                            format!("{kind} operand at index {index} is invalid."),
                            Some(object_id.to_string()),
                            Some(op_path),
                            &["realize_geometry", "build_mesh", "run_solver"],
                        ));
                    }
                }
            }
        }
        if enabled_count == 0 {
            diagnostics.push(error(
                "GEOMETRY_CSG_NO_ENABLED_OPERANDS",
                format!("{kind} geometry must have at least one enabled operand."),
                Some(object_id.to_string()),
                Some(path.to_string()),
                &["realize_geometry", "build_mesh", "run_solver"],
            ));
        }
        return;
    }

    // Legacy binary forms: Difference { base, tool }, Union/Intersection { a, b }, Xor { left, right }
    let (left_key, right_key) = match kind {
        "Difference" => ("base", "tool"),
        "Xor" => ("left", "right"),
        _ => ("a", "b"),
    };
    let left = params
        .get(left_key)
        .or_else(|| params.get("base"))
        .or_else(|| params.get("left"))
        .and_then(parse_geometry_value);
    let right = params
        .get(right_key)
        .or_else(|| params.get("tool"))
        .or_else(|| params.get("right"))
        .and_then(parse_geometry_value);
    match (left, right) {
        (Some(left), Some(right)) => {
            validate_geometry_node_depth(
                &left,
                backend_target,
                object_id,
                &format!("{path}/{left_key}"),
                depth + 1,
                diagnostics,
            );
            validate_geometry_node_depth(
                &right,
                backend_target,
                object_id,
                &format!("{path}/{right_key}"),
                depth + 1,
                diagnostics,
            );
        }
        _ => diagnostics.push(error(
            "GEOMETRY_CSG_DIFFERENCE_INVALID",
            format!("{kind} geometry must provide operands or '{left_key}' and '{right_key}' geometry nodes."),
            Some(object_id.to_string()),
            Some(path.to_string()),
            &["realize_geometry", "build_mesh", "run_solver"],
        )),
    }
}

fn validate_csg_node(
    params: &Value,
    backend_target: &GeometryBackendTarget,
    object_id: &str,
    path: &str,
    depth: usize,
    diagnostics: &mut Vec<GeometryDiagnostic>,
) {
    let op = params.get("op").and_then(Value::as_str).unwrap_or("");
    if !matches!(
        op,
        "union" | "subtract" | "difference" | "intersect" | "intersection" | "xor"
    ) {
        diagnostics.push(error(
            "GEOMETRY_CSG_OP_UNSUPPORTED",
            format!("CSG operation '{op}' is not supported."),
            Some(object_id.to_string()),
            Some(path.to_string()),
            &["realize_geometry", "build_mesh", "run_solver"],
        ));
    }
    let children = params
        .get("operands")
        .or_else(|| params.get("children"))
        .and_then(Value::as_array);
    let Some(children) = children else {
        diagnostics.push(error(
            "GEOMETRY_CSG_CHILDREN_INVALID",
            "CSG geometry requires at least two child geometry nodes.",
            Some(object_id.to_string()),
            Some(path.to_string()),
            &["realize_geometry", "build_mesh", "run_solver"],
        ));
        return;
    };
    if children.len() < 2 || children.len() > MAX_CSG_OPERANDS {
        diagnostics.push(error(
            "GEOMETRY_CSG_CHILDREN_INVALID",
            format!("CSG geometry requires between 2 and {MAX_CSG_OPERANDS} child geometry nodes."),
            Some(object_id.to_string()),
            Some(path.to_string()),
            &["realize_geometry", "build_mesh", "run_solver"],
        ));
        return;
    }
    let mut operand_ids = std::collections::BTreeSet::new();
    for (index, child_value) in children.iter().enumerate() {
        let child_path = format!("{path}/children[{index}]");
        if let Ok(operand) =
            serde_json::from_value::<crate::SceneBooleanOperand>(child_value.clone())
        {
            validate_csg_operand_id(
                &operand.operand_id,
                &mut operand_ids,
                object_id,
                &child_path,
                diagnostics,
            );
            validate_geometry_node_depth(
                &operand.geometry,
                backend_target,
                object_id,
                &child_path,
                depth + 1,
                diagnostics,
            );
        } else if let Some(child_geom) = parse_geometry_value(child_value) {
            validate_geometry_node_depth(
                &child_geom,
                backend_target,
                object_id,
                &child_path,
                depth + 1,
                diagnostics,
            );
        } else {
            diagnostics.push(error(
                "GEOMETRY_CSG_CHILDREN_INVALID",
                format!("CSG child at index {index} is invalid."),
                Some(object_id.to_string()),
                Some(child_path),
                &["realize_geometry", "build_mesh", "run_solver"],
            ));
        }
    }
}

fn validate_translate_node(
    params: &Value,
    backend_target: &GeometryBackendTarget,
    object_id: &str,
    path: &str,
    depth: usize,
    diagnostics: &mut Vec<GeometryDiagnostic>,
) {
    let offset = vec3_param(params, "offset").or_else(|| vec3_param(params, "by"));
    if !offset.is_some_and(finite_vec3) {
        diagnostics.push(error(
            "GEOMETRY_PARAM_INVALID",
            "Translate geometry requires finite 3-vector 'offset' (or 'by').".to_string(),
            Some(object_id.to_string()),
            Some(path.to_string()),
            &["realize_geometry", "build_mesh", "run_solver"],
        ));
    }
    let child = params
        .get("child")
        .or_else(|| params.get("base"))
        .and_then(parse_geometry_value);
    if let Some(child) = child {
        validate_geometry_node_depth(
            &child,
            backend_target,
            object_id,
            &format!("{path}/child"),
            depth + 1,
            diagnostics,
        );
    } else {
        diagnostics.push(error(
            "GEOMETRY_PARAM_INVALID",
            "Translate geometry requires a valid 'child' (or 'base') geometry node.".to_string(),
            Some(object_id.to_string()),
            Some(path.to_string()),
            &["realize_geometry", "build_mesh", "run_solver"],
        ));
    }
}

fn validate_transform_node(
    params: &Value,
    backend_target: &GeometryBackendTarget,
    object_id: &str,
    path: &str,
    depth: usize,
    diagnostics: &mut Vec<GeometryDiagnostic>,
) {
    let parsed_patch = params
        .get("transform")
        .and_then(|value| serde_json::from_value::<crate::Transform3DPatch>(value.clone()).ok())
        .or_else(|| serde_json::from_value::<crate::Transform3DPatch>(params.clone()).ok());
    let transform = parsed_patch.and_then(|patch| {
        let mut t = Transform3D::default();
        t.apply_patch(patch).ok()?;
        Some(t)
    });
    if !transform.as_ref().is_some_and(transform_is_valid) {
        diagnostics.push(error(
            "GEOMETRY_TRANSFORM_INVALID",
            "Transform geometry requires a valid Transform3D payload.".to_string(),
            Some(object_id.to_string()),
            Some(path.to_string()),
            &["realize_geometry", "build_mesh", "run_solver"],
        ));
    }
    let child = params
        .get("child")
        .or_else(|| params.get("base"))
        .and_then(parse_geometry_value);
    if let Some(child) = child {
        validate_geometry_node_depth(
            &child,
            backend_target,
            object_id,
            &format!("{path}/child"),
            depth + 1,
            diagnostics,
        );
    } else {
        diagnostics.push(error(
            "GEOMETRY_PARAM_INVALID",
            "Transform geometry requires a valid 'child' geometry node.".to_string(),
            Some(object_id.to_string()),
            Some(path.to_string()),
            &["realize_geometry", "build_mesh", "run_solver"],
        ));
    }
}

fn validate_slice_plane_node(
    params: &Value,
    backend_target: &GeometryBackendTarget,
    object_id: &str,
    path: &str,
    depth: usize,
    diagnostics: &mut Vec<GeometryDiagnostic>,
) {
    let origin =
        vec3_param(params, "plane_origin_m").or_else(|| vec3_param(params, "plane_origin"));
    if !origin.is_some_and(finite_vec3) {
        diagnostics.push(error(
            "GEOMETRY_PARAM_INVALID",
            "SlicePlane geometry requires finite 3-vector 'plane_origin_m'.".to_string(),
            Some(object_id.to_string()),
            Some(path.to_string()),
            &["realize_geometry", "build_mesh", "run_solver"],
        ));
    }
    let normal = vec3_param(params, "plane_normal");
    let normal_valid = normal.is_some_and(|n| {
        finite_vec3(n) && (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt() > 1e-12
    });
    if !normal_valid {
        diagnostics.push(error(
            "GEOMETRY_PARAM_INVALID",
            "SlicePlane geometry requires finite non-zero 3-vector 'plane_normal'.".to_string(),
            Some(object_id.to_string()),
            Some(path.to_string()),
            &["realize_geometry", "build_mesh", "run_solver"],
        ));
    }
    let keep_side = params
        .get("keep_side")
        .and_then(Value::as_str)
        .unwrap_or("positive");
    if !matches!(keep_side, "positive" | "negative") {
        diagnostics.push(error(
            "GEOMETRY_PARAM_INVALID",
            "SlicePlane 'keep_side' must be 'positive' or 'negative'.".to_string(),
            Some(object_id.to_string()),
            Some(path.to_string()),
            &["realize_geometry", "build_mesh", "run_solver"],
        ));
    }
    if let Some(child) = params
        .get("child")
        .or_else(|| params.get("base"))
        .and_then(parse_geometry_value)
    {
        validate_geometry_node_depth(
            &child,
            backend_target,
            object_id,
            &format!("{path}/child"),
            depth + 1,
            diagnostics,
        );
    } else {
        diagnostics.push(error(
            "GEOMETRY_PARAM_INVALID",
            "SlicePlane geometry requires a valid 'child' geometry node.".to_string(),
            Some(object_id.to_string()),
            Some(path.to_string()),
            &["realize_geometry", "build_mesh", "run_solver"],
        ));
    }
}

fn validate_array_3d_node(
    params: &Value,
    backend_target: &GeometryBackendTarget,
    object_id: &str,
    path: &str,
    depth: usize,
    diagnostics: &mut Vec<GeometryDiagnostic>,
) {
    let parsed_axes = params
        .get("axes")
        .and_then(|value| serde_json::from_value::<[crate::SceneArrayAxisSpec; 3]>(value.clone()).ok());
    match parsed_axes {
        Some(axes) => match crate::validate_and_order_array_axes(&axes) {
            Ok((_ordered, total_instances)) => {
                let budget = match backend_target {
                    GeometryBackendTarget::Fem => fullmag_ir::MAX_ARRAY_INSTANCES_FEM_OCC,
                    GeometryBackendTarget::Fdm => fullmag_ir::MAX_ARRAY_INSTANCES_FDM,
                };
                if total_instances > budget {
                    diagnostics.push(error(
                        "GEOMETRY_ARRAY3D_BUDGET_EXCEEDED",
                        format!(
                            "Array3D total instances ({total_instances}) exceeds {} backend limit ({budget}).",
                            backend_target.as_str().to_uppercase()
                        ),
                        Some(object_id.to_string()),
                        Some(path.to_string()),
                        &["realize_geometry", "build_mesh", "run_solver"],
                    ));
                }
            }
            Err(message) => {
                diagnostics.push(error(
                    "GEOMETRY_PARAM_INVALID",
                    message,
                    Some(object_id.to_string()),
                    Some(format!("{path}/axes")),
                    &["realize_geometry", "build_mesh", "run_solver"],
                ));
            }
        },
        None => {
            diagnostics.push(error(
                "GEOMETRY_PARAM_INVALID",
                "Array3D geometry requires an 'axes' array of 3 valid axis specifications (x, y, z)."
                    .to_string(),
                Some(object_id.to_string()),
                Some(format!("{path}/axes")),
                &["realize_geometry", "build_mesh", "run_solver"],
            ));
        }
    }

    if let Some(raw_ct) = params.get("child_transform") {
        if !raw_ct.is_null() {
            let valid = serde_json::from_value::<crate::Transform3DPatch>(raw_ct.clone())
                .ok()
                .and_then(|patch| {
                    let mut t = Transform3D::default();
                    t.apply_patch(patch).ok()?;
                    Some(t)
                })
                .as_ref()
                .is_some_and(transform_is_valid);
            if !valid {
                diagnostics.push(error(
                    "GEOMETRY_TRANSFORM_INVALID",
                    "Array3D 'child_transform' must be a valid Transform3D payload.".to_string(),
                    Some(object_id.to_string()),
                    Some(format!("{path}/child_transform")),
                    &["realize_geometry", "build_mesh", "run_solver"],
                ));
            }
        }
    }

    if let Some(child) = params
        .get("child")
        .or_else(|| params.get("base"))
        .and_then(parse_geometry_value)
    {
        validate_geometry_node_depth(
            &child,
            backend_target,
            object_id,
            &format!("{path}/child"),
            depth + 1,
            diagnostics,
        );
    } else {
        diagnostics.push(error(
            "GEOMETRY_PARAM_INVALID",
            "Array3D geometry requires a valid 'child' geometry node.".to_string(),
            Some(object_id.to_string()),
            Some(path.to_string()),
            &["realize_geometry", "build_mesh", "run_solver"],
        ));
    }
}

fn validate_polygon_prism_params(
    params: &Value,
    object_id: &str,
    path: &str,
    diagnostics: &mut Vec<GeometryDiagnostic>,
) {
    validate_positive_number_param(params, "thickness", object_id, path, diagnostics);
    let vertices = params
        .get("vertices_xy")
        .and_then(Value::as_array)
        .and_then(|arr| {
            arr.iter()
                .map(|item| {
                    let pair = item.as_array()?;
                    if pair.len() != 2 {
                        return None;
                    }
                    let x = pair[0].as_f64()?;
                    let y = pair[1].as_f64()?;
                    (x.is_finite() && y.is_finite()).then_some([x, y])
                })
                .collect::<Option<Vec<[f64; 2]>>>()
        });
    match vertices {
        Some(verts) if verts.len() >= 3 => {
            let mut doubled_area = 0.0;
            for i in 0..verts.len() {
                let a = verts[i];
                let b = verts[(i + 1) % verts.len()];
                doubled_area += a[0] * b[1] - b[0] * a[1];
            }
            if !doubled_area.is_finite() || doubled_area.abs() <= 1e-30 {
                diagnostics.push(error(
                    "GEOMETRY_PARAM_INVALID",
                    "PolygonPrism 'vertices_xy' must enclose non-zero area.".to_string(),
                    Some(object_id.to_string()),
                    Some(path.to_string()),
                    &["realize_geometry", "build_mesh", "run_solver"],
                ));
            }
        }
        _ => diagnostics.push(error(
            "GEOMETRY_PARAM_INVALID",
            "PolygonPrism requires 'vertices_xy' with at least 3 finite 2D points.".to_string(),
            Some(object_id.to_string()),
            Some(path.to_string()),
            &["realize_geometry", "build_mesh", "run_solver"],
        )),
    }
}

fn validate_positive_vec2_param(
    params: &Value,
    key: &str,
    object_id: &str,
    path: &str,
    diagnostics: &mut Vec<GeometryDiagnostic>,
) {
    let valid = params
        .get(key)
        .and_then(Value::as_array)
        .filter(|arr| arr.len() == 2)
        .and_then(|arr| Some([arr[0].as_f64()?, arr[1].as_f64()?]))
        .is_some_and(|v| v[0].is_finite() && v[0] > 0.0 && v[1].is_finite() && v[1] > 0.0);
    if !valid {
        diagnostics.push(error(
            "GEOMETRY_PARAM_INVALID",
            format!("Geometry parameter '{key}' must be a positive 2-vector."),
            Some(object_id.to_string()),
            Some(path.to_string()),
            &["realize_geometry", "build_mesh", "run_solver"],
        ));
    }
}

fn validate_optional_nonzero_vec3_param(
    params: &Value,
    key: &str,
    object_id: &str,
    path: &str,
    diagnostics: &mut Vec<GeometryDiagnostic>,
) {
    let Some(raw) = params.get(key) else {
        return;
    };
    if raw.is_null() {
        return;
    }
    let valid = vec3_param(params, key).is_some_and(|v| {
        finite_vec3(v) && (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt() > 1e-12
    });
    if !valid {
        diagnostics.push(error(
            "GEOMETRY_PARAM_INVALID",
            format!("Geometry parameter '{key}' must be a finite non-zero 3-vector."),
            Some(object_id.to_string()),
            Some(path.to_string()),
            &["realize_geometry", "build_mesh", "run_solver"],
        ));
    }
}

fn derive_object_bounds(object: &SceneObject) -> Option<([f64; 3], [f64; 3])> {
    let (local_min, local_max) = derive_geometry_bounds(&object.geometry)?;
    transform_bounds_by_transform3d(local_min, local_max, &object.transform)
}

fn transform_bounds_by_transform3d(
    local_min: [f64; 3],
    local_max: [f64; 3],
    transform: &Transform3D,
) -> Option<([f64; 3], [f64; 3])> {
    let scale = transform.scale;
    let pivot = transform.pivot;
    if !finite_vec3(scale)
        || !finite_vec3(pivot)
        || !finite_vec3(transform.translation)
        || !quat_is_valid(transform.rotation_quat)
    {
        return None;
    }
    let mut world_min = [f64::INFINITY; 3];
    let mut world_max = [f64::NEG_INFINITY; 3];
    for x in [local_min[0], local_max[0]] {
        for y in [local_min[1], local_max[1]] {
            for z in [local_min[2], local_max[2]] {
                let scaled = [
                    (x - pivot[0]) * scale[0],
                    (y - pivot[1]) * scale[1],
                    (z - pivot[2]) * scale[2],
                ];
                let rotated = rotate_point_by_quat(scaled, transform.rotation_quat);
                let world = [
                    rotated[0] + pivot[0] + transform.translation[0],
                    rotated[1] + pivot[1] + transform.translation[1],
                    rotated[2] + pivot[2] + transform.translation[2],
                ];
                world_min = min_vec3(world_min, world);
                world_max = max_vec3(world_max, world);
            }
        }
    }
    Some((world_min, world_max))
}

#[derive(Clone, Copy)]
struct MicrostripConnection {
    length_m: f64,
    width_m: f64,
    offset_v_m: f64,
}

struct MicrostripLayout {
    length_m: f64,
    thickness_m: f64,
    return_width_m: f64,
    return_offset_m: f64,
    stations: Vec<(f64, f64)>,
    connections: Option<[MicrostripConnection; 2]>,
    rotation: [[f64; 3]; 3],
    translation: [f64; 3],
}

fn parse_microstrip_layout(params: &Value) -> Result<MicrostripLayout, &'static str> {
    let positive = |key| match number_param(params, key) {
        Some(value) if value.is_finite() && value > 0.0 => Ok(value),
        _ => Err("length, thickness, conductivity and return width must be positive SI values"),
    };
    let length_m = positive("length_m")?;
    let thickness_m = positive("thickness_m")?;
    positive("conductivity_s_per_m")?;
    let return_width_m = positive("return_width_m")?;
    let return_offset_m = number_param(params, "return_offset_m")
        .ok_or("return_offset_m must be a non-negative SI value")?;
    if !return_offset_m.is_finite() || return_offset_m < 0.0 {
        return Err("return_offset_m must be a non-negative SI value");
    }

    let raw_stations = params
        .get("stations")
        .and_then(Value::as_array)
        .ok_or("stations must contain at least two ordered width stations")?;
    if raw_stations.len() < 2 {
        return Err("stations must contain at least two ordered width stations");
    }
    let mut stations = Vec::with_capacity(raw_stations.len());
    for station in raw_stations {
        let s = number_param(station, "s").ok_or("station s must be finite")?;
        let width = number_param(station, "signal_width_m")
            .ok_or("station signal_width_m must be positive")?;
        if !s.is_finite() || !(0.0..=1.0).contains(&s) {
            return Err("station s must lie in [0, 1]");
        }
        if !width.is_finite() || width <= 0.0 {
            return Err("station signal_width_m must be positive");
        }
        if stations.last().is_some_and(|(previous, _)| s <= *previous) {
            return Err("station positions must be strictly increasing");
        }
        stations.push((s, width));
    }
    if stations.first().map(|station| station.0) != Some(0.0)
        || stations.last().map(|station| station.0) != Some(1.0)
    {
        return Err("stations must start at s=0 and end at s=1");
    }

    let connections = if let Some(raw) = params.get("loop") {
        let fields = raw.as_object().ok_or("microstrip loop must be an object")?;
        if fields.keys().any(|key| !matches!(key.as_str(), "enabled"
            | "inlet_connection_length_m" | "inlet_connection_width_m" | "inlet_connection_offset_v_m"
            | "inlet_connection_part_id" | "inlet_connection_conductivity_s_per_m"
            | "outlet_connection_length_m" | "outlet_connection_width_m" | "outlet_connection_offset_v_m"
            | "outlet_connection_part_id" | "outlet_connection_conductivity_s_per_m")) {
            return Err("microstrip loop contains unsupported authored fields");
        }
        let enabled = match raw.get("enabled") {None => false, Some(Value::Bool(value)) => *value,
            _ => return Err("microstrip loop.enabled must be boolean")};
        if !enabled {
            if fields.iter().any(|(key,value)| key != "enabled" && !value.is_null()) {
                return Err("connection parameters require loop.enabled=true");
            }
            None
        } else {
            if return_offset_m <= 0.0 {return Err("closed_loop requires positive return_offset_m");}
            let conductor_id = |kind: &str| -> Result<String, &'static str> {
                match params.get("conductors").and_then(Value::as_array) {
                    Some(entries) if !entries.is_empty() => entries.iter()
                        .find(|entry| entry.get("kind").and_then(Value::as_str)==Some(kind))
                        .and_then(|entry| entry.get("id")).and_then(Value::as_str)
                        .filter(|id| !id.trim().is_empty()).map(str::to_string)
                        .ok_or("closed_loop requires explicit signal and return part IDs"),
                    _ => Ok(kind.to_string()),
                }
            };
            let mut ids = vec![conductor_id("signal")?, conductor_id("return")?];
            let mut connections = Vec::with_capacity(2);
            for (side, signal_width) in [("inlet",stations[0].1),("outlet",stations[stations.len()-1].1)] {
                let positive = |suffix: &str| -> Result<f64, &'static str> {
                    number_param(raw,&format!("{side}_connection_{suffix}"))
                        .filter(|value|value.is_finite() && *value>0.0)
                        .ok_or("closed_loop requires explicit positive connection dimensions and conductivity")
                };
                let length_m=positive("length_m")?;
                let width_m=positive("width_m")?;
                positive("conductivity_s_per_m")?;
                let offset_v_m=number_param(raw,&format!("{side}_connection_offset_v_m"))
                    .filter(|value|value.is_finite()).ok_or("closed_loop requires finite explicit connection offset")?;
                let id=raw.get(format!("{side}_connection_part_id")).and_then(Value::as_str)
                    .filter(|id|!id.trim().is_empty()).ok_or("closed_loop requires explicit connection part ID")?;
                ids.push(id.to_string());
                for target in [signal_width,return_width_m] {
                    if (offset_v_m+width_m/2.0).min(target/2.0) <= (offset_v_m-width_m/2.0).max(-target/2.0) {
                        return Err("connection must contact signal and return with positive area");
                    }
                }
                connections.push(MicrostripConnection {length_m,width_m,offset_v_m});
            }
            if ids.iter().collect::<std::collections::BTreeSet<_>>().len()!=4 {
                return Err("closed_loop part IDs must be distinct");
            }
            Some([connections[0],connections[1]])
        }
    } else {None};
    let (rotation, translation) = parse_antenna_layout_transform(params)?;
    Ok(MicrostripLayout {
        length_m,
        thickness_m,
        return_width_m,
        return_offset_m,
        stations,
        connections,
        rotation,
        translation,
    })
}

fn parse_antenna_layout_transform(
    params: &Value,
) -> Result<([[f64; 3]; 3], [f64; 3]), &'static str> {
    let transform = params.get("transform");
    if transform.is_some_and(|value| !value.is_object()) {
        return Err("transform must be a rigid transform object");
    }
    let rotation = if let Some(raw) = transform.and_then(|value| value.get("rotation_matrix")) {
        let rows = raw
            .as_array()
            .filter(|rows| rows.len() == 3)
            .ok_or("rotation_matrix must be a right-handed 3x3 rotation")?;
        let mut matrix = [[0.0; 3]; 3];
        for (row_index, row) in rows.iter().enumerate() {
            matrix[row_index] = vec3_from_value(row)
                .ok_or("rotation_matrix must be a right-handed 3x3 rotation")?;
        }
        if !valid_rotation_matrix(matrix) {
            return Err("rotation_matrix must be a right-handed 3x3 rotation");
        }
        matrix
    } else {
        [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]
    };
    let translation = if let Some(raw) = transform.and_then(|value| value.get("translation_m")) {
        vec3_from_value(raw).ok_or("translation_m must be a finite 3-vector")?
    } else {
        [0.0; 3]
    };
    Ok((rotation, translation))
}

struct CpwWidthStation {
    s: f64,
    signal_width_m: f64,
    left_gap_m: f64,
    right_gap_m: f64,
    left_ground_width_m: f64,
    right_ground_width_m: f64,
}

struct CpwLayout {
    length_m: f64,
    thickness_m: f64,
    stations: Vec<CpwWidthStation>,
    rotation: [[f64; 3]; 3],
    translation: [f64; 3],
}

fn parse_cpw_layout(params: &Value) -> Result<CpwLayout, &'static str> {
    let positive = |value: &Value, key| match number_param(value, key) {
        Some(number) if number.is_finite() && number > 0.0 => Ok(number),
        _ => Err("CPW dimensions, gaps, widths and conductivity must be positive SI values"),
    };
    let length_m = positive(params, "length_m")?;
    let thickness_m = positive(params, "thickness_m")?;
    positive(params, "conductivity_s_per_m")?;
    let raw = params.get("stations").and_then(Value::as_array)
        .filter(|stations| stations.len() >= 2)
        .ok_or("stations must contain at least two ordered width stations")?;
    let mut stations: Vec<CpwWidthStation> = Vec::with_capacity(raw.len());
    for station in raw {
        let s = number_param(station, "s").ok_or("station s must be finite")?;
        if !s.is_finite() || !(0.0..=1.0).contains(&s) {
            return Err("station s must lie in [0, 1]");
        }
        if stations.last().is_some_and(|previous| s <= previous.s) {
            return Err("station positions must be strictly increasing");
        }
        stations.push(CpwWidthStation {
            s,
            signal_width_m: positive(station, "signal_width_m")?,
            left_gap_m: positive(station, "left_gap_m")?,
            right_gap_m: positive(station, "right_gap_m")?,
            left_ground_width_m: positive(station, "left_ground_width_m")?,
            right_ground_width_m: positive(station, "right_ground_width_m")?,
        });
    }
    if stations.first().map(|station| station.s) != Some(0.0)
        || stations.last().map(|station| station.s) != Some(1.0)
    {
        return Err("stations must start at s=0 and end at s=1");
    }
    let (rotation, translation) = parse_antenna_layout_transform(params)?;
    Ok(CpwLayout { length_m, thickness_m, stations, rotation, translation })
}

fn cpw_layout_bounds(params: &Value) -> Option<([f64; 3], [f64; 3])> {
    let layout = parse_cpw_layout(params).ok()?;
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for station in layout.stations {
        let mut positions = vec![station.s * layout.length_m];
        if params.pointer("/loop/enabled").and_then(Value::as_bool) == Some(true) {
            let side = if station.s == 0.0 { Some("inlet") }
                else if station.s == 1.0 { Some("outlet") } else { None };
            if let Some(side) = side {
                let length = number_param(&params["loop"], &format!("{side}_connection_length_m"))
                    .filter(|value| value.is_finite() && *value > 0.0)?;
                // The crossbar reaches both outer ground edges at this endpoint.
                positions.push(if side == "inlet" { -length } else { layout.length_m + length });
            }
        }
        let half_signal = station.signal_width_m / 2.0;
        for (left, right) in [
            (-half_signal, half_signal),
            (-half_signal - station.left_gap_m - station.left_ground_width_m,
             -half_signal - station.left_gap_m),
            (half_signal + station.right_gap_m,
             half_signal + station.right_gap_m + station.right_ground_width_m),
        ] {
            for y in [left, right] {
                for z in [-layout.thickness_m / 2.0, layout.thickness_m / 2.0] {
                    for &u in &positions {
                        let local = [u, y, z];
                        for axis in 0..3 {
                            let world = (0..3)
                                .map(|component| layout.rotation[axis][component] * local[component])
                                .sum::<f64>() + layout.translation[axis];
                            min[axis] = min[axis].min(world);
                            max[axis] = max[axis].max(world);
                        }
                    }
                }
            }
        }
    }
    Some((min, max))
}

fn vec3_from_value(value: &Value) -> Option<[f64; 3]> {
    let values = value.as_array()?;
    if values.len() != 3 {
        return None;
    }
    let vector = [
        values[0].as_f64()?,
        values[1].as_f64()?,
        values[2].as_f64()?,
    ];
    finite_vec3(vector).then_some(vector)
}

fn valid_rotation_matrix(matrix: [[f64; 3]; 3]) -> bool {
    for left in 0..3 {
        for right in 0..3 {
            let dot = (0..3)
                .map(|row| matrix[row][left] * matrix[row][right])
                .sum::<f64>();
            if !dot.is_finite() || (dot - if left == right { 1.0 } else { 0.0 }).abs() > 1e-9 {
                return false;
            }
        }
    }
    let determinant = matrix[0][0] * (matrix[1][1] * matrix[2][2] - matrix[1][2] * matrix[2][1])
        - matrix[0][1] * (matrix[1][0] * matrix[2][2] - matrix[1][2] * matrix[2][0])
        + matrix[0][2] * (matrix[1][0] * matrix[2][1] - matrix[1][1] * matrix[2][0]);
    (determinant - 1.0).abs() <= 1e-9
}

fn microstrip_layout_bounds(params: &Value) -> Option<([f64; 3], [f64; 3])> {
    let layout = parse_microstrip_layout(params).ok()?;
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for (s, signal_width) in layout.stations {
        for (width, center_z) in [
            (signal_width, 0.0),
            (
                layout.return_width_m,
                -(layout.thickness_m + layout.return_offset_m),
            ),
        ] {
            for y in [-width / 2.0, width / 2.0] {
                for z in [
                    center_z - layout.thickness_m / 2.0,
                    center_z + layout.thickness_m / 2.0,
                ] {
                    let local = [s * layout.length_m, y, z];
                    for axis in 0..3 {
                        let world = (0..3)
                            .map(|component| layout.rotation[axis][component] * local[component])
                            .sum::<f64>()
                            + layout.translation[axis];
                        min[axis] = min[axis].min(world);
                        max[axis] = max[axis].max(world);
                    }
                }
            }
        }
    }
    if let Some(connections) = layout.connections {
        for (side, connection) in connections.iter().enumerate() {
            let ends = if side==0 {[-connection.length_m,0.0]} else {[layout.length_m,layout.length_m+connection.length_m]};
            for u in ends {
                for v in [connection.offset_v_m-connection.width_m/2.0,connection.offset_v_m+connection.width_m/2.0] {
                    for z in [-1.5*layout.thickness_m-layout.return_offset_m,layout.thickness_m/2.0] {
                        let local=[u,v,z];
                        for axis in 0..3 {
                            let world=(0..3).map(|component|layout.rotation[axis][component]*local[component])
                                .sum::<f64>()+layout.translation[axis];
                            min[axis]=min[axis].min(world);max[axis]=max[axis].max(world);
                        }
                    }
                }
            }
        }
    }
    Some((min, max))
}

struct MeanderLayout {
    length_m: f64,
    signal_width_m: f64,
    thickness_m: f64,
    finger_count: usize,
    pitch_m: f64,
    bend_radius_m: f64,
    rotation: [[f64; 3]; 3],
    translation: [f64; 3],
}

struct InductiveLoopLayout {
    loop_shape: String,
    inner_radius_m: f64,
    signal_width_m: f64,
    thickness_m: f64,
    turns: usize,
    pitch_m: f64,
    rotation: [[f64; 3]; 3],
    translation: [f64; 3],
}

struct PiecewisePath3DLayout {
    waypoints: Vec<([f64; 3], f64)>,
    thickness_m: f64,
    rotation: [[f64; 3]; 3],
    translation: [f64; 3],
}

fn parse_meander_layout(params: &Value) -> Result<MeanderLayout, &'static str> {
    let positive = |key| match number_param(params, key) {
        Some(value) if value.is_finite() && value > 0.0 => Ok(value),
        _ => Err("length_m, signal_width_m, thickness_m, pitch_m and conductivity_s_per_m must be positive SI values"),
    };
    let length_m = positive("length_m")?;
    let signal_width_m = positive("signal_width_m")?;
    let thickness_m = positive("thickness_m")?;
    positive("conductivity_s_per_m")?;
    let pitch_m = positive("pitch_m")?;
    let finger_count = params
        .get("finger_count")
        .and_then(Value::as_u64)
        .ok_or("finger_count must be an integer in [2, 64]")?;
    if !(2..=64).contains(&finger_count) {
        return Err("finger_count must be an integer in [2, 64]");
    }
    let bend_radius_m = match params.get("bend_radius_m") {
        None | Some(Value::Null) => 0.0,
        Some(_) => number_param(params, "bend_radius_m")
            .filter(|value| value.is_finite() && *value >= 0.0)
            .ok_or("bend_radius_m must be a non-negative finite SI value")?,
    };
    if pitch_m <= signal_width_m {
        return Err("pitch_m must be strictly greater than signal_width_m");
    }
    if 2.0 * bend_radius_m + signal_width_m > pitch_m + 1.0e-15 {
        return Err("meander bend_radius_m causes self-intersection: require 2 * bend_radius_m + signal_width_m <= pitch_m");
    }
    let (rotation, translation) = parse_antenna_layout_transform(params)?;
    Ok(MeanderLayout {
        length_m,
        signal_width_m,
        thickness_m,
        finger_count: finger_count as usize,
        pitch_m,
        bend_radius_m,
        rotation,
        translation,
    })
}

fn parse_inductive_loop_layout(params: &Value) -> Result<InductiveLoopLayout, &'static str> {
    let loop_shape = params
        .get("loop_shape")
        .and_then(Value::as_str)
        .unwrap_or("circular");
    if !matches!(loop_shape, "circular" | "rectangular" | "omega") {
        return Err("loop_shape must be 'circular', 'rectangular', or 'omega'");
    }
    let positive = |key| match number_param(params, key) {
        Some(value) if value.is_finite() && value > 0.0 => Ok(value),
        _ => Err("inner_radius_m, signal_width_m, thickness_m and conductivity_s_per_m must be positive SI values"),
    };
    let inner_radius_m = positive("inner_radius_m")?;
    let signal_width_m = positive("signal_width_m")?;
    let thickness_m = positive("thickness_m")?;
    positive("conductivity_s_per_m")?;
    let turns = match params.get("turns") {
        None | Some(Value::Null) => 1u64,
        Some(v) => v.as_u64().ok_or("turns must be an integer in [1, 16]")?,
    };
    if !(1..=16).contains(&turns) {
        return Err("turns must be an integer in [1, 16]");
    }
    let bend_radius_m = match params.get("bend_radius_m") {
        None | Some(Value::Null) => 0.0,
        Some(_) => number_param(params, "bend_radius_m")
            .filter(|value| value.is_finite() && *value >= 0.0)
            .ok_or("bend_radius_m must be a non-negative finite SI value")?,
    };
    if loop_shape == "rectangular" && bend_radius_m > inner_radius_m + 1.0e-15 {
        return Err("bend_radius_m must not exceed inner_radius_m for rectangular loops");
    }
    if let Some(raw_gap) = params.get("feed_gap_m").filter(|v| !v.is_null()) {
        let gap = raw_gap
            .as_f64()
            .filter(|v| v.is_finite() && *v > 0.0)
            .ok_or("feed_gap_m must be positive when specified")?;
        if gap >= 2.0 * inner_radius_m {
            return Err("feed_gap_m must be strictly smaller than 2 * inner_radius_m");
        }
    }
    let pitch_m = match params.get("pitch_m") {
        None | Some(Value::Null) => 2.0 * signal_width_m,
        Some(_) => {
            let p = number_param(params, "pitch_m")
                .filter(|value| value.is_finite() && *value > 0.0)
                .ok_or("pitch_m must be a positive finite SI value")?;
            if turns > 1 && p <= signal_width_m {
                return Err("pitch_m must exceed signal_width_m for multi-turn loops");
            }
            p
        }
    };
    let (rotation, translation) = parse_antenna_layout_transform(params)?;
    Ok(InductiveLoopLayout {
        loop_shape: loop_shape.to_string(),
        inner_radius_m,
        signal_width_m,
        thickness_m,
        turns: turns as usize,
        pitch_m,
        rotation,
        translation,
    })
}

fn parse_piecewise_path_3d_layout(params: &Value) -> Result<PiecewisePath3DLayout, &'static str> {
    let positive = |key| match number_param(params, key) {
        Some(value) if value.is_finite() && value > 0.0 => Ok(value),
        _ => Err("signal_width_m, thickness_m and conductivity_s_per_m must be positive SI values"),
    };
    let default_width = positive("signal_width_m")?;
    let thickness_m = positive("thickness_m")?;
    positive("conductivity_s_per_m")?;
    let raw_waypoints = params
        .get("waypoints")
        .and_then(Value::as_array)
        .ok_or("waypoints must contain at least two distinct 3D points")?;
    if raw_waypoints.len() < 2 {
        return Err("waypoints must contain at least two distinct 3D points");
    }
    let mut waypoints: Vec<([f64; 3], f64)> = Vec::with_capacity(raw_waypoints.len());
    for raw in raw_waypoints {
        let (pt, width, bend) = if let Some(obj) = raw.as_object() {
            let x = obj
                .get("x_m")
                .or_else(|| obj.get("x"))
                .and_then(Value::as_f64)
                .ok_or("waypoint x_m must be finite")?;
            let y = obj
                .get("y_m")
                .or_else(|| obj.get("y"))
                .and_then(Value::as_f64)
                .ok_or("waypoint y_m must be finite")?;
            let z = obj
                .get("z_m")
                .or_else(|| obj.get("z"))
                .and_then(Value::as_f64)
                .ok_or("waypoint z_m must be finite")?;
            let w = match obj.get("width_m") {
                None | Some(Value::Null) => default_width,
                Some(val) => val
                    .as_f64()
                    .filter(|v| v.is_finite() && *v > 0.0)
                    .ok_or("waypoint width_m must be positive")?,
            };
            let b = match obj.get("bend_radius_m") {
                None | Some(Value::Null) => 0.0,
                Some(val) => val
                    .as_f64()
                    .filter(|v| v.is_finite() && *v >= 0.0)
                    .ok_or("waypoint bend_radius_m must be non-negative")?,
            };
            ([x, y, z], w, b)
        } else if let Some(arr) = raw.as_array() {
            if arr.len() != 3 {
                return Err("waypoint array must have 3 coordinates");
            }
            let x = arr[0].as_f64().ok_or("waypoint x must be finite")?;
            let y = arr[1].as_f64().ok_or("waypoint y must be finite")?;
            let z = arr[2].as_f64().ok_or("waypoint z must be finite")?;
            ([x, y, z], default_width, 0.0)
        } else {
            return Err("waypoint must be an object or 3-element coordinate array");
        };
        if !finite_vec3(pt) || !bend.is_finite() {
            return Err("waypoint coordinates must be finite");
        }
        if let Some((prev, _)) = waypoints.last() {
            let dx = pt[0] - prev[0];
            let dy = pt[1] - prev[1];
            let dz = pt[2] - prev[2];
            if (dx * dx + dy * dy + dz * dz).sqrt() <= 1.0e-12 {
                return Err("consecutive waypoints must be distinct");
            }
        }
        waypoints.push((pt, width));
    }
    let (rotation, translation) = parse_antenna_layout_transform(params)?;
    Ok(PiecewisePath3DLayout {
        waypoints,
        thickness_m,
        rotation,
        translation,
    })
}

fn transform_bounds_corners(
    local_min: [f64; 3],
    local_max: [f64; 3],
    rotation: [[f64; 3]; 3],
    translation: [f64; 3],
) -> ([f64; 3], [f64; 3]) {
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for &x in &[local_min[0], local_max[0]] {
        for &y in &[local_min[1], local_max[1]] {
            for &z in &[local_min[2], local_max[2]] {
                let local = [x, y, z];
                for axis in 0..3 {
                    let world = (0..3)
                        .map(|component| rotation[axis][component] * local[component])
                        .sum::<f64>()
                        + translation[axis];
                    min[axis] = min[axis].min(world);
                    max[axis] = max[axis].max(world);
                }
            }
        }
    }
    (min, max)
}

fn meander_layout_bounds(params: &Value) -> Option<([f64; 3], [f64; 3])> {
    let layout = parse_meander_layout(params).ok()?;
    let half_u = 0.5 * layout.length_m + layout.bend_radius_m + 0.5 * layout.signal_width_m;
    let half_v = 0.5 * ((layout.finger_count - 1) as f64) * layout.pitch_m + 0.5 * layout.signal_width_m;
    let half_w = 0.5 * layout.thickness_m;
    Some(transform_bounds_corners(
        [-half_u, -half_v, -half_w],
        [half_u, half_v, half_w],
        layout.rotation,
        layout.translation,
    ))
}

fn inductive_loop_layout_bounds(params: &Value) -> Option<([f64; 3], [f64; 3])> {
    let layout = parse_inductive_loop_layout(params).ok()?;
    let outer = layout.inner_radius_m
        + ((layout.turns - 1) as f64) * layout.pitch_m
        + layout.signal_width_m;
    let extra_u_min = if layout.loop_shape == "omega" {
        outer + layout.inner_radius_m
    } else {
        outer
    };
    let half_w = 0.5 * layout.thickness_m;
    Some(transform_bounds_corners(
        [-extra_u_min, -outer, -half_w],
        [outer, outer, half_w],
        layout.rotation,
        layout.translation,
    ))
}

fn piecewise_path_3d_layout_bounds(params: &Value) -> Option<([f64; 3], [f64; 3])> {
    let layout = parse_piecewise_path_3d_layout(params).ok()?;
    let mut local_min = [f64::INFINITY; 3];
    let mut local_max = [f64::NEG_INFINITY; 3];
    let half_t = 0.5 * layout.thickness_m;
    for (pt, width) in layout.waypoints {
        let pad = (0.5 * width).max(half_t);
        for axis in 0..3 {
            local_min[axis] = local_min[axis].min(pt[axis] - pad);
            local_max[axis] = local_max[axis].max(pt[axis] + pad);
        }
    }
    Some(transform_bounds_corners(
        local_min,
        local_max,
        layout.rotation,
        layout.translation,
    ))
}

pub fn derive_scene_geometry_bounds(geometry: &SceneGeometry) -> Option<([f64; 3], [f64; 3])> {
    derive_geometry_bounds(geometry)
}

fn derive_geometry_bounds(geometry: &SceneGeometry) -> Option<([f64; 3], [f64; 3])> {
    match geometry.geometry_kind.as_str() {
        "MicrostripAntennaLayout" => microstrip_layout_bounds(&geometry.geometry_params),
        "CPWAntennaLayout" => cpw_layout_bounds(&geometry.geometry_params),
        "MeanderAntennaLayout" => meander_layout_bounds(&geometry.geometry_params),
        "InductiveLoopLayout" => inductive_loop_layout_bounds(&geometry.geometry_params),
        "PiecewisePath3DLayout" => piecewise_path_3d_layout_bounds(&geometry.geometry_params),
        "Box" => {
            let size = vec3_param(&geometry.geometry_params, "size")
                .or_else(|| vec3_param(&geometry.geometry_params, "dimensions"))?;
            if !positive_vec3(size) {
                return None;
            }
            Some((
                [-size[0] / 2.0, -size[1] / 2.0, -size[2] / 2.0],
                [size[0] / 2.0, size[1] / 2.0, size[2] / 2.0],
            ))
        }
        "Cylinder" => {
            let radius = number_param(&geometry.geometry_params, "radius")?;
            let height = number_param(&geometry.geometry_params, "height")?;
            if !(radius.is_finite() && radius > 0.0 && height.is_finite() && height > 0.0) {
                return None;
            }
            let axis = match geometry.geometry_params.get("axis") {
                Some(_) => vec3_param(&geometry.geometry_params, "axis")?,
                None => [0.0, 0.0, 1.0],
            };
            if !finite_vec3(axis) {
                return None;
            }
            let axis_scale = axis.iter().map(|component| component.abs()).fold(0.0, f64::max);
            if axis_scale <= 0.0 {
                return None;
            }
            let scaled_axis = axis.map(|component| component / axis_scale);
            let scaled_norm = scaled_axis[0].hypot(scaled_axis[1]).hypot(scaled_axis[2]);
            if !scaled_norm.is_finite() || scaled_norm <= 0.0 {
                return None;
            }
            let unit_axis = scaled_axis.map(|component| component / scaled_norm);
            let half_height = height / 2.0;
            let extent = std::array::from_fn(|index| {
                let axial_component = unit_axis[index].abs();
                let radial_component = (1.0 - unit_axis[index] * unit_axis[index])
                    .max(0.0)
                    .sqrt();
                radius * radial_component + half_height * axial_component
            });
            if !finite_vec3(extent) {
                return None;
            }
            Some((extent.map(|value| -value), extent))
        }
        "ArchWaveguide" => {
            let length = number_param(&geometry.geometry_params, "length")?;
            let width = number_param(&geometry.geometry_params, "width")?;
            let height = number_param(&geometry.geometry_params, "height")?;
            let arch_height = number_param(&geometry.geometry_params, "arch_height")?;
            let z0 = number_param(&geometry.geometry_params, "z0").unwrap_or(0.0);
            if !(length.is_finite()
                && length > 0.0
                && width.is_finite()
                && width > 0.0
                && height.is_finite()
                && height > 0.0
                && arch_height.is_finite()
                && z0.is_finite())
            {
                return None;
            }
            let half_length = 0.5 * length;
            let half_width = 0.5 * width;
            let half_height = 0.5 * height;
            let z_min = z0.min(z0 + arch_height) - half_height;
            let z_max = z0.max(z0 + arch_height) + half_height;
            Some((
                [-half_length, -half_width, z_min],
                [half_length, half_width, z_max],
            ))
        }
        "Sphere" => {
            let radius = number_param(&geometry.geometry_params, "radius")?;
            if !radius.is_finite() || radius <= 0.0 {
                return None;
            }
            Some(([-radius; 3], [radius; 3]))
        }
        "Ellipsoid" => {
            let [rx, ry, rz] = match vec3_param(&geometry.geometry_params, "radii") {
                Some(radii) => radii,
                None => [
                    number_param(&geometry.geometry_params, "rx")?,
                    number_param(&geometry.geometry_params, "ry")?,
                    number_param(&geometry.geometry_params, "rz")?,
                ],
            };
            if [rx, ry, rz]
                .iter()
                .any(|value| !value.is_finite() || *value <= 0.0)
            {
                return None;
            }
            Some(([-rx, -ry, -rz], [rx, ry, rz]))
        }
        "Ellipse" => {
            let [rx, ry] = if let Some(arr) = geometry
                .geometry_params
                .get("radii")
                .and_then(Value::as_array)
                .filter(|arr| arr.len() == 2)
            {
                [arr[0].as_f64()?, arr[1].as_f64()?]
            } else {
                [
                    number_param(&geometry.geometry_params, "rx")?,
                    number_param(&geometry.geometry_params, "ry")?,
                ]
            };
            let height = number_param(&geometry.geometry_params, "height")?;
            if !(rx.is_finite() && rx > 0.0 && ry.is_finite() && ry > 0.0 && height.is_finite() && height > 0.0) {
                return None;
            }
            Some(([-rx, -ry, -height * 0.5], [rx, ry, height * 0.5]))
        }
        "Cone" => {
            let r0 = number_param(&geometry.geometry_params, "radius_bottom")?;
            let r1 = number_param(&geometry.geometry_params, "radius_top")?;
            let height = number_param(&geometry.geometry_params, "height")
                .or_else(|| number_param(&geometry.geometry_params, "length"))?;
            if !(r0.is_finite() && r0 >= 0.0 && r1.is_finite() && r1 >= 0.0 && (r0 > 0.0 || r1 > 0.0) && height.is_finite() && height > 0.0) {
                return None;
            }
            let axis = vec3_param(&geometry.geometry_params, "axis").unwrap_or([0.0, 0.0, 1.0]);
            let norm = (axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]).sqrt();
            if !finite_vec3(axis) || !norm.is_finite() || norm <= 1e-12 {
                return None;
            }
            let u = [axis[0] / norm, axis[1] / norm, axis[2] / norm];
            let half_h = height * 0.5;
            let mut bmin = [0.0; 3];
            let mut bmax = [0.0; 3];
            for i in 0..3 {
                let radial = (1.0 - u[i] * u[i]).max(0.0).sqrt();
                bmin[i] = (half_h * u[i] - r1 * radial).min(-half_h * u[i] - r0 * radial);
                bmax[i] = (half_h * u[i] + r1 * radial).max(-half_h * u[i] + r0 * radial);
            }
            Some((bmin, bmax))
        }
        "Torus" => {
            let major = number_param(&geometry.geometry_params, "major_radius")?;
            let minor = number_param(&geometry.geometry_params, "minor_radius")?;
            if !(major.is_finite() && major > 0.0 && minor.is_finite() && minor > 0.0 && minor < major) {
                return None;
            }
            let axis = vec3_param(&geometry.geometry_params, "axis").unwrap_or([0.0, 0.0, 1.0]);
            let norm = (axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]).sqrt();
            if !finite_vec3(axis) || !norm.is_finite() || norm <= 1e-12 {
                return None;
            }
            let u = [axis[0] / norm, axis[1] / norm, axis[2] / norm];
            let ext = [0, 1, 2].map(|i| major * (1.0 - u[i] * u[i]).max(0.0).sqrt() + minor);
            Some(([-ext[0], -ext[1], -ext[2]], ext))
        }
        "PolygonPrism" => {
            let thickness = number_param(&geometry.geometry_params, "thickness")?;
            if !thickness.is_finite() || thickness <= 0.0 {
                return None;
            }
            let verts = geometry.geometry_params.get("vertices_xy")?.as_array()?;
            if verts.len() < 3 {
                return None;
            }
            let mut min_x = f64::INFINITY;
            let mut max_x = f64::NEG_INFINITY;
            let mut min_y = f64::INFINITY;
            let mut max_y = f64::NEG_INFINITY;
            for item in verts {
                let pair = item.as_array()?;
                let x = pair.first()?.as_f64()?;
                let y = pair.get(1)?.as_f64()?;
                if !x.is_finite() || !y.is_finite() {
                    return None;
                }
                min_x = min_x.min(x);
                max_x = max_x.max(x);
                min_y = min_y.min(y);
                max_y = max_y.max(y);
            }
            Some(([min_x, min_y, -thickness * 0.5], [max_x, max_y, thickness * 0.5]))
        }
        "SinWaveguide" => {
            let length = number_param(&geometry.geometry_params, "length")?;
            let width = number_param(&geometry.geometry_params, "width")?;
            let height = number_param(&geometry.geometry_params, "height")?;
            let amplitude = number_param(&geometry.geometry_params, "amplitude")?;
            let z0 = number_param(&geometry.geometry_params, "z0").unwrap_or(0.0);
            if !(length.is_finite() && length > 0.0 && width.is_finite() && width > 0.0 && height.is_finite() && height > 0.0 && amplitude.is_finite() && z0.is_finite()) {
                return None;
            }
            let zm = amplitude.abs() + 0.5 * height;
            Some(([-0.5 * length, -0.5 * width, z0 - zm], [0.5 * length, 0.5 * width, z0 + zm]))
        }
        "Translate" => {
            let offset = vec3_param(&geometry.geometry_params, "offset")
                .or_else(|| vec3_param(&geometry.geometry_params, "by"))?;
            let child = geometry
                .geometry_params
                .get("child")
                .or_else(|| geometry.geometry_params.get("base"))
                .and_then(parse_geometry_value)?;
            let (cmin, cmax) = derive_geometry_bounds(&child)?;
            Some((
                [cmin[0] + offset[0], cmin[1] + offset[1], cmin[2] + offset[2]],
                [cmax[0] + offset[0], cmax[1] + offset[1], cmax[2] + offset[2]],
            ))
        }
        "Transform" => {
            let patch = geometry
                .geometry_params
                .get("transform")
                .and_then(|v| serde_json::from_value::<crate::Transform3DPatch>(v.clone()).ok())
                .or_else(|| {
                    serde_json::from_value::<crate::Transform3DPatch>(geometry.geometry_params.clone()).ok()
                })?;
            let mut transform = Transform3D::default();
            transform.apply_patch(patch).ok()?;
            let child = geometry
                .geometry_params
                .get("child")
                .or_else(|| geometry.geometry_params.get("base"))
                .and_then(parse_geometry_value)?;
            let (cmin, cmax) = derive_geometry_bounds(&child)?;
            transform_bounds_by_transform3d(cmin, cmax, &transform)
        }
        "SlicePlane" => {
            let child = geometry
                .geometry_params
                .get("child")
                .or_else(|| geometry.geometry_params.get("base"))
                .and_then(parse_geometry_value)?;
            derive_geometry_bounds(&child)
        }
        "Array3D" => {
            let child = geometry
                .geometry_params
                .get("child")
                .or_else(|| geometry.geometry_params.get("base"))
                .and_then(parse_geometry_value)?;
            let (mut cmin, mut cmax) = derive_geometry_bounds(&child)?;
            if let Some(raw_ct) = geometry
                .geometry_params
                .get("child_transform")
                .filter(|v| !v.is_null())
            {
                let patch = serde_json::from_value::<crate::Transform3DPatch>(raw_ct.clone()).ok()?;
                let mut t = Transform3D::default();
                t.apply_patch(patch).ok()?;
                (cmin, cmax) = transform_bounds_by_transform3d(cmin, cmax, &t)?;
            }
            let raw_axes = geometry.geometry_params.get("axes")?;
            let axes = serde_json::from_value::<[crate::SceneArrayAxisSpec; 3]>(raw_axes.clone()).ok()?;
            let (ordered, total) = crate::validate_and_order_array_axes(&axes).ok()?;
            if total > fullmag_ir::MAX_ARRAY_INSTANCES_FDM {
                return None;
            }
            let extent = [cmax[0] - cmin[0], cmax[1] - cmin[1], cmax[2] - cmin[2]];
            let mut step_vectors = [[0.0; 3]; 3];
            let mut k_ranges = [(0.0, 0.0); 3];
            let mut has_rot_or_scale = false;
            for a in 0..3 {
                let ax = &ordered[a];
                let delta = match ax.spacing_mode {
                    crate::SceneArraySpacingMode::LatticeStep => ax.pitch_m,
                    crate::SceneArraySpacingMode::BoundingBoxGap => {
                        ax.relative_factor * extent[a] + ax.gap_m
                    }
                };
                let mut v = ax.step_translation_extra_m;
                v[a] += delta;
                step_vectors[a] = v;
                let n = ax.effective_count();
                if n > 1 {
                    let span = (n - 1) as f64;
                    k_ranges[a] = match ax.direction {
                        crate::SceneArrayDirection::Positive => (0.0, span),
                        crate::SceneArrayDirection::Negative => (-span, 0.0),
                        crate::SceneArrayDirection::Symmetric => (-0.5 * span, 0.5 * span),
                    };
                    if ax.step_rotation_euler_deg.iter().any(|r| r.abs() > 1e-12)
                        || ax.step_scale_factor.iter().any(|s| (*s - 1.0).abs() > 1e-12)
                    {
                        has_rot_or_scale = true;
                    }
                }
            }
            if !has_rot_or_scale {
                let mut tmin = [0.0; 3];
                let mut tmax = [0.0; 3];
                for a in 0..3 {
                    let (klo, khi) = k_ranges[a];
                    for j in 0..3 {
                        let plo = klo * step_vectors[a][j];
                        let phi = khi * step_vectors[a][j];
                        tmin[j] += plo.min(phi);
                        tmax[j] += plo.max(phi);
                    }
                }
                return Some((
                    [cmin[0] + tmin[0], cmin[1] + tmin[1], cmin[2] + tmin[2]],
                    [cmax[0] + tmax[0], cmax[1] + tmax[1], cmax[2] + tmax[2]],
                ));
            }
            let mut out_min = [f64::INFINITY; 3];
            let mut out_max = [f64::NEG_INFINITY; 3];
            let idx_x = ordered[0].canonical_indices();
            let idx_y = ordered[1].canonical_indices();
            let idx_z = ordered[2].canonical_indices();
            for &kx in &idx_x {
                for &ky in &idx_y {
                    for &kz in &idx_z {
                        let ks = [kx, ky, kz];
                        let mut trans = [0.0; 3];
                        let mut rot_deg = [0.0; 3];
                        let mut scale = [1.0; 3];
                        for a in 0..3 {
                            let k = ks[a];
                            if k == 0.0 {
                                continue;
                            }
                            for j in 0..3 {
                                trans[j] += k * step_vectors[a][j];
                                rot_deg[j] += k * ordered[a].step_rotation_euler_deg[j];
                                let sf = ordered[a].step_scale_factor[j];
                                if (sf - 1.0).abs() > 1e-15 {
                                    scale[j] *= sf.powf(k);
                                }
                            }
                        }
                        let inst_transform = Transform3D {
                            translation: trans,
                            rotation_quat: crate::euler_xyz_deg_to_quat(rot_deg),
                            scale,
                            pivot: [0.0, 0.0, 0.0],
                        };
                        let (imin, imax) =
                            transform_bounds_by_transform3d(cmin, cmax, &inst_transform)?;
                        out_min = min_vec3(out_min, imin);
                        out_max = max_vec3(out_max, imax);
                    }
                }
            }
            Some((out_min, out_max))
        }
        "Difference" => {
            if let Some(operands) = geometry
                .geometry_params
                .get("operands")
                .and_then(Value::as_array)
            {
                let first = operands.iter().find_map(|raw| {
                    if let Ok(op) = serde_json::from_value::<crate::SceneBooleanOperand>(raw.clone()) {
                        if !op.enabled {
                            return None;
                        }
                        let (bmin, bmax) = derive_geometry_bounds(&op.geometry)?;
                        return match op.transform.as_ref() {
                            Some(t) => transform_bounds_by_transform3d(bmin, bmax, t),
                            None => Some((bmin, bmax)),
                        };
                    }
                    parse_geometry_value(raw).and_then(|g| derive_geometry_bounds(&g))
                });
                return first;
            }
            let base = geometry
                .geometry_params
                .get("base")
                .and_then(parse_geometry_value)?;
            derive_geometry_bounds(&base)
        }
        "Union" | "Xor" | "Intersection" | "Csg" => {
            let op_kind = if geometry.geometry_kind == "Csg" {
                match geometry.geometry_params.get("op").and_then(Value::as_str).unwrap_or("") {
                    "subtract" | "difference" => "Difference",
                    "intersect" | "intersection" => "Intersection",
                    _ => "Union",
                }
            } else {
                geometry.geometry_kind.as_str()
            };
            let mut child_bounds = Vec::new();
            if let Some(operands) = geometry
                .geometry_params
                .get("operands")
                .or_else(|| geometry.geometry_params.get("children"))
                .and_then(Value::as_array)
            {
                for raw in operands {
                    if let Ok(op) = serde_json::from_value::<crate::SceneBooleanOperand>(raw.clone()) {
                        if !op.enabled {
                            continue;
                        }
                        if let Some((bmin, bmax)) = derive_geometry_bounds(&op.geometry) {
                            let transformed = match op.transform.as_ref() {
                                Some(t) => transform_bounds_by_transform3d(bmin, bmax, t),
                                None => Some((bmin, bmax)),
                            };
                            if let Some(bounds) = transformed {
                                child_bounds.push(bounds);
                            }
                        }
                    } else if let Some(g) = parse_geometry_value(raw) {
                        if let Some(bounds) = derive_geometry_bounds(&g) {
                            child_bounds.push(bounds);
                        }
                    }
                }
            } else {
                for key in ["base", "a", "left", "tool", "b", "right"] {
                    if let Some(g) = geometry.geometry_params.get(key).and_then(parse_geometry_value) {
                        if let Some(bounds) = derive_geometry_bounds(&g) {
                            child_bounds.push(bounds);
                        }
                    }
                }
            }
            if child_bounds.is_empty() {
                return geometry.bounds_min.zip(geometry.bounds_max);
            }
            match op_kind {
                "Difference" => Some(child_bounds[0]),
                "Intersection" => {
                    let mut acc_min = child_bounds[0].0;
                    let mut acc_max = child_bounds[0].1;
                    for (bmin, bmax) in child_bounds.into_iter().skip(1) {
                        acc_min = max_vec3(acc_min, bmin);
                        acc_max = min_vec3(acc_max, bmax);
                    }
                    if (0..3).any(|i| acc_max[i] < acc_min[i]) {
                        None
                    } else {
                        Some((acc_min, acc_max))
                    }
                }
                _ => {
                    let mut acc_min = child_bounds[0].0;
                    let mut acc_max = child_bounds[0].1;
                    for (bmin, bmax) in child_bounds.into_iter().skip(1) {
                        acc_min = min_vec3(acc_min, bmin);
                        acc_max = max_vec3(acc_max, bmax);
                    }
                    Some((acc_min, acc_max))
                }
            }
        }
        _ => geometry.bounds_min.zip(geometry.bounds_max),
    }
}

fn parse_geometry_value(value: &Value) -> Option<SceneGeometry> {
    serde_json::from_value(value.clone()).ok()
}

fn validate_positive_vec3_param(
    params: &Value,
    key: &str,
    object_id: &str,
    path: &str,
    diagnostics: &mut Vec<GeometryDiagnostic>,
) {
    match vec3_param(params, key) {
        Some(value) if positive_vec3(value) => {}
        _ => diagnostics.push(error(
            "GEOMETRY_PARAM_INVALID",
            format!("Geometry parameter '{key}' must be a positive 3-vector."),
            Some(object_id.to_string()),
            Some(path.to_string()),
            &["realize_geometry", "build_mesh", "run_solver"],
        )),
    }
}

fn validate_positive_number_param(
    params: &Value,
    key: &str,
    object_id: &str,
    path: &str,
    diagnostics: &mut Vec<GeometryDiagnostic>,
) {
    match number_param(params, key) {
        Some(value) if value.is_finite() && value > 0.0 => {}
        _ => diagnostics.push(error(
            "GEOMETRY_PARAM_INVALID",
            format!("Geometry parameter '{key}' must be a positive number."),
            Some(object_id.to_string()),
            Some(path.to_string()),
            &["realize_geometry", "build_mesh", "run_solver"],
        )),
    }
}

fn validate_finite_number_param(
    params: &Value,
    key: &str,
    object_id: &str,
    path: &str,
    diagnostics: &mut Vec<GeometryDiagnostic>,
) {
    match number_param(params, key) {
        Some(value) if value.is_finite() => {}
        _ => diagnostics.push(error(
            "GEOMETRY_PARAM_INVALID",
            format!("Geometry parameter '{key}' must be a finite number."),
            Some(object_id.to_string()),
            Some(path.to_string()),
            &["realize_geometry", "build_mesh", "run_solver"],
        )),
    }
}

fn validate_optional_finite_number_param(
    params: &Value,
    key: &str,
    object_id: &str,
    path: &str,
    diagnostics: &mut Vec<GeometryDiagnostic>,
) {
    if params.get(key).is_none() {
        return;
    }
    validate_finite_number_param(params, key, object_id, path, diagnostics);
}

fn number_param(params: &Value, key: &str) -> Option<f64> {
    params.get(key)?.as_f64()
}

fn vec3_param(params: &Value, key: &str) -> Option<[f64; 3]> {
    let values = params.get(key)?.as_array()?;
    if values.len() != 3 {
        return None;
    }
    Some([
        values[0].as_f64()?,
        values[1].as_f64()?,
        values[2].as_f64()?,
    ])
}

fn transform_is_valid(transform: &Transform3D) -> bool {
    finite_vec3(transform.translation)
        && finite_vec3(transform.scale)
        && finite_vec3(transform.pivot)
        && transform.scale.iter().all(|value| *value > 0.0)
        && quat_is_valid(transform.rotation_quat)
}

fn positive_vec3(value: [f64; 3]) -> bool {
    value
        .iter()
        .all(|component| component.is_finite() && *component > 0.0)
}

fn finite_vec3(value: [f64; 3]) -> bool {
    value.iter().all(|component| component.is_finite())
}

fn quat_is_valid(value: [f64; 4]) -> bool {
    value.iter().all(|component| component.is_finite())
        && value.iter().any(|component| component.abs() > f64::EPSILON)
}

fn rotate_point_by_quat(point: [f64; 3], quat: [f64; 4]) -> [f64; 3] {
    let norm =
        (quat[0] * quat[0] + quat[1] * quat[1] + quat[2] * quat[2] + quat[3] * quat[3]).sqrt();
    if !norm.is_finite() || norm <= f64::EPSILON {
        return point;
    }
    let qx = quat[0] / norm;
    let qy = quat[1] / norm;
    let qz = quat[2] / norm;
    let qw = quat[3] / norm;
    let uv = cross([qx, qy, qz], point);
    let uuv = cross([qx, qy, qz], uv);
    [
        point[0] + 2.0 * (qw * uv[0] + uuv[0]),
        point[1] + 2.0 * (qw * uv[1] + uuv[1]),
        point[2] + 2.0 * (qw * uv[2] + uuv[2]),
    ]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn aabb_overlap(
    left_min: [f64; 3],
    left_max: [f64; 3],
    right_min: [f64; 3],
    right_max: [f64; 3],
) -> bool {
    (0..3).all(|axis| left_min[axis] < right_max[axis] && right_min[axis] < left_max[axis])
}

fn mesh_reference_size(scene: &SceneDocument) -> Option<f64> {
    parse_mesh_size(scene.study.mesh_defaults.maximum_element_size.as_deref())
        .or_else(|| parse_mesh_size(Some(scene.study.mesh_defaults.hmax.as_str())))
        .or_else(|| {
            parse_mesh_size(
                scene
                    .study
                    .shared_domain_mesh
                    .maximum_element_size
                    .as_deref(),
            )
        })
        .or_else(|| parse_mesh_size(Some(scene.study.shared_domain_mesh.hmax.as_str())))
}

fn parse_mesh_size(value: Option<&str>) -> Option<f64> {
    let raw = value?.trim();
    if raw.is_empty() || raw.eq_ignore_ascii_case("auto") {
        return None;
    }
    raw.parse::<f64>()
        .ok()
        .filter(|value| value.is_finite() && *value > 0.0)
}

fn stable_body_id(object_id: &str, geometry_path: &str) -> String {
    format!(
        "body:{}:{}",
        slug_token(object_id),
        fnv1a64_hex(geometry_path.as_bytes())
    )
}

fn slug_token(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        "object".to_string()
    } else {
        out
    }
}

fn fnv1a64_hex(bytes: &[u8]) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn scene_has_dirty_mesh_tags(scene: &SceneDocument) -> bool {
    scene
        .objects
        .iter()
        .any(|object| object.tags.iter().any(|tag| tag == "mesh:dirty"))
}

fn min_vec3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0].min(b[0]), a[1].min(b[1]), a[2].min(b[2])]
}

fn max_vec3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0].max(b[0]), a[1].max(b[1]), a[2].max(b[2])]
}

fn primitive(
    id: &str,
    label: &str,
    category: &str,
    fem: bool,
    fdm: bool,
    dsl: bool,
    boolean: bool,
    status: GeometrySupportStatus,
) -> PrimitiveGeometryCapability {
    PrimitiveGeometryCapability {
        id: id.to_string(),
        label: label.to_string(),
        category: category.to_string(),
        fem,
        fdm,
        dsl,
        boolean,
        status,
    }
}

fn boolean(
    op: &str,
    fem: bool,
    fdm: bool,
    dsl: bool,
    status: GeometrySupportStatus,
    notes: &str,
) -> BooleanGeometryCapability {
    BooleanGeometryCapability {
        op: op.to_string(),
        fem,
        fdm,
        dsl,
        status,
        notes: notes.to_string(),
    }
}

fn error(
    code: &str,
    message: impl Into<String>,
    object_id: Option<String>,
    geometry_path: Option<String>,
    blocks: &[&str],
) -> GeometryDiagnostic {
    diagnostic(
        GeometryDiagnosticSeverity::Error,
        code,
        message,
        object_id,
        geometry_path,
        blocks,
    )
}

fn warning(
    code: &str,
    message: impl Into<String>,
    object_id: Option<String>,
    geometry_path: Option<String>,
    blocks: &[&str],
) -> GeometryDiagnostic {
    diagnostic(
        GeometryDiagnosticSeverity::Warning,
        code,
        message,
        object_id,
        geometry_path,
        blocks,
    )
}

fn diagnostic(
    severity: GeometryDiagnosticSeverity,
    code: &str,
    message: impl Into<String>,
    object_id: Option<String>,
    geometry_path: Option<String>,
    blocks: &[&str],
) -> GeometryDiagnostic {
    let path = geometry_path.clone().unwrap_or_else(|| "scene".to_string());
    GeometryDiagnostic {
        id: format!("{}:{}", code, path),
        severity,
        code: code.to_string(),
        message: message.into(),
        object_id,
        geometry_path,
        blocks: blocks.iter().map(|block| (*block).to_string()).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        SceneCurrentModulesState, SceneEditorState, SceneMaterialAsset, SceneMetadata,
        SceneOutputsState, SceneStudyState, ScriptBuilderMaterialState,
    };
    use serde_json::json;

    #[test]
    fn stl_capability_exposes_fem_without_claiming_fdm_boolean_or_production_support() {
        let capabilities = geometry_capabilities(1);
        let stl = capabilities.primitive_capabilities.iter()
            .find(|capability| capability.id == "imported_geometry").unwrap();
        assert!(stl.fem && stl.dsl);
        assert!(!stl.fdm && !stl.boolean);
        assert_eq!(stl.status, GeometrySupportStatus::Preview);
    }

    fn scene_with_object(geometry: SceneGeometry) -> SceneDocument {
        SceneDocument {
            revision: 7,
            materials: vec![SceneMaterialAsset {
                id: "mat:free".to_string(),
                name: "material".to_string(),
                properties: ScriptBuilderMaterialState {
                    ms: None,
                    aex: None,
                    alpha: 0.01,
                    dind: None,
                    dbulk: None,
                    ku1: None,
                    ku2: None,
                    kc1: None,
                    kc2: None,
                    kc3: None,
                },
                source: None,
                references: Vec::new(),
            }],
            magnetization_assets: vec![crate::MagnetizationAsset {
                id: "mag:free".to_string(),
                name: "magnetization".to_string(),
                kind: "preset_texture".to_string(),
                value: None,
                seed: None,
                source_path: None,
                source_format: None,
                dataset: None,
                sample_index: None,
                mapping: Default::default(),
                texture_transform: Default::default(),
                preset_kind: Some("uniform".to_string()),
                preset_params: Some(json!({ "direction": [0.0, 0.0, 1.0] })),
                preset_version: Some(1),
                ui_label: Some("Uniform".to_string()),
            }],
            couplings: Vec::new(),
            objects: vec![SceneObject {
                id: "free".to_string(),
                name: "free".to_string(),
                role: "magnet".to_string(),
                geometry,
                transform: Default::default(),
                material_ref: "mat:free".to_string(),
                region_name: None,
                magnetization_ref: Some("mag:free".to_string()),
                region_overrides: Default::default(),
                physics_stack: vec![],
                object_mesh: None,
                mesh_override: None,
                regions: Vec::new(),
                allocated_region_ids: Vec::new(),
                material_parameter_fields: Vec::new(),
                absorbing_boundary: None,
                visualization_hint: Default::default(),
                notes: None,
                visible: true,
                locked: false,
                tags: vec!["mesh:dirty".to_string()],
            }],
            version: "scene.v1".to_string(),
            scene: SceneMetadata::default(),
            universe: None,
            field_drives: crate::SceneFieldDrivesState::default(),
            monitors: crate::SceneMonitorState::default(),
            selections: Vec::new(),
            magnetization_constraints: Vec::new(),
            current_modules: SceneCurrentModulesState::default(),
            current_transports: Vec::new(),
            spin_transports: Vec::new(),
            spin_torques: Vec::new(),
            oersted_fields: Vec::new(),
            antenna_port_modes: Vec::new(),
            antenna_field_solve_stages: Vec::new(),
            antenna_target_projections: Vec::new(),
            solved_antenna_drives: Vec::new(),
            antenna_spectrum_requests: Vec::new(),
            study: SceneStudyState::default(),
            outputs: SceneOutputsState::default(),
            editor: SceneEditorState::default(),
            analysis: Default::default(),
        }
    }

    #[test]
    fn imported_stl_is_a_real_fem_source_without_an_explicit_mesh_waiver() {
        let mut scene = scene_with_object(SceneGeometry {
            geometry_name: None,
            source_asset: None,
            geometry_kind: "ImportedGeometry".to_string(),
            geometry_params: json!({"source": "body.stl", "scale": 1e-6, "volume": "full"}),
            bounds_min: Some([0.0; 3]), bounds_max: Some([1e-6; 3]),
        });
        scene.objects[0].tags.clear();
        assert!(geometry_blocks_solver_run(&scene, GeometryBackendTarget::Fem).is_none());
        assert!(geometry_blocks_solver_run(&scene, GeometryBackendTarget::Fdm).is_some());
        scene.objects[0].geometry.geometry_params["volume"] = json!("surface");
        let validation = validate_geometry_scene(&scene, GeometryBackendTarget::Fem);
        let diagnostic = validation.diagnostics.iter().find(|row| row.code == "GEOMETRY_IMPORTED_SURFACE_ONLY").unwrap();
        assert!(!diagnostic.blocks.iter().any(|block| block == "realize_geometry"));
        assert!(diagnostic.blocks.iter().any(|block| block == "build_mesh"));
        assert!(geometry_blocks_solver_run(&scene, GeometryBackendTarget::Fem).is_some());
    }

    #[test]
    fn auxiliary_geometry_preserves_mesh_body_without_magnetic_references() {
        for role in ["antenna", "conductor", "geometry"] {
            let mut scene = scene_with_object(SceneGeometry {
                geometry_name: None,
                source_asset: None,
                geometry_kind: "Box".to_string(),
                geometry_params: json!({ "size": [1.0, 2.0, 3.0] }),
                bounds_min: None,
                bounds_max: None,
            });
            scene.objects[0].role = role.to_string();
            scene.objects[0].material_ref.clear();
            scene.objects[0].magnetization_ref = None;
            scene.materials.clear();
            scene.magnetization_assets.clear();
            assert_eq!(validate_geometry_scene(&scene, GeometryBackendTarget::Fem).status, "ready");
            assert!(geometry_blocks_mesh_build(&scene, GeometryBackendTarget::Fem).is_none());
            let realized = realize_geometry_scene(&scene, GeometryBackendTarget::Fem);
            assert_eq!(realized.bodies.len(), 1);
            assert_eq!(realized.bodies[0].object_id, "free");
            assert_eq!(realized.bodies[0].bounds_max, [0.5, 1.0, 1.5]);

            scene.objects[0].tags.clear();
            scene.objects[0].role = "magnet".to_string();
            scene.objects[0].physics_stack = vec![crate::ScriptBuilderMagneticInteractionEntry {
                kind: crate::ScriptBuilderMagneticInteractionKind::Exchange,
                enabled: true,
                params: None,
            }];
            assert!(geometry_blocks_mesh_build(&scene, GeometryBackendTarget::Fem).is_none());
            let validation = validate_geometry_scene(&scene, GeometryBackendTarget::Fem);
            assert!(validation.diagnostics.iter().any(|entry| entry.code == "GEOMETRY_OBJECT_MATERIAL_MISSING"));
            assert!(validation.diagnostics.iter().any(|entry| entry.code == "GEOMETRY_OBJECT_MAGNETIZATION_MISSING"));
            assert!(geometry_blocks_solver_run(&scene, GeometryBackendTarget::Fem).is_some());
        }
    }

    #[test]
    fn auxiliary_geometry_rejects_explicit_dangling_magnetic_references() {
        let mut scene = scene_with_object(SceneGeometry {
            geometry_name: None,
            source_asset: None,
            geometry_kind: "Box".to_string(),
            geometry_params: json!({ "size": [1.0, 2.0, 3.0] }),
            bounds_min: None,
            bounds_max: None,
        });
        scene.objects[0].role = "antenna".to_string();
        scene.materials.clear();
        scene.magnetization_assets.clear();
        let validation = validate_geometry_scene(&scene, GeometryBackendTarget::Fem);
        assert!(validation.diagnostics.iter().any(|entry| entry.code == "GEOMETRY_OBJECT_MATERIAL_MISSING"));
        assert!(validation.diagnostics.iter().any(|entry| entry.code == "GEOMETRY_OBJECT_MAGNETIZATION_MISSING"));
    }

    #[test]
    fn box_scene_realizes_with_bounds_and_dirty_state() {
        let scene = scene_with_object(SceneGeometry {
            geometry_name: None,
            source_asset: None,
            geometry_kind: "Box".to_string(),
            geometry_params: json!({ "size": [1.0, 2.0, 3.0] }),
            bounds_min: None,
            bounds_max: None,
        });
        let validation = validate_geometry_scene(&scene, GeometryBackendTarget::Fem);
        assert_eq!(validation.status, "ready");
        assert!(validation.dirty);
        let snapshot = realize_geometry_scene(&scene, GeometryBackendTarget::Fem);
        assert_eq!(snapshot.source_scene_revision, 7);
        assert_eq!(snapshot.bodies[0].bounds_min, [-0.5, -1.0, -1.5]);
        assert_eq!(snapshot.bodies[0].bounds_max, [0.5, 1.0, 1.5]);
    }

    #[test]
    fn arch_waveguide_scene_realizes_with_python_ir_bounds() {
        let scene = scene_with_object(SceneGeometry {
            geometry_name: None,
            source_asset: None,
            geometry_kind: "ArchWaveguide".to_string(),
            geometry_params: json!({
                "length": 400e-9,
                "width": 40e-9,
                "height": 10e-9,
                "arch_height": -80e-9,
                "z0": 10e-9,
            }),
            bounds_min: None,
            bounds_max: None,
        });

        let validation = validate_geometry_scene(&scene, GeometryBackendTarget::Fem);
        assert_eq!(validation.status, "ready");
        let mut clean_scene = scene.clone();
        clean_scene.objects[0].tags.clear();
        assert_eq!(
            geometry_blocks_solver_run(&clean_scene, GeometryBackendTarget::Fem),
            None
        );
        let snapshot = realize_geometry_scene(&scene, GeometryBackendTarget::Fem);
        assert_eq!(snapshot.status, "ready");
        assert_eq!(snapshot.bodies[0].geometry_kind, "ArchWaveguide");
        assert!((snapshot.bodies[0].bounds_min[0] + 200e-9).abs() < 1e-18);
        assert!((snapshot.bodies[0].bounds_min[1] + 20e-9).abs() < 1e-18);
        assert!((snapshot.bodies[0].bounds_min[2] + 75e-9).abs() < 1e-18);
        assert!((snapshot.bodies[0].bounds_max[0] - 200e-9).abs() < 1e-18);
        assert!((snapshot.bodies[0].bounds_max[1] - 20e-9).abs() < 1e-18);
        assert!((snapshot.bodies[0].bounds_max[2] - 15e-9).abs() < 1e-18);
    }

    #[test]
    fn microstrip_scene_derives_bounds_from_stations_not_stale_stored_bounds() {
        let scene = scene_with_object(SceneGeometry {
            geometry_name: None,
            source_asset: None,
            geometry_kind: "MicrostripAntennaLayout".to_string(),
            geometry_params: json!({
                "length_m": 1e-6,
                "thickness_m": 10e-9,
                "conductivity_s_per_m": 5.8e7,
                "return_width_m": 500e-9,
                "return_offset_m": 30e-9,
                "stations": [
                    {"s": 0.0, "signal_width_m": 50e-9},
                    {"s": 0.5, "signal_width_m": 600e-9},
                    {"s": 1.0, "signal_width_m": 50e-9}
                ],
                "transform": {
                    "rotation_matrix": [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
                    "translation_m": [0, -0.5e-6, 0]
                }
            }),
            bounds_min: Some([-1.0, -1.0, -1.0]),
            bounds_max: Some([1.0, 1.0, 1.0]),
        });
        assert_eq!(
            validate_geometry_scene(&scene, GeometryBackendTarget::Fem).status,
            "ready"
        );
        let snapshot = realize_geometry_scene(&scene, GeometryBackendTarget::Fem);
        let body = &snapshot.bodies[0];
        assert!((body.bounds_min[0] + 300e-9).abs() < 1e-18);
        assert!((body.bounds_max[0] - 300e-9).abs() < 1e-18);
        assert!((body.bounds_min[1] + 0.5e-6).abs() < 1e-18);
        assert!((body.bounds_max[1] - 0.5e-6).abs() < 1e-18);
        assert!((body.bounds_min[2] + 45e-9).abs() < 1e-18);
        assert!((body.bounds_max[2] - 5e-9).abs() < 1e-18);
        assert!(validate_geometry_scene(&scene, GeometryBackendTarget::Fdm)
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "GEOMETRY_KIND_UNSUPPORTED"));
    }

    #[test]
    fn microstrip_scene_rejects_unordered_stations_and_nonrigid_transform() {
        let mut scene = scene_with_object(SceneGeometry {
            geometry_name: None,
            source_asset: None,
            geometry_kind: "MicrostripAntennaLayout".to_string(),
            geometry_params: json!({
                "length_m": 1e-6,
                "thickness_m": 10e-9,
                "conductivity_s_per_m": 5.8e7,
                "return_width_m": 500e-9,
                "return_offset_m": 30e-9,
                "stations": [
                    {"s": 0.0, "signal_width_m": 50e-9},
                    {"s": 0.0, "signal_width_m": 20e-9},
                    {"s": 1.0, "signal_width_m": 50e-9}
                ]
            }),
            bounds_min: None,
            bounds_max: None,
        });
        let validation = validate_geometry_scene(&scene, GeometryBackendTarget::Fem);
        assert!(validation
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "GEOMETRY_PARAM_INVALID"
                && diagnostic.message.contains("strictly increasing")));
        scene.objects[0].geometry.geometry_params["stations"][1]["s"] = json!(0.5);
        scene.objects[0].geometry.geometry_params["transform"] = json!({
            "rotation_matrix": [[-1, 0, 0], [0, 1, 0], [0, 0, 1]]
        });
        let validation = validate_geometry_scene(&scene, GeometryBackendTarget::Fem);
        assert!(validation
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "GEOMETRY_PARAM_INVALID"
                && diagnostic.message.contains("right-handed")));
    }

    fn cpw_params() -> Value {
        json!({
            "length_m": 1e-6, "thickness_m": 10e-9, "conductivity_s_per_m": 5.8e7,
            "stations": [
                {"s": 0.0, "signal_width_m": 50e-9, "left_gap_m": 100e-9,
                 "right_gap_m": 200e-9, "left_ground_width_m": 200e-9, "right_ground_width_m": 300e-9},
                {"s": 0.5, "signal_width_m": 600e-9, "left_gap_m": 100e-9,
                 "right_gap_m": 200e-9, "left_ground_width_m": 200e-9, "right_ground_width_m": 300e-9},
                {"s": 1.0, "signal_width_m": 50e-9, "left_gap_m": 100e-9,
                 "right_gap_m": 200e-9, "left_ground_width_m": 200e-9, "right_ground_width_m": 300e-9}
            ],
            "transform": {"rotation_matrix": [[0,-1,0],[1,0,0],[0,0,1]],
                          "translation_m": [2e-6,-0.5e-6,20e-9]}
        })
    }

    #[test]
    fn cpw_scene_uses_all_station_bounds_and_rejects_fdm() {
        let mut scene = scene_with_object(SceneGeometry {
            geometry_name: None,
            source_asset: None,
            geometry_kind: "CPWAntennaLayout".to_string(),
            geometry_params: cpw_params(),
            bounds_min: Some([-1.0; 3]), bounds_max: Some([1.0; 3]),
        });
        scene.objects[0].role = "antenna".to_string();
        scene.objects[0].material_ref.clear();
        scene.objects[0].magnetization_ref = None;
        assert_eq!(validate_geometry_scene(&scene, GeometryBackendTarget::Fem).status, "ready");
        let snapshot = realize_geometry_scene(&scene, GeometryBackendTarget::Fem);
        let body = &snapshot.bodies[0];
        for (actual, expected) in body.bounds_min.iter().zip([1.2e-6, -0.5e-6, 15e-9]) {
            assert!((actual - expected).abs() < 1e-18);
        }
        for (actual, expected) in body.bounds_max.iter().zip([2.6e-6, 0.5e-6, 25e-9]) {
            assert!((actual - expected).abs() < 1e-18);
        }
        assert!(body.material_ref.is_empty());
        assert!(body.magnetization_ref.is_none());
        assert!(validate_geometry_scene(&scene, GeometryBackendTarget::Fdm).diagnostics
            .iter().any(|diagnostic| diagnostic.code == "GEOMETRY_KIND_UNSUPPORTED"));
    }

    #[test]
    fn cpw_closed_loop_bounds_include_transformed_end_connections() {
        let mut params = cpw_params();
        params["loop"] = json!({
            "enabled": true,
            "inlet_connection_length_m": 0.2e-6,
            "outlet_connection_length_m": 0.3e-6
        });
        let (min, max) = cpw_layout_bounds(&params).unwrap();
        for (actual, expected) in min.into_iter().zip([1.2e-6, -0.7e-6, 15e-9]) {
            assert!((actual - expected).abs() < 1e-18);
        }
        for (actual, expected) in max.into_iter().zip([2.6e-6, 0.8e-6, 25e-9]) {
            assert!((actual - expected).abs() < 1e-18);
        }
        params["loop"]["enabled"] = json!(false);
        let (min, max) = cpw_layout_bounds(&params).unwrap();
        assert!((min[1] + 0.5e-6).abs() < 1e-18);
        assert!((max[1] - 0.5e-6).abs() < 1e-18);
        params["loop"]["enabled"] = json!(true);
        params["loop"]["inlet_connection_length_m"] = json!(-1.0);
        assert!(cpw_layout_bounds(&params).is_none());
    }

    #[test]
    fn cpw_layout_rejects_invalid_stations_and_transforms() {
        for key in ["signal_width_m", "left_gap_m", "right_gap_m",
                    "left_ground_width_m", "right_ground_width_m"] {
            let mut params = cpw_params();
            params["stations"][1][key] = json!(0.0);
            assert!(parse_cpw_layout(&params).is_err(), "{key}");
            params["stations"][1].as_object_mut().unwrap().remove(key);
            assert!(parse_cpw_layout(&params).is_err(), "missing {key}");
        }
        for (index, s) in [(0, 0.1), (1, 0.0), (1, 1.1), (2, 0.9)] {
            let mut params = cpw_params();
            params["stations"][index]["s"] = json!(s);
            assert!(parse_cpw_layout(&params).is_err());
        }
        for rotation in [json!([[-1,0,0],[0,1,0],[0,0,1]]),
                         json!([[2,0,0],[0,1,0],[0,0,1]])] {
            let mut params = cpw_params();
            params["transform"]["rotation_matrix"] = rotation;
            assert!(parse_cpw_layout(&params).is_err());
        }
    }

    #[test]
    fn canonical_boolean_operands_require_nonempty_unique_ids() {
        let raw_box = json!({
            "geometry_kind": "Box",
            "geometry_params": { "size": [1.0, 1.0, 1.0] }
        });
        for (ids, expected_code) in [
            (["", "op:2"], "GEOMETRY_CSG_OPERAND_ID_INVALID"),
            (["op:1", "op:1"], "GEOMETRY_CSG_OPERAND_ID_DUPLICATE"),
        ] {
            let scene = scene_with_object(SceneGeometry {
                geometry_name: None,
                source_asset: None,
                geometry_kind: "Union".to_string(),
                geometry_params: json!({
                    "operands": [
                        { "operand_id": ids[0], "geometry": raw_box.clone() },
                        { "operand_id": ids[1], "geometry": raw_box.clone() }
                    ]
                }),
                bounds_min: None,
                bounds_max: None,
            });
            let validation = validate_geometry_scene(&scene, GeometryBackendTarget::Fem);
            assert!(validation
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == expected_code));
            assert!(geometry_blocks_mesh_build(&scene, GeometryBackendTarget::Fem).is_some());
        }
    }

    #[test]
    fn legacy_raw_geometry_operand_arrays_remain_supported() {
        let scene = scene_with_object(SceneGeometry {
            geometry_name: None,
            source_asset: None,
            geometry_kind: "Union".to_string(),
            geometry_params: json!({ "operands": [
                { "geometry_kind": "Box", "geometry_params": { "size": [1.0, 1.0, 1.0] } },
                { "geometry_kind": "Box", "geometry_params": { "size": [2.0, 1.0, 1.0] } }
            ]}),
            bounds_min: None,
            bounds_max: None,
        });
        let validation = validate_geometry_scene(&scene, GeometryBackendTarget::Fem);
        assert!(!validation.diagnostics.iter().any(|diagnostic| matches!(
            diagnostic.code.as_str(),
            "GEOMETRY_CSG_OPERAND_ID_INVALID" | "GEOMETRY_CSG_OPERAND_ID_DUPLICATE"
        )));
    }

    #[test]
    fn unsupported_csg_blocks_mesh_build() {
        let scene = scene_with_object(SceneGeometry {
            geometry_name: None,
            source_asset: None,
            geometry_kind: "Csg".to_string(),
            geometry_params: json!({ "op": "union", "children": [] }),
            bounds_min: None,
            bounds_max: None,
        });
        let reason = geometry_blocks_mesh_build(&scene, GeometryBackendTarget::Fem);
        assert!(reason.is_some());
    }

    #[test]
    fn workspace_body_ids_are_stable_when_object_order_changes() {
        let mut scene = scene_with_object(SceneGeometry {
            geometry_name: None,
            source_asset: None,
            geometry_kind: "Box".to_string(),
            geometry_params: json!({ "size": [1.0, 1.0, 1.0] }),
            bounds_min: None,
            bounds_max: None,
        });
        let mut second = scene.objects[0].clone();
        second.id = "second".to_string();
        second.name = "second".to_string();
        second.region_name = Some("second".to_string());
        scene.objects.push(second);

        let first_workspace = build_geometry_workspace(&scene, GeometryBackendTarget::Fem);
        scene.objects.reverse();
        let second_workspace = build_geometry_workspace(&scene, GeometryBackendTarget::Fem);
        let mut first_ids: Vec<_> = first_workspace
            .bodies
            .iter()
            .map(|body| body.body_id.clone())
            .collect();
        let mut second_ids: Vec<_> = second_workspace
            .bodies
            .iter()
            .map(|body| body.body_id.clone())
            .collect();
        first_ids.sort();
        second_ids.sort();
        assert_eq!(first_ids, second_ids);
    }

    #[test]
    fn rotated_box_bounds_are_conservative_world_aabb() {
        let mut scene = scene_with_object(SceneGeometry {
            geometry_name: None,
            source_asset: None,
            geometry_kind: "Box".to_string(),
            geometry_params: json!({ "size": [2.0, 4.0, 2.0] }),
            bounds_min: None,
            bounds_max: None,
        });
        let s = std::f64::consts::FRAC_1_SQRT_2;
        scene.objects[0].transform.rotation_quat = [0.0, 0.0, s, s];
        let snapshot = realize_geometry_scene(&scene, GeometryBackendTarget::Fem);
        let body = &snapshot.bodies[0];
        assert!((body.bounds_min[0] + 2.0).abs() < 1e-12);
        assert!((body.bounds_max[0] - 2.0).abs() < 1e-12);
        assert!((body.bounds_min[1] + 1.0).abs() < 1e-12);
        assert!((body.bounds_max[1] - 1.0).abs() < 1e-12);
    }

    #[test]
    fn duplicate_region_and_overlap_emit_diagnostics() {
        let mut scene = scene_with_object(SceneGeometry {
            geometry_name: None,
            source_asset: None,
            geometry_kind: "Box".to_string(),
            geometry_params: json!({ "size": [1.0, 1.0, 1.0] }),
            bounds_min: None,
            bounds_max: None,
        });
        scene.objects[0].region_name = Some("shared".to_string());
        let mut second = scene.objects[0].clone();
        second.id = "second".to_string();
        second.name = "second".to_string();
        second.region_name = Some("shared".to_string());
        second.transform.translation = [0.25, 0.0, 0.0];
        scene.objects.push(second);
        let validation = validate_geometry_scene(&scene, GeometryBackendTarget::Fem);
        assert!(validation
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "GEOMETRY_REGION_NAME_DUPLICATE"));
        assert!(validation
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "GEOMETRY_OBJECT_OVERLAPS_OBJECT"));
    }

    #[test]
    fn tiny_feature_below_mesh_size_warns() {
        let mut scene = scene_with_object(SceneGeometry {
            geometry_name: None,
            source_asset: None,
            geometry_kind: "Box".to_string(),
            geometry_params: json!({ "size": [1.0, 1.0, 0.1] }),
            bounds_min: None,
            bounds_max: None,
        });
        scene.study.mesh_defaults.maximum_element_size = Some("0.2".to_string());
        let validation = validate_geometry_scene(&scene, GeometryBackendTarget::Fem);
        assert!(validation
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "GEOMETRY_TINY_FEATURE_BELOW_MESH_SIZE"));
    }

    #[test]
    fn manual_universe_outside_blocks_mesh_and_solver_but_auto_does_not() {
        let mut scene = scene_with_object(SceneGeometry {
            geometry_name: None,
            source_asset: None,
            geometry_kind: "Box".into(),
            geometry_params: json!({"size": [2.0, 2.0, 2.0]}),
            bounds_min: None,
            bounds_max: None,
        });
        scene.objects[0].tags.clear();
        for mode in ["manual", "auto"] {
            scene.study.universe_mesh = Some(
                serde_json::from_value(json!({
                    "mode": mode, "size": [1.0, 1.0, 1.0], "center": [0.0, 0.0, 0.0]
                }))
                .unwrap(),
            );
            let validation = validate_geometry_scene(&scene, GeometryBackendTarget::Fem);
            let outside = validation
                .diagnostics
                .iter()
                .find(|d| d.code == "GEOMETRY_OBJECT_OUTSIDE_UNIVERSE")
                .unwrap();
            assert_eq!(outside.blocks.is_empty(), mode == "auto");
            assert_eq!(
                geometry_blocks_mesh_build(&scene, GeometryBackendTarget::Fem).is_some(),
                mode == "manual"
            );
            assert_eq!(
                geometry_blocks_solver_run(&scene, GeometryBackendTarget::Fem).is_some(),
                mode == "manual"
            );
        }
        // The accepted policy overrides an older materialized scene projection.
        scene.universe = Some(
            serde_json::from_value(json!({"mode": "manual", "size": [1.0, 1.0, 1.0]})).unwrap(),
        );
        scene.study.universe_mesh = Some(
            serde_json::from_value(json!({"mode": "manual", "size": [4.0, 4.0, 4.0]})).unwrap(),
        );
        assert!(geometry_blocks_mesh_build(&scene, GeometryBackendTarget::Fem).is_none());
    }

    #[test]
    fn manual_universe_requires_finite_positive_size_even_without_geometry() {
        let mut scene = scene_with_object(SceneGeometry {
            geometry_name: None,
            source_asset: None,
            geometry_kind: "Box".into(),
            geometry_params: json!({"size": [1.0, 1.0, 1.0]}),
            bounds_min: None,
            bounds_max: None,
        });
        scene.objects.clear();
        scene.study.universe_mesh =
            Some(serde_json::from_value(json!({"mode": "manual"})).unwrap());
        let validation = validate_geometry_scene(&scene, GeometryBackendTarget::Fem);
        assert!(validation
            .diagnostics
            .iter()
            .any(|d| d.code == "GEOMETRY_UNIVERSE_INVALID_BOUNDS"
                && d.blocks.iter().any(|b| b == "build_mesh")));
    }
}
