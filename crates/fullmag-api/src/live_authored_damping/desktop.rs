//! Coefficient preview on the FEM carrier published by an idle desktop mesh command.

use std::path::Path;
use std::sync::Arc;

use fullmag_authoring::SceneDocument;
use fullmag_ir::{BackendPlanIR, ExecutionPlanIR};
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::types::SessionStateResponse;

pub(super) fn idle(snapshot: &SessionStateResponse) -> bool {
    let idle_status = |status: &str| matches!(status, "waiting_for_compute" | "awaiting_command");
    idle_status(&snapshot.session.status)
        && snapshot
            .run
            .as_ref()
            .is_none_or(|run| run.run_id == snapshot.session.run_id && idle_status(&run.status))
        && snapshot
            .live_state
            .as_ref()
            .is_none_or(|live| idle_status(&live.status))
        && snapshot.stage_execution.as_ref().is_none_or(|stage| {
            !matches!(
                stage.runtime_state.as_str(),
                "running" | "paused" | "stopping"
            )
        })
}

/// The journal's mesh command binds a scene topology digest and a scene
/// revision. Its result binds the generation, while the plan and the selected
/// mesh independently carry the node order, markers and object ownership.
fn qualified_build_generation<'a>(
    snapshot: &'a SessionStateResponse,
    scene: &SceneDocument,
) -> Option<&'a str> {
    if !idle(snapshot) {
        return None;
    }
    let metadata = snapshot.metadata.as_ref()?;
    let workspace = snapshot.mesh_workspace.as_ref()?;
    let summary = workspace.get("last_build_summary")?;
    let source_revision = summary["source_scene_revision"].as_u64()?;
    let mesh = snapshot.fem_mesh.as_ref()?;
    let generation = mesh.generation_id.as_deref()?;
    if !workspace["active_build"].is_null()
        || !workspace["last_build_error"].is_null()
        || workspace.get("accepted_run_id").is_some()
        || summary["status"] != "completed"
        || !matches!(
            metadata["status"].as_str(),
            Some("waiting_for_compute" | "awaiting_command")
        )
        || metadata
            .pointer("/problem_meta/runtime_metadata/mesh_source_scene_revision")?
            .as_u64()
            != Some(source_revision)
        || source_revision > scene.revision
        || summary["mesh_generation_id"].as_str() != Some(generation)
        || summary
            .pointer("/mesh_options/authored_mesh_input_sha256")?
            .as_str()?
            != fullmag_session::canonical_json_sha256(&crate::scene_mesh_signature(scene))
    {
        return None;
    }
    Some(generation)
}

pub(crate) fn published_mesh_is_current(
    snapshot: &SessionStateResponse,
    scene: &SceneDocument,
) -> Option<bool> {
    let workspace = snapshot.mesh_workspace.as_ref()?;
    let metadata = snapshot.metadata.as_ref()?;
    if !idle(snapshot)
        || workspace.get("accepted_run_id").is_some()
        || !matches!(metadata["status"].as_str(), Some("waiting_for_compute" | "awaiting_command"))
    {
        return None;
    }
    let binding = metadata.get(super::PUBLICATION)?.get("desktop_domain")?;
    Some(
        qualified_build_generation(snapshot, scene).is_some()
            && domain_identity(snapshot).as_ref() == Some(binding),
    )
}

fn qualified_plan(
    snapshot: &SessionStateResponse,
    scene: &SceneDocument,
) -> Option<Arc<ExecutionPlanIR>> {
    let generation = qualified_build_generation(snapshot, scene)?;
    let mesh = snapshot.fem_mesh.as_ref()?;
    let plan = snapshot.metadata.as_ref()?.execution_plan()?;
    let BackendPlanIR::Fem(fem) = &plan.backend_plan else {
        return None;
    };
    if fem.fe_order != 1 || mesh.cells.is_empty() {
        return None;
    }
    let expected = fullmag_runner::FemMeshPayload::from(fem);
    if expected.generation_id.as_deref() != Some(generation)
        || fullmag_runner::fem_mesh_topology_fingerprint(&expected) != mesh.topology_fingerprint()
        || serde_json::to_value(&expected.object_segments).ok()?
            != serde_json::to_value(&mesh.object_segments).ok()?
    {
        return None;
    }
    Some(plan)
}

