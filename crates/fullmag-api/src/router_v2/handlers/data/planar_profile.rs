//! Line profile of one planar sample (`eq-planar-line-profile`, note 0970).
//!
//! A profile is a derived resource of the same sample as the raster: the
//! segment lives in that sample's frame, every point is a probe-equivalent
//! point evaluation, and FEM profiles add the arc lengths where the segment
//! crosses element faces inside the plane, so the drawn trace is exact on
//! affine elements.

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::Json;

use crate::error::ApiError;
use crate::planar_sampling::{evaluate_point_component, PlanarMeshOverlay};
use crate::schemas::planar_fields::{
    PlanarFieldProfileQuery, PlanarFieldProfileResource, PlanarFieldQuery,
    PlanarProfilePointResource,
};
use crate::AppState;

use super::{build_planar_field_from_source, source_resource, PlanarDataSource};

/// Uniform samples accepted per profile.
const MIN_PROFILE_SAMPLES: u32 = 2;
const MAX_PROFILE_SAMPLES: u32 = 4096;
/// Upper bound on uniform plus element-face points in one response.
const MAX_PROFILE_POINTS: usize = 16_384;

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/planar-monitors/{monitor_id}/profile",
    params(("quantity_id" = String, Path), ("monitor_id" = String, Path), PlanarFieldProfileQuery),
    responses(
        (status = 200, body = PlanarFieldProfileResource),
        (status = 400, description = "Invalid planar query or segment", body = crate::schemas::common::ApiErrorResponse),
        (status = 404, description = "Field or monitor missing", body = crate::schemas::common::ApiErrorResponse),
        (status = 409, description = "Stale source", body = crate::schemas::common::ApiErrorResponse),
        (status = 422, description = "Unsupported planar sampling or too many profile points", body = crate::schemas::common::ApiErrorResponse)
    ),
    tag = "data"
)]
pub async fn get_planar_field_profile(
    State(state): State<Arc<AppState>>,
    Path((quantity_id, monitor_id)): Path<(String, String)>,
    Query(profile): Query<PlanarFieldProfileQuery>,
) -> Result<Json<PlanarFieldProfileResource>, ApiError> {
    planar_profile_response(
        &state,
        &quantity_id,
        PlanarDataSource::Monitor(monitor_id),
        profile,
    )
    .await
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/fields/{quantity_id}/planar-default/profile",
    params(("quantity_id" = String, Path), PlanarFieldProfileQuery),
    responses(
        (status = 200, body = PlanarFieldProfileResource),
        (status = 400, description = "Invalid planar query or segment", body = crate::schemas::common::ApiErrorResponse),
        (status = 404, description = "Field or domain missing", body = crate::schemas::common::ApiErrorResponse),
        (status = 409, description = "Stale source", body = crate::schemas::common::ApiErrorResponse),
        (status = 422, description = "Unsupported planar sampling or too many profile points", body = crate::schemas::common::ApiErrorResponse)
    ),
    tag = "data"
)]
pub async fn get_planar_default_field_profile(
    State(state): State<Arc<AppState>>,
    Path(quantity_id): Path<String>,
    Query(profile): Query<PlanarFieldProfileQuery>,
) -> Result<Json<PlanarFieldProfileResource>, ApiError> {
    planar_profile_response(&state, &quantity_id, PlanarDataSource::Default, profile).await
}

