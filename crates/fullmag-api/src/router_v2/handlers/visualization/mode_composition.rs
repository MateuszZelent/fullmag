use std::collections::HashSet;
use std::sync::Arc;
use std::sync::OnceLock;

use axum::extract::State;
use axum::Json;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::error::ApiError;
use crate::schemas::mode_composition::{
    ModeCompositionLayer, ModeCompositionLifecycle, ModeCompositionOperation, ModeCompositionPatch,
    ModeCompositionResource, ModeFieldComponent, ModeFieldRepresentation,
};
use crate::schemas::realtime::{RealtimeResourceChange, RealtimeResourceName};
use crate::types::AppState;

#[utoipa::path(
    get,
    path = "/v2/sessions/current/visualization/mode-compositions/active",
    responses(
        (status = 200, description = "Active per-object eigenmode visualization composition", body = ModeCompositionResource),
    ),
    tag = "visualization"
)]
pub async fn get_active_mode_composition(
    State(state): State<Arc<AppState>>,
) -> Result<Json<ModeCompositionResource>, ApiError> {
    reconcile_mode_composition_lifecycle(&state).await?;
    Ok(Json(
        state
            .current_display_presentation
            .read()
            .await
            .mode_composition
            .clone(),
    ))
}

#[utoipa::path(
    patch,
    path = "/v2/sessions/current/visualization/mode-compositions/active",
    request_body = ModeCompositionPatch,
    responses(
        (status = 200, description = "Active composition patched", body = ModeCompositionResource),
        (status = 400, description = "Invalid composition patch"),
        (status = 409, description = "Composition revision or dataset conflict"),
    ),
    tag = "visualization"
)]
pub async fn patch_active_mode_composition(
    State(state): State<Arc<AppState>>,
    Json(patch): Json<ModeCompositionPatch>,
) -> Result<Json<ModeCompositionResource>, ApiError> {
    // One process-wide mutation queue makes the compare/apply/revalidate sequence
    // serial.  A stale base revision is still rejected, never silently overwritten.
    let _queue = mode_composition_mutation_queue().lock().await;
    reconcile_mode_composition_lifecycle(&state).await?;
    let current = state
        .current_display_presentation
        .read()
        .await
        .mode_composition
        .clone();
    let next = apply_mode_composition_patch(&current, patch)?;
    validate_registered_targets(&state, &next).await?;
    let mut presentation = state.current_display_presentation.write().await;
    if presentation.mode_composition.revision != current.revision {
        return Err(ApiError::conflict(
            "mode_composition_revision_conflict: composition changed while patch was being validated",
        ));
    }
    presentation.mode_composition = next.clone();
    drop(presentation);
    emit_mode_composition_realtime_change(&state, next.revision).await?;
    Ok(Json(next))
}

fn mode_composition_mutation_queue() -> &'static Mutex<()> {
    static QUEUE: OnceLock<Mutex<()>> = OnceLock::new();
    QUEUE.get_or_init(|| Mutex::new(()))
}

pub(crate) async fn reconcile_mode_composition_lifecycle(
    state: &Arc<AppState>,
) -> Result<Option<ModeCompositionResource>, ApiError> {
    let lifecycle = {
        let live = state.current_live_state.read().await;
        let Some(snapshot) = live.as_ref() else {
            return Ok(None);
        };
        mode_composition_lifecycle(snapshot)
    };
    let mut presentation = state.current_display_presentation.write().await;
    if presentation.mode_composition.lifecycle == lifecycle {
        return Ok(None);
    }
    let reset =
        reset_mode_composition_for_lifecycle_change(&presentation.mode_composition, lifecycle);
    presentation.mode_composition = reset.clone();
    Ok(Some(reset))
}

fn mode_composition_lifecycle(
    snapshot: &crate::types::SessionStateResponse,
) -> ModeCompositionLifecycle {
    ModeCompositionLifecycle {
        session_id: snapshot.session.session_id.clone(),
        run_id: snapshot.run.as_ref().map(|run| run.run_id.clone()),
        artifact_revision: crate::router_v2::handlers::sessions::status::artifact_revision(
            snapshot,
        ),
        mesh_revision: snapshot.mesh_revision,
    }
}

pub(crate) fn reset_mode_composition_for_lifecycle_change(
    current: &ModeCompositionResource,
    lifecycle: ModeCompositionLifecycle,
) -> ModeCompositionResource {
    ModeCompositionResource {
        revision: current.revision.saturating_add(1),
        lifecycle,
        ..ModeCompositionResource::default()
    }
}

