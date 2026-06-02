//! Shared vector math for direct-minimization relaxation paths.
//!
//! These helpers implement tangent-space projection and torque metrics used by
//! bootstrap projected-gradient and nonlinear-CG relaxation on FDM and FEM
//! runner paths. Backend-specific code owns state movement and observables;
//! this module owns only backend-neutral vector algebra on reduced
//! magnetization and effective-field samples.

#![allow(dead_code)]

pub(crate) fn dot_vec3(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub(crate) fn add_vec3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

pub(crate) fn sub_vec3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

pub(crate) fn scale_vec3(a: [f64; 3], s: f64) -> [f64; 3] {
    [a[0] * s, a[1] * s, a[2] * s]
}

pub(crate) fn normalized_vec3(v: [f64; 3]) -> [f64; 3] {
    let n2 = dot_vec3(v, v);
    if n2 <= 0.0 {
        [0.0, 0.0, 0.0]
    } else {
        let inv = 1.0 / n2.sqrt();
        [v[0] * inv, v[1] * inv, v[2] * inv]
    }
}

pub(crate) fn tangent_gradient_from_field(
    magnetization: &[[f64; 3]],
    h_eff: &[[f64; 3]],
) -> Vec<[f64; 3]> {
    magnetization
        .iter()
        .zip(h_eff.iter())
        .map(|(m, h)| {
            let projected = sub_vec3(*h, scale_vec3(*m, dot_vec3(*m, *h)));
            scale_vec3(projected, -1.0)
        })
        .collect()
}

pub(crate) fn global_dot_vec3(a: &[[f64; 3]], b: &[[f64; 3]]) -> f64 {
    a.iter()
        .zip(b.iter())
        .map(|(ai, bi)| dot_vec3(*ai, *bi))
        .sum()
}

pub(crate) fn project_tangent(m: &[[f64; 3]], v: &[[f64; 3]]) -> Vec<[f64; 3]> {
    m.iter()
        .zip(v.iter())
        .map(|(mi, vi)| sub_vec3(*vi, scale_vec3(*mi, dot_vec3(*mi, *vi))))
        .collect()
}

pub(crate) fn max_torque_from_field(magnetization: &[[f64; 3]], h_eff: &[[f64; 3]]) -> f64 {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tangent_gradient_projects_effective_field_onto_spin_tangent_plane() {
        let m = [[1.0, 0.0, 0.0]];
        let h = [[2.0, 3.0, 4.0]];

        assert_eq!(
            tangent_gradient_from_field(&m, &h),
            vec![[-0.0, -3.0, -4.0]]
        );
    }

    #[test]
    fn torque_metric_reports_max_cross_product_norm() {
        let m = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
        let h = [[0.0, 2.0, 0.0], [3.0, 0.0, 4.0]];

        assert_eq!(max_torque_from_field(&m, &h), 5.0);
    }
}
