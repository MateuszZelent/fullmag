//! Projection of a material onto the selected, already built geometry-only mesh.

use std::path::Path;
use std::sync::Arc;

use fullmag_authoring::SceneDocument;
use fullmag_ir::BackendPlanIR;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::live_geometry_mesh_build as mesh_build;
use crate::types::{AppState, CurrentLiveRequestContext, SessionStateResponse};

/// Clear values on the old domain in the same transaction that installs the mesh.
pub(crate) fn invalidate_for_build(snapshot: &mut SessionStateResponse, revision: u64) -> bool {
    let needs_field = snapshot.scene_document.as_ref().is_some_and(|scene| {
        scene
            .objects
            .iter()
            .any(|object| object.absorbing_boundary.is_some())
            || has_material_inputs(scene)
    });
    if !needs_field && super::publication_revision(snapshot).is_none() {
        return false;
    }
    snapshot.metadata.get_or_insert_with(|| json!({}).into())[super::PUBLICATION] =
        super::binding(revision, None);
    crate::session::replace_authored_damping(snapshot, None);
    true
}

pub(super) fn has_material_inputs(scene: &SceneDocument) -> bool {
    scene.study.requested_backend.eq_ignore_ascii_case("fem")
        && fullmag_authoring::scene_solve_objects(scene)
            .next()
            .is_some()
        && !fullmag_authoring::scene_document_has_unresolved_solve_prerequisites(scene)
}

#[derive(Debug)]
pub(super) enum Evaluation {
    Ready(Value),
    Pending(String),
}

fn pending(reason: impl Into<String>) -> Result<Evaluation, ApiError> {
    Ok(Evaluation::Pending(reason.into()))
}

/// Editing coefficients and completing Build Mesh both use this path. Geometry
/// capture omits meshing; only the asset retained by the original build is used.
pub(super) fn evaluate(
    repo: &Path,
    workspace: &Path,
    store_root: Option<&Path>,
    context: &CurrentLiveRequestContext,
    snapshot: &SessionStateResponse,
    scene: &SceneDocument,
    revision: u64,
) -> Result<Evaluation, ApiError> {
    if !has_material_inputs(scene) {
        return pending("fem_material_or_initial_state_missing");
    }
    if mesh_build::bound_geometry_mesh_is_current(snapshot, scene) != Some(true) {
        return pending("geometry_input_binding_mismatch");
    }
    let Some(root) = store_root else { return pending("geometry_store_missing") };
    let Some(reference) = mesh_build::geometry_reuse_reference(snapshot, context) else {
        return pending("geometry_reuse_reference_unavailable");
    };
    let Some(mesh) = snapshot.fem_mesh.as_ref() else { return pending("geometry_mesh_missing") };
    let store = fullmag_session::SessionStore::open_existing(root.to_owned())
        .map_err(|error| ApiError::internal(format!("open geometry asset store: {error}")))?;
    let Some(asset) = mesh_build::load_geometry_reuse_asset(&store, scene, &reference)? else {
        return pending("geometry_cas_asset_input_mismatch");
    };
    if !mesh_build::can_qualify_live_geometry_reuse(scene, &asset) {
        return pending("geometry_asset_outside_supported_p1_reuse");
    }

    let requested = fullmag_application::RequestedExecution {
        backend: scene.study.requested_backend.clone(),
        device: scene.study.requested_device.clone(),
        precision: scene.study.requested_precision.clone(),
        mode: scene.study.requested_mode.clone(),
        minimum_resources: None,
    };
    let source = Path::new(&snapshot.session.script_path);
    let asset_root = source.is_absolute().then(|| source.parent()).flatten();
    let problem = crate::script::scene_document_to_authored_problem_ir_with_asset_root(
        repo, workspace, asset_root, scene, &requested,
    )?;
    let mut input = fullmag_application::StudyStepExecutionInput {
        step_id: "authored_damping".into(),
        problem,
        layers: scene.study.execution_layers.clone(),
    };
    if !mesh_build::bind_reused_geometry_to_inputs(
        repo,
        scene,
        &asset,
        &reference.provenance(),
        std::slice::from_mut(&mut input),
    )? {
        return pending("geometry_owner_or_mesh_recipe_mismatch");
    }
    let problem = match fullmag_application::bind_declared_execution(&input.problem, vec![]) {
        Ok(problem) => problem,
        Err(reason) => return pending(format!("geometry_execution_binding: {reason}")),
    };
    let plan = match fullmag_plan::plan(&problem) {
        Ok(plan) => plan,
        Err(reason) => return pending(format!("geometry_damping_plan: {reason}")),
    };
    let BackendPlanIR::Fem(fem) = &plan.backend_plan else {
        return pending("geometry_damping_plan_not_fem");
    };
    if fem.fe_order != 1 {
        return pending("geometry_damping_requires_p1");
    }
    let planned = fullmag_runner::FemMeshPayload::from(fem);
    if fullmag_runner::fem_mesh_topology_fingerprint(&planned) != mesh.topology_fingerprint() {
        return pending("geometry_node_topology_mismatch");
    }
    // The solver uses magnet names for packed segments, whereas Build Mesh
    // retains immutable scene IDs. Resolve that association via the authored IR.
    let owners: std::collections::BTreeMap<_, _> = problem
        .magnets
        .iter()
        .filter_map(|magnet| Some((magnet.name.as_str(), magnet.object_id.as_deref()?)))
        .collect();
    if planned.object_segments.len() != mesh.object_segments.len()
        || !planned
            .object_segments
            .iter()
            .zip(&mesh.object_segments)
            .all(|(solver, built)| {
                owners
                    .get(solver.object_id.as_str())
                    .copied()
                    .unwrap_or(solver.object_id.as_str())
                    == built.object_id
                    && (solver.node_start, solver.node_count)
                        == (built.node_start, built.node_count)
            })
    {
        return pending("geometry_node_ownership_mismatch");
    }
    let layout = match fullmag_runner::study_magnetization_layout_for_plan(&plan) {
        Ok(layout) => layout,
        Err(error) => return pending(format!("geometry_damping_layout: {}", error.message)),
    };
    let Some(mut field) = super::project_damping(plan.backend_plan, layout, revision) else {
        return pending("geometry_damping_projection_unavailable");
    };
    field["geometry_source"] = reference.provenance();
    field["mesh_topology_sha256"] = mesh.topology_fingerprint().into();
    Ok(Evaluation::Ready(field))
}

