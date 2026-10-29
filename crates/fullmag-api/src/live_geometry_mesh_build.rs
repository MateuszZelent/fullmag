//! Geometry-only FEM mesh build for the Docker live workspace (ADR 0074).
//!
//! The solver mesh is realized from the scene geometry, universe and mesh
//! policies. Materials, initial state, interactions and study stages are not
//! read, and no RunIntent is created: editing the scene afterwards makes the
//! published mesh stale instead of locking the authored inputs.

use std::path::Path;
use std::sync::Arc;

use fullmag_authoring::{SceneDocument, ScriptBuilderMeshState};
use fullmag_ir::{FemDomainRegionMarkerIR, FemSharedDomainBuildReportIR, MeshIR};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::error::ApiError;
use crate::router_v2::handlers::simulation::commands::{
    scene_object_geometry_entry, scene_per_geometry_mesh_options,
    study_universe_for_problem_patch,
};
use crate::types::{AppState, CurrentLiveRequestContext, CurrentLiveSnapshotRequest};

const GEOMETRY_MESH_BUILD_SCHEMA: &str = "fullmag.geometry_mesh_build.v1";
const MESH_NAME: &str = "study_domain";
/// Exit code of `fullmag.meshing.geometry_mesh_build` for an authored input
/// that cannot be meshed; its message is shown to the user unchanged.
const USER_FACING_EXIT_CODE: i32 = 2;
/// ScriptBuilderMeshState stores these sizes as authored text.
const TEXT_NUMERIC_POLICY_KEYS: [&str; 12] = [
    "hmax",
    "hmin",
    "maximum_element_size",
    "minimum_element_size",
    "curvature_factor",
    "growth_rate",
    "maximum_element_growth_rate",
    "narrow_region_resolution",
    "resolved_growth_rate",
    "interface_hmax",
    "interface_thickness",
    "transition_growth",
];

#[derive(Debug, Deserialize)]
struct GeometryMeshBuildOutput {
    schema: String,
    mesh: MeshIR,
    #[serde(default)]
    region_markers: Vec<FemDomainRegionMarkerIR>,
    #[serde(default)]
    quality: Option<Value>,
    #[serde(default)]
    mesh_statistics: Option<Value>,
    #[serde(default)]
    mesh_provenance: Option<Value>,
    #[serde(default)]
    quality_data_artifact: Option<Value>,
}

/// Mesher options from the shared-domain policy: authored text sizes become
/// numbers and empty text means "not authored".
fn shared_domain_mesh_options(policy: &ScriptBuilderMeshState) -> Result<Map<String, Value>, ApiError> {
    let Value::Object(mut options) = serde_json::to_value(policy).map_err(|error| {
        ApiError::internal(format!("failed to encode the shared-domain mesh policy: {error}"))
    })?
    else {
        return Err(ApiError::internal("shared-domain mesh policy is not an object"));
    };
    options.retain(|_, value| !matches!(value, Value::String(text) if text.trim().is_empty()));
    for key in TEXT_NUMERIC_POLICY_KEYS {
        let Some(Value::String(text)) = options.get(key).cloned() else {
            continue;
        };
        // Non-numeric text such as "auto" is interpreted by the mesher.
        if let Ok(number) = text.trim().parse::<f64>() {
            if !number.is_finite() || number <= 0.0 {
                return Err(ApiError::bad_request(format!(
                    "Shared-domain mesh policy '{key}' must be a positive number."
                )));
            }
            options.insert(key.to_string(), json!(number));
        }
    }
    options.remove("order");
    Ok(options)
}