async fn validate_registered_targets(
    state: &Arc<AppState>,
    composition: &ModeCompositionResource,
) -> Result<(), ApiError> {
    let selection = state.current_display_selection.read().await;
    let presentation = state.current_display_presentation.read().await;
    let live = state.current_live_state.read().await;
    let snapshot = live.as_ref().ok_or_else(|| {
        ApiError::conflict("mode_composition_lifecycle_missing: no active session")
    })?;
    validate_composition_dataset(snapshot, composition)?;
    let visualization = super::display::build_visualization_state_response(
        &selection,
        &presentation,
        Some(snapshot),
    );
    let object_ids = visualization
        .targets
        .objects
        .iter()
        .map(|target| target.scope_id.as_str())
        .collect::<HashSet<_>>();
    for layer in &composition.layers {
        if !object_ids.contains(layer.object_id.as_str()) {
            return Err(ApiError::conflict(format!(
                "mode_field_object_scope_missing: no current magnetic object target for {}",
                layer.object_id
            )));
        }
        validate_published_mode(snapshot, layer)?;
    }
    Ok(())
}

fn validate_composition_dataset(
    snapshot: &crate::types::SessionStateResponse,
    composition: &ModeCompositionResource,
) -> Result<(), ApiError> {
    if composition.layers.is_empty() {
        return Ok(());
    }
    let active_run_id = snapshot.run.as_ref().map(|run| run.run_id.as_str());
    if active_run_id != Some(composition.run_id.as_str()) {
        return Err(ApiError::conflict(
            "mode_composition_dataset_mismatch: composition run is not the active run",
        ));
    }
    let stage_exists = snapshot.stage_execution.as_ref().is_some_and(|execution| {
        execution
            .stages
            .iter()
            .any(|stage| stage.stage_id.as_deref() == Some(composition.stage_id.as_str()))
    });
    if !stage_exists {
        return Err(ApiError::conflict(
            "mode_composition_dataset_mismatch: composition stage is not published by the active run",
        ));
    }
    Ok(())
}

fn validate_published_mode(
    snapshot: &crate::types::SessionStateResponse,
    layer: &ModeCompositionLayer,
) -> Result<(), ApiError> {
    let artifact_dir = crate::session::current_artifact_dir(snapshot).ok_or_else(|| {
        ApiError::conflict("mode_composition_mode_missing: active run has no artifact directory")
    })?;
    let spectrum = ["eigen/spectrum.v3.json", "eigen/spectrum.v2.json"]
        .iter()
        .find_map(|path| {
            crate::artifacts::read_json_artifact_value(&artifact_dir, path)
                .ok()
                .map(|spectrum| (*path, spectrum))
        });
    let Some((spectrum_path, spectrum)) = spectrum else {
        return Err(ApiError::conflict(
            "mode_composition_mode_missing: no published eigen spectrum for the active run",
        ));
    };
    if !spectrum_declares_mode(&spectrum, layer) {
        return Err(ApiError::conflict(format!(
            "mode_composition_mode_missing: mode {} for sample {} is not published",
            layer.mode.mode_id, layer.mode.sample_id
        )));
    }
    if layer.mode.artifact_revision.starts_with("sha256:") {
        let artifact_path = crate::artifacts::resolve_artifact_path(&artifact_dir, spectrum_path)?;
        let bytes = std::fs::read(&artifact_path).map_err(|error| {
            ApiError::internal(format!(
                "failed to read published eigen spectrum '{}': {error}",
                artifact_path.display()
            ))
        })?;
        let digest = format!("sha256:{:x}", Sha256::digest(bytes));
        if layer.mode.artifact_revision != digest {
            return Err(ApiError::conflict(
                "mode_composition_dataset_mismatch: layer artifact revision is not the published spectrum revision",
            ));
        }
    }
    Ok(())
}

fn spectrum_declares_mode(spectrum: &serde_json::Value, layer: &ModeCompositionLayer) -> bool {
    spectrum
        .get("samples")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter(|sample| {
            sample.get("sample_id").and_then(serde_json::Value::as_str)
                == Some(layer.mode.sample_id.as_str())
        })
        .flat_map(|sample| {
            sample
                .get("modes")
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
        })
        .any(|mode| {
            mode.get("mode_id").and_then(serde_json::Value::as_str)
                == Some(layer.mode.mode_id.as_str())
        })
}

