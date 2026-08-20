//! Quantity catalog endpoint under the canonical resource-first v1 contract.

use axum::{extract::State, Json};
use std::sync::Arc;

use crate::schemas::quantities::QuantityCatalogResponse;
use crate::types::{AppState, SessionStateResponse};
use fullmag_quantities::normalize_quantity_id;

fn capability_list_contains(ids: &[String], entry: &crate::schemas::quantities::QuantityCatalogEntry) -> bool {
    ids.iter().any(|id| {
        normalize_quantity_id(id)
            .map(|normalized| normalized.as_str() == entry.id)
            .unwrap_or_else(|_| {
                id.eq_ignore_ascii_case(&entry.id)
                    || entry
                        .scalar_metric_key
                        .as_deref()
                        .is_some_and(|key| id.eq_ignore_ascii_case(key))
            })
    })
}

fn solver_advertises_quantity(
    entry: &crate::schemas::quantities::QuantityCatalogEntry,
    preview_quantities: &[String],
    snapshot_quantities: &[String],
    scalar_outputs: &[String],
) -> bool {
    if entry.shape == "global_scalar" || entry.location == "global" {
        capability_list_contains(scalar_outputs, entry)
    } else {
        capability_list_contains(preview_quantities, entry)
            || capability_list_contains(snapshot_quantities, entry)
    }
}

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
    let Some(capabilities) = snapshot.capabilities.as_ref() else {
        return;
    };

    for entry in &mut response.quantities {
        let advertised = solver_advertises_quantity(
            entry,
            &capabilities.preview_quantities,
            &capabilities.snapshot_quantities,
            &capabilities.scalar_outputs,
        );
        let supported = advertised;
        entry.capability_state = if supported {
            "supported".to_string()
        } else {
            "unsupported".to_string()
        };
        entry.solver_capability = entry.capability_state.clone();
        entry.requestable = supported
            && matches!(
                entry.shape.as_str(),
                "vector_field" | "spatial_scalar" | "global_scalar"
            );
        entry.materializable = supported
            && matches!(entry.shape.as_str(), "vector_field" | "spatial_scalar")
            && entry.supports_preview_3d;
        entry.renderable = entry.materializable && entry.renderable;

        let status = snapshot.live_state.as_ref().and_then(|state| {
            state
                .latest_step
                .field_materialization_states
                .iter()
                .find(|status| status.quantity == entry.id)
        });
        let has_payload = snapshot.latest_fields.get(&entry.id).is_some()
            || snapshot.preview_cache.get(&entry.id).is_some();
        let (materialization_state, reason_code) = match status.map(|status| status.state) {
            Some(fullmag_runner::LiveFieldMaterializationState::Pending) => {
                if has_payload {
                    ("stale_complete", Some("field_stale_complete"))
                } else {
                    ("pending", Some("field_materialization_pending"))
                }
            }
            Some(fullmag_runner::LiveFieldMaterializationState::Superseded) => {
                ("stale_complete", Some("field_stale_complete"))
            }
            Some(fullmag_runner::LiveFieldMaterializationState::Error) => {
                ("error", Some("field_materialization_error"))
            }
            Some(fullmag_runner::LiveFieldMaterializationState::Complete) => ("complete", None),
            None if has_payload => ("complete", None),
            None if supported => ("unmaterialized", Some("field_unmaterialized")),
            None => ("unsupported", Some("quantity_unsupported")),
        };
        entry.materialization_state = materialization_state.to_string();
        entry.materialization_reason_code = reason_code.map(str::to_string);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(solver_advertises_quantity(
            &total_energy,
            &[],
            &[],
            &["E_total".to_string()],
        ));
        assert!(!solver_advertises_quantity(
            &total_energy,
            &["E_total".to_string()],
            &[],
            &[],
        ));
    }

    #[test]
    fn spatial_capability_never_leaks_from_scalar_outputs() {
        let demag = entry("H_demag");
        assert!(!solver_advertises_quantity(
            &demag,
            &[],
            &[],
            &["H_demag".to_string()],
        ));
        assert!(solver_advertises_quantity(
            &demag,
            &["H_demag".to_string()],
            &[],
            &[],
        ));
    }
}
