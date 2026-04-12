//! Quantity metadata — delegates to `fullmag_quantities` (the canonical crate)
//! and adds runner-specific helpers that depend on `StepStats`.

use crate::types::{RunError, StepStats};

// ── Re-exports from the shared crate ─────────────────────────────────

pub use fullmag_quantities::{
    QuantityComponent, QuantityId, QuantityShape,
    NormalizationHint, QuantityDomain, QuantityLocation,
    QuantityReduction,
    // catalog functions
    quantity_specs, quantity_spec, quantity_unit,
    interactive_preview_quantity_ids, cached_preview_quantity_ids,
    all_quantity_ids, quantity_catalog,
};

pub use fullmag_quantities::QuantitySpec;

/// Legacy alias — old code used `QuantityKind`; new canonical name is `QuantityShape`.
pub type QuantityKind = QuantityShape;

// ── Runner-specific helpers ──────────────────────────────────────────

pub fn quantity_spatial_domain(id: &str) -> &'static str {
    quantity_spec(id)
        .map(|spec| spec.domain.as_str())
        .unwrap_or(QuantityDomain::FullDomain.as_str())
}

pub fn normalize_quantity_id(requested: &str) -> Result<QuantityId, RunError> {
    fullmag_quantities::normalize_quantity_id(requested).map_err(|err| RunError {
        message: err.to_string(),
    })
}

pub fn parse_quantity_component(component: &str) -> Result<QuantityComponent, RunError> {
    QuantityComponent::parse(component).map_err(|msg| RunError { message: msg })
}

pub fn normalized_quantity_name(requested: &str) -> Result<&'static str, RunError> {
    Ok(normalize_quantity_id(requested)?.as_str())
}

pub fn global_scalar_value(id: &str, stats: &StepStats) -> Option<f64> {
    match quantity_spec(id)?.scalar_metric_key? {
        "e_ex" => Some(stats.e_ex),
        "e_demag" => Some(stats.e_demag),
        "e_ext" => Some(stats.e_ext),
        "e_ani" => Some(stats.e_ani),
        "e_dmi" => Some(stats.e_dmi),
        "e_total" => Some(stats.e_total),
        _ => None,
    }
}
