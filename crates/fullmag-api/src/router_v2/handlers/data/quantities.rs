//! Quantity catalog endpoint under the canonical resource-first v1 contract.

use axum::{extract::{Query, State}, Json};
use std::sync::Arc;

use crate::schemas::quantities::QuantityCatalogResponse;
use crate::session::{
    relevant_field_materialization_status, resolved_current_field_source,
    ResolvedCurrentFieldSource,
};
use crate::types::{AppState, SessionStateResponse};
use fullmag_quantities::{quantity_spec, QuantitySpec};
use fullmag_runner::{
    resolve_quantity_capability, FieldCarrierDescriptor, FieldPayloadState,
    QuantityMaterializationCapability, ResolvedQuantityCapabilityContext,
};

use super::resolved_spatial_field::{
    full_field_publication_carrier_identity, resolve_current_spatial_field_metadata,
    SpatialFieldCarrier, SpatialFieldSourceKind,
};

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/quantities",
    params(crate::schemas::fields::ArtifactFieldCatalogQuery),
    responses(
        (status = 200, description = "Quantity catalog", body = QuantityCatalogResponse),
    ),
    tag = "data"
)]
pub async fn get_quantities_catalog(
    State(state): State<Arc<AppState>>,
    Query(query): Query<crate::schemas::fields::ArtifactFieldCatalogQuery>,
) -> Result<Json<QuantityCatalogResponse>, crate::error::ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let artifact_fields = match query.stage_id.as_deref() {
        Some(stage) => super::inspection_field_provider::catalog_fields_for_stage(&state, stage).await?,
        None => Vec::new(),
    };
    let mut response = QuantityCatalogResponse::build();
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| crate::error::ApiError::not_found("no active local live workspace"))?;
    crate::ensure_current_live_request_context(
        snapshot,
        &request_context,
        state
            .current_live_session_epoch
            .load(std::sync::atomic::Ordering::Acquire),
    )?;
    for field in &artifact_fields {super::inspection_field_provider::ensure_observation(snapshot,field)?;}
    annotate_runtime_quantity_state(&mut response, snapshot);
    if query.stage_id.is_some() {
        response.quantities.retain(|entry| artifact_fields.iter().any(|field| field.quantity_id == entry.id));
    }
    for field in &artifact_fields {
        let Some(entry)=response.quantities.iter_mut().find(|entry|entry.id==field.quantity_id) else {continue;};
        let capability=super::inspection_field_provider::capability(field)?;
        let renderable=capability.render==fullmag_runner::QuantityRenderCapability::Renderable;
        let next:crate::schemas::quantities::ResolvedQuantityCapability=capability.into();
        let already_artifact=entry.resolved_capability.as_ref().is_some_and(|old|old.lane=="artifact_inspection_read_only");
        if already_artifact {entry.resolved_capability.as_mut().expect("artifact capability").carriers.extend(next.carriers);}
        else {entry.resolved_capability=Some(next);}
        entry.capability_state="supported".into();entry.requestable=true;entry.renderable=renderable;
        entry.materializable=false;entry.materialization_state="stale_complete".into();
        entry.materialization_reason_code=Some("historical_inspection_read_only".into());
        // The solver capability remains the ordinary resolved-plan truth.
        entry.location=super::inspection_field_provider::locator(field)?.indexing.as_str().into();
    }
    Ok(Json(response))
}

