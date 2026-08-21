//! Quantity catalog endpoint under the canonical resource-first v1 contract.

use axum::{extract::State, Json};
use std::sync::Arc;

use crate::schemas::quantities::QuantityCatalogResponse;
use crate::types::{AppState, SessionStateResponse};
use fullmag_quantities::{quantity_spec, QuantitySpec};
use fullmag_runner::{
    resolve_quantity_capability, FieldCarrierDescriptor, FieldPayloadState,
    QuantityMaterializationCapability, ResolvedQuantityCapabilityContext,
};

use super::resolved_spatial_field::{
    full_field_publication_carrier_identity, resolve_current_spatial_field,
};

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/quantities",
    responses(
        (status = 200, description = "Quantity catalog", body = QuantityCatalogResponse),
    ),
    tag = "data"
)]
pub async fn get_quantities_catalog(
    State(state): State<Arc<AppState>>,
) -> Json<QuantityCatalogResponse> {
    let mut response = QuantityCatalogResponse::build();
    let guard = state.current_live_state.read().await;
    if let Some(snapshot) = guard.as_ref() {
        annotate_runtime_quantity_state(&mut response, snapshot);
    }
    Json(response)
}

fn annotate_runtime_quantity_state(
    response: &mut QuantityCatalogResponse,
    snapshot: &SessionStateResponse,
) {
    let Some(_capabilities) = snapshot.capabilities.as_ref() else {
        return;
    };

    for entry in &mut response.quantities {
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

        let status = snapshot.live_state.as_ref().and_then(|state| {
            state
                .latest_step
                .field_materialization_states
                .iter()
                .find(|status| status.quantity == entry.id)
        });
        let source_is_present = snapshot.latest_fields.get(&entry.id).is_some()
            || snapshot.preview_cache.get(&entry.id).is_some()
            || (entry.id == "m"
                && snapshot
                    .live_state
                    .as_ref()
                    .and_then(|state| state.latest_step.magnetization.as_ref())
                    .is_some());
        let resolved_field = source_is_present
            .then(|| resolve_current_spatial_field(snapshot, &entry.id, usize::from(spec.n_comp)))
            .transpose()
            .ok()
            .flatten()
            .flatten()
            .filter(|field| !field.values.is_empty());
        let has_payload = resolved_field.is_some();
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
        );
        entry.renderable = resolved.render == fullmag_runner::QuantityRenderCapability::Renderable;
        entry.resolved_capability = Some(resolved.into());
    }
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
        None => fullmag_runner::ResolvedQuantityCapability {
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
        },
    }
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
        assert!(response.quantities.iter().all(|entry| entry
            .resolved_capability
            .as_ref()
            .is_none_or(|resolved| resolved
                .carriers
                .iter()
                .all(|carrier| !carrier.carrier_id.starts_with("declared:")))));
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
