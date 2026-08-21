use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QuantityProviderCapability {
    Available,
    Unavailable,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QuantityRequestCapability {
    FieldVector,
    ScalarResource,
    UnsupportedShape,
    Unavailable,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QuantityMaterializationCapability {
    NotApplicable,
    Unmaterialized,
    Pending,
    Materialized,
    LegacyUnverified,
    Unavailable,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QuantityRenderCapability {
    Renderable,
    UnsupportedShape,
    Unavailable,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QuantityPublicationCapability {
    Interactive,
    ExportOnly,
    Hidden,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FieldPayloadState {
    Current,
    LegacyUnverified,
    Unmaterialized,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
pub struct FieldCarrierDescriptor {
    pub carrier_id: String,
    pub carrier_fingerprint: String,
    /// Compatibility projection of `scope_kind` for existing clients.
    pub scope: String,
    pub scope_kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope_id: Option<String>,
    pub components: u8,
    pub indexing: String,
    pub view: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload_version: Option<String>,
    pub payload_state: FieldPayloadState,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
pub struct ResolvedQuantityCapability {
    pub quantity_id: String,
    pub provider: QuantityProviderCapability,
    pub request: QuantityRequestCapability,
    pub materialization: QuantityMaterializationCapability,
    pub render: QuantityRenderCapability,
    pub publication: QuantityPublicationCapability,
    pub scope: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
    pub lane: String,
    pub precision: String,
    pub carriers: Vec<FieldCarrierDescriptor>,
}

macro_rules! mirror_enum_from_runner {
    ($runner:ty, $api:ty, {$($variant:ident),+ $(,)?}) => {
        impl From<$runner> for $api {
            fn from(value: $runner) -> Self {
                match value {
                    $(<$runner>::$variant => <$api>::$variant,)+
                }
            }
        }
    };
}

mirror_enum_from_runner!(fullmag_runner::QuantityProviderCapability, QuantityProviderCapability, {
    Available, Unavailable
});
mirror_enum_from_runner!(fullmag_runner::QuantityRequestCapability, QuantityRequestCapability, {
    FieldVector, ScalarResource, UnsupportedShape, Unavailable
});
mirror_enum_from_runner!(fullmag_runner::QuantityMaterializationCapability, QuantityMaterializationCapability, {
    NotApplicable, Unmaterialized, Pending, Materialized, LegacyUnverified, Unavailable
});
mirror_enum_from_runner!(fullmag_runner::QuantityRenderCapability, QuantityRenderCapability, {
    Renderable, UnsupportedShape, Unavailable
});
mirror_enum_from_runner!(fullmag_runner::QuantityPublicationCapability, QuantityPublicationCapability, {
    Interactive, ExportOnly, Hidden
});
mirror_enum_from_runner!(fullmag_runner::FieldPayloadState, FieldPayloadState, {
    Current, LegacyUnverified, Unmaterialized
});

impl From<fullmag_runner::FieldCarrierDescriptor> for FieldCarrierDescriptor {
    fn from(value: fullmag_runner::FieldCarrierDescriptor) -> Self {
        Self {
            carrier_id: value.carrier_id,
            carrier_fingerprint: value.carrier_fingerprint,
            scope: value.scope,
            scope_kind: value.scope_kind,
            scope_id: value.scope_id,
            components: value.components,
            indexing: value.indexing,
            view: value.view,
            payload_version: value.payload_version,
            payload_state: value.payload_state.into(),
        }
    }
}

impl From<fullmag_runner::ResolvedQuantityCapability> for ResolvedQuantityCapability {
    fn from(value: fullmag_runner::ResolvedQuantityCapability) -> Self {
        Self {
            quantity_id: value.quantity_id,
            provider: value.provider.into(),
            request: value.request.into(),
            materialization: value.materialization.into(),
            render: value.render.into(),
            publication: value.publication.into(),
            scope: value.scope,
            reason_code: value.reason_code,
            lane: value.lane,
            precision: value.precision,
            carriers: value.carriers.into_iter().map(Into::into).collect(),
        }
    }
}

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
    /// Solver/provider capability plane, independent of request and payload state.
    pub solver_capability: String,
    /// Whether the active runtime exposes a legal data-plane request for this shape.
    pub requestable: bool,
    /// Whether the current UI renderer supports this quantity shape without coercion.
    pub renderable: bool,
    /// Publication plane: `interactive`, `export_only`, or `hidden`.
    pub publication_state: String,
    /// Whether the current plan can materialize this quantity on demand.
    pub materializable: bool,
    /// Current cache/materialization state.  This is intentionally separate
    /// from `capability_state`: an advertised quantity may have no payload yet.
    pub materialization_state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub materialization_reason_code: Option<String>,
    /// Runner-resolved provider/request/materialization/render/publication truth.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_capability: Option<ResolvedQuantityCapability>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quick_access_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scalar_metric_key: Option<String>,
}

impl From<fullmag_quantities::QuantityDescriptorWire> for QuantityCatalogEntry {
    fn from(value: fullmag_quantities::QuantityDescriptorWire) -> Self {
        let renderable = value.ui_exposed
            && value.supports_preview_3d
            && matches!(value.shape.as_str(), "vector_field" | "spatial_scalar");
        let publication_state = if value.ui_exposed && value.interactive_preview {
            "interactive"
        } else if value.supports_export {
            "export_only"
        } else {
            "hidden"
        };
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
            solver_capability: "unknown".to_string(),
            requestable: false,
            renderable,
            publication_state: publication_state.to_string(),
            materializable: false,
            materialization_state: "unmaterialized".to_string(),
            materialization_reason_code: None,
            resolved_capability: None,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_catalog_preserves_all_canonical_quantities_and_shape_planes() {
        let catalog = QuantityCatalogResponse::build();
        assert_eq!(catalog.quantities.len(), 52);

        let tensor = catalog
            .quantities
            .iter()
            .find(|entry| entry.id == "spin_current_tensor")
            .expect("canonical tensor quantity");
        assert_eq!(tensor.shape, "tensor_field");
        assert_eq!(tensor.n_comp, 9);
        assert!(!tensor.requestable);
        assert!(!tensor.renderable);
        assert_eq!(tensor.publication_state, "export_only");

        let magnetization = catalog
            .quantities
            .iter()
            .find(|entry| entry.id == "m")
            .expect("canonical magnetization quantity");
        assert!(magnetization.renderable);
        assert_eq!(magnetization.publication_state, "interactive");
    }
}
