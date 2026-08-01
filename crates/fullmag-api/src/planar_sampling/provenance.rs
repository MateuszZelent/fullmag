use super::{Occupancy, PlanarSampleMeta, ResolvedPlanarSampleRequest, PLANAR_SAMPLER_VERSION};

pub(super) fn meta(
    request: &ResolvedPlanarSampleRequest,
    sampling_method: &'static str,
    occupancy: &[Occupancy],
    occupied_measure: f64,
    overlap_count: u32,
    fold_count: u32,
    basis_order: u8,
    integration_order: u8,
) -> PlanarSampleMeta {
    PlanarSampleMeta {
        sampler_version: PLANAR_SAMPLER_VERSION,
        sampling_method,
        monitor_id: request.monitor_id.clone(),
        monitor_hash: request.monitor_hash.clone(),
        bounds_uv_m: match request.frame.extent {
            fullmag_ir::PlanarExtentIR::Explicit {
                u_min_m,
                u_max_m,
                v_min_m,
                v_max_m,
            } => [u_min_m, u_max_m, v_min_m, v_max_m],
            _ => [0.0; 4],
        },
        resolution: request.resolution,
        occupied_count: occupancy
            .iter()
            .filter(|value| {
                matches!(
                    value,
                    Occupancy::Occupied
                        | Occupancy::UndefinedOrientation
                        | Occupancy::OverlapAmbiguous
                )
            })
            .count() as u32,
        partial_count: occupancy
            .iter()
            .filter(|value| **value == Occupancy::Partial)
            .count() as u32,
        empty_count: occupancy
            .iter()
            .filter(|value| **value == Occupancy::Empty)
            .count() as u32,
        occupied_measure,
        overlap_count,
        fold_count,
        non_injective: overlap_count > 0 || fold_count > 0,
        basis_order,
        integration_order,
    }
}