pub(super) fn domain_identity(snapshot: &SessionStateResponse) -> Option<Value> {
    let mesh = snapshot.fem_mesh.as_ref()?;
    Some(json!({
        "generation_id": mesh.generation_id,
        "topology_sha256": mesh.topology_fingerprint(),
        "object_segments_sha256": fullmag_session::canonical_json_sha256(
            &serde_json::to_value(&mesh.object_segments).ok()?),
    }))
}

fn nodal_field(
    snapshot: &SessionStateResponse,
    plan: &ExecutionPlanIR,
    values: &[f64],
    revision: u64,
) -> Option<Value> {
    let BackendPlanIR::Fem(fem) = &plan.backend_plan else {
        return None;
    };
    if values.len() != fem.mesh.nodes.len() || !values.iter().all(|value| value.is_finite()) {
        return None;
    }
    let layout = fullmag_runner::study_magnetization_layout_for_plan(plan).ok()?;
    Some(
        json!({"values": values, "layout": layout, "source_revision": revision, "desktop_domain": domain_identity(snapshot)?,
        "sample_location": "node", "authored_damping_revision": revision}),
    )
}

/// CLI session and runtime frames may arrive separately. Publish once both
/// halves of the successful build match the still-committed authored settings.
pub(crate) fn publish_completed_build(snapshot: &mut SessionStateResponse) -> bool {
    let Some(previous_revision) = super::publication_revision(snapshot) else {
        return false;
    };
    let Some(scene) = snapshot.scene_document.as_ref() else {
        return false;
    };
    // The scene can advance without changing its damping. A freshly built
    // plan is authoritative for its exact scene revision, even when the
    // previous coefficient publication predates a metadata-only edit.
    let revision = scene.revision;
    if previous_revision > revision || snapshot.latest_fields.get("mat_alpha").is_some()
        || snapshot
            .mesh_workspace
            .as_ref()
            .and_then(|w| w.pointer("/last_build_summary/source_scene_revision"))
            .and_then(Value::as_u64)
            != Some(revision)
    {
        return false;
    }
    let Some(plan) = qualified_plan(snapshot, scene) else {
        return false;
    };
    let BackendPlanIR::Fem(fem) = &plan.backend_plan else {
        return false;
    };
    let uniform;
    let values = match fem.material.alpha_field.as_deref() {
        Some(values) => values,
        None => {
            uniform = vec![fem.material.damping; fem.mesh.nodes.len()];
            &uniform
        }
    };
    let Some(field) = nodal_field(snapshot, &plan, values, revision) else {
        return false;
    };
    snapshot.metadata.as_mut().expect("qualified CLI plan")[super::PUBLICATION] =
        super::binding(revision, Some(&field));
    crate::session::replace_authored_damping(snapshot, Some(field));
    true
}

pub(super) fn evaluate_edit(
    repo: &Path,
    workspace: &Path,
    snapshot: &SessionStateResponse,
    scene: &SceneDocument,
    revision: u64,
) -> Result<Option<Value>, ApiError> {
    let Some(plan) = qualified_plan(snapshot, scene) else {
        return Ok(None);
    };
    let BackendPlanIR::Fem(fem) = &plan.backend_plan else {
        return Ok(None);
    };
    let requested = fullmag_application::RequestedExecution {
        backend: scene.study.requested_backend.clone(),
        device: scene.study.requested_device.clone(),
        precision: scene.study.requested_precision.clone(),
        mode: scene.study.requested_mode.clone(),
        minimum_resources: None,
    };
    let script = Path::new(&snapshot.session.script_path);
    let asset_root = script.is_absolute().then(|| script.parent()).flatten();
    let problem = crate::script::scene_document_to_authored_problem_ir_with_asset_root(
        repo, workspace, asset_root, scene, &requested,
    )?;
    let values = fullmag_plan::damping_on_geometry_mesh(&problem, &fem.mesh, &fem.object_segments)
        .map_err(|error| {
            ApiError::unprocessable(format!("evaluate edited FEM damping: {error}"))
        })?;
    Ok(nodal_field(snapshot, &plan, &values, revision))
}
