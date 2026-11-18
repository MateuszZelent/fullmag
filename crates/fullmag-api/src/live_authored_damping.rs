//! Re-evaluate edited Gilbert damping on an already prepared Live domain.
//! Keep the immutable run receipt and the solver's magnetization untouched.

use std::collections::BTreeMap;
use std::sync::atomic::Ordering;

use fullmag_authoring::SceneDocument;
use fullmag_ir::BackendPlanIR;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::live_authored_initial_state::apply_preparation::{
    plan_on_published_domain, PublishedDomainPlan,
};
use crate::shared_json::SharedJson;
use crate::types::{AppState, CurrentLiveRequestContext, SessionStateResponse};

pub(crate) const PUBLICATION: &str = "authored_damping";

pub(crate) fn retire_for_prepared_domain(snapshot: &mut SessionStateResponse) {
    if publication_revision(snapshot).is_some() {
        if let Some(object) = snapshot.metadata.as_mut().and_then(|m| m.as_object_mut()) {
            object.remove(PUBLICATION);
        }
        crate::session::replace_authored_damping(snapshot, None);
    }
}

pub(crate) fn mark_prepared_domain_changed(snapshot: &mut SessionStateResponse, revision: u64) {
    let Some(metadata) = snapshot.metadata.as_mut() else {
        return;
    };
    if !matches!(
        metadata
            .pointer("/execution_plan/backend_plan/kind")
            .and_then(Value::as_str),
        Some("fdm" | "fdm_multilayer" | "fem")
    ) {
        return;
    }
    let mut pending = binding(revision, None);
    pending["requires_domain_rebuild"] = true.into();
    metadata[PUBLICATION] = pending;
    crate::session::replace_authored_damping(snapshot, None);
}

pub(crate) fn publication_revision(snapshot: &SessionStateResponse) -> Option<u64> {
    snapshot
        .metadata
        .as_ref()?
        .get(PUBLICATION)?
        .get("scene_revision")?
        .as_u64()
}

fn absorbers(scene: &SceneDocument) -> BTreeMap<&str, &fullmag_ir::AbsorbingBoundaryLayerIR> {
    scene
        .objects
        .iter()
        .filter_map(|object| {
            object
                .absorbing_boundary
                .as_ref()
                .map(|layer| (object.id.as_str(), layer))
        })
        .collect()
}

pub(crate) struct PreparedDamping {
    session_id: String,
    session_epoch: u64,
    domain: crate::session::LiveFieldDomainIdentity,
    previous_metadata: Option<u64>,
    previous_scene_revision: u64,
    previous_preparation_revision: u64,
    binding: Value,
    field: Option<Value>,
}

impl PreparedDamping {
    pub(crate) fn validate(
        &self,
        state: &AppState,
        snapshot: &SessionStateResponse,
    ) -> Result<(), ApiError> {
        if self.session_id != snapshot.session.session_id
            || self.session_epoch != state.current_live_session_epoch.load(Ordering::Acquire)
            || self.domain != crate::session::current_live_field_domain_identity(snapshot)
            || self.previous_metadata != snapshot.metadata.as_ref().map(SharedJson::version)
            || self.previous_scene_revision
                != snapshot
                    .scene_document
                    .as_ref()
                    .map_or(0, |scene| scene.revision)
            || self.previous_preparation_revision != snapshot.simulation_preparation_revision
        {
            return Err(ApiError::conflict_with_code(
                "damping_domain_changed",
                "the scene or prepared domain changed while evaluating damping",
            ));
        }
        Ok(())
    }

    pub(crate) fn publish(self, snapshot: &mut SessionStateResponse) {
        // ReplaceScene can atomically apply magnetization too. Its candidate
        // already owns the new execution plan. Merge only our own publication.
        let metadata = snapshot.metadata.get_or_insert_with(|| json!({}).into());
        metadata[PUBLICATION] = self.binding;
        crate::session::replace_authored_damping(snapshot, self.field);
    }
}

