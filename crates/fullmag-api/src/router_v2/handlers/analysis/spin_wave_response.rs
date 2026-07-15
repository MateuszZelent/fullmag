//! Time-domain Γ and finite-k spin-wave analysis artifact resources.

use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::artifacts::{read_json_artifact_value, require_current_live_artifact_dir};
use crate::error::ApiError;
use crate::types::AppState;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SpinWavePeakResource {
    pub index: usize,
    pub frequency_hz: f64,
    pub power: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SpinWaveGammaResource {
    pub schema_version: String,
    pub time_unit: String,
    pub frequency_unit: String,
    pub trace_unit: String,
    pub source_unit: String,
    pub susceptibility_unit: String,
    pub weighting: String,
    pub detrend: String,
    pub window: String,
    pub normalization: String,
    pub reference_m0: f64,
    pub reference_m0_secondary: f64,
    pub response_component: String,
    pub transverse_components: [String; 2],
    pub time_s: Vec<f64>,
    pub response_trace: Vec<f64>,
    pub secondary_response_trace: Vec<f64>,
    pub source_trace: Vec<f64>,
    pub frequency_hz: Vec<f64>,
    pub response_psd: Vec<f64>,
    pub primary_response_psd: Vec<f64>,
    pub secondary_response_psd: Vec<f64>,
    pub source_psd: Vec<f64>,
    pub response_spectrum_real: Vec<f64>,
    pub response_spectrum_imag: Vec<f64>,
    pub secondary_response_spectrum_real: Vec<f64>,
    pub secondary_response_spectrum_imag: Vec<f64>,
    pub source_spectrum_real: Vec<f64>,
    pub source_spectrum_imag: Vec<f64>,
    pub window_values: Vec<f64>,
    pub window_power_sum: f64,
    pub nyquist_hz: f64,
    pub susceptibility_abs: Vec<Option<f64>>,
    pub peaks: Vec<SpinWavePeakResource>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct DynamicStructureFactorResource {
    pub schema_version: String,
    pub artifact_ref: String,
    pub bounded: bool,
    pub original_frequency_count: usize,
    pub original_wavevector_count: usize,
    pub wavevector_unit: String,
    pub frequency_unit: String,
    pub x_m: Vec<f64>,
    pub time_s: Vec<f64>,
    pub k_rad_per_m: Vec<f64>,
    pub frequency_hz: Vec<f64>,
    pub power: Vec<f64>,
    pub spectrum_real: Vec<f64>,
    pub spectrum_imag: Vec<f64>,
    pub source_power: Vec<f64>,
    pub source_spectrum_real: Vec<f64>,
    pub source_spectrum_imag: Vec<f64>,
    pub source_observable: String,
    pub source_unit: String,
    pub component: String,
    pub propagation_axis: String,
    pub phase_convention: String,
    pub normalization: String,
    pub spatial_window: Vec<f64>,
    pub temporal_window: Vec<f64>,
    pub spatial_window_power_sum: f64,
    pub temporal_window_power_sum: f64,
    pub mesh_probe_signature: String,
    pub invalid_probe_mask: Vec<bool>,
    pub excluded_absorber_ranges_m: Vec<[f64; 2]>,
    pub frequency_count: usize,
    pub wavevector_count: usize,
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/spin-wave/gamma.v1",
    responses(
        (status = 200, description = "Moment-weighted Γ time trace and spectrum", body = SpinWaveGammaResource),
        (status = 404, description = "No Γ spin-wave response artifact"),
    ),
    tag = "analysis"
)]
pub async fn get_spin_wave_gamma(
    State(state): State<Arc<AppState>>,
) -> Result<Json<SpinWaveGammaResource>, ApiError> {
    read_typed_artifact(&state, "analysis/spin_wave_response.gamma.v1.json").await
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/spin-wave/dynamic-structure-factor.v1",
    responses(
        (status = 200, description = "Finite-k dynamic structure factor", body = DynamicStructureFactorResource),
        (status = 404, description = "No finite-k spin-wave artifact"),
    ),
    tag = "analysis"
)]
pub async fn get_dynamic_structure_factor(
    State(state): State<Arc<AppState>>,
) -> Result<Json<DynamicStructureFactorResource>, ApiError> {
    let Json(resource) = read_typed_artifact(&state, "analysis/dynamic_structure_factor.1d.v1.json").await?;
    Ok(Json(bound_dynamic_structure_factor(resource, 4096)))
}

