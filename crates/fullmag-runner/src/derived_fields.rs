pub(crate) fn compute_torque_field(
    magnetization: &[[f64; 3]],
    effective_field: &[[f64; 3]],
) -> Vec<[f64; 3]> {
    magnetization
        .iter()
        .zip(effective_field.iter())
        .map(|(m, h)| {
            [
                m[1] * h[2] - m[2] * h[1],
                m[2] * h[0] - m[0] * h[2],
                m[0] * h[1] - m[1] * h[0],
            ]
        })
        .collect()
}
