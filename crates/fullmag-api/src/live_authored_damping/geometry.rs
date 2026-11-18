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
) -> Result<Option<Value>, ApiError> {
    if !has_material_inputs(scene)
        || mesh_build::bound_geometry_mesh_is_current(snapshot, scene) != Some(true)
    {
        return Ok(None);
    }
    let (Some(root), Some(reference), Some(mesh)) = (
        store_root,
        mesh_build::geometry_reuse_reference(snapshot, context),
        snapshot.fem_mesh.as_ref(),
    ) else {
        return Ok(None);
    };
    let store = fullmag_session::SessionStore::open_existing(root.to_owned())
        .map_err(|error| ApiError::internal(format!("open geometry asset store: {error}")))?;
    let Some(asset) = mesh_build::load_geometry_reuse_asset(&store, scene, &reference)? else {
        return Ok(None);
    };
    if !mesh_build::can_qualify_live_geometry_reuse(scene, &asset) {
        return Ok(None);
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
        return Ok(None);
    }
    let Ok(problem) = fullmag_application::bind_declared_execution(&input.problem, vec![]) else {
        return Ok(None);
    };
    let Ok(plan) = fullmag_plan::plan(&problem) else {
        // A geometry-only model can be meshed before its full physics is executable.
        return Ok(None);
    };
    let BackendPlanIR::Fem(fem) = &plan.backend_plan else {
        return Ok(None);
    };
    if fem.fe_order != 1 {
        return Ok(None);
    }
    let planned = fullmag_runner::FemMeshPayload::from(fem);
    if fullmag_runner::fem_mesh_topology_fingerprint(&planned) != mesh.topology_fingerprint() {
        return Ok(None);
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
        return Ok(None);
    }
    let Ok(layout) = fullmag_runner::study_magnetization_layout_for_plan(&plan) else {
        return Ok(None);
    };
    let mut field = super::project_damping(plan.backend_plan, layout, revision);
    if let Some(raw) = &mut field {
        raw["geometry_source"] = reference.provenance();
        raw["mesh_topology_sha256"] = mesh.topology_fingerprint().into();
    }
    Ok(field)
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
        let revision = scene.revision;
        let evaluation =
            super::prepare_snapshot(state, context.clone(), snapshot, scene, revision).await;
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
                current.state_version = current.state_version.wrapping_add(1);
            }
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