pub(super) async fn planar_profile_response(
    state: &Arc<AppState>,
    quantity_id: &str,
    source: PlanarDataSource,
    profile: PlanarFieldProfileQuery,
) -> Result<Json<PlanarFieldProfileResource>, ApiError> {
    let endpoints = [profile.u0_m, profile.v0_m, profile.u1_m, profile.v1_m];
    if endpoints.iter().any(|value| !value.is_finite()) {
        return Err(ApiError::bad_request(
            "invalid_planar_profile: segment endpoints must be finite",
        ));
    }
    let samples = profile.samples.unwrap_or(256);
    if !(MIN_PROFILE_SAMPLES..=MAX_PROFILE_SAMPLES).contains(&samples) {
        return Err(ApiError::bad_request(format!(
            "invalid_planar_profile: samples must be within {MIN_PROFILE_SAMPLES}..={MAX_PROFILE_SAMPLES}"
        )));
    }
    let du = profile.u1_m - profile.u0_m;
    let dv = profile.v1_m - profile.v0_m;
    let length_m = du.hypot(dv);
    if length_m <= 0.0 {
        return Err(ApiError::bad_request(
            "invalid_planar_profile: segment endpoints must differ",
        ));
    }
    let query = PlanarFieldQuery {
        sample_token: profile.sample_token.clone(),
        component: profile.component.clone(),
        scope_kind: profile.scope_kind.clone(),
        scope_id: profile.scope_id.clone(),
        scope_region_id: profile.scope_region_id.clone(),
        stage_id: profile.stage_id.clone(),
        snapshot_id: profile.snapshot_id.clone(),
        resolution_x: profile.resolution_x,
        resolution_y: profile.resolution_y,
        quality: profile.quality.clone(),
        vector_budget: Some(0),
        include_mesh: Some(false),
        expected_scene_revision: profile.expected_scene_revision,
        expected_monitor_revision: profile.expected_monitor_revision,
        expected_source_revision: profile.expected_source_revision,
        expected_mesh_revision: profile.expected_mesh_revision,
        expected_carrier_revision: profile.expected_carrier_revision,
        expected_field_revision: profile.expected_field_revision,
        position_fraction: None,
    };
    let built = build_planar_field_from_source(state, quantity_id, source, &query).await?;
    let bounds = built.result.meta.bounds_uv_m;
    let frame = &built.frame;

    let mut parameters = (0..samples)
        .map(|index| (f64::from(index) / f64::from(samples - 1), "uniform"))
        .collect::<Vec<_>>();
    if let Some(overlay) = &built.result.overlay {
        parameters.extend(
            face_crossings(overlay, [profile.u0_m, profile.v0_m], [du, dv])
                .into_iter()
                .map(|t| (t, "element_face")),
        );
    }
    if parameters.len() > MAX_PROFILE_POINTS {
        return Err(ApiError::unprocessable(format!(
            "planar_profile_too_dense: {} points exceed {MAX_PROFILE_POINTS}; shorten the segment or coarsen the mesh",
            parameters.len()
        )));
    }
    parameters.sort_by(|left, right| left.0.total_cmp(&right.0));
    parameters.dedup_by(|next, kept| {
        let same = (next.0 - kept.0).abs() <= 1.0e-12;
        if same && next.1 == "element_face" {
            kept.1 = "element_face";
        }
        same
    });

    let mut points = Vec::with_capacity(parameters.len());
    // One element index for the whole profile instead of a scan per point.
    let mut locator = built.target.point_locator(parameters.len());
    for (t, kind) in parameters {
        let u_m = profile.u0_m + t * du;
        let v_m = profile.v0_m + t * dv;
        let world_m = [
            frame.origin_m[0] + u_m * frame.u_axis[0] + v_m * frame.v_axis[0],
            frame.origin_m[1] + u_m * frame.u_axis[1] + v_m * frame.v_axis[1],
            frame.origin_m[2] + u_m * frame.u_axis[2] + v_m * frame.v_axis[2],
        ];
        let inside_frame =
            u_m >= bounds[0] && u_m <= bounds[1] && v_m >= bounds[2] && v_m <= bounds[3];
        let point = if inside_frame {
            locator.evaluate(world_m)
        } else {
            None
        };
        let (scalar, vector, entity_id) = match &point {
            Some((entity_id, values)) => {
                let (scalar, vector) = evaluate_point_component(values, &built.request)?;
                (scalar, vector, Some(*entity_id))
            }
            None => (None, None, None),
        };
        points.push(PlanarProfilePointResource {
            s_m: t * length_m,
            u_m,
            v_m,
            kind: kind.to_string(),
            occupancy: match (inside_frame, &point) {
                (false, _) => "outside",
                (true, None) => "empty",
                (true, Some(_)) => "occupied",
            }
            .to_string(),
            scalar,
            vector,
            entity_id,
        });
    }

    Ok(Json(PlanarFieldProfileResource {
        source: source_resource(&built.source),
        quantity_id: quantity_id.to_string(),
        component: built.component.clone(),
        sample_token: built.sample_token.clone(),
        source_entity_kind: built.source_entity_kind.to_string(),
        u0_m: profile.u0_m,
        v0_m: profile.v0_m,
        u1_m: profile.u1_m,
        v1_m: profile.v1_m,
        length_m,
        sampling_method: "line_profile".to_string(),
        points,
    }))
}

