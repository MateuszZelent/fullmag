//! Quantity catalog endpoint under the canonical resource-first v1 contract.

use axum::Json;

use crate::schemas::quantities::QuantityCatalogResponse;

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/quantities",
    responses(
        (status = 200, description = "Quantity catalog", body = QuantityCatalogResponse),
    ),
    tag = "data"
)]
pub async fn get_quantities_catalog() -> Json<QuantityCatalogResponse> {
    Json(QuantityCatalogResponse::build())
}
