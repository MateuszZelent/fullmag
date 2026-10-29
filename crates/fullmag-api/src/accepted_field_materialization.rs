//! API adoption of immutable worker-published accepted observables.

use std::{collections::BTreeSet, path::Path, sync::Arc};
use anyhow::Result;
use fullmag_runner::AcceptedMaterializationBatch;
use serde_json::{json, Value};
use crate::accepted_field_binary::AcceptedFieldReader;
use crate::accepted_field_materialization_worker::{field_key, load_latest_bundle, LoadedBundle, SCHEMA};
use crate::error::ApiError;
use crate::live_accepted_projection::ProjectionPublicationFence;
use crate::schemas::runtime::FieldMaterializationRequirement;
use crate::types::{AppState, CurrentLiveFieldFrameRequest, SessionStateResponse};

/// Other live-state writers (artifact import, display selection, ...) do not
/// take the caller's transition fence; a candidate they invalidate is rebuilt
/// from the newer snapshot instead of overwriting their update.
const ADOPTION_PUBLICATION_ATTEMPTS: usize = 3;

/// Identity the bundle was admitted against. A change is a conflict, not a
/// reason to rebuild the candidate.
struct AdmittedSource {
    session_id: String,
    scene_revision: Option<u64>,
    run_id: Option<String>,
    allow_api_instance_rebind: bool,
}

/// Caller owns the transition fence. This path only reads CAS; it cannot solve,
/// allocate devices, or reinterpret a bundle belonging to an older scene.
pub(crate) async fn adopt_current_bundle(
    state: &Arc<AppState>, energies_only: bool,
    requirements: &[crate::schemas::runtime::FieldMaterializationRequirement],
) -> Result<(), ApiError> {
    adopt_bundle(state, energies_only, energies_only, false, requirements).await
}

/// The terminal projector already owns the transition fence and exact final
/// state. Publish its complete observation generation without a UI command or
/// another evaluator; explicit Compute commands can replay the same CAS data.
pub(crate) async fn adopt_terminal_bundle(state: &Arc<AppState>) -> Result<(), ApiError> {
    adopt_bundle(state, false, true, true, &[]).await
}

async fn adopt_bundle(
    state: &Arc<AppState>, energies_only: bool, include_energies: bool,
    all_fields: bool,
    requirements: &[crate::schemas::runtime::FieldMaterializationRequirement],
) -> Result<(), ApiError> {
    if !energies_only && !all_fields && requirements.is_empty() {
        return Err(ApiError::conflict("accepted field materialization requires an explicit resolved scope"));
    }
    let before = state.current_live_state.read().await.as_ref().cloned()
        .ok_or_else(|| ApiError::not_found("no current workspace"))?;
    let run = before.run.as_ref().ok_or_else(|| ApiError::conflict("no accepted run"))?;
    if !matches!(run.status.as_str(), "completed" | "failed" | "cancelled") {
        return Err(ApiError::conflict("accepted quantities require a terminal run and its verified state"));
    }
    let run_id = run.run_id.clone();
    let root = state.submit_store_root.clone().ok_or_else(|| ApiError::conflict("accepted store unavailable"))?;
    let reader_root = root.clone();
    let loaded = tokio::task::spawn_blocking(move || load_latest_bundle(&root, &run_id)).await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::conflict_with_code("accepted_materialization_unavailable", format!("{error:#}")))?;
    let record = &loaded.record;
    let batch = record.batch.as_ref().ok_or_else(|| ApiError::conflict_with_code(
        "accepted_materialization_unsupported", record.error.clone().unwrap_or_default()))?;
    let automatic_requirements;
    let requirements = if all_fields {
        automatic_requirements = vec![crate::schemas::runtime::FieldMaterializationRequirement {
            quantity_ids: batch.fields.iter().filter(|field| field.role != "airbox")
                .map(|field| field.quantity_id.clone()).collect(),
            scope_kind: "full".into(), scope_id: None,
            generation_id: crate::router_v2::handlers::sessions::status::domain_generation_id(&before),
            carrier_fingerprint: None,
        }];
        automatic_requirements.as_slice()
    } else { requirements };
    if batch.source != record.source || batch.magnetization_content_sha256 != record.state_object_ref
        || batch.clock.accepted_step != record.source.id.accepted_step {
        return Err(ApiError::conflict("bundle source differs"));
    }
    batch.clock.validate().map_err(|error| ApiError::conflict(error.to_string()))?;
    let restored_identity = state.accepted_run_reattach_identity.read().await.clone();
    let allow_api_instance_rebind = restored_identity.as_ref().is_some_and(|identity| {
        before.scene_document.as_ref().is_some_and(|scene| identity.matches(
            &run.run_id, &before.session.session_id,
            state.current_live_session_epoch.load(std::sync::atomic::Ordering::Acquire),
            scene.revision,
        ))
    });
    let admitted = AdmittedSource {
        session_id: before.session.session_id.clone(),
        scene_revision: before.scene_document.as_ref().map(|scene| scene.revision),
        run_id: before.run.as_ref().map(|run| run.run_id.clone()),
        allow_api_instance_rebind,
    };
    // Candidate construction (full-snapshot clone, frame application with
    // effective-source hashing, spatial-field resolution) is heavy on large
    // domains. Build it outside the live-state lock and hold the write lock
    // only for the fenced swap, so health/status readers never queue behind
    // it on the fair RwLock. Same shape as `apply_projection`.
    let mut base = Some(before);
    for _ in 0..ADOPTION_PUBLICATION_ATTEMPTS {
        let candidate = match base.take() {
            Some(snapshot) => snapshot,
            None => state.current_live_state.read().await.as_ref().cloned()
                .ok_or_else(|| ApiError::not_found("no current workspace"))?,
        };
        let fence = ProjectionPublicationFence::capture(&candidate)?;
        let next = adopted_candidate(state, candidate, &admitted, &loaded, batch, &reader_root,
            energies_only, include_energies, requirements)?;
        let mut current = state.current_live_state.write().await;
        let unchanged = current.as_ref().is_some_and(|snapshot| {
            ProjectionPublicationFence::capture(snapshot).is_ok_and(|now| now == fence)
        });
        if !unchanged {
            drop(current);
            drop(next);
            continue;
        }
        let previous = std::mem::replace(&mut *current, Some(next));
        drop(current);
        if let Some(previous) = previous {
            let _ = tokio::task::spawn_blocking(move || drop(previous));
        }
        return Ok(());
    }
    Err(ApiError::conflict("current live state kept changing during accepted adoption"))
}