/// Segment parameters `t` in (0, 1) where `a + t·d` crosses an edge of a
/// section polygon, i.e. an element face inside the sampling plane.
pub(super) fn face_crossings(overlay: &PlanarMeshOverlay, a: [f64; 2], d: [f64; 2]) -> Vec<f64> {
    let mut crossings = Vec::new();
    for polygon in &overlay.polygons {
        let vertices = &polygon.vertices_uv_m;
        if vertices.len() < 2 {
            continue;
        }
        for index in 0..vertices.len() {
            let p = vertices[index];
            let q = vertices[(index + 1) % vertices.len()];
            let e = [q[0] - p[0], q[1] - p[1]];
            let denominator = d[0] * e[1] - d[1] * e[0];
            let scale = (d[0].hypot(d[1]) * e[0].hypot(e[1])).max(f64::MIN_POSITIVE);
            if denominator.abs() <= 1.0e-12 * scale {
                continue;
            }
            let w = [p[0] - a[0], p[1] - a[1]];
            let t = (w[0] * e[1] - w[1] * e[0]) / denominator;
            let r = (w[0] * d[1] - w[1] * d[0]) / denominator;
            if t > 0.0 && t < 1.0 && (-1.0e-12..=1.0 + 1.0e-12).contains(&r) {
                crossings.push(t);
            }
        }
    }
    crossings
}

#[cfg(test)]
mod tests {
    use super::face_crossings;
    use crate::planar_sampling::{PlanarMeshOverlay, PlanarOverlayPolygon};

    fn square(min: [f64; 2], max: [f64; 2]) -> PlanarOverlayPolygon {
        PlanarOverlayPolygon {
            vertices_uv_m: vec![min, [max[0], min[1]], max, [min[0], max[1]]],
            parent_element_id: 0,
        }
    }

    #[test]
    fn segment_crossings_are_the_element_faces_inside_the_plane() {
        let overlay = PlanarMeshOverlay {
            frame_origin_m: [0.0; 3],
            frame_u_axis: [1.0, 0.0, 0.0],
            frame_v_axis: [0.0, 1.0, 0.0],
            frame_normal: [0.0, 0.0, 1.0],
            bounds_uv_m: [0.0, 2.0, 0.0, 1.0],
            polygons: vec![square([0.0, 0.0], [1.0, 1.0]), square([1.0, 0.0], [2.0, 1.0])],
            segments: Vec::new(),
        };
        // A horizontal segment from u = -0.5 to u = 2.5 at v = 0.5 crosses
        // u = 0, 1 (shared face, reported by both polygons) and 2.
        let mut crossings = face_crossings(&overlay, [-0.5, 0.5], [3.0, 0.0]);
        crossings.sort_by(f64::total_cmp);
        let expected = [0.5 / 3.0, 1.5 / 3.0, 1.5 / 3.0, 2.5 / 3.0];
        assert_eq!(crossings.len(), expected.len());
        for (left, right) in crossings.iter().zip(expected) {
            assert!((left - right).abs() < 1.0e-12);
        }
        // Parallel edges are not crossings.
        assert!(face_crossings(&overlay, [0.0, 0.0], [2.0, 0.0])
            .iter()
            .all(|t| *t > 0.0 && *t < 1.0));
    }
}