fn annotate_runtime_quantity_state(
    response: &mut QuantityCatalogResponse,
    snapshot: &SessionStateResponse,
) {
    let standalone_inspection = snapshot
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("execution_plan"))
        .and_then(|plan| plan.get("backend_plan"))
        .and_then(|plan| plan.get("kind"))
        .and_then(serde_json::Value::as_str)
        == Some("antenna_external_lead_inspection");
    // An unresolved workspace remains unknown. A resolved nonmagnetic
    // inspection, however, has no magnetic provider: use the canonical
    // unavailable capability path even without a magnetic runtime profile.
    let prepared_m_without_runtime_capabilities = snapshot.capabilities.is_none()
        && !standalone_inspection
        && quantity_spec("m").is_some_and(|spec| {
            prepared_initial_state_m_carriers(snapshot, spec, spec.domain.as_str()).is_some()
        });
    if snapshot.capabilities.is_none() && !standalone_inspection
        && !prepared_m_without_runtime_capabilities
    {
        return;
    }

    for entry in &mut response.quantities {
        if prepared_m_without_runtime_capabilities && entry.id != "m" {
            continue;
        }
        let Some(spec) = quantity_spec(&entry.id) else {
            continue;
        };
        let preliminary = resolved_quantity_capability_for_snapshot(
            snapshot,
            spec,
            QuantityMaterializationCapability::Unmaterialized,
            Vec::new(),
            spec.domain.as_str(),
        );
        let supported =
            preliminary.provider == fullmag_runner::QuantityProviderCapability::Available;

        let status = relevant_field_materialization_status(snapshot, &entry.id);
        let resolved_field = resolve_current_spatial_field_metadata(
            snapshot,
            &entry.id,
            usize::from(spec.n_comp),
        )
        .ok()
        .flatten();
        // Metadata resolution validates the descriptor's value_count and
        // current domain without reading a binary field payload.
        let has_payload = resolved_field.is_some()
            || crate::accepted_field_materialization::current_global_energy(snapshot, &entry.id).is_some();
        let unavailable_payload_state = || {
            if supported {
                ("unmaterialized", Some("field_unmaterialized"))
            } else {
                ("unsupported", Some("quantity_unsupported"))
            }
        };
        let (materialization_state, reason_code) = match status.map(|status| status.state) {
            Some(fullmag_runner::LiveFieldMaterializationState::Pending) => {
                if has_payload {
                    ("stale_complete", Some("field_stale_complete"))
                } else {
                    ("pending", Some("field_materialization_pending"))
                }
            }
            Some(fullmag_runner::LiveFieldMaterializationState::Superseded) => {
                if has_payload {
                    ("stale_complete", Some("field_stale_complete"))
                } else {
                    unavailable_payload_state()
                }
            }
            Some(fullmag_runner::LiveFieldMaterializationState::Error) => {
                ("error", Some("field_materialization_error"))
            }
            Some(fullmag_runner::LiveFieldMaterializationState::Complete) if has_payload => {
                ("complete", None)
            }
            Some(fullmag_runner::LiveFieldMaterializationState::Complete) => {
                unavailable_payload_state()
            }
            None if has_payload => ("complete", None),
            None => unavailable_payload_state(),
        };
        entry.materialization_state = materialization_state.to_string();
        entry.materialization_reason_code = reason_code.map(str::to_string);

        let materialization = match materialization_state {
            "complete" | "stale_complete" => QuantityMaterializationCapability::Materialized,
            "pending" => QuantityMaterializationCapability::Pending,
            "unmaterialized" => QuantityMaterializationCapability::Unmaterialized,
            _ => QuantityMaterializationCapability::Unavailable,
        };
        let carriers = if matches!(materialization_state, "complete" | "stale_complete") {
            resolved_field
                .as_ref()
                .and_then(full_field_publication_carrier_identity)
                .map(|identity| {
                    current_field_carriers(
                        spec,
                        &identity.scope_kind,
                        identity.scope_id.as_deref(),
                        &identity.carrier_id,
                        Some(&identity.carrier_fingerprint),
                        None,
                    )
                })
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        let resolved = resolved_quantity_capability_for_snapshot(
            snapshot,
            spec,
            materialization,
            carriers,
            spec.domain.as_str(),
        );
        entry.capability_state = if supported {
            "supported"
        } else {
            "unsupported"
        }
        .to_string();
        entry.solver_capability = entry.capability_state.clone();
        entry.requestable = matches!(
            resolved.request,
            fullmag_runner::QuantityRequestCapability::FieldVector
                | fullmag_runner::QuantityRequestCapability::ScalarResource
        );
        entry.materializable = matches!(
            resolved.request,
            fullmag_runner::QuantityRequestCapability::FieldVector
        ) && resolved.reason_code.as_deref() != Some("prepared_initial_state");
        // The Docker runtime only adopts fields a finished accepted run
        // published; it has no evaluator for a prepared state. Report such a
        // field as supported but not yet computable instead of letting a
        // Compute request fail.
        if entry.materializable
            && materialization_state == "unmaterialized"
            && accepted_fields_require_terminal_run(snapshot)
        {
            entry.materializable = false;
            entry.materialization_reason_code = Some("accepted_state_required".to_string());
        }
        entry.renderable = resolved.render == fullmag_runner::QuantityRenderCapability::Renderable;
        entry.resolved_capability = Some(resolved.into());
    }
}