pub(crate) async fn prepare(
    state: &std::sync::Arc<AppState>,
    context: Option<&CurrentLiveRequestContext>,
    scene: &SceneDocument,
) -> Result<Option<PreparedDamping>, ApiError> {
    let snapshot = {
        let current = state.current_live_state.read().await;
        let Some(snapshot) = current.as_ref() else {
            return Ok(None);
        };
        let Some(before) = snapshot.scene_document.as_ref() else {
            return Ok(None);
        };
        let before_layers = absorbers(before);
        let after_layers = absorbers(scene);
        if before_layers == after_layers {
            // The common scene commit already compares authoritative domain
            // signatures, even when no absorber has ever been authored.
            if before_layers.is_empty() && publication_revision(snapshot).is_none() {
                return Ok(None);
            }
            let impact = fullmag_authoring::classify_region_realization_impact(before, scene);
            if !impact.coefficients && !impact.topology && !impact.membership {
                return Ok(None);
            }
        }
        snapshot.clone()
    };
    let context = match context {
        Some(context) => context.clone(),
        None => crate::capture_current_live_request_context(state).await?,
    };
    crate::ensure_current_live_request_context(
        &snapshot,
        &context,
        state.current_live_session_epoch.load(Ordering::Acquire),
    )?;
    let repo = state.repo_root.clone();
    let workspace = state.current_workspace_root.clone();
    let store = state.submit_store_root.clone();
    let scene = scene.clone();
    tokio::task::spawn_blocking(move || {
        let previous_metadata = snapshot.metadata.as_ref().map(SharedJson::version);
        let revision = scene.revision.saturating_add(1);
        let metadata = snapshot.metadata.as_ref();
        if metadata.is_some_and(|m| !m.is_object()) {
            return Err(ApiError::conflict(
                "published domain metadata must be an object",
            ));
        }
        // Once topology changes, comparing two newer authored scenes cannot
        // prove that the still-published carrier is their domain. Only the
        // installation of a fresh qualified preparation clears this fence.
        let requires_domain_rebuild = metadata
            .is_some_and(|m| m[PUBLICATION]["requires_domain_rebuild"] == true)
            || snapshot.scene_document.as_ref().is_some_and(|previous| {
                crate::scene_mesh_signature(previous) != crate::scene_mesh_signature(&scene)
            });
        let field = if !requires_domain_rebuild
            && metadata.is_some_and(|m| m.get("execution_plan").is_some())
        {
            let result = plan_on_published_domain(
                &repo,
                &workspace,
                store.as_deref(),
                &context,
                &snapshot,
                &scene,
            )?;
            match result {
                PublishedDomainPlan::Ready { plan, layout, .. } => {
                    project_damping(plan.backend_plan, layout, revision)
                }
                PublishedDomainPlan::Pending(_) => {
                    // A topology edit or unavailable native evidence means the
                    // old coefficient must disappear until the next preparation.
                    None
                }
            }
        } else {
            None
        };
        let mut binding = binding(revision, field.as_ref());
        binding["requires_domain_rebuild"] = requires_domain_rebuild.into();
        Ok(Some(PreparedDamping {
            session_id: context.session_id,
            session_epoch: context.session_epoch,
            previous_scene_revision: scene.revision,
            previous_preparation_revision: snapshot.simulation_preparation_revision,
            domain: crate::session::current_live_field_domain_identity(&snapshot),
            previous_metadata,
            binding,
            field,
        }))
    })
    .await
    .map_err(|error| ApiError::internal(format!("evaluate authored damping: {error}")))?
}

pub(crate) fn project_damping(plan: BackendPlanIR, layout: Value, revision: u64) -> Option<Value> {
    let values = match plan {
        BackendPlanIR::Fdm(fdm) => fdm
            .material
            .alpha_field
            .unwrap_or_else(|| vec![fdm.material.damping; fdm.initial_magnetization.len()]),
        BackendPlanIR::Fem(fem) => fem
            .material
            .alpha_field
            .unwrap_or_else(|| vec![fem.material.damping; fem.mesh.nodes.len()]),
        BackendPlanIR::FdmMultilayer(multilayer) => multilayer
            .layers
            .into_iter()
            .flat_map(|layer| {
                layer.material.alpha_field.unwrap_or_else(|| {
                    vec![layer.material.damping; layer.initial_magnetization.len()]
                })
            })
            .collect(),
        _ => return None,
    };
    let sample_location = if layout["backend"] == "fem" { "node" } else { "cell" };
    Some(json!({"values": values, "layout": layout, "source_revision": revision,
        "sample_location": sample_location, "authored_damping_revision": revision}))
}

pub(crate) fn binding(revision: u64, field: Option<&Value>) -> Value {
    json!({
        "scene_revision": revision,
        "samples_sha256": field.map(|raw| fullmag_session::canonical_json_sha256(&raw["values"])),
        "layout_sha256": field.map(|raw| fullmag_session::canonical_json_sha256(&raw["layout"])),
    })
}

pub(crate) fn matches_publication(snapshot: &SessionStateResponse, raw: &Value) -> bool {
    let Some(metadata) = snapshot.metadata.as_ref() else {
        return false;
    };
    let publication = &metadata[PUBLICATION];
    if raw.get("authored_damping_revision").and_then(Value::as_u64)
        != publication["scene_revision"].as_u64()
    {
        return false;
    }
    let Some(expected) = publication["samples_sha256"].as_str() else {
        return false;
    };
    let check = || {
        fullmag_session::canonical_json_sha256(&raw["values"]) == expected
            && publication["layout_sha256"].as_str().is_some_and(|layout| {
                fullmag_session::canonical_json_sha256(&raw["layout"]) == layout
            })
    };
    match snapshot.latest_fields.get_shared("mat_alpha") {
        Some(field) if std::ptr::eq(&**field, raw) => {
            field.dependent_flag(metadata.version(), check)
        }
        _ => check(),
    }
}

pub(crate) fn native_layer_values(
    snapshot: &SessionStateResponse,
    id: &str,
    count: usize,
) -> Result<Vec<f64>, ApiError> {
    let field = snapshot
        .latest_fields
        .get("mat_alpha")
        .filter(|raw| matches_publication(snapshot, raw))
        .ok_or_else(|| ApiError::not_found("edited damping awaits domain preparation"))?;
    let layer = field["layout"]["layers"]
        .as_array()
        .and_then(|layers| {
            layers
                .iter()
                .find(|layer| layer["layer_id"].as_str() == Some(id))
        })
        .ok_or_else(|| ApiError::conflict("edited damping has no matching native layer"))?;
    let offset = layer["value_offset"]
        .as_u64()
        .and_then(|v| usize::try_from(v).ok());
    let samples = offset
        .and_then(|start| Some(start..start.checked_add(count)?))
        .and_then(|range| field["values"].as_array()?.get(range))
        .filter(|_| layer["value_count"].as_u64() == Some(count as u64))
        .ok_or_else(|| ApiError::conflict("edited damping and native layer sizes differ"))?;
    samples
        .iter()
        .map(|sample| {
            sample
                .as_f64()
                .ok_or_else(|| ApiError::conflict("invalid edited damping sample"))
        })
        .collect()
}
