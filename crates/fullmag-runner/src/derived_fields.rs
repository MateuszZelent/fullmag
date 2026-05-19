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
                [-mx_mx_b[0], -mx_mx_b[1], -mx_mx_b[2]]
            }
        })
        .collect()
}

pub(crate) fn max_torque_residual_apm_from_field(
    magnetization: &[[f64; 3]],
    effective_field: &[[f64; 3]],
) -> f64 {
    magnetization
        .iter()
        .zip(effective_field.iter())
        .fold(0.0, |acc, (m, h)| {
            let cross = [
                m[1] * h[2] - m[2] * h[1],
                m[2] * h[0] - m[0] * h[2],
                m[0] * h[1] - m[1] * h[0],
            ];
            acc.max((cross[0] * cross[0] + cross[1] * cross[1] + cross[2] * cross[2]).sqrt())
        })
}

#[allow(dead_code)]
pub(crate) fn max_vector_norm(vectors: &[[f64; 3]]) -> f64 {
    vectors.iter().fold(0.0, |acc, v| {
        acc.max((v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt())
    })
}

#[cfg(test)]
mod tests {
    use super::max_torque_residual_apm_from_field;

    #[test]
    fn max_torque_residual_apm_uses_h_eff_units_directly() {
        let magnetization = [[1.0, 0.0, 0.0]];
        let effective_field = [[0.0, 3.0, 4.0]];

        let torque = max_torque_residual_apm_from_field(&magnetization, &effective_field);

        assert!((torque - 5.0).abs() < 1e-15);
    }
}