/// Whether field materialization must wait for a finished accepted run.
fn accepted_fields_require_terminal_run(snapshot: &SessionStateResponse) -> bool {
    crate::live_accepted_execution::docker_api_only_runtime()
        && !snapshot.run.as_ref().is_some_and(|run| {
            matches!(run.status.as_str(), "completed" | "failed" | "cancelled")
        })
}

pub(crate) fn current_field_carriers(
    spec: &QuantitySpec,
    scope_kind: &str,
    scope_id: Option<&str>,
    carrier_id: &str,
    carrier_fingerprint: Option<&str>,
    payload_version: Option<&str>,
) -> Vec<FieldCarrierDescriptor> {
    if !matches!(
        spec.shape,
        fullmag_quantities::QuantityShape::VectorField
            | fullmag_quantities::QuantityShape::SpatialScalar
    ) || carrier_id.trim().is_empty()
        || carrier_fingerprint.is_none_or(|fingerprint| fingerprint.trim().is_empty())
        || carrier_id.starts_with("declared:")
    {
        return Vec::new();
    }
    vec![FieldCarrierDescriptor {
        carrier_id: carrier_id.to_string(),
        carrier_fingerprint: carrier_fingerprint.unwrap().to_string(),
        scope: scope_kind.to_string(),
        scope_kind: scope_kind.to_string(),
        scope_id: scope_id.map(str::to_string),
        components: spec.n_comp,
        indexing: spec.location.as_str().to_string(),
        view: spec.default_component.as_str().to_string(),
        payload_version: payload_version.map(str::to_string),
        payload_state: FieldPayloadState::Current,
    }]
}

pub(crate) fn resolved_quantity_capability_for_snapshot(
    snapshot: &SessionStateResponse,
    spec: &QuantitySpec,
    materialization: QuantityMaterializationCapability,
    carriers: Vec<FieldCarrierDescriptor>,
    scope: &str,
) -> fullmag_runner::ResolvedQuantityCapability {
    let precision = snapshot
        .session
        .resolved_precision
        .as_deref()
        .unwrap_or(snapshot.session.precision.as_str());
    match snapshot.capabilities.as_ref() {
        Some(capabilities) => resolve_quantity_capability(
            capabilities,
            spec,
            ResolvedQuantityCapabilityContext {
                scope,
                precision,
                materialization,
                carriers,
            },
        ),
        None => {
            let mut unavailable = fullmag_runner::ResolvedQuantityCapability {
                quantity_id: spec.id.as_str().to_string(),
                provider: fullmag_runner::QuantityProviderCapability::Unavailable,
                request: fullmag_runner::QuantityRequestCapability::Unavailable,
                materialization: QuantityMaterializationCapability::Unavailable,
                render: fullmag_runner::QuantityRenderCapability::Unavailable,
                publication: if spec.ui_exposed && spec.interactive_preview {
                    fullmag_runner::QuantityPublicationCapability::Interactive
                } else if spec.supports_export {
                    fullmag_runner::QuantityPublicationCapability::ExportOnly
                } else {
                    fullmag_runner::QuantityPublicationCapability::Hidden
                },
                scope: scope.to_string(),
                reason_code: Some("runtime_capabilities_unavailable".to_string()),
                lane: "unresolved".to_string(),
                precision: precision.to_string(),
                carriers: Vec::new(),
            };
            if let Some(prepared_carriers) =
                prepared_initial_state_m_carriers(snapshot, spec, scope)
            {
                unavailable.request = fullmag_runner::QuantityRequestCapability::FieldVector;
                unavailable.materialization = QuantityMaterializationCapability::Materialized;
                unavailable.render = fullmag_runner::QuantityRenderCapability::Renderable;
                unavailable.reason_code = Some("prepared_initial_state".to_string());
                unavailable.carriers = prepared_carriers;
            }
            unavailable
        }
    }
}