/// Build the published snapshot from a disposable clone. Pure with respect to
/// the shared live state: the caller publishes it only after its fence check.
#[allow(clippy::too_many_arguments)]
fn adopted_candidate(
    state: &AppState, mut next: SessionStateResponse, admitted: &AdmittedSource,
    loaded: &LoadedBundle, batch: &AcceptedMaterializationBatch, reader_root: &Path,
    energies_only: bool, include_energies: bool,
    requirements: &[FieldMaterializationRequirement],
) -> Result<SessionStateResponse, ApiError> {
    let record = &loaded.record;
    if next.session.session_id != admitted.session_id
        || next.scene_document.as_ref().map(|scene| scene.revision) != admitted.scene_revision
        || next.run.as_ref().map(|run| &run.run_id) != admitted.run_id.as_ref() {
        return Err(ApiError::conflict("current accepted source changed"));
    }
    let scene = next.scene_document.as_ref().ok_or_else(|| ApiError::conflict("accepted scene missing"))?;
    let execution_input = crate::live_execution_binding::input_identity(scene)?;
    crate::live_execution_binding::validate_input_binding(&loaded.specification,
        &execution_input, scene.revision)?;
    let live = loaded.specification.pointer("/parameters/live_workspace");
    if (!admitted.allow_api_instance_rebind
        && live.and_then(|value| value.get("api_instance_id")).and_then(Value::as_str)
            != Some(state.request_scope_instance_id.as_str()))
        || live.and_then(|value| value.get("session_id")).and_then(Value::as_str)
            != Some(next.session.session_id.as_str())
        || live.and_then(|value| value.get("session_epoch")).and_then(Value::as_u64)
            != Some(state.current_live_session_epoch.load(std::sync::atomic::Ordering::Acquire)) {
        return Err(ApiError::conflict("accepted bundle belongs to another live owner"));
    }
    let m = next.latest_fields.get("m").ok_or_else(|| ApiError::conflict("accepted state projection is pending"))?;
    let domain_generation = crate::router_v2::handlers::sessions::status::domain_generation_id(&next);
    if requirements.iter().any(|requirement| requirement.generation_id != domain_generation)
        || !crate::session::latest_field_source_is_qualified(&next, "m", m)
    {
        return Err(ApiError::conflict("materialization domain changed after command admission"));
    }
    if m.get("state_object_ref").and_then(Value::as_str) != Some(record.state_object_ref.as_str())
        || m.get("accepted_state_ref") != Some(&serde_json::to_value(&record.source)
            .map_err(|error| ApiError::internal(error.to_string()))?)
        || m.get("carrier_fingerprint").and_then(Value::as_str) != Some(loaded.state_fingerprint.as_str())
        || m.get("source_step").and_then(Value::as_u64) != Some(batch.clock.accepted_step)
        || m.get("source_time_seconds").and_then(Value::as_f64) != Some(batch.clock.time_seconds) {
        return Err(ApiError::conflict("displayed magnetization differs from materialized state"));
    }
    let frame = crate::session::accepted_observation_frame_ref(&next,
        batch.clock.accepted_step, Some(batch.clock.time_seconds));
    let wanted = requirements.iter().flat_map(|requirement| requirement.quantity_ids.iter()
        .map(String::as_str)).collect::<BTreeSet<_>>();
    let mut fields = crate::types::LatestFields::default();
    let mut readers = Vec::new();
    if !energies_only {
        let mut identities = BTreeSet::new();
        for field in &batch.fields {
            if !matches!(field.role.as_str(), "magnetic" | "layer_native" | "airbox")
                || !identities.insert((field.quantity_id.as_str(), field.role == "airbox")) {
                return Err(ApiError::conflict("accepted quantity carrier is ambiguous or has an unknown role"));
            }
        }
        for requirement in requirements {
            for quantity in &requirement.quantity_ids {
                // Magnetization is the accepted solver state, not a derived
                // evaluator output. Its exact source, clock and carrier were
                // validated above; preserve that published full-domain field.
                if quantity == "m" && requirement.scope_kind == "full" { continue; }
                if !batch.fields.iter().any(|field| field.quantity_id == *quantity
                    && (field.role == "airbox") == (requirement.scope_kind == "airbox")) {
                    let key = format!("{}:{quantity}", requirement.scope_kind);
                    let reason = batch.unavailable_scopes.get(&key).map(String::as_str)
                        .unwrap_or("the accepted evaluator did not publish this carrier");
                    return Err(ApiError::conflict_with_code("accepted_materialization_unsupported", format!(
                        "{quantity} for {}: {reason}", requirement.scope_kind)));
                }
            }
        }
        for field in &batch.fields {
            // Target-only carriers are adopted separately; never overwrite a
            // layer-native field with an array from a different observation grid.
            if field.role == "airbox" || field.quantity_id == "m" { continue; }
            if !wanted.is_empty() && !wanted.contains(field.quantity_id.as_str()) { continue; }
            let spec = fullmag_quantities::quantity_spec(&field.quantity_id)
                .ok_or_else(|| ApiError::conflict("accepted quantity is unknown"))?;
            let binary = record.binary_fields.get(&field_key(field));
            let value_count = binary.map_or(field.values.len(), |reference| reference.value_count);
            if field.n_comp != spec.n_comp as usize || field.n_comp == 0
                || value_count == 0 || value_count % field.n_comp != 0
                || field.values.iter().any(|value| !value.is_finite()) {
                return Err(ApiError::conflict("accepted quantity field shape is invalid"));
            }
            let mut raw = json!({
                "n_comp": field.n_comp, "layout": field.layout,
                "carrier_id": field.carrier_id,
                "spatial_kind": field.spatial_kind,
                "unavailable_scopes": batch.unavailable_scopes,
                "source_step": batch.clock.accepted_step, "source_time_seconds": batch.clock.time_seconds,
                "solver_dt": batch.clock.dt_seconds, "observation_frame": frame,
                "provenance": {"source": SCHEMA, "accepted_state_ref": batch.source,
                    "state_object_ref": record.state_object_ref, "execution_input": execution_input,
                    "plan_sha256": batch.plan_sha256, "lane": batch.lane,
                    "evaluator_build_identity": batch.evaluator_build_identity},
            });
            if let Some(reference) = binary {
                raw["accepted_binary_field"] = serde_json::to_value(reference)
                    .map_err(|error| ApiError::internal(error.to_string()))?;
                readers.push((field.quantity_id.clone(), Arc::new(
                    AcceptedFieldReader::new(reader_root.to_path_buf(), reference.clone())?)));
            } else { raw["values"] = json!(field.values); }
            fields.insert(field.quantity_id.clone(), raw);
        }
        for field in batch.fields.iter().filter(|field| field.role == "airbox") {
            if !wanted.is_empty() && !wanted.contains(field.quantity_id.as_str()) { continue; }
            let mut raw = fields.get(&field.quantity_id).cloned().ok_or_else(|| {
                ApiError::conflict("target-only Airbox carrier cannot replace a missing magnetic carrier")
            })?;
            if field.layout.get("manifest").is_none() || (field.layout.get("field_artifact").is_none()
                && field.layout.get("field_artifact_object_ref").is_none()) {
                return Err(ApiError::conflict("accepted Airbox carrier lacks its validated manifest and artifact"));
            }
            raw["accepted_airbox"] = field.layout.clone();
            if let Some(reference) = record.binary_fields.get(&field_key(field)) {
                raw["accepted_airbox"]["accepted_binary_field"] = serde_json::to_value(reference)
                    .map_err(|error| ApiError::internal(error.to_string()))?;
            }
            fields.insert(field.quantity_id.clone(), raw);
        }
    }
    for (quantity, reader) in readers { fields.attach_binary(quantity, reader)?; }
    if include_energies {
        let standard = ["E_total", "E_ex", "E_demag", "E_ext", "E_ani", "E_dmi"];
        if standard.iter().any(|quantity| !batch.energies.contains_key(*quantity))
            || batch.energies.values().any(|value| !value.is_finite()) {
            return Err(ApiError::conflict("accepted energy decomposition unavailable"));
        }
        // Global quantities remain scalar; do not broadcast a total energy to
        // every cell and accidentally present joules as an energy density.
        for (quantity, value) in &batch.energies {
            let spec = fullmag_quantities::quantity_spec(quantity)
                .ok_or_else(|| ApiError::conflict("unknown accepted energy quantity"))?;
            if spec.location != fullmag_quantities::QuantityLocation::Global || spec.unit != "J" {
                return Err(ApiError::conflict("accepted energy quantity is not a global value in joules"));
            }
            fields.insert(quantity.clone(), json!({"values": [value], "n_comp": 1,
                "source_step": batch.clock.accepted_step, "source_time_seconds": batch.clock.time_seconds,
                "observation_frame": frame, "layout": {"kind": "global_scalar"},
                "provenance": {"source": SCHEMA, "accepted_state_ref": batch.source,
                    "state_object_ref": record.state_object_ref, "execution_input": execution_input,
                    "evaluator_build_identity": batch.evaluator_build_identity}}));
        }
        // Do not rewrite a solver history row matched only by step/time:
        // separate stages may reuse that clock. These global results retain
        // the full accepted source identity in the same quantity data plane.
    }
    crate::session::apply_current_live_field_frame_to_candidate(&mut next, CurrentLiveFieldFrameRequest {
        session_id: admitted.session_id.clone(), latest_fields: Some(fields), replace_latest_fields: false,
        field_generation: None, preview_fields: None, clear_preview_cache: false,
    }, Some(&frame))?;
    if !energies_only {
        // A newly materialized target can appear before the previous catalog
        // knew about it. Validate it even when it was not an existing command
        // requirement; it still must never replace the magnetic carrier.
        for field in batch.fields.iter().filter(|field| field.role == "airbox"
            && wanted.contains(field.quantity_id.as_str())) {
            crate::router_v2::handlers::data::fields::load_fdm_multilayer_airbox_carrier_for_quantity(&next, &field.quantity_id)
                .map_err(ApiError::conflict)?.ok_or_else(|| ApiError::conflict("accepted Airbox target does not resolve"))?;
        }
        for requirement in requirements {
            for quantity in &requirement.quantity_ids {
                let spec = fullmag_quantities::quantity_spec(quantity)
                    .ok_or_else(|| ApiError::conflict("unknown requested quantity"))?;
                match requirement.scope_kind.as_str() {
                    "full" => {
                        if crate::router_v2::handlers::data::resolved_spatial_field::resolve_current_spatial_field_metadata(
                            &next, quantity, spec.n_comp as usize,
                        )?.is_none() {
                            return Err(ApiError::conflict("materialized field does not resolve in the current domain"));
                        }
                    }
                    "airbox" => {
                        let carrier = crate::router_v2::handlers::data::fields::load_fdm_multilayer_airbox_carrier_for_quantity(&next, quantity)
                            .map_err(ApiError::conflict)?.ok_or_else(|| ApiError::conflict("materialized Airbox carrier unavailable"))?;
                        if requirement.carrier_fingerprint.as_deref()
                            .is_some_and(|fingerprint| fingerprint != carrier.carrier_fingerprint) {
                            return Err(ApiError::conflict("materialized Airbox target changed"));
                        }
                        if carrier.sample_count == 0 || !carrier.published_quantities.contains(quantity)
                            || carrier.unavailable_quantities.contains_key(quantity) {
                            return Err(ApiError::conflict("materialized Airbox quantity unavailable"));
                        }
                    }
                    _ => return Err(ApiError::conflict("unsupported materialization scope")),
                }
            }
        }
    }
    Ok(next)
}

