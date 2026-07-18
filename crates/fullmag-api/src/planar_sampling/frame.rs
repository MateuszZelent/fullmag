use crate::error::ApiError;
use fullmag_ir::{PlanarExtentIR, PlanarFrameIR};

#[derive(Debug, Clone, Copy)]
pub(super) struct ResolvedFrame {
    pub origin: [f64; 3],
    pub u: [f64; 3],
    pub v: [f64; 3],
    pub normal: [f64; 3],
    pub bounds: [f64; 4],
}

impl ResolvedFrame {
    pub fn try_from_ir(frame: &PlanarFrameIR) -> Result<Self, ApiError> {
        let bounds = match frame.extent {
            PlanarExtentIR::Explicit {
                u_min_m,
                u_max_m,
                v_min_m,
                v_max_m,
            } => [u_min_m, u_max_m, v_min_m, v_max_m],
            _ => {
                return Err(ApiError::bad_request(
                    "unresolved_planar_extent: sampler requires explicit runtime bounds",
                ))
            }
        };
        let finite = frame
            .origin_m
            .iter()
            .chain(frame.u_axis.iter())
            .chain(frame.v_axis.iter())
            .chain(frame.normal.iter())
            .chain(bounds.iter())
            .all(|value| value.is_finite());
        if !finite || bounds[0] >= bounds[1] || bounds[2] >= bounds[3] {
            return Err(ApiError::bad_request("invalid_planar_frame"));
        }
        let unit = |a: [f64; 3]| (dot(a, a) - 1.0).abs() <= 1.0e-10;
        if !unit(frame.u_axis)
            || !unit(frame.v_axis)
            || !unit(frame.normal)
            || dot(frame.u_axis, frame.v_axis).abs() > 1.0e-10
            || dot(frame.u_axis, frame.normal).abs() > 1.0e-10
            || dot(frame.v_axis, frame.normal).abs() > 1.0e-10
        {
            return Err(ApiError::bad_request(
                "invalid_planar_frame: basis is not orthonormal",
            ));
        }
        Ok(Self {
            origin: frame.origin_m,
            u: frame.u_axis,
            v: frame.v_axis,
            normal: frame.normal,
            bounds,
        })
    }

    pub fn point(&self, u: f64, v: f64, s: f64) -> [f64; 3] {
        [
            self.origin[0] + u * self.u[0] + v * self.v[0] + s * self.normal[0],
            self.origin[1] + u * self.u[1] + v * self.v[1] + s * self.normal[1],
            self.origin[2] + u * self.u[2] + v * self.v[2] + s * self.normal[2],
        ]
    }

    pub fn project(&self, point: [f64; 3]) -> [f64; 3] {
        let delta = [
            point[0] - self.origin[0],
            point[1] - self.origin[1],
            point[2] - self.origin[2],
        ];
        [
            dot(delta, self.u),
            dot(delta, self.v),
            dot(delta, self.normal),
        ]
    }

    pub fn pixel_center(&self, x: u32, y: u32, resolution: [u32; 2]) -> [f64; 2] {
        let du = (self.bounds[1] - self.bounds[0]) / resolution[0] as f64;
        let dv = (self.bounds[3] - self.bounds[2]) / resolution[1] as f64;
        [
            self.bounds[0] + (x as f64 + 0.5) * du,
            self.bounds[2] + (y as f64 + 0.5) * dv,
        ]
    }
}

pub(super) fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub(super) fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
