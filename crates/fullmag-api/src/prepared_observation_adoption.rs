//! Adopt a prepared-state observation bundle with the prepared magnetization
//! (ADR 0071 v1). The FEM preparer published it under its preparation lease;
//! here it is accepted only for the exact same preparation, plan and initial
//! magnetization, so a changed scene never shows stale fields.

use std::path::Path;
use std::sync::Arc;

use serde_json::json;

use crate::accepted_field_binary::{AcceptedFieldReader, BinaryFieldRef};
use crate::error::ApiError;
use crate::live_scene_preparation::LiveScenePreparationReadModel;
use crate::prepared_observation_bundle::{PreparedObservationBundle, PREPARED_OBSERVATION_BUNDLE_SCHEMA};
use crate::types::{CurrentLiveFieldFrameRequest, LatestFields, SessionStateResponse};

const MAX_BUNDLE_BYTES: u64 = 16 * 1024 * 1024;
pub(crate) const PROVENANCE_SOURCE: &str = "prepared_state_evaluation";

/// Publish the evaluated fields next to the prepared m. Returns whether a
/// bundle was adopted; absence or a mismatch leaves the snapshot unchanged.
pub(crate) fn adopt_prepared_observation(
    snapshot: &mut SessionStateResponse,
    read_model: &LiveScenePreparationReadModel,
    store_root: &Path,
    run_id: &str,
    step_id: &str,
) -> Result<bool, ApiError> {
    let fullmag_ir::BackendPlanIR::Fem(plan) = &read_model.execution_plan.backend_plan else {
        return Ok(false);
    };
    let internal = |error: anyhow::Error| ApiError::internal(format!("{error:#}"));
    let task_id = fullmag_session::task_id_for_study_step(run_id, step_id).map_err(internal)?;
    let store = fullmag_session::store::SessionStore::open_existing(store_root).map_err(internal)?;
    let Some(record) = store.read_task_prepared_observation(run_id, &task_id).map_err(internal)? else {
        return Ok(false);
    };
    let fullmag_session::FmsTaskPreparedObservationOutcome::Published { bundle_object_ref, .. } =
        &record.outcome
    else {
        return Ok(false);
    };
    let flattened = plan.initial_magnetization.iter().flatten().copied().collect::<Vec<_>>();
    if record.preparation_id != read_model.preparation_id
        || record.plan_fingerprint != read_model.plan_fingerprint
        || record.magnetization_values_sha256 != fullmag_runner::live_preview_values_sha256(&flattened)
    {
        return Ok(false);
    }
    let bytes = store
        .cas()
        .get_bounded(bundle_object_ref, MAX_BUNDLE_BYTES)
        .map_err(internal)?
        .ok_or_else(|| ApiError::conflict("prepared observation bundle object is missing"))?;
    let bundle: PreparedObservationBundle = serde_json::from_slice(&bytes)
        .map_err(|error| ApiError::conflict(format!("prepared observation bundle is invalid: {error}")))?;
    if bundle.schema_version != PREPARED_OBSERVATION_BUNDLE_SCHEMA
        || bundle.identity.preparation_id != record.preparation_id
        || bundle.identity.plan_fingerprint != record.plan_fingerprint
        || bundle.identity.magnetization_values_sha256 != record.magnetization_values_sha256
        || bundle.identity.task_id != record.task_id
        || bundle.clock.accepted_step != 0
    {
        return Err(ApiError::conflict("prepared observation bundle differs from its record"));
    }
    let frame = crate::session::accepted_observation_frame_ref(
        snapshot,
        0,
        Some(bundle.clock.time_seconds),
    );
    let provenance = json!({
        "source": PROVENANCE_SOURCE,
        "preparation_id": record.preparation_id,
        "plan_fingerprint": record.plan_fingerprint,
        "evaluation_lane": bundle.evaluation_lane,
        "requested_lane": bundle.requested_lane,
        "evaluator_build_identity": bundle.evaluator_build_identity,
    });
    let mut fields = LatestFields::default();
    let mut readers = Vec::new();
    for field in &bundle.fields {
        let spec = fullmag_quantities::quantity_spec(&field.quantity_id)
            .ok_or_else(|| ApiError::conflict("prepared observation quantity is unknown"))?;
        if field.quantity_id == "m" || field.n_comp != usize::from(spec.n_comp) {
            return Err(ApiError::conflict("prepared observation field shape is invalid"));
        }
        let reference: BinaryFieldRef = serde_json::from_value(field.binary.clone())
            .map_err(|error| ApiError::conflict(format!("prepared field reference is invalid: {error}")))?;
        reference.validate()?;
        if reference.value_count != plan.mesh.nodes.len().saturating_mul(field.n_comp) {
            return Err(ApiError::conflict("prepared field does not cover the prepared mesh"));
        }
        fields.insert(field.quantity_id.clone(), json!({
            "n_comp": field.n_comp,
            "layout": field.layout,
            "carrier_id": field.carrier_id,
            "spatial_kind": field.spatial_kind,
            "unavailable_scopes": bundle.unavailable_scopes,
            "source_step": 0,
            "source_time_seconds": bundle.clock.time_seconds,
            "observation_frame": frame,
            "accepted_binary_field": reference.clone(),
            "provenance": provenance,
        }));
        readers.push((
            field.quantity_id.clone(),
            Arc::new(AcceptedFieldReader::new(store_root.to_path_buf(), reference)?),
        ));
    }
    for (quantity, value) in &bundle.energies {
        let spec = fullmag_quantities::quantity_spec(quantity)
            .ok_or_else(|| ApiError::conflict("prepared observation energy is unknown"))?;
        if spec.location != fullmag_quantities::QuantityLocation::Global
            || spec.unit != "J"
            || !value.is_finite()
        {
            return Err(ApiError::conflict("prepared observation energy is not a global value in joules"));
        }
        fields.insert(quantity.clone(), json!({
            "values": [value], "n_comp": 1, "source_step": 0,
            "source_time_seconds": bundle.clock.time_seconds,
            "observation_frame": frame, "layout": {"kind": "global_scalar"},
            "provenance": provenance,
        }));
    }
    for (quantity, reader) in readers {
        fields.attach_binary(quantity, reader)?;
    }
    let session_id = snapshot.session.session_id.clone();
    crate::session::apply_current_live_accepted_field_frame(
        snapshot,
        CurrentLiveFieldFrameRequest {
            session_id,
            latest_fields: Some(fields),
            replace_latest_fields: false,
            field_generation: None,
            preview_fields: None,
            clear_preview_cache: false,
        },
        frame,
    )?;
    Ok(true)
}
