pub(crate) fn compute_torque_field(
    magnetization: &[[f64; 3]],
    effective_field: &[[f64; 3]],
    damping: f64,
    precession_enabled: bool,
) -> Vec<[f64; 3]> {
    magnetization
        .iter()
        .zip(effective_field.iter())
        .map(|(m, h)| {
            let b = [crate::MU0 * h[0], crate::MU0 * h[1], crate::MU0 * h[2]];
            let mx_b = [
                m[1] * b[2] - m[2] * b[1],
                m[2] * b[0] - m[0] * b[2],
                m[0] * b[1] - m[1] * b[0],
            ];
            let mx_mx_b = [
                m[1] * mx_b[2] - m[2] * mx_b[1],
                m[2] * mx_b[0] - m[0] * mx_b[2],
                m[0] * mx_b[1] - m[1] * mx_b[0],
            ];
            if precession_enabled {
                let scale = -1.0 / (1.0 + damping * damping);
                [
                    scale * (mx_b[0] + damping * mx_mx_b[0]),
                    scale * (mx_b[1] + damping * mx_mx_b[1]),
                    scale * (mx_b[2] + damping * mx_mx_b[2]),
                ]
            } else {
                [
                    -mx_mx_b[0],
                    -mx_mx_b[1],
                    -mx_mx_b[2],
                ]
            }
        })
        .collect()
}

pub(crate) fn max_torque_apm_from_torque_t(max_torque_t: f64) -> f64 {
    max_torque_t / crate::MU0
}

#[cfg_attr(not(any(feature = "cuda", feature = "fem-gpu")), allow(dead_code))]
pub(crate) fn max_torque_t_from_field(
    magnetization: &[[f64; 3]],
    effective_field: &[[f64; 3]],
    damping: f64,
    precession_enabled: bool,
) -> f64 {
    max_vector_norm(&compute_torque_field(
        magnetization,
        effective_field,
        damping,
        precession_enabled,
    ))
}

#[cfg_attr(not(any(feature = "cuda", feature = "fem-gpu")), allow(dead_code))]
pub(crate) fn max_vector_norm(vectors: &[[f64; 3]]) -> f64 {
    vectors.iter().fold(0.0, |acc, v| {
        acc.max((v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt())
    })
}
