/// Exact Gilbert-form LLG trajectory for an initial `+x` macrospin in a
/// constant `+z` field expressed in A/m.
///
/// This is a backend-independent physics oracle for the sign convention used
/// by Fullmag's FDM LLG implementations.
pub fn constant_z_field_llg_from_positive_x(
    gyromagnetic_ratio: f64,
    damping: f64,
    field_z_apm: f64,
    time_s: f64,
) -> [f64; 3] {
    let omega = gyromagnetic_ratio * field_z_apm / (1.0 + damping * damping);
    let damping_rate = damping * omega;
    let phase = omega * time_s;
    let decay = 1.0 / (damping_rate * time_s).cosh();
    [
        decay * phase.cos(),
        decay * phase.sin(),
        (damping_rate * time_s).tanh(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_constant_field_oracle_starts_at_positive_x_and_stays_normalized() {
        assert_eq!(
            constant_z_field_llg_from_positive_x(2.211e5, 0.02, 1.0e4, 0.0),
            [1.0, 0.0, 0.0]
        );

        let state = constant_z_field_llg_from_positive_x(2.211e5, 0.02, 1.0e4, 1.0e-9);
        let norm = state.iter().map(|value| value * value).sum::<f64>().sqrt();
        assert!((norm - 1.0).abs() <= 8.0 * f64::EPSILON);
    }
}