fn positive_number(value: Option<&Value>) -> Option<f64> {
    let number = match value? {
        Value::Number(number) => number.as_f64()?,
        Value::String(text) => text.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    (number.is_finite() && number > 0.0).then_some(number)
}

/// Body target: the shared-domain h_max, otherwise the coarsest object target
/// when every meshed object authors its own. `None` is reported by the mesher
/// as a user-facing "set h_max" error rather than replaced by a default.
fn body_hmax(options: &Map<String, Value>, per_geometry: &[Value], object_count: usize) -> Option<f64> {
    if let Some(hmax) =
        positive_number(options.get("hmax")).or_else(|| positive_number(options.get("maximum_element_size")))
    {
        return Some(hmax);
    }
    let object_targets = per_geometry
        .iter()
        .filter_map(|entry| {
            positive_number(entry.get("hmax")).or_else(|| positive_number(entry.get("maximum_element_size")))
        })
        .collect::<Vec<_>>();
    (object_count > 0 && object_targets.len() == object_count)
        .then(|| object_targets.into_iter().fold(0.0_f64, f64::max))
}

/// Scene lowering for the mesher; geometry names are the immutable object ids.
pub(crate) fn geometry_only_mesh_payload(scene: &SceneDocument) -> Result<Value, ApiError> {
    let mut geometries = Vec::new();
    let mut geometry_object_ids = Map::new();
    for object in fullmag_authoring::scene_solve_objects(scene) {
        geometries.push(scene_object_geometry_entry(object, &object.id)?);
        geometry_object_ids.insert(object.id.clone(), Value::String(object.id.clone()));
    }
    let mut options = shared_domain_mesh_options(&scene.study.shared_domain_mesh)?;
    let per_geometry = match scene_per_geometry_mesh_options(scene)? {
        Some(Value::Array(entries)) => entries,
        _ => Vec::new(),
    };
    let hmax = body_hmax(&options, &per_geometry, geometries.len());
    options.insert("per_geometry".to_string(), Value::Array(per_geometry));
    Ok(json!({
        "geometries": geometries,
        "geometry_object_ids": geometry_object_ids,
        "declared_universe": study_universe_for_problem_patch(scene)?,
        "hmax": hmax,
        "order": scene.study.shared_domain_mesh.order.unwrap_or(1),
        "mesh_name": MESH_NAME,
        "mesh_options": options,
    }))
}

fn helper_error_message(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    text.lines()
        .rev()
        .find_map(|line| {
            serde_json::from_str::<Value>(line.trim())
                .ok()
                .and_then(|value| value.get("error").and_then(Value::as_str).map(str::to_owned))
        })
        .unwrap_or_else(|| {
            let tail = text.trim();
            let skip = tail.chars().count().saturating_sub(2000);
            tail.chars().skip(skip).collect()
        })
}

fn run_geometry_mesh_build(repo_root: &Path, payload: &Value) -> Result<GeometryMeshBuildOutput, ApiError> {
    let payload_text = serde_json::to_string(payload)
        .map_err(|error| ApiError::internal(format!("failed to encode mesh build input: {error}")))?;
    // A JSON string literal is a valid Python string literal.
    let payload_literal = serde_json::to_string(&payload_text)
        .map_err(|error| ApiError::internal(format!("failed to quote mesh build input: {error}")))?;
    let script = format!(
        "import io, sys; sys.stdin = io.StringIO({payload_literal}); \
         from fullmag.meshing.geometry_mesh_build import main; main()"
    );
    let output = crate::script::run_python_helper(repo_root, &["-c".to_string(), script])?;
    if !output.status.success() {
        let message = helper_error_message(&output.stderr);
        return Err(if output.status.code() == Some(USER_FACING_EXIT_CODE) {
            ApiError::bad_request(message)
        } else {
            ApiError::unprocessable_with_code("geometry_mesh_build_failed", message)
        });
    }
    let parsed: GeometryMeshBuildOutput = serde_json::from_slice(&output.stdout).map_err(|error| {
        ApiError::internal(format!("geometry mesh build returned an invalid result: {error}"))
    })?;
    if parsed.schema != GEOMETRY_MESH_BUILD_SCHEMA {
        return Err(ApiError::internal(format!(
            "geometry mesh build returned schema '{}', expected '{GEOMETRY_MESH_BUILD_SCHEMA}'",
            parsed.schema
        )));
    }
    Ok(parsed)
}

fn quality_summary(quality: Option<&Value>) -> Value {
    let Some(quality) = quality else {
        return Value::Null;
    };
    json!({
        "n_elements": quality.get("nElements"),
        "sicn_min": quality.get("sicnMin"),
        "sicn_max": quality.get("sicnMax"),
        "sicn_mean": quality.get("sicnMean"),
        "sicn_p5": quality.get("sicnP5"),
        "gamma_min": quality.get("gammaMin"),
        "gamma_mean": quality.get("gammaMean"),
        "avg_quality": quality.get("avgQuality"),
    })
}

fn mesh_bounds(mesh: &MeshIR) -> (Value, Value) {
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for node in &mesh.nodes {
        for axis in 0..3 {
            min[axis] = min[axis].min(node[axis]);
            max[axis] = max[axis].max(node[axis]);
        }
    }
    if mesh.nodes.is_empty() {
        return (Value::Null, Value::Null);
    }
    (json!(min), json!(max))
}

struct GeometryMeshPublication {
    fem_mesh: fullmag_runner::FemMeshPayload,
    mesh_workspace: Value,
}

fn geometry_mesh_publication(
    output: GeometryMeshBuildOutput,
    command_id: &str,
    source_scene_revision: u64,
    previous_history: Vec<Value>,
    canonical_policy_snapshot: Value,
) -> Result<GeometryMeshPublication, ApiError> {
    let (mesh, object_segments, mesh_parts) =
        fullmag_plan::pack_geometry_only_shared_domain_mesh(&output.mesh, &output.region_markers)
            .map_err(|reason| ApiError::unprocessable_with_code("geometry_mesh_packing_failed", reason))?;
    let provenance = output.mesh_provenance.unwrap_or(Value::Null);
    let build_report = provenance
        .get("shared_domain_build_report")
        .cloned()
        .and_then(|report| serde_json::from_value::<FemSharedDomainBuildReportIR>(report).ok());
    let fem_mesh = fullmag_runner::FemMeshPayload::from_geometry_only_domain_mesh(
        &mesh,
        &object_segments,
        &mesh_parts,
        build_report,
    );
    let quality_summary = quality_summary(output.quality.as_ref());
    let (bounds_min, bounds_max) = mesh_bounds(&mesh);
    let build_id = format!("mesh:{command_id}");
    let hmax = provenance.get("hmax").cloned().unwrap_or(Value::Null);
    let effective_airbox_target = provenance
        .get("effective_airbox_target")
        .cloned()
        .unwrap_or(Value::Null);
    let effective_per_object_targets = provenance
        .get("effective_per_object_targets")
        .cloned()
        .unwrap_or(Value::Null);
    let summary = json!({
        "kind": "mesh_build_summary",
        "command_id": command_id,
        "build_id": build_id,
        "status": "completed",
        "mesh_generation_id": fem_mesh.generation_id,
        "mesh_target": "study_domain",
        "mesh_reason": "geometry_only_build",
        "source_scene_revision": source_scene_revision,
        "canonical_policy_snapshot": canonical_policy_snapshot,
        "shared_domain_build_mode": provenance.get("shared_domain_build_mode"),
        "effective_airbox_target": effective_airbox_target,
        "effective_per_object_targets": effective_per_object_targets,
        "node_count": mesh.nodes.len(),
        "element_count": mesh.cell_count(),
        "boundary_face_count": mesh.facet_count(),
    });
    let mut history = previous_history;
    history.push(json!({
        "command_id": command_id,
        "build_id": build_id,
        "status": "completed",
        "mesh_generation_id": fem_mesh.generation_id,
        "mesh_name": mesh.mesh_name,
        "generation_mode": "geometry_only_shared_domain",
        "node_count": mesh.nodes.len(),
        "element_count": mesh.cell_count(),
        "boundary_face_count": mesh.facet_count(),
        "quality": quality_summary,
        "mesh_target": "study_domain",
        "mesh_reason": "geometry_only_build",
        "source_scene_revision": source_scene_revision,
        "canonical_policy_snapshot": summary["canonical_policy_snapshot"],
        "mesh_provenance": provenance,
        "mesh_statistics": output.mesh_statistics,
        "quality_data_artifact": output.quality_data_artifact,
    }));
    let mesh_workspace = json!({
        "status": "completed",
        "source_scene_revision": source_scene_revision,
        "active_build": null,
        "last_build_error": null,
        "mesh_summary": {
            "mesh_id": fem_mesh.mesh_id,
            "mesh_name": mesh.mesh_name,
            "backend": "fem",
            "source_kind": "geometry_only_shared_domain",
            "order": provenance.get("order"),
            "hmax": hmax,
            "node_count": mesh.nodes.len(),
            "element_count": mesh.cell_count(),
            "boundary_face_count": mesh.facet_count(),
            "bounds_min": bounds_min,
            "bounds_max": bounds_max,
            "domain_mesh_mode": fem_mesh.domain_mesh_mode,
            "generation_id": fem_mesh.generation_id,
        },
        "mesh_quality_summary": quality_summary,
        "quality_data_artifact": output.quality_data_artifact,
        "mesh_statistics": output.mesh_statistics,
        "mesh_cost_report": {
            "node_count": mesh.nodes.len(),
            "element_count": mesh.cell_count(),
            "boundary_face_count": mesh.facet_count(),
            "status": "completed",
        },
        "effective_airbox_target": summary["effective_airbox_target"],
        "effective_per_object_targets": summary["effective_per_object_targets"],
        "mesh_pipeline_status": [{
            "id": "remesh",
            "status": "completed",
            "detail": "geometry-only shared-domain mesh published",
        }],
        "mesh_history": history,
        "last_build_summary": summary,
    });
    Ok(GeometryMeshPublication { fem_mesh, mesh_workspace })
}

/// Mesh the current scene and publish the result into the live read model.
/// The caller owns the command journal record; this function only produces
/// the mesh and fails without mutating the workspace when meshing fails.
pub(crate) async fn build_and_publish_geometry_mesh(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
    command_id: &str,
) -> Result<(), ApiError> {
    let (scene, previous_history) = {
        let current = state.current_live_state.read().await;
        let snapshot = current
            .as_ref()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        crate::ensure_current_live_request_context(
            snapshot,
            context,
            state
                .current_live_session_epoch
                .load(std::sync::atomic::Ordering::Acquire),
        )?;
        let scene = snapshot
            .scene_document
            .clone()
            .ok_or_else(|| ApiError::not_found("no scene document available for meshing"))?;
        let history = snapshot
            .mesh_workspace
            .as_deref()
            .and_then(|workspace| workspace.get("mesh_history"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        (scene, history)
    };
    let payload = geometry_only_mesh_payload(&scene)?;
    let canonical_policy_snapshot = json!({
        "universe": scene.study.universe_mesh.as_ref().or(scene.universe.as_ref()),
        "shared_domain": scene.study.shared_domain_mesh,
        "objects": payload["mesh_options"]["per_geometry"],
    });
    let repo_root = state.repo_root.clone();
    let output = tokio::task::spawn_blocking(move || run_geometry_mesh_build(&repo_root, &payload))
        .await
        .map_err(|error| ApiError::internal(format!("geometry mesh build task failed: {error}")))??;
    let publication = geometry_mesh_publication(
        output,
        command_id,
        scene.revision,
        previous_history,
        canonical_policy_snapshot,
    )?;

    {
        let _transition = state.current_live_session_transition.lock().await;
        let mut current = state.current_live_state.write().await;
        let snapshot = current
            .as_mut()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        crate::ensure_current_live_request_context(
            snapshot,
            context,
            state
                .current_live_session_epoch
                .load(std::sync::atomic::Ordering::Acquire),
        )?;
        let mut published = snapshot.clone();
        crate::session::apply_current_live_snapshot(
            &mut published,
            CurrentLiveSnapshotRequest {
                session_id: context.session_id.clone(),
                session: None,
                session_status: None,
                metadata: None,
                mesh_workspace: Some(publication.mesh_workspace),
                stage_execution: None,
                simulation_preparation: None,
                run: None,
                live_state: None,
                frozen_spins_runtime_status: None,
                coupled_checkpoint: None,
                latest_scalar_row: None,
                latest_fields: None,
                replace_latest_fields: false,
                field_generation: None,
                preview_fields: None,
                clear_preview_cache: false,
                engine_log: None,
                solver_profile: None,
                fem_mesh: Some(publication.fem_mesh),
            },
        )?;
        *snapshot = published;
    }
    if let Some(snapshot) = state.current_live_state.read().await.as_ref().cloned() {
        let display_revision = state.current_display_selection.read().await.revision;
        let realtime_state =
            crate::current_live_realtime_state_from_snapshot(state, &snapshot, display_revision)
                .await;
        crate::publish_current_live_realtime_batch_changed(state, &realtime_state, false, 0).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_domain_options_parse_authored_text_and_drop_unset_values() {
        let policy = ScriptBuilderMeshState {
            hmax: "1e-8".to_string(),
            hmin: String::new(),
            optimize: "Netgen".to_string(),
            order: Some(2),
            ..ScriptBuilderMeshState::default()
        };

        let options = shared_domain_mesh_options(&policy).unwrap();

        assert_eq!(options.get("hmax"), Some(&json!(1e-8)));
        assert!(!options.contains_key("hmin"));
        assert!(!options.contains_key("order"));
        assert_eq!(options.get("optimize"), Some(&json!("Netgen")));
    }

    #[test]
    fn body_hmax_requires_a_shared_or_complete_object_target() {
        let unset = Map::new();
        let objects = vec![json!({"hmax": "2e-8"}), json!({"maximum_element_size": 3e-8})];

        assert_eq!(body_hmax(&unset, &objects, 2), Some(3e-8));
        assert_eq!(body_hmax(&unset, &objects[..1], 2), None);
        let mut shared = Map::new();
        shared.insert("hmax".to_string(), json!(1e-8));
        assert_eq!(body_hmax(&shared, &[], 2), Some(1e-8));
    }
}
