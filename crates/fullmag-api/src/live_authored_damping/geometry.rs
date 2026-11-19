//! Projection of a material onto the selected, already built geometry-only mesh.

use std::path::Path;
use std::sync::Arc;

use fullmag_authoring::SceneDocument;
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

/// Geometry-only packing assigns cells to whole objects. A projected mask
/// uses those objects' native nodes and the authored predicate. A conformal
/// region needs its own marker-to-owner mapping on the published carrier.
pub(super) fn projected_region_binding_error(
    scene: &SceneDocument,
    asset: &fullmag_ir::FemDomainMeshAssetIR,
) -> Option<&'static str> {
    if !asset.object_region_markers.is_empty() || asset.build_report.as_ref()
        .is_some_and(|report| !report.object_region_markers.is_empty())
    {
        return Some("geometry_region_marker_ownership_not_bound");
    }
    for owner in fullmag_authoring::scene_solve_objects(scene) {
        for region in owner.regions.iter().filter(|region| region.enabled) {
            if region.owner_object != owner.id
                || !asset.region_markers.iter().any(|marker| marker.geometry_name == owner.id)
            {
                return Some("geometry_region_owner_mismatch");
            }
            if region.realization_policy == fullmag_authoring::SceneRegionRealizationPolicy::Conformal {
                return Some("geometry_conformal_region_markers_missing");
            }
        }
    }
    None
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
    if !mesh_build::is_supported_geometry_only_p1_domain(scene, &asset) {
        return pending("geometry_asset_outside_supported_p1_reuse");
    }
    if let Some(reason) = projected_region_binding_error(scene, &asset) {
        return pending(reason);
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
    // Build Mesh has already chosen the nodal carrier. Verify its retained
    // topology and ownership independently of solver stage and mesh recipes.
    let Some(raw) = &asset.mesh else { return pending("geometry_mesh_missing") };
    let (packed, segments, _) = match fullmag_plan::pack_geometry_only_shared_domain_mesh(
        raw, &asset.region_markers,
    ) {
        Ok(domain) => domain,
        Err(reason) => return pending(format!("geometry_mesh_packing: {reason}")),
    };
    let fingerprint = mesh.topology_fingerprint();
    if fullmag_runner::geometry_only_mesh_topology_fingerprint(&packed).as_deref() != Ok(fingerprint) {
        return pending("geometry_node_topology_mismatch");
    }
    if snapshot.mesh_workspace.as_ref().and_then(|w| w["mesh_summary"]["order"].as_u64()) != Some(1) {
        return pending("geometry_damping_requires_p1");
    }
    if segments.len() != mesh.object_segments.len()
        || !segments.iter().zip(&mesh.object_segments).all(|(a, b)| {
            a.object_id == b.object_id && a.geometry_id == b.geometry_id
                && (a.node_start, a.node_count, a.element_start, a.element_count)
                    == (b.node_start, b.node_count, b.element_start, b.element_count)
        })
    {
        return pending("geometry_node_ownership_mismatch");
    }
    let values = match fullmag_plan::damping_on_geometry_mesh(&problem, &packed, &segments) {
        Ok(values) => values,
        Err(reason) => return pending(format!("geometry_damping_material: {reason}")),
    };
    let layout = json!({
        "backend": "fem", "mesh_name": packed.mesh_name, "fe_order": 1,
        "topology_fingerprint": packed.topology_fingerprint_v6(),
        "n_nodes": packed.nodes.len(), "n_elements": packed.cell_count(),
    });
    Ok(Evaluation::Ready(json!({
        "values": values, "layout": layout, "source_revision": revision,
        "sample_location": "node", "authored_damping_revision": revision,
        "geometry_source": reference.provenance(), "mesh_topology_sha256": fingerprint,
    })))
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
