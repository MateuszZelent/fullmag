//! Analytic reference models for dispersion comparison (ADR 0054, spec
//! frontend-v2/32 §9).
//!
//! The comparison status is derived from declared assumptions, never from the
//! closeness of the curves. This resource publishes, for each analytic model
//! the planner accepts in `dispersion_validation.analytic_model`, the physical
//! assumptions and the source of its validity range.

use axum::Json;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

pub const ANALYTIC_REFERENCE_SCHEMA_VERSION: &str = "analytic-reference-models.v1";

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AnalyticReferenceValidity {
    /// Field of the run's validation intent that bounds the compared |k| [rad/m].
    pub wavevector_limit_source: String,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AnalyticReferenceModelResource {
    pub model_id: String,
    pub title: String,
    /// Boundary assumption compared with the run's, e.g. `open_film`.
    pub boundary_assumption: String,
    pub surface_pinning: String,
    pub thickness_mode_order: u32,
    pub assumptions: Vec<String>,
    pub validity: AnalyticReferenceValidity,
    pub bibliography: String,
    pub physics_note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AnalyticReferenceModelCollectionResource {
    pub schema_version: String,
    pub models: Vec<AnalyticReferenceModelResource>,
}

pub fn analytic_reference_models() -> AnalyticReferenceModelCollectionResource {
    AnalyticReferenceModelCollectionResource {
        schema_version: ANALYTIC_REFERENCE_SCHEMA_VERSION.to_string(),
        models: vec![AnalyticReferenceModelResource {
            model_id: "kalinikos_slab_n0".to_string(),
            title: "Kalinikos–Slavin dipole-exchange, lowest thickness mode".to_string(),
            boundary_assumption: "open_film".to_string(),
            surface_pinning: "unpinned".to_string(),
            thickness_mode_order: 0,
            assumptions: vec![
                "Laterally infinite film in open space".to_string(),
                "Uniform static magnetization".to_string(),
                "Unpinned surface spins".to_string(),
                "Diagonal approximation, n = 0 thickness mode".to_string(),
            ],
            validity: AnalyticReferenceValidity {
                wavevector_limit_source: "dispersion_validation.max_k_rad_per_m".to_string(),
                note: "The run declares the compared |k| range; a finite airbox truncation is a different assumption"
                    .to_string(),
            },
            bibliography:
                "Kalinikos and Slavin, J. Phys. C 19 (1986), DOI:10.1088/0022-3719/19/35/7013"
                    .to_string(),
            physics_note: "docs/physics/0700-frequency-domain-linearized-llg.md".to_string(),
        }],
    }
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/references/analytic-models",
    responses((status = 200, body = AnalyticReferenceModelCollectionResource)),
    tag = "analysis"
)]
pub async fn list_analytic_reference_models() -> Json<AnalyticReferenceModelCollectionResource> {
    Json(analytic_reference_models())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_planner_analytic_model_declares_its_assumptions() {
        let catalog = analytic_reference_models();
        let model = catalog
            .models
            .iter()
            .find(|model| model.model_id == "kalinikos_slab_n0")
            .expect("planner model is published");
        assert_eq!(model.boundary_assumption, "open_film");
        assert_eq!(
            model.validity.wavevector_limit_source,
            "dispersion_validation.max_k_rad_per_m"
        );
    }
}
