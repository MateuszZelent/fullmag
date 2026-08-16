//! Quantity catalog endpoint under the canonical resource-first v1 contract.

use axum::{extract::State, Json};
use std::sync::Arc;

use crate::schemas::quantities::QuantityCatalogResponse;
use crate::types::{AppState, SessionStateResponse};
use fullmag_quantities::normalize_quantity_id;

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
        let advertised = capabilities
            .preview_quantities
            .iter()
            .chain(capabilities.snapshot_quantities.iter())
            .filter_map(|id| normalize_quantity_id(id).ok())
            .any(|id| id.as_str() == entry.id);
        let supported = advertised;
        entry.capability_state = if supported {
            "supported".to_string()
        } else {
            "unsupported".to_string()
        };
        entry.materializable = supported && entry.supports_preview_3d;

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
