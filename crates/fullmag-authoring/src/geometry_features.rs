//! Stable authored geometry feature sequences.
//!
//! A `SceneGeometry` predates the feature-sequence authoring model and stores
//! the current geometry as a kind plus a JSON parameter object.  This module
//! exposes a lossless, backend-neutral view of that existing shape: every
//! node receives a stable path-derived identity, nested CSG inputs retain
//! their parent-child lineage, and an object's transform is represented as an
//! explicit final feature.  The sequence is descriptive only; meshing and
//! solver preparation remain separate consumers.

use crate::{GeometryDiagnostic, GeometryDiagnosticSeverity, SceneDocument, SceneGeometry};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// One authored geometry operation in a stable feature sequence.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GeometryFeature {
    /// Stable within the object and independent of scene/object ordering.
    pub feature_id: String,
    /// Canonical source path, for example `objects/film/geometry/base`.
    pub path: String,
    /// Scene object owning the feature.
    pub object_id: String,
    /// Authored operation kind, such as `Box`, `Difference`, or `transform`.
    pub kind: String,
    /// Original typed parameters, retained for round-trip and diagnostics.
    #[serde(default)]
    pub parameters: Value,
    /// Feature IDs consumed by this operation in source order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub input_feature_ids: Vec<String>,
}

/// Stable feature sequence and diagnostics for one scene object.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GeometryFeatureSequence {
    pub object_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_feature_id: Option<String>,
    #[serde(default)]
    pub features: Vec<GeometryFeature>,
    #[serde(default)]
    pub diagnostics: Vec<GeometryDiagnostic>,
}

/// Lower one existing scene object into a stable, inspectable feature sequence.
///
/// Unknown or malformed child nodes are retained as diagnostics and never
/// silently discarded.  The function does not call a mesher or mutate the
/// scene.
pub fn build_geometry_feature_sequence(
    scene: &SceneDocument,
    object_id: &str,
) -> GeometryFeatureSequence {
    let mut result = GeometryFeatureSequence {
        object_id: object_id.to_string(),
        terminal_feature_id: None,
        features: Vec::new(),
        diagnostics: Vec::new(),
    };
    let Some(object) = scene.objects.iter().find(|object| object.id == object_id) else {
        result.diagnostics.push(diagnostic(
            "GEOMETRY_OBJECT_NOT_FOUND",
            format!("Scene object '{object_id}' does not exist."),
            object_id,
            None,
            &["realize_geometry", "build_mesh", "run_solver"],
        ));
        return result;
    };

    let root_path = format!("objects/{object_id}/geometry");
    let terminal = append_geometry_node(
        object_id,
        &root_path,
        &object.geometry,
        &mut result.features,
        &mut result.diagnostics,
    );

    // Keep the transform as a first-class feature.  This makes rotation and
    // scale explicit in the authoring lineage instead of burying them in a
    // mesh identity or dropping them at a backend boundary.
    let transform_path = format!("objects/{object_id}/transform");
    let transform_id = feature_id(object_id, &transform_path);
    let transform_parameters = serde_json::to_value(&object.transform).unwrap_or(Value::Null);
    result.features.push(GeometryFeature {
        feature_id: transform_id.clone(),
        path: transform_path,
        object_id: object_id.to_string(),
        kind: "transform".to_string(),
        parameters: transform_parameters,
        input_feature_ids: terminal.into_iter().collect(),
    });
    result.terminal_feature_id = Some(transform_id);
    result
}

fn append_geometry_node(
    object_id: &str,
    path: &str,
    geometry: &SceneGeometry,
    features: &mut Vec<GeometryFeature>,
    diagnostics: &mut Vec<GeometryDiagnostic>,
) -> String {
    let mut input_feature_ids = Vec::new();
    for (role, child) in child_geometries(geometry) {
        let child_path = format!("{path}/{role}");
        input_feature_ids.push(append_geometry_node(
            object_id,
            &child_path,
            &child,
            features,
            diagnostics,
        ));
    }

    let id = feature_id(object_id, path);
    features.push(GeometryFeature {
        feature_id: id.clone(),
        path: path.to_string(),
        object_id: object_id.to_string(),
        kind: geometry.geometry_kind.clone(),
        parameters: geometry.geometry_params.clone(),
        input_feature_ids,
    });

    if geometry.geometry_kind.trim().is_empty() {
        diagnostics.push(diagnostic(
            "GEOMETRY_FEATURE_KIND_EMPTY",
            "Geometry feature kind must not be empty.",
            object_id,
            Some(path),
            &["realize_geometry", "build_mesh", "run_solver"],
        ));
    }
    id
}

fn child_geometries(geometry: &SceneGeometry) -> Vec<(String, SceneGeometry)> {
    let mut children = Vec::new();
    match geometry.geometry_kind.as_str() {
        "Difference" => {
            for role in ["base", "tool"] {
                if let Some(child) = geometry.geometry_params.get(role).and_then(parse_geometry) {
                    children.push((role.to_string(), child));
                }
            }
        }
        "Csg" => {
            if let Some(values) = geometry
                .geometry_params
                .get("children")
                .and_then(Value::as_array)
            {
                for (index, value) in values.iter().enumerate() {
                    if let Some(child) = parse_geometry(value) {
                        children.push((format!("children/{index}"), child));
                    }
                }
            }
        }
        "Union" | "Intersection" => {
            for role in ["a", "b"] {
                if let Some(child) = geometry.geometry_params.get(role).and_then(parse_geometry) {
                    children.push((role.to_string(), child));
                }
            }
        }
        "Translate" => {
            if let Some(child) = geometry
                .geometry_params
                .get("base")
                .and_then(parse_geometry)
            {
                children.push(("base".to_string(), child));
            }
        }
        _ => {}
    }
    children
}

