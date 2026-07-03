//! Canonical quantity system for Fullmag.
//!
//! This crate is the **single source of truth** for all quantity identity,
//! metadata, shape, domain, location, reduction, and capability information.
//!
//! It is deliberately dependency-light: only `serde` and `serde_json` are
//! required.  Every other Fullmag crate (`fullmag-ir`, `fullmag-plan`,
//! `fullmag-runner`, `fullmag-api`, `fullmag-py-core`) imports from here.
//!
//! # Design principles
//!
//! - **ZP-01**: no parallel catalogs.
//! - **ZP-02**: `m` is not an exception.
//! - **ZP-03**: separate physics from solver diagnostics.
//! - **ZP-05**: UI never guesses quantity metadata.

pub mod catalog;
pub mod descriptor;
pub mod eval;
pub mod id;
pub mod provider;
pub mod reduction;
pub mod registry;
pub mod schema_version;
pub mod step_data;
pub mod transport;

pub use catalog::{
    all_quantity_ids, cached_preview_quantity_ids, field_materialization_quantity_ids,
    interactive_preview_quantity_ids, quantity_catalog, quantity_spec, quantity_specs,
    quantity_unit,
};
pub use descriptor::{NormalizationHint, QuantityDomain, QuantityLocation, QuantitySpec};
pub use eval::{eval_global_scalar, reduce_scalars, reduce_vector_field, QuantityValue};
pub use id::{normalize_quantity_id, QuantityId, QuantityIdError};
pub use reduction::QuantityReduction;
pub use schema_version::SCHEMA_VERSION;
pub use step_data::{GlobalQuantityRow, StepDiagnostics};
pub use transport::{
    build_wire_catalog, LiveQuantityFrame, QuantityCatalogResponse, QuantityDescriptorLive,
    QuantityDescriptorWire, QuantityPreviewRequest, StepUpdateV2,
};

// Provider trait and registry (QB-05)
pub use provider::{EmptyFieldAccess, NamedFieldAccess, QuantityEvalContext, QuantityProvider};
pub use registry::{
    register_standard_providers, GlobalScalarProvider, QuantityRegistry,
    SpatialScalarFieldProvider, VectorFieldProvider,
};

/// Shape / kind of a quantity (determines renderer and transport).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuantityShape {
    VectorField,
    SpatialScalar,
    GlobalScalar,
}

impl QuantityShape {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::VectorField => "vector_field",
            Self::SpatialScalar => "spatial_scalar",
            Self::GlobalScalar => "global_scalar",
        }
    }

    /// Legacy alias used by existing API code.
    pub const fn as_api_kind(self) -> &'static str {
        self.as_str()
    }
}

/// Component selection for a quantity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuantityComponent {
    Vector3,
    X,
    Y,
    Z,
    Magnitude,
}

impl QuantityComponent {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Vector3 => "3D",
            Self::X => "x",
            Self::Y => "y",
            Self::Z => "z",
            Self::Magnitude => "magnitude",
        }
    }

    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "3D" => Ok(Self::Vector3),
            "x" => Ok(Self::X),
            "y" => Ok(Self::Y),
            "z" => Ok(Self::Z),
            "magnitude" => Ok(Self::Magnitude),
            other => Err(format!("unsupported quantity component '{other}'")),
        }
    }
}
