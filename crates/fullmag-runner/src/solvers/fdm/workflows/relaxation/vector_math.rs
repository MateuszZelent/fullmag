//! Vector and tangent-space math for FDM direct-minimizer workflows.

use fullmag_engine::{dot, normalized, scale, sub, Vector3, VectorFieldSoA};

/// Max torque from magnetization and effective field: max |m x H_eff|.
pub(crate) fn compute_max_torque(magnetization: &[Vector3], h_eff: &[Vector3]) -> f64 {
    magnetization
        .iter()
        .zip(h_eff.iter())
        .map(|(m, h)| {
            let cross = [
                m[1] * h[2] - m[2] * h[1],
                m[2] * h[0] - m[0] * h[2],
                m[0] * h[1] - m[1] * h[0],
            ];
            (cross[0] * cross[0] + cross[1] * cross[1] + cross[2] * cross[2]).sqrt()
        })
        .fold(0.0, f64::max)
}

/// Global inner product over vector fields: sum_i a_i dot b_i.
pub(crate) fn global_dot(a: &[Vector3], b: &[Vector3]) -> f64 {
    a.iter().zip(b.iter()).map(|(ai, bi)| dot(*ai, *bi)).sum()
}

/// Project a vector field onto the cellwise tangent space at m.
pub(crate) fn project_tangent(m: &[Vector3], v: &[Vector3]) -> Vec<Vector3> {
    m.iter()
        .zip(v.iter())
        .map(|(mi, vi)| {
            let mdotv = dot(*mi, *vi);
            sub(*vi, scale(*mi, mdotv))
        })
        .collect()
}

pub(crate) fn global_dot_soa(a: &VectorFieldSoA, b: &VectorFieldSoA) -> f64 {
    debug_assert_eq!(a.len(), b.len());
    let mut sum = 0.0;
    for i in 0..a.len() {
        sum += a.x[i] * b.x[i] + a.y[i] * b.y[i] + a.z[i] * b.z[i];
    }
    sum
}

pub(crate) fn compute_max_torque_soa(
    magnetization: &VectorFieldSoA,
    h_eff: &VectorFieldSoA,
) -> f64 {
    debug_assert_eq!(magnetization.len(), h_eff.len());
    let mut max_torque = 0.0;
    for i in 0..magnetization.len() {
        let cx = magnetization.y[i] * h_eff.z[i] - magnetization.z[i] * h_eff.y[i];
        let cy = magnetization.z[i] * h_eff.x[i] - magnetization.x[i] * h_eff.z[i];
        let cz = magnetization.x[i] * h_eff.y[i] - magnetization.y[i] * h_eff.x[i];
        let torque = (cx * cx + cy * cy + cz * cz).sqrt();
        if torque > max_torque {
            max_torque = torque;
        }
    }
    max_torque
}

pub(crate) fn project_tangent_soa_into(
    m: &VectorFieldSoA,
    v: &VectorFieldSoA,
    out: &mut VectorFieldSoA,
) {
    debug_assert_eq!(m.len(), v.len());
    debug_assert!(out.len() >= m.len());
    for i in 0..m.len() {
        let mdotv = m.x[i] * v.x[i] + m.y[i] * v.y[i] + m.z[i] * v.z[i];
        out.x[i] = v.x[i] - m.x[i] * mdotv;
        out.y[i] = v.y[i] - m.y[i] * mdotv;
        out.z[i] = v.z[i] - m.z[i] * mdotv;
    }
}

pub(crate) fn scaled_retraction_soa_into(
    m: &VectorFieldSoA,
    direction: &VectorFieldSoA,
    scale_factor: f64,
    out: &mut VectorFieldSoA,
) {
    debug_assert_eq!(m.len(), direction.len());
    debug_assert!(out.len() >= m.len());
    for i in 0..m.len() {
        let value = normalized([
            m.x[i] + scale_factor * direction.x[i],
            m.y[i] + scale_factor * direction.y[i],
            m.z[i] + scale_factor * direction.z[i],
        ])
        .unwrap_or([0.0, 0.0, 0.0]);
        out.x[i] = value[0];
        out.y[i] = value[1];
        out.z[i] = value[2];
    }
}

pub(crate) fn copy_scaled_soa_into(
    src: &VectorFieldSoA,
    scale_factor: f64,
    out: &mut VectorFieldSoA,
) {
    debug_assert!(out.len() >= src.len());
    for i in 0..src.len() {
        out.x[i] = src.x[i] * scale_factor;
        out.y[i] = src.y[i] * scale_factor;
        out.z[i] = src.z[i] * scale_factor;
    }
}