async fn emit_mode_composition_realtime_change(
    state: &Arc<AppState>,
    revision: u64,
) -> Result<(), ApiError> {
    let (session_id, run_id) = state
        .current_live_state
        .read()
        .await
        .as_ref()
        .map(|snapshot| {
            (
                snapshot.session.session_id.clone(),
                snapshot.run.as_ref().map(|run| run.run_id.clone()),
            )
        })
        .unwrap_or_else(|| ("current".to_string(), None));
    crate::publish_current_live_realtime_resource_changes(
        state,
        session_id,
        run_id,
        vec![RealtimeResourceChange {
            resource: RealtimeResourceName::VisualizationState,
            revision,
            resource_id: Some("mode-compositions/active".to_string()),
            quantity_ids: Vec::new(),
            broad: false,
            domain_generation_id: None,
            recommended_fetch: Some(
                "/v2/sessions/current/visualization/mode-compositions/active".to_string(),
            ),
        }],
        false,
        0,
    )
    .await
}

pub(crate) fn apply_mode_composition_patch(
    current: &ModeCompositionResource,
    patch: ModeCompositionPatch,
) -> Result<ModeCompositionResource, ApiError> {
    if patch.base_revision != current.revision {
        return Err(ApiError::conflict(format!(
            "mode_composition_revision_conflict: expected base revision {}, received {}",
            current.revision, patch.base_revision
        )));
    }

    let mut next = current.clone();
    if let Some(dataset) = patch.dataset {
        validate_identity("run_id", &dataset.run_id)?;
        validate_identity("stage_id", &dataset.stage_id)?;
        validate_identity("artifact_revision", &dataset.artifact_revision)?;
        if !next.layers.is_empty()
            && (next.run_id != dataset.run_id
                || next.stage_id != dataset.stage_id
                || next.artifact_revision != dataset.artifact_revision)
        {
            return Err(ApiError::conflict(
                "mode_composition_dataset_mismatch: clear existing layers before changing the dataset",
            ));
        }
        next.run_id = dataset.run_id;
        next.stage_id = dataset.stage_id;
        next.artifact_revision = dataset.artifact_revision;
    }
    if let Some(clock) = patch.phase_clock {
        if !clock.master_rate_hz.is_finite() || clock.master_rate_hz < 0.0 {
            return Err(ApiError::bad_request(
                "mode_composition_value_invalid: master_rate_hz must be finite and non-negative",
            ));
        }
        next.phase_clock = clock;
    }

    for operation in patch.operations {
        match operation {
            ModeCompositionOperation::UpsertLayer { layer } => {
                validate_layer(&next, &layer)?;
                if let Some(existing) = next
                    .layers
                    .iter_mut()
                    .find(|existing| existing.layer_id == layer.layer_id)
                {
                    *existing = layer;
                } else {
                    next.layers.push(layer);
                }
            }
            ModeCompositionOperation::RemoveLayer { layer_id } => {
                validate_identity("layer_id", &layer_id)?;
                next.layers.retain(|layer| layer.layer_id != layer_id);
            }
            ModeCompositionOperation::ClearLayers => next.layers.clear(),
        }
    }

    validate_unique_surface_owners(&next.layers)?;
    next.schema_version = "mode-composition.v1".to_string();
    next.revision = current.revision.saturating_add(1);
    Ok(next)
}

fn validate_layer(
    composition: &ModeCompositionResource,
    layer: &ModeCompositionLayer,
) -> Result<(), ApiError> {
    for (name, value) in [
        ("layer_id", layer.layer_id.as_str()),
        ("target_id", layer.target_id.as_str()),
        ("object_id", layer.object_id.as_str()),
        ("field_id", layer.field_id.as_str()),
        ("sample_id", layer.mode.sample_id.as_str()),
        ("mode_id", layer.mode.mode_id.as_str()),
    ] {
        validate_identity(name, value)?;
    }
    if layer.target_id != format!("object:{}", layer.object_id) {
        return Err(ApiError::bad_request(
            "mode_field_object_scope_missing: target_id must be the canonical object target",
        ));
    }
    if layer.mode.run_id != composition.run_id
        || layer.mode.stage_id != composition.stage_id
        || layer.mode.artifact_revision != composition.artifact_revision
    {
        return Err(ApiError::conflict(
            "mode_composition_dataset_mismatch: layer mode reference does not match the active composition dataset",
        ));
    }
    for (name, value) in [
        ("phase_rad", layer.phase_rad),
        ("amplitude_scale", layer.amplitude_scale),
        ("animation.rate_hz", layer.animation.rate_hz),
        (
            "animation.phase_offset_rad",
            layer.animation.phase_offset_rad,
        ),
        ("appearance.opacity", layer.appearance.opacity),
        (
            "appearance.vector_length_scale",
            layer.appearance.vector_length_scale,
        ),
    ] {
        if !value.is_finite() {
            return Err(ApiError::bad_request(format!(
                "mode_composition_value_invalid: {name} must be finite"
            )));
        }
    }
    if layer.amplitude_scale < 0.0
        || layer.animation.rate_hz < 0.0
        || layer.appearance.vector_length_scale < 0.0
        || !(0.0..=1.0).contains(&layer.appearance.opacity)
    {
        return Err(ApiError::bad_request(
            "mode_composition_value_invalid: scale/rate must be non-negative and opacity must be in [0, 1]",
        ));
    }
    match (layer.representation, layer.component) {
        (ModeFieldRepresentation::Abs, ModeFieldComponent::Vector)
        | (ModeFieldRepresentation::Phase, ModeFieldComponent::Vector)
        | (ModeFieldRepresentation::Phase, ModeFieldComponent::Magnitude) => {
            return Err(ApiError::bad_request(
                "mode_composition_projection_invalid: representation and component combination is not supported",
            ));
        }
        _ => {}
    }
    match (layer.appearance.range_min, layer.appearance.range_max) {
        (Some(min), Some(max)) if min.is_finite() && max.is_finite() && min < max => {}
        (None, None) => {}
        _ => {
            return Err(ApiError::bad_request(
                "mode_composition_value_invalid: manual range must contain finite min < max",
            ))
        }
    }
    Ok(())
}

