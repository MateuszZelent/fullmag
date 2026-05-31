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
                false,
                false,
                false,
                true,
                GeometrySupportStatus::Preview,
            ),
            primitive(
                "ellipsoid",
                "Ellipsoid",
                "mumax",
                false,
                false,
                false,
                true,
                GeometrySupportStatus::Preview,
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
                false,
                false,
                false,
                true,
                GeometrySupportStatus::Preview,
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
                false,
                false,
                false,
                true,
                GeometrySupportStatus::Preview,
            ),
        ],
        csg_capabilities: vec![
            boolean(
                "union",
                false,
                false,
                false,
                GeometrySupportStatus::Unsupported,
                "Union is represented in SceneDocument but not yet realized by the production mesh pipeline.",
            ),
            boolean(
                "subtract",
                true,
                true,
                true,
                GeometrySupportStatus::Production,
                "Difference is supported for Box/Cylinder inputs, including Cylinder minus Cylinder rings.",
            ),
            boolean(
                "intersect",
                false,
                false,
                false,
                GeometrySupportStatus::Unsupported,
                "Intersection is represented in SceneDocument but not yet realized by the production mesh pipeline.",
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
    if object.material_ref.trim().is_empty()
        || !scene
            .materials
            .iter()
            .any(|material| material.id == object.material_ref)
    {
        diagnostics.push(error(
            "GEOMETRY_OBJECT_MATERIAL_MISSING",
            format!("Object '{}' references a missing material.", object.id),
            Some(object.id.clone()),
            Some(object_path.clone()),
            &["realize_geometry", "build_mesh", "run_solver"],
        ));
    }
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
                "Object '{}' must reference a magnetization asset before mesh/compute.",
                object.id
            ),
            Some(object.id.clone()),
            Some(object_path.clone()),
            &["build_mesh", "run_solver"],
        )),
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
    validate_geometry_node(
        &object.geometry,
        backend_target,
        &object.id,
        &object_path,
        diagnostics,
    );
    validate_tiny_features(scene, object, &object_path, diagnostics);
    if let (Some((bounds_min, bounds_max)), Some(universe)) =
        (derive_object_bounds(object), scene.universe.as_ref())
    {
        if let (Some(universe_size), Some(universe_center)) = (universe.size, universe.center) {
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
                bounds_min[axis] < universe_min[axis] || bounds_max[axis] > universe_max[axis]
            }) {
                diagnostics.push(warning(
                    "GEOMETRY_OBJECT_OUTSIDE_UNIVERSE",
                    format!(
                        "Object '{}' extends outside the declared Universe bounds.",
                        object.id
                    ),
                    Some(object.id.clone()),
                    Some(object_path),
                    &[],
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

fn validate_geometry_node(
    geometry: &SceneGeometry,
    backend_target: &GeometryBackendTarget,
    object_id: &str,
    path: &str,
    diagnostics: &mut Vec<GeometryDiagnostic>,
) {
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
        "Difference" => validate_difference_node(
            &geometry.geometry_params,
            backend_target,
            object_id,
            path,
            diagnostics,
        ),
        "Csg" => validate_csg_node(
            &geometry.geometry_params,
            backend_target,
            object_id,
            path,
            diagnostics,
        ),
        "Ellipsoid" | "Sphere" | "Ellipse" => diagnostics.push(error(
            "GEOMETRY_KIND_PREVIEW_ONLY",
            format!(
                "{} is preview-only for {} and cannot feed the production mesh pipeline yet.",
                geometry.geometry_kind,
                backend_target.as_str()
            ),
            Some(object_id.to_string()),
            Some(path.to_string()),
            &["realize_geometry", "build_mesh", "run_solver"],
        )),
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

fn validate_difference_node(
    params: &Value,
    backend_target: &GeometryBackendTarget,
    object_id: &str,
    path: &str,
    diagnostics: &mut Vec<GeometryDiagnostic>,
) {
    let base = params.get("base").and_then(parse_geometry_value);
    let tool = params.get("tool").and_then(parse_geometry_value);
    match (base, tool) {
        (Some(base), Some(tool)) => {
            validate_geometry_node(
                &base,
                backend_target,
                object_id,
                &format!("{path}/base"),
                diagnostics,
            );
            validate_geometry_node(
                &tool,
                backend_target,
                object_id,
                &format!("{path}/tool"),
                diagnostics,
            );
            if !matches!(base.geometry_kind.as_str(), "Box" | "Cylinder")
                || !matches!(tool.geometry_kind.as_str(), "Box" | "Cylinder")
            {
                diagnostics.push(error(
                    "GEOMETRY_CSG_DIFFERENCE_UNSUPPORTED_INPUTS",
                    "Difference currently supports Box/Cylinder base and tool geometries only.",
                    Some(object_id.to_string()),
                    Some(path.to_string()),
                    &["realize_geometry", "build_mesh", "run_solver"],
                ));
            }
        }
        _ => diagnostics.push(error(
            "GEOMETRY_CSG_DIFFERENCE_INVALID",
            "Difference geometry must provide base and tool geometry nodes.",
            Some(object_id.to_string()),
            Some(path.to_string()),
            &["realize_geometry", "build_mesh", "run_solver"],
        )),
    }
}

fn validate_csg_node(
    params: &Value,
    _backend_target: &GeometryBackendTarget,
    object_id: &str,
    path: &str,
    diagnostics: &mut Vec<GeometryDiagnostic>,
) {
    let op = params.get("op").and_then(Value::as_str).unwrap_or("");
    if op != "subtract" {
        diagnostics.push(error(
            "GEOMETRY_CSG_OP_UNSUPPORTED",
            format!("CSG operation '{op}' is not production-realized yet."),
            Some(object_id.to_string()),
            Some(path.to_string()),
            &["realize_geometry", "build_mesh", "run_solver"],
        ));
    }
    let children = params.get("children").and_then(Value::as_array);
    if children.map_or(true, |children| children.len() < 2) {
        diagnostics.push(error(
            "GEOMETRY_CSG_CHILDREN_INVALID",
            "CSG geometry requires at least two child geometry nodes.",
            Some(object_id.to_string()),
            Some(path.to_string()),
            &["realize_geometry", "build_mesh", "run_solver"],
        ));
    }
}

fn derive_object_bounds(object: &SceneObject) -> Option<([f64; 3], [f64; 3])> {
    let (local_min, local_max) = derive_geometry_bounds(&object.geometry)?;
    let scale = object.transform.scale;
    if !finite_vec3(scale)
        || !finite_vec3(object.transform.translation)
        || !quat_is_valid(object.transform.rotation_quat)
    {
        return None;
    }
    let mut world_min = [f64::INFINITY; 3];
    let mut world_max = [f64::NEG_INFINITY; 3];
    for x in [local_min[0], local_max[0]] {
        for y in [local_min[1], local_max[1]] {
            for z in [local_min[2], local_max[2]] {
                let scaled = [x * scale[0], y * scale[1], z * scale[2]];
                let rotated = rotate_point_by_quat(scaled, object.transform.rotation_quat);
                let world = [
                    rotated[0] + object.transform.translation[0],
                    rotated[1] + object.transform.translation[1],
                    rotated[2] + object.transform.translation[2],
                ];
                world_min = min_vec3(world_min, world);
                world_max = max_vec3(world_max, world);
            }
        }
    }
    Some((world_min, world_max))
}

fn derive_geometry_bounds(geometry: &SceneGeometry) -> Option<([f64; 3], [f64; 3])> {
    match geometry.geometry_kind.as_str() {
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
            Some((
                [-radius, -radius, -height / 2.0],
                [radius, radius, height / 2.0],
            ))
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
        "Ellipsoid" => {
            let rx = number_param(&geometry.geometry_params, "rx")?;
            let ry = number_param(&geometry.geometry_params, "ry")?;
            let rz = number_param(&geometry.geometry_params, "rz")?;
            if [rx, ry, rz]
                .iter()
                .any(|value| !value.is_finite() || *value <= 0.0)
            {
                return None;
            }
            Some(([-rx, -ry, -rz], [rx, ry, rz]))
        }
        "Difference" => {
            let base = geometry
                .geometry_params
                .get("base")
                .and_then(parse_geometry_value)?;
            derive_geometry_bounds(&base)
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
                },
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
            objects: vec![SceneObject {
                id: "free".to_string(),
                name: "free".to_string(),
                geometry,
                transform: Default::default(),
                material_ref: "mat:free".to_string(),
                region_name: None,
                magnetization_ref: Some("mag:free".to_string()),
                region_overrides: Default::default(),
                physics_stack: vec![],
                object_mesh: None,
                mesh_override: None,
                notes: None,
                visible: true,
                locked: false,
                tags: vec!["mesh:dirty".to_string()],
            }],
            version: "scene.v1".to_string(),
            scene: SceneMetadata::default(),
            universe: None,
            current_modules: SceneCurrentModulesState::default(),
            study: SceneStudyState::default(),
            outputs: SceneOutputsState::default(),
            editor: SceneEditorState::default(),
        }
    }

    #[test]
    fn box_scene_realizes_with_bounds_and_dirty_state() {
        let scene = scene_with_object(SceneGeometry {
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
    fn unsupported_csg_blocks_mesh_build() {
        let scene = scene_with_object(SceneGeometry {
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
}
