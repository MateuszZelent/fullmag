use crate::{
    error::ApiError,
    planar_sampling::{PlanarMeshOverlay, MAX_FDM_PLANAR_GRID_SEGMENTS},
};

const FMFG_HEADER_LEN: usize = 160;

pub(crate) fn serialize_fmfg_v1(overlay: &PlanarMeshOverlay) -> Result<Vec<u8>, ApiError> {
    if overlay.segments.len() > MAX_FDM_PLANAR_GRID_SEGMENTS {
        return Err(ApiError::unprocessable(format!(
            "planar_mesh_budget_exceeded: FDM grid overlay exceeds {MAX_FDM_PLANAR_GRID_SEGMENTS} segments"
        )));
    }
    if overlay
        .bounds_uv_m
        .iter()
        .chain(
            overlay
                .frame_origin_m
                .iter()
                .chain(&overlay.frame_u_axis)
                .chain(&overlay.frame_v_axis)
                .chain(&overlay.frame_normal),
        )
        .any(|value| !value.is_finite())
    {
        return Err(ApiError::unprocessable(
            "invalid_fdm_planar_grid_overlay: non-finite geometry",
        ));
    }
    if overlay
        .segments
        .iter()
        .flat_map(|segment| segment.a_uv_m.iter().chain(&segment.b_uv_m))
        .any(|value| !value.is_finite() || !(*value as f32).is_finite())
    {
        return Err(ApiError::unprocessable(
            "invalid_fdm_planar_grid_overlay: segment is not representable as f32",
        ));
    }
    let mut bytes = Vec::with_capacity(FMFG_HEADER_LEN + overlay.segments.len() * 16);
    bytes.extend_from_slice(b"FMFG");
    write_u32(&mut bytes, 1);
    write_u32(&mut bytes, overlay.segments.len() as u32);
    bytes.resize(32, 0);
    for value in overlay.bounds_uv_m {
        write_f64(&mut bytes, value);
    }
    for vector in [
        overlay.frame_origin_m,
        overlay.frame_u_axis,
        overlay.frame_v_axis,
        overlay.frame_normal,
    ] {
        for value in vector {
            write_f64(&mut bytes, value);
        }
    }
    debug_assert_eq!(bytes.len(), FMFG_HEADER_LEN);
    for segment in &overlay.segments {
        for value in [
            segment.a_uv_m[0],
            segment.a_uv_m[1],
            segment.b_uv_m[0],
            segment.b_uv_m[1],
        ] {
            bytes.extend_from_slice(&(value as f32).to_le_bytes());
        }
    }
    Ok(bytes)
}

fn write_u32(bytes: &mut Vec<u8>, value: u32) {
    bytes.extend_from_slice(&value.to_le_bytes());
}
fn write_f64(bytes: &mut Vec<u8>, value: f64) {
    bytes.extend_from_slice(&value.to_le_bytes());
}