fn parse_geometry(value: &Value) -> Option<SceneGeometry> {
    if let Ok(geometry) = serde_json::from_value::<SceneGeometry>(value.clone()) {
        return Some(geometry);
    }
    let object = value.as_object()?;
    let kind = object
        .get("geometry_kind")
        .or_else(|| object.get("kind"))?
        .as_str()?
        .to_string();
    let parameters = object
        .get("geometry_params")
        .cloned()
        .unwrap_or_else(|| Value::Object(object.clone()));
    Some(SceneGeometry {
        geometry_kind: kind,
        geometry_params: parameters,
        bounds_min: None,
        bounds_max: None,
    })
}

fn feature_id(object_id: &str, path: &str) -> String {
    format!(
        "feature:{}:{}",
        slug_token(object_id),
        fnv1a64_hex(path.as_bytes())
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

fn diagnostic(
    code: &str,
    message: impl Into<String>,
    object_id: &str,
    geometry_path: Option<&str>,
    blocks: &[&str],
) -> GeometryDiagnostic {
    GeometryDiagnostic {
        id: format!("{code}:{object_id}"),
        severity: GeometryDiagnosticSeverity::Error,
        code: code.to_string(),
        message: message.into(),
        object_id: Some(object_id.to_string()),
        geometry_path: geometry_path.map(str::to_string),
        blocks: blocks.iter().map(|value| (*value).to_string()).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scene_with_geometry(geometry: SceneGeometry) -> SceneDocument {
        let mut scene = SceneDocument::default();
        scene.objects.push(crate::SceneObject {
            id: "film".to_string(),
            name: "Film".to_string(),
            role: "magnet".to_string(),
            geometry,
            transform: crate::Transform3D::default(),
            material_ref: "mat".to_string(),
            region_name: None,
            magnetization_ref: None,
            region_overrides: Default::default(),
            physics_stack: Vec::new(),
            object_mesh: None,
            mesh_override: None,
            regions: Vec::new(),
            allocated_region_ids: Vec::new(),
            material_parameter_fields: Vec::new(),
            absorbing_boundary: None,
            notes: None,
            visible: true,
            locked: false,
            tags: Vec::new(),
        });
        scene
    }

    #[test]
    fn feature_ids_and_paths_are_stable_for_nested_csg() {
        let scene = scene_with_geometry(SceneGeometry {
            geometry_kind: "Difference".to_string(),
            geometry_params: json!({
                "base": {"geometry_kind": "Box", "geometry_params": {"size": [4.0, 4.0, 1.0]}},
                "tool": {"geometry_kind": "Cylinder", "geometry_params": {"radius": 0.5, "height": 2.0}}
            }),
            bounds_min: None,
            bounds_max: None,
        });
        let first = build_geometry_feature_sequence(&scene, "film");
        let mut reordered = scene.clone();
        reordered.objects.reverse();
        let second = build_geometry_feature_sequence(&reordered, "film");
        assert_eq!(first, second);
        assert_eq!(first.features.len(), 4); // base, tool, difference, transform
        assert_eq!(first.features[0].path, "objects/film/geometry/base");
        assert_eq!(first.features[1].path, "objects/film/geometry/tool");
        assert_eq!(first.features[2].input_feature_ids.len(), 2);
        assert_eq!(first.features[3].kind, "transform");
        assert!(first.diagnostics.is_empty());
    }

    #[test]
    fn malformed_or_missing_objects_fail_closed_with_a_diagnostic() {
        let scene = SceneDocument::default();
        let missing = build_geometry_feature_sequence(&scene, "missing");
        assert!(missing.features.is_empty());
        assert_eq!(missing.diagnostics[0].code, "GEOMETRY_OBJECT_NOT_FOUND");

        let malformed = scene_with_geometry(SceneGeometry {
            geometry_kind: String::new(),
            geometry_params: Value::Object(Map::new()),
            bounds_min: None,
            bounds_max: None,
        });
        let sequence = build_geometry_feature_sequence(&malformed, "film");
        assert_eq!(sequence.diagnostics[0].code, "GEOMETRY_FEATURE_KIND_EMPTY");
        assert_eq!(sequence.terminal_feature_id.is_some(), true);
    }

    #[test]
    fn transform_is_explicit_and_preserves_rotation_and_scale() {
        let mut scene = scene_with_geometry(SceneGeometry {
            geometry_kind: "Box".to_string(),
            geometry_params: json!({"size": [1.0, 2.0, 3.0]}),
            bounds_min: None,
            bounds_max: None,
        });
        scene.objects[0].transform.translation = [1.0, 2.0, 3.0];
        scene.objects[0].transform.scale = [2.0, 1.0, 0.5];
        let sequence = build_geometry_feature_sequence(&scene, "film");
        let transform = sequence.features.last().expect("transform feature");
        assert_eq!(transform.kind, "transform");
        assert_eq!(transform.parameters["translation"], json!([1.0, 2.0, 3.0]));
        assert_eq!(transform.parameters["scale"], json!([2.0, 1.0, 0.5]));
        assert_eq!(transform.input_feature_ids.len(), 1);
    }
}