/// A global observation is a single value in joules, never a spatial field.
/// Preserve the exact accepted state and authored-input fences even when two
/// stages happen to share a step/time clock and the same mesh.
pub(crate) fn current_global_energy(
    current: &crate::types::SessionStateResponse, quantity: &str,
) -> Option<f64> {
    let spec = fullmag_quantities::quantity_spec(quantity)?;
    if spec.location != fullmag_quantities::QuantityLocation::Global || spec.unit != "J" { return None; }
    let raw = current.latest_fields.get(quantity)?;
    let provenance = raw.get("provenance")?;
    let current_source = match provenance.get("source")?.as_str()? {
        SCHEMA => accepted_energy_source_matches(current, provenance).is_some(),
        crate::prepared_observation_adoption::PROVENANCE_SOURCE => {
            prepared_energy_source_is_current(current, quantity, raw, provenance)
        }
        _ => false,
    };
    if !current_source { return None; }
    let values = raw.get("values")?.as_array()?;
    if values.len() != 1 { return None; }
    values[0].as_f64().filter(|value| value.is_finite())
}

/// A prepared-state energy belongs to exactly one preparation of the current
/// scene and to the step-0 frame it was evaluated on; a new preparation or an
/// accepted run frame makes it stale, like the prepared spatial fields.
fn prepared_energy_source_is_current(
    current: &crate::types::SessionStateResponse, quantity: &str,
    raw: &Value, provenance: &Value,
) -> bool {
    let Some(preparation) = current.simulation_preparation.as_ref() else { return false };
    provenance.get("preparation_id").and_then(Value::as_str) == Some(preparation.preparation_id.as_str())
        && crate::session::latest_field_source_is_qualified(current, quantity, raw)
}

