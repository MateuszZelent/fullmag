use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct QuantityCatalogEntry {
    pub id: String,
    pub label: String,
    pub description: String,
    pub shape: String,
    pub unit: String,
    pub location: String,
    pub domain: String,
    pub n_comp: u8,
    pub normalization_hint: String,
    pub interactive_preview: bool,
    pub supports_preview_2d: bool,
    pub supports_preview_3d: bool,
    pub supports_history: bool,
    pub supports_export: bool,
    /// Capability of the resolved backend/plan, independent of field cache.
    pub capability_state: String,
    /// Whether the current plan can materialize this quantity on demand.
    pub materializable: bool,
    /// Current cache/materialization state.  This is intentionally separate
    /// from `capability_state`: an advertised quantity may have no payload yet.
    pub materialization_state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub materialization_reason_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quick_access_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scalar_metric_key: Option<String>,
}

impl From<fullmag_quantities::QuantityDescriptorWire> for QuantityCatalogEntry {
    fn from(value: fullmag_quantities::QuantityDescriptorWire) -> Self {
        Self {
            id: value.id,
            label: value.label,
            description: value.description,
            shape: value.shape,
            unit: value.unit,
            location: value.location,
            domain: value.domain,
            n_comp: value.n_comp,
            normalization_hint: value.normalization_hint,
            interactive_preview: value.interactive_preview,
            supports_preview_2d: value.supports_preview_2d,
            supports_preview_3d: value.supports_preview_3d,
            supports_history: value.supports_history,
            supports_export: value.supports_export,
            capability_state: "unknown".to_string(),
            materializable: false,
            materialization_state: "unmaterialized".to_string(),
            materialization_reason_code: None,
            quick_access_label: value.quick_access_label,
            scalar_metric_key: value.scalar_metric_key,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct QuantityCatalogResponse {
    pub schema_version: String,
    pub quantities: Vec<QuantityCatalogEntry>,
}

impl QuantityCatalogResponse {
    pub fn build() -> Self {
        fullmag_quantities::QuantityCatalogResponse::build().into()
    }
}

impl From<fullmag_quantities::QuantityCatalogResponse> for QuantityCatalogResponse {
    fn from(value: fullmag_quantities::QuantityCatalogResponse) -> Self {
        Self {
            schema_version: value.schema_version,
            quantities: value.quantities.into_iter().map(Into::into).collect(),
        }
    }
}