fn validate_unique_surface_owners(layers: &[ModeCompositionLayer]) -> Result<(), ApiError> {
    let mut targets = HashSet::new();
    for layer in layers.iter().filter(|layer| layer.enabled) {
        if !targets.insert(layer.target_id.as_str()) {
            return Err(ApiError::conflict(format!(
                "duplicate_surface_owner: {}",
                layer.target_id
            )));
        }
    }
    Ok(())
}

fn validate_identity(name: &str, value: &str) -> Result<(), ApiError> {
    if value.trim().is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        return Err(ApiError::bad_request(format!(
            "mode_composition_identity_invalid: {name} must be non-empty, bounded text"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schemas::mode_composition::{
        EigenModeResourceRef, ModeCompositionLayer, ModeCompositionOperation, ModeCompositionPatch,
        ModeCompositionResource, ModeFieldComponent, ModeFieldNormalization,
        ModeFieldRepresentation, ModeLayerAnimation, ModeLayerAppearance,
    };

    fn layer(layer_id: &str, object_id: &str) -> ModeCompositionLayer {
        ModeCompositionLayer {
            layer_id: layer_id.to_string(),
            target_id: format!("object:{object_id}"),
            object_id: object_id.to_string(),
            enabled: true,
            mode: EigenModeResourceRef {
                run_id: "run-1".to_string(),
                stage_id: "stage-1".to_string(),
                artifact_revision: "artifact-1".to_string(),
                sample_id: "sample-1".to_string(),
                mode_id: "mode-1".to_string(),
                branch_id: None,
                sample_index: Some(0),
                raw_mode_index: Some(0),
            },
            field_id: "analysis:eigen:sample-0000:mode-0000".to_string(),
            representation: ModeFieldRepresentation::PhaseRotatedReal,
            component: ModeFieldComponent::X,
            phase_rad: 0.0,
            amplitude_scale: 1.0,
            normalization: ModeFieldNormalization::ModeGlobalMax,
            animation: ModeLayerAnimation {
                enabled: false,
                rate_hz: 1.0,
                phase_offset_rad: 0.0,
                synchronized: true,
            },
            appearance: ModeLayerAppearance {
                colormap: "coolwarm".to_string(),
                auto_range: true,
                range_min: None,
                range_max: None,
                symmetric_zero: true,
                opacity: 1.0,
                colorbar_visible: true,
                vectors_visible: false,
                vector_budget: 1200,
                vector_length_scale: 1.0,
            },
        }
    }

    #[test]
    fn patch_rejects_duplicate_enabled_surface_owner_for_target() {
        let current = ModeCompositionResource {
            revision: 7,
            run_id: "run-1".to_string(),
            stage_id: "stage-1".to_string(),
            artifact_revision: "artifact-1".to_string(),
            ..ModeCompositionResource::default()
        };
        let patch = ModeCompositionPatch {
            base_revision: 7,
            dataset: None,
            phase_clock: None,
            operations: vec![
                ModeCompositionOperation::UpsertLayer {
                    layer: layer("mode-layer:a", "sample"),
                },
                ModeCompositionOperation::UpsertLayer {
                    layer: layer("mode-layer:b", "sample"),
                },
            ],
        };

        let error = apply_mode_composition_patch(&current, patch)
            .expect_err("one target cannot have two enabled modal surface owners");
        assert!(error.message.starts_with("duplicate_surface_owner:"));
    }

    #[test]
    fn patch_rejects_stale_revision_and_dataset_mismatch() {
        let current = ModeCompositionResource {
            revision: 4,
            run_id: "run-1".to_string(),
            stage_id: "stage-1".to_string(),
            artifact_revision: "artifact-1".to_string(),
            ..ModeCompositionResource::default()
        };
        let stale = ModeCompositionPatch {
            base_revision: 3,
            dataset: None,
            phase_clock: None,
            operations: Vec::new(),
        };
        assert!(apply_mode_composition_patch(&current, stale)
            .expect_err("stale revision must fail")
            .message
            .starts_with("mode_composition_revision_conflict:"));

        let mismatch = ModeCompositionPatch {
            base_revision: 4,
            dataset: None,
            phase_clock: None,
            operations: vec![ModeCompositionOperation::UpsertLayer {
                layer: layer("mode-layer:a", "sample"),
            }],
        };
        let mut foreign = match &mismatch.operations[0] {
            ModeCompositionOperation::UpsertLayer { layer } => layer.clone(),
            _ => unreachable!(),
        };
        foreign.mode.artifact_revision = "artifact-2".to_string();
        let mismatch = ModeCompositionPatch {
            operations: vec![ModeCompositionOperation::UpsertLayer { layer: foreign }],
            ..mismatch
        };
        assert!(apply_mode_composition_patch(&current, mismatch)
            .expect_err("foreign dataset must fail")
            .message
            .starts_with("mode_composition_dataset_mismatch:"));
    }

    #[test]
    fn lifecycle_change_clears_layers_and_advances_only_the_composition_revision() {
        let current = ModeCompositionResource {
            revision: 7,
            run_id: "run-1".to_string(),
            stage_id: "stage-1".to_string(),
            artifact_revision: "artifact-1".to_string(),
            layers: vec![layer("mode-layer:a", "sample")],
            ..ModeCompositionResource::default()
        };
        let lifecycle = ModeCompositionLifecycle {
            session_id: "session-2".to_string(),
            run_id: Some("run-2".to_string()),
            artifact_revision: 9,
            mesh_revision: 11,
        };

        let reset = reset_mode_composition_for_lifecycle_change(&current, lifecycle.clone());

        assert_eq!(reset.revision, 8);
        assert!(reset.layers.is_empty());
        assert!(reset.run_id.is_empty());
        assert!(reset.stage_id.is_empty());
        assert!(reset.artifact_revision.is_empty());
        assert_eq!(reset.lifecycle, lifecycle);
    }

    #[test]
    fn published_mode_validation_uses_stable_sample_and_mode_ids() {
        let spectrum = serde_json::json!({
            "samples": [{
                "sample_id": "sample-1",
                "modes": [{ "mode_id": "mode-1" }]
            }]
        });
        let known = layer("mode-layer:a", "sample");
        assert!(spectrum_declares_mode(&spectrum, &known));

        let mut wrong_sample = known.clone();
        wrong_sample.mode.sample_id = "sample-2".to_string();
        assert!(!spectrum_declares_mode(&spectrum, &wrong_sample));

        let mut wrong_mode = known;
        wrong_mode.mode.mode_id = "mode-2".to_string();
        assert!(!spectrum_declares_mode(&spectrum, &wrong_mode));
    }

    #[test]
    fn patch_rejects_illegal_representation_component_pairs() {
        let current = ModeCompositionResource {
            revision: 2,
            run_id: "run-1".to_string(),
            stage_id: "stage-1".to_string(),
            artifact_revision: "artifact-1".to_string(),
            ..ModeCompositionResource::default()
        };
        for (representation, component) in [
            (ModeFieldRepresentation::Abs, ModeFieldComponent::Vector),
            (ModeFieldRepresentation::Phase, ModeFieldComponent::Vector),
            (
                ModeFieldRepresentation::Phase,
                ModeFieldComponent::Magnitude,
            ),
        ] {
            let mut invalid = layer("mode-layer:a", "sample");
            invalid.representation = representation;
            invalid.component = component;
            let error = apply_mode_composition_patch(
                &current,
                ModeCompositionPatch {
                    base_revision: 2,
                    dataset: None,
                    phase_clock: None,
                    operations: vec![ModeCompositionOperation::UpsertLayer { layer: invalid }],
                },
            )
            .expect_err("invalid projection must fail closed");
            assert!(error
                .message
                .starts_with("mode_composition_projection_invalid:"));
        }
    }
}
