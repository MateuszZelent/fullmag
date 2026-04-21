//! Quantity catalog endpoint under the canonical resource-first v1 contract.

use axum::Json;

use crate::schemas::quantities::QuantityCatalogResponse;

#[utoipa::path(
    get,
    path = "/v1/live/current/quantities/catalog",
    responses(
        (status = 200, description = "Quantity catalog", body = QuantityCatalogResponse),
    ),
    tag = "quantities"
)]
pub async fn get_quantities_catalog() -> Json<QuantityCatalogResponse> {
    Json(QuantityCatalogResponse::build())
}