/// Build Mesh retains its own successful result when a partial scene has no
/// damping yet. A concurrent edit is fenced with the same checks as PATCH.
pub(crate) async fn refresh_after_build(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
    mut snapshot: SessionStateResponse,
) {
    let built_domain = crate::session::current_live_field_domain_identity(&snapshot);
    loop {
        let Some(scene) = snapshot.scene_document.clone() else {
            return;
        };
        let evaluation =
            super::prepare_snapshot(state, context.clone(), snapshot, scene, super::DampingUpdate::GeometryBuild).await;
        let prepared = match evaluation {
            Ok(value) => value,
            Err(error) => {
                tracing::warn!(%error, "damping preview unavailable on completed geometry mesh");
                return;
            }
        };
        let _transition = state.current_live_session_transition.lock().await;
        let mut live = state.current_live_state.write().await;
        let Some(current) = live.as_mut() else { return };
        if prepared.validate(state, current).is_ok() {
            if prepared.field.is_some() {
                prepared.publish(current);
            } else {
                // Build Mesh already retired the samples in its first transaction.
                current.metadata.get_or_insert_with(|| json!({}).into())[super::PUBLICATION] = prepared.binding;
            }
            current.state_version = current.state_version.wrapping_add(1);
            return;
        }
        if current.session.session_id != context.session_id
            || state
                .current_live_session_epoch
                .load(std::sync::atomic::Ordering::Acquire)
                != context.session_epoch
            || crate::session::current_live_field_domain_identity(current) != built_domain
            || current.metadata.as_ref().is_none_or(|m| {
                m[super::PUBLICATION]["samples_sha256"].is_string()
                    || m[super::PUBLICATION]["requires_domain_rebuild"] == true
                    || m.get("execution_plan").is_some()
            })
        {
            return;
        }
        snapshot = current.clone();
    }
}