/// Keep a prepared initial magnetization readable before a solver provider is
/// selected, while requiring the field to remain the exact current publication
/// bound to the prepared mesh workspace and current observation domain.
fn prepared_initial_state_m_carriers(
    snapshot: &SessionStateResponse,
    spec: &QuantitySpec,
    scope: &str,
) -> Option<Vec<FieldCarrierDescriptor>> {
    if spec.id.as_str() != "m" || scope.trim().is_empty() || scope.trim() == "airbox" {
        return None;
    }

    let workspace = snapshot.mesh_workspace.as_ref()?;
    if workspace.get("status").and_then(serde_json::Value::as_str) != Some("completed") {
        return None;
    }
    let preparation_id = workspace
        .get("preparation_id")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())?;
    let plan_fingerprint = workspace
        .get("plan_fingerprint")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())?;
    let source_scene_revision = workspace
        .get("source_scene_revision")
        .and_then(serde_json::Value::as_u64)?;
    if snapshot.scene_document.as_ref()?.revision != source_scene_revision {
        return None;
    }

    let raw = snapshot.latest_fields.get("m")?;
    let provenance = raw.get("provenance")?;
    if provenance.get("source_kind").and_then(serde_json::Value::as_str)
        != Some("prepared_initial_state")
        || provenance
            .get("preparation_id")
            .and_then(serde_json::Value::as_str)
            != Some(preparation_id)
        || provenance
            .get("plan_fingerprint")
            .and_then(serde_json::Value::as_str)
            != Some(plan_fingerprint)
        || raw
            .get("source_revision")
            .and_then(serde_json::Value::as_u64)
            != Some(source_scene_revision)
        || raw.get("source_step").and_then(serde_json::Value::as_u64) != Some(0)
    {
        return None;
    }

    let source_time_seconds = raw
        .get("source_time_seconds")
        .and_then(serde_json::Value::as_f64)
        .filter(|time| time.is_finite() && *time >= 0.0)?;
    let observation_frame = raw
        .get("observation_frame")
        .and_then(|value| {
            serde_json::from_value::<crate::schemas::common::AcceptedObservationFrameRef>(
                value.clone(),
            )
            .ok()
        })?;
    if observation_frame.source_step != 0
        || observation_frame.source_time_seconds != Some(source_time_seconds)
        || observation_frame
            != crate::session::accepted_observation_frame_ref(
                snapshot,
                0,
                Some(source_time_seconds),
            )
    {
        return None;
    }

    // A same-identity preview or legacy live field must not stand in for the
    // prepared materialization. Pointer identity ties this check to `latest_fields.m`.
    let Some(ResolvedCurrentFieldSource::Latest(selected)) =
        resolved_current_field_source(snapshot, "m", usize::from(spec.n_comp))
    else {
        return None;
    };
    if !std::ptr::eq(selected, raw) {
        return None;
    }

    let field = resolve_current_spatial_field_metadata(snapshot, "m", usize::from(spec.n_comp))
        .ok()??;
    if field.source_kind != SpatialFieldSourceKind::Materialized {
        return None;
    }
    let value_count = super::field_resolution::json_field_value_count(raw);
    if value_count == 0 || value_count % usize::from(spec.n_comp) != 0 {
        return None;
    }
    let point_count = value_count / usize::from(spec.n_comp);
    field.validate_metadata_contract(point_count).ok()?;

    // The preparation publisher already rejects non-finite vectors. This
    // metadata-only resolution checks the current spatial layout without
    // decoding a large field a second time during catalog/capability reads;
    // the field resource decoder validates values before returning them.
    let layout = raw.get("layout")?;
    let layout_matches = match &field.carrier {
        SpatialFieldCarrier::FdmCells {
            cells,
            multilayer_scope,
            ..
        } => {
            if let Some(multilayer_scope) = multilayer_scope {
                layout == multilayer_scope.artifact_layout
                    && layout
                        .get("backend")
                        .and_then(serde_json::Value::as_str)
                        == Some("fdm_multilayer")
            } else {
                layout
                    .get("backend")
                    .and_then(serde_json::Value::as_str)
                    == Some("fdm")
                    && super::field_resolution::json_field_grid(raw) == Some(*cells)
            }
        }
        SpatialFieldCarrier::FemNodes { topology, .. } => {
            layout
                .get("backend")
                .and_then(serde_json::Value::as_str)
                == Some("fem")
                && layout
                    .get("location")
                    .and_then(serde_json::Value::as_str)
                    == Some("node")
                && layout.get("node_count").and_then(serde_json::Value::as_u64)
                    == u64::try_from(topology.nodes.len()).ok()
                && point_count == topology.nodes.len()
        }
        _ => false,
    };
    if !layout_matches {
        return None;
    }

    Some(
        full_field_publication_carrier_identity(&field)
            .map(|identity| {
                current_field_carriers(
                    spec,
                    &identity.scope_kind,
                    identity.scope_id.as_deref(),
                    &identity.carrier_id,
                    Some(&identity.carrier_fingerprint),
                    None,
                )
            })
            .unwrap_or_default(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::default_current_live_state;
    use crate::types::CurrentLiveSnapshotRequest;
    use fullmag_runner::{BackendCapabilities, ResolvedQuantityProviderRegistry, RuntimeEngineId};

    fn snapshot_with_field_provider(quantity_id: &str) -> SessionStateResponse {
        let request: CurrentLiveSnapshotRequest = serde_json::from_value(serde_json::json!({
            "session_id": "quantity-carrier-contract"
        }))
        .expect("minimal live snapshot request should deserialize");
        let mut snapshot = default_current_live_state(&request);
        snapshot.capabilities = Some(BackendCapabilities {
            engine_id: RuntimeEngineId::FdmCpuReference,
            capability_profile_version: "test".to_string(),
            supported_terms: Vec::new(),
            term_scopes: std::collections::BTreeMap::new(),
            feature_capabilities: std::collections::BTreeMap::new(),
            supported_demag_realizations: Vec::new(),
            preview_quantities: vec![quantity_id.to_string()],
            snapshot_quantities: Vec::new(),
            scalar_outputs: Vec::new(),
            resolved_quantity_registry: Some(ResolvedQuantityProviderRegistry::from_resolved_plan(
                "fdm_cpu_reference",
                "double",
                [quantity_id],
                std::iter::empty::<&str>(),
            )),
            approximate_operators: Vec::new(),
            supports_frequency_response: false,
            supports_coupled_magnetoelastic_quasistatic: false,
            supports_coupled_magnetoelastic_elastodynamic: false,
            supports_frequency_domain_elastodynamics: false,
            supports_coupled_eigenmodes: false,
            supports_lossy_fallback_override: false,
        });
        snapshot
    }

    fn entry(id: &str) -> crate::schemas::quantities::QuantityCatalogEntry {
        QuantityCatalogResponse::build()
            .quantities
            .into_iter()
            .find(|entry| entry.id == id)
            .expect("catalog quantity")
    }

    fn snapshot_with_prepared_initial_m() -> SessionStateResponse {
        let request: CurrentLiveSnapshotRequest = serde_json::from_value(serde_json::json!({
            "session_id": "prepared-initial-m-contract"
        }))
        .expect("minimal live snapshot request should deserialize");
        let mut snapshot = default_current_live_state(&request);
        snapshot.metadata = Some(serde_json::json!({
            "execution_plan": {
                "backend_plan": {
                    "kind": "fdm",
                    "grid": { "cells": [1, 1, 1] }
                }
            }
        }).into());
        snapshot.mesh_workspace = Some(serde_json::json!({
            "preparation_id": "prep-current",
            "plan_fingerprint": "plan-current",
            "source_scene_revision": 7,
            "status": "completed"
        }).into());
        let mut scene = fullmag_authoring::SceneDocument::default();
        scene.revision = 7;
        snapshot.scene_document = Some(scene);

        let observation_frame = crate::session::accepted_observation_frame_ref(
            &snapshot,
            0,
            Some(0.0),
        );
        let mut latest_fields = crate::types::LatestFields::default();
        latest_fields.insert(
            "m".into(),
            serde_json::json!({
                "values": [[0.0, 0.0, 1.0]],
                "layout": { "backend": "fdm", "grid_cells": [1, 1, 1] },
                "source_step": 0,
                "source_time_seconds": 0.0,
                "source_revision": 7,
                "provenance": {
                    "source_kind": "prepared_initial_state",
                    "preparation_id": "prep-current",
                    "plan_fingerprint": "plan-current"
                },
                "observation_frame": observation_frame.clone()
            }),
        );
        let session_id = snapshot.session.session_id.clone();
        crate::session::apply_current_live_accepted_field_frame(
            &mut snapshot,
            crate::types::CurrentLiveFieldFrameRequest {
                session_id,
                latest_fields: Some(latest_fields),
                replace_latest_fields: false,
                field_generation: None,
                preview_fields: None,
                clear_preview_cache: false,
            },
            observation_frame,
        )
        .expect("prepared initial magnetization should bind to the current frame");
        snapshot
    }

    fn resolve_without_runtime_capabilities(
        snapshot: &SessionStateResponse,
        quantity_id: &str,
        scope: &str,
    ) -> fullmag_runner::ResolvedQuantityCapability {
        let spec = quantity_spec(quantity_id).expect("canonical quantity");
        resolved_quantity_capability_for_snapshot(
            snapshot,
            spec,
            QuantityMaterializationCapability::Unmaterialized,
            Vec::new(),
            scope,
        )
    }

    #[test]
    fn global_scalar_capability_comes_from_scalar_outputs_only() {
        let total_energy = entry("E_total");
        assert_eq!(total_energy.shape, "global_scalar");
        assert_eq!(total_energy.location, "global");
    }

    #[test]
    fn spatial_capability_never_leaks_from_scalar_outputs() {
        let demag = entry("H_demag");
        assert_eq!(demag.shape, "vector_field");
        assert_ne!(demag.location, "global");
    }

    #[test]
    fn exact_prepared_initial_m_remains_readable_without_solver_capabilities() {
        let snapshot = snapshot_with_prepared_initial_m();
        let spec = quantity_spec("m").expect("magnetization quantity");
        let resolved = resolve_without_runtime_capabilities(&snapshot, "m", spec.domain.as_str());

        assert_eq!(
            resolved.provider,
            fullmag_runner::QuantityProviderCapability::Unavailable
        );
        assert_eq!(
            resolved.request,
            fullmag_runner::QuantityRequestCapability::FieldVector
        );
        assert_eq!(
            resolved.materialization,
            QuantityMaterializationCapability::Materialized
        );
        assert_eq!(
            resolved.render,
            fullmag_runner::QuantityRenderCapability::Renderable
        );
        assert_eq!(resolved.lane, "unresolved");
        assert_eq!(resolved.reason_code.as_deref(), Some("prepared_initial_state"));
    }

    #[test]
    fn prepared_initial_m_catalog_is_readable_but_not_materializable() {
        let snapshot = snapshot_with_prepared_initial_m();
        let mut response = QuantityCatalogResponse::build();
        annotate_runtime_quantity_state(&mut response, &snapshot);

        let magnetization = response
            .quantities
            .iter()
            .find(|entry| entry.id == "m")
            .expect("magnetization catalog entry");
        assert_eq!(magnetization.capability_state, "unsupported");
        assert_eq!(magnetization.solver_capability, "unsupported");
        assert!(magnetization.requestable);
        assert!(magnetization.renderable);
        assert!(!magnetization.materializable);
        let resolved = magnetization
            .resolved_capability
            .as_ref()
            .expect("prepared initial magnetization capability");
        assert_eq!(
            resolved.provider,
            crate::schemas::quantities::QuantityProviderCapability::Unavailable
        );
        assert_eq!(resolved.lane, "unresolved");
        assert_eq!(resolved.reason_code.as_deref(), Some("prepared_initial_state"));

        let demag = response
            .quantities
            .iter()
            .find(|entry| entry.id == "H_demag")
            .expect("demagnetizing field catalog entry");
        assert_eq!(demag.capability_state, "unknown");
        assert!(demag.resolved_capability.is_none());
    }

    #[test]
    fn prepared_initial_m_rejects_stale_identity_frame_airbox_and_other_quantities() {
        let mut stale_identity = snapshot_with_prepared_initial_m();
        stale_identity
            .mesh_workspace
            .as_mut()
            .expect("current mesh workspace")["plan_fingerprint"] =
            serde_json::json!("different-plan");
        let spec = quantity_spec("m").expect("magnetization quantity");
        assert_eq!(
            resolve_without_runtime_capabilities(
                &stale_identity,
                "m",
                spec.domain.as_str()
            )
            .request,
            fullmag_runner::QuantityRequestCapability::Unavailable
        );

        let mut missing_identity = snapshot_with_prepared_initial_m();
        missing_identity
            .mesh_workspace
            .as_mut()
            .expect("current mesh workspace")
            .as_object_mut()
            .expect("mesh workspace object")
            .remove("preparation_id");
        assert_eq!(
            resolve_without_runtime_capabilities(
                &missing_identity,
                "m",
                spec.domain.as_str()
            )
            .request,
            fullmag_runner::QuantityRequestCapability::Unavailable
        );

        let mut stale_frame = snapshot_with_prepared_initial_m();
        stale_frame.mesh_revision = stale_frame.mesh_revision.saturating_add(1);
        assert_eq!(
            resolve_without_runtime_capabilities(&stale_frame, "m", spec.domain.as_str())
                .request,
            fullmag_runner::QuantityRequestCapability::Unavailable
        );
        let current = snapshot_with_prepared_initial_m();
        assert_eq!(
            resolve_without_runtime_capabilities(&current, "m", "airbox").request,
            fullmag_runner::QuantityRequestCapability::Unavailable
        );
        let demag = quantity_spec("H_demag").expect("demagnetizing field quantity");
        assert_eq!(
            resolve_without_runtime_capabilities(&current, "H_demag", demag.domain.as_str())
                .request,
            fullmag_runner::QuantityRequestCapability::Unavailable
        );
    }

    #[test]
    fn standalone_without_magnetic_capabilities_resolves_catalog_unavailable() {
        let mut snapshot = snapshot_with_field_provider("m");
        snapshot.capabilities = None;
        snapshot.metadata = Some(serde_json::json!({
            "execution_plan": { "backend_plan": { "kind": "antenna_external_lead_inspection" } }
        }).into());
        let mut response = QuantityCatalogResponse::build();
        annotate_runtime_quantity_state(&mut response, &snapshot);

        for entry in &response.quantities {
            assert_eq!(entry.capability_state, "unsupported", "{}", entry.id);
            assert_eq!(entry.solver_capability, "unsupported", "{}", entry.id);
            assert_eq!(entry.materialization_state, "unsupported", "{}", entry.id);
            assert!(!entry.requestable && !entry.materializable, "{}", entry.id);
            assert!(!entry.renderable, "{}", entry.id);
            let resolved = entry.resolved_capability.as_ref().expect("resolved absence");
            assert_eq!(
                resolved.provider,
                crate::schemas::quantities::QuantityProviderCapability::Unavailable
            );
            assert_eq!(
                resolved.request,
                crate::schemas::quantities::QuantityRequestCapability::Unavailable
            );
            assert!(resolved.carriers.is_empty());
        }
    }

    #[test]
    fn unresolved_workspace_catalog_stays_unknown_without_capabilities() {
        let mut snapshot = snapshot_with_field_provider("m");
        snapshot.capabilities = None;
        snapshot.metadata = None;
        let mut response = QuantityCatalogResponse::build();
        annotate_runtime_quantity_state(&mut response, &snapshot);
        assert!(response.quantities.iter().all(|entry| entry.capability_state == "unknown"));
    }

    #[test]
    fn legal_unmaterialized_quantity_catalog_entry_has_no_carrier() {
        let snapshot = snapshot_with_field_provider("H_demag");
        let mut response = QuantityCatalogResponse::build();

        annotate_runtime_quantity_state(&mut response, &snapshot);

        let demag = response
            .quantities
            .iter()
            .find(|entry| entry.id == "H_demag")
            .expect("canonical quantity");
        let resolved = demag
            .resolved_capability
            .as_ref()
            .expect("resolved capability");
        assert_eq!(demag.materialization_state, "unmaterialized");
        assert!(resolved.carriers.is_empty());
        assert!(response.quantities.iter().all(|entry| {
            entry.resolved_capability.as_ref().is_none_or(|resolved| {
                resolved
                    .carriers
                    .iter()
                    .all(|carrier| !carrier.carrier_id.starts_with("declared:"))
            })
        }));
    }

    #[test]
    fn completed_vector_status_without_payload_remains_unmaterialized() {
        let mut snapshot = snapshot_with_field_provider("H_demag");
        snapshot.live_state = Some(
            serde_json::from_value(serde_json::json!({
                "status": "running",
                "updated_at_unix_ms": 1,
                "latest_step": {
                    "step": 1,
                    "time": 0.0,
                    "dt": 0.0,
                    "e_ex": 0.0,
                    "e_demag": 0.0,
                    "e_ext": 0.0,
                    "e_total": 0.0,
                    "max_dm_dt": 0.0,
                    "max_h_eff": 0.0,
                    "wall_time_ns": 0,
                    "grid": [1, 1, 1],
                    "field_materialization_states": [{
                        "quantity": "H_demag",
                        "source_step": 1,
                        "request_revision": 4,
                        "state": "complete",
                        "error": null
                    }],
                    "finished": false
                }
            }))
            .expect("complete live state should deserialize"),
        );
        let mut response = QuantityCatalogResponse::build();

        annotate_runtime_quantity_state(&mut response, &snapshot);

        let demag = response
            .quantities
            .iter()
            .find(|entry| entry.id == "H_demag")
            .expect("canonical quantity");
        assert_eq!(demag.materialization_state, "unmaterialized");
        assert_eq!(
            demag.materialization_reason_code.as_deref(),
            Some("field_unmaterialized")
        );
        assert!(demag
            .resolved_capability
            .as_ref()
            .expect("resolved capability")
            .carriers
            .is_empty());
    }
}