fn accepted_energy_source_matches(
    current: &crate::types::SessionStateResponse, provenance: &Value,
) -> Option<()> {
    let source: fullmag_quantities::AcceptedStateRef = serde_json::from_value(provenance.get("accepted_state_ref")?.clone()).ok()?;
    if current.run.as_ref()?.run_id != source.id.run_id { return None; }
    let m = current.latest_fields.get("m")?;
    if !crate::session::latest_field_source_is_qualified(current, "m", m)
        || m.get("state_object_ref")? != provenance.get("state_object_ref")?
        || m.get("accepted_state_ref")? != provenance.get("accepted_state_ref")? { return None; }
    let input: fullmag_authoring::SceneExecutionInputIdentity =
        serde_json::from_value(provenance.get("execution_input")?.clone()).ok()?;
    if input != crate::live_execution_binding::input_identity(current.scene_document.as_ref()?).ok()? { return None; }
    Some(())
}

/// Current-energy consumers use the existing resource shape. Solver history
/// remains untouched; only this source-qualified current observation wins.
pub(crate) fn current_energy_observation(
    current: &crate::types::SessionStateResponse,
) -> Option<crate::schemas::runtime::SolverEnergyCurrentResource> {
    let total = current_global_energy(current, "E_total")?;
    let raw = current.latest_fields.get("E_total")?;
    let proof = raw.get("provenance")?;
    let frame = raw.get("observation_frame")?;
    let component = |quantity: &str| -> Option<f64> {
        let value = current.latest_fields.get(quantity)?;
        if value.get("provenance")? != proof || value.get("observation_frame")? != frame {
            return None;
        }
        let values = value.get("values")?.as_array()?;
        if values.len() != 1 { return None; }
        values[0].as_f64().filter(|value| value.is_finite())
    };
    Some(crate::schemas::runtime::SolverEnergyCurrentResource {
        revision: current.scalar_revision.saturating_add(crate::router_v2::handlers::sessions::status::field_revision(current)),
        step: raw.get("source_step")?.as_u64()?,
        time_seconds: raw.get("source_time_seconds")?.as_f64()?,
        exchange: component("E_ex")?, demag: component("E_demag")?,
        zeeman: component("E_ext")?, anisotropy: component("E_ani")?,
        dmi: component("E_dmi")?, total,
    })
}