fn bound_dynamic_structure_factor(mut resource: DynamicStructureFactorResource, max_cells: usize) -> DynamicStructureFactorResource {
    let original_nf = resource.frequency_count;
    let original_nk = resource.wavevector_count;
    if original_nf.saturating_mul(original_nk) <= max_cells { return resource; }
    let mut f_stride=1usize; let mut k_stride=1usize;
    while original_nf.div_ceil(f_stride).saturating_mul(original_nk.div_ceil(k_stride)) > max_cells {
        if original_nf / f_stride >= original_nk / k_stride { f_stride += 1; } else { k_stride += 1; }
    }
    let f_indices=(0..original_nf).step_by(f_stride).collect::<Vec<_>>();
    let k_indices=(0..original_nk).step_by(k_stride).collect::<Vec<_>>();
    let project = |values: &[f64]| f_indices.iter().flat_map(|f| k_indices.iter().map(move |k| values.get(f*original_nk+k).copied().unwrap_or(0.0))).collect::<Vec<_>>();
    resource.power=project(&resource.power);
    resource.spectrum_real=project(&resource.spectrum_real);
    resource.spectrum_imag=project(&resource.spectrum_imag);
    resource.source_power=project(&resource.source_power);
    resource.source_spectrum_real=project(&resource.source_spectrum_real);
    resource.source_spectrum_imag=project(&resource.source_spectrum_imag);
    resource.frequency_hz=f_indices.iter().map(|index| resource.frequency_hz[*index]).collect();
    resource.k_rad_per_m=k_indices.iter().map(|index| resource.k_rad_per_m[*index]).collect();
    resource.invalid_probe_mask=k_indices.iter().map(|index| resource.invalid_probe_mask.get(*index).copied().unwrap_or(true)).collect();
    resource.frequency_count=f_indices.len(); resource.wavevector_count=k_indices.len();
    resource.original_frequency_count=original_nf; resource.original_wavevector_count=original_nk; resource.bounded=true;
    resource
}

async fn read_typed_artifact<T>(state: &Arc<AppState>, relative_path: &str) -> Result<Json<T>, ApiError>
where
    T: for<'de> Deserialize<'de>,
{
    let artifact_dir = require_current_live_artifact_dir(state).await?;
    serde_json::from_value(read_json_artifact_value(&artifact_dir, relative_path)?)
        .map(Json)
        .map_err(|error| ApiError::internal(format!("invalid {relative_path} artifact: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finite_k_json_projection_is_bounded_and_keeps_artifact_reference() {
        let count=10_000;
        let resource=DynamicStructureFactorResource {
            schema_version:"dynamic_structure_factor.1d.v1".into(), artifact_ref:"analysis/full.json".into(), bounded:false,
            original_frequency_count:100, original_wavevector_count:100, wavevector_unit:"rad/m".into(), frequency_unit:"Hz".into(),
            x_m:(0..100).map(|i|i as f64).collect(), time_s:(0..198).map(|i|i as f64).collect(),
            k_rad_per_m:(0..100).map(|i|i as f64).collect(), frequency_hz:(0..100).map(|i|i as f64).collect(),
            power:vec![1.0;count], spectrum_real:vec![0.0;count], spectrum_imag:vec![0.0;count],
            source_power:vec![1.0;count], source_spectrum_real:vec![0.0;count], source_spectrum_imag:vec![0.0;count], source_observable:"H_drive".into(), source_unit:"A/m".into(),
            component:"my".into(), propagation_axis:"x".into(), phase_convention:"exp[-i(k*x-2*pi*f*t)]".into(), normalization:"canonical".into(),
            spatial_window:vec![1.0;100], temporal_window:vec![1.0;198], spatial_window_power_sum:100.0, temporal_window_power_sum:198.0,
            mesh_probe_signature:"signature".into(), invalid_probe_mask:vec![false;100], excluded_absorber_ranges_m:vec![], frequency_count:100, wavevector_count:100,
        };
        let bounded=bound_dynamic_structure_factor(resource,4096);
        assert!(bounded.bounded);
        assert!(bounded.frequency_count*bounded.wavevector_count<=4096);
        assert_eq!(bounded.power.len(),bounded.frequency_count*bounded.wavevector_count);
        assert_eq!(bounded.artifact_ref,"analysis/full.json");
        assert_eq!((bounded.original_frequency_count,bounded.original_wavevector_count),(100,100));
    }
}
