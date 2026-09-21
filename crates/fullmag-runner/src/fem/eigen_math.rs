use fullmag_engine::Vector3;

pub(super) fn vector_norm(value: [f64; 3]) -> f64 {
    (value[0] * value[0] + value[1] * value[1] + value[2] * value[2]).sqrt()
}

/// Converts an eigenvalue (H_eff, A/m) to an ordinary frequency (Hz).
///
/// Returns `None` when `eigenvalue` is negative or non-finite; see
/// `angular_frequency_from_eigenvalue` below (audit finding H7,
/// docs/audits/2026-09-15-eigensolve-dispersion-correctness-audit.md).
pub(super) fn frequency_from_eigenvalue(gyromagnetic_ratio: f64, eigenvalue: f64) -> Option<f64> {
    angular_frequency_from_eigenvalue(gyromagnetic_ratio, eigenvalue)
        .map(|omega| omega / (2.0 * std::f64::consts::PI))
}

/// Converts an eigenvalue (H_eff, A/m) to angular frequency (rad/s).
///
/// A negative eigenvalue indicates a non-minimum equilibrium (an
/// unstable/soft mode, or an unconverged relaxation) rather than a
/// legitimate zero-frequency acoustic mode. Previously this was silently
/// clamped to zero via `eigenvalue.max(0.0)`, which let corrupted
/// eigenpairs masquerade as valid 0 Hz modes and, worse, be preferentially
/// selected by `EigenTargetIR::Lowest` sorting (audit finding H7). Callers
/// must now treat `None` as an explicit rejection of that eigenpair rather
/// than substituting a fallback frequency.
pub(super) fn angular_frequency_from_eigenvalue(
    gyromagnetic_ratio: f64,
    eigenvalue: f64,
) -> Option<f64> {
    // gyromagnetic_ratio is μ₀γ (≈ 2.211e5 m/(A·s)), eigenvalue is H_eff in A/m.
    // ω = μ₀γ · H_eff — no additional μ₀ factor needed.
    if !eigenvalue.is_finite() || eigenvalue < 0.0 {
        return None;
    }
    Some(gyromagnetic_ratio * eigenvalue)
}

pub(super) fn angular_frequency_from_raw_eigenvalue(
    gyromagnetic_ratio: f64,
    eigenvalue: f64,
) -> f64 {
    gyromagnetic_ratio * eigenvalue
}

/// Stable thin-film n=0 demagnetizing factor
///
/// `P00(k t) = 1 - (1 - exp(-k t))/(k t)` loses significant digits near
/// Gamma when written with `exp` and two subtractions. Keep the Taylor branch
/// and `expm1` branch in one runner-owned kernel so postsolve comparison and
/// FEM path helpers cannot silently diverge.
pub(crate) fn thin_film_p00(kd: f64) -> f64 {
    if kd == 0.0 {
        return 0.0;
    }
    if kd.abs() < 1.0e-4 {
        return kd
            * (0.5 + kd * (-1.0 / 6.0 + kd * (1.0 / 24.0 + kd * (-1.0 / 120.0 + kd / 720.0))));
    }
    1.0 + (-kd).exp_m1() / kd
}

pub(super) fn dot(a: Vector3, b: Vector3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub(super) fn cross(a: Vector3, b: Vector3) -> Vector3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

pub(super) fn norm(a: Vector3) -> f64 {
    dot(a, a).sqrt()
}

pub(super) fn normalize_vector(a: Vector3) -> Vector3 {
    let magnitude = norm(a);
    if magnitude <= 1e-30 {
        [1.0, 0.0, 0.0]
    } else {
        scale_vector(a, 1.0 / magnitude)
    }
}

pub(super) fn scale_vector(a: Vector3, factor: f64) -> Vector3 {
    [a[0] * factor, a[1] * factor, a[2] * factor]
}

pub(super) fn add_vector(a: Vector3, b: Vector3) -> Vector3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

#[cfg(test)]
mod tests {
    use super::*;

    // Audit finding H7: a negative eigenvalue indicates a non-minimum
    // equilibrium (an unstable/soft mode, or an unconverged relaxation) and
    // must be rejected (`None`), never silently clamped to a fabricated
    // zero-frequency mode.
    #[test]
    fn angular_frequency_from_eigenvalue_rejects_negative_eigenvalue() {
        assert_eq!(angular_frequency_from_eigenvalue(2.211e5, -1.0), None);
        assert_eq!(angular_frequency_from_eigenvalue(2.211e5, -1.0e-12), None);
    }

    #[test]
    fn angular_frequency_from_eigenvalue_rejects_non_finite_eigenvalue() {
        assert_eq!(angular_frequency_from_eigenvalue(2.211e5, f64::NAN), None);
        assert_eq!(
            angular_frequency_from_eigenvalue(2.211e5, f64::INFINITY),
            None
        );
    }

    #[test]
    fn angular_frequency_from_eigenvalue_accepts_zero_as_a_legitimate_acoustic_mode() {
        assert_eq!(angular_frequency_from_eigenvalue(2.211e5, 0.0), Some(0.0));
    }

    #[test]
    fn angular_frequency_from_eigenvalue_computes_expected_value_for_positive_input() {
        let gyromagnetic_ratio = 2.211e5;
        let eigenvalue = 1.0e6;
        assert_eq!(
            angular_frequency_from_eigenvalue(gyromagnetic_ratio, eigenvalue),
            Some(gyromagnetic_ratio * eigenvalue)
        );
    }

    #[test]
    fn frequency_from_eigenvalue_rejects_negative_eigenvalue() {
        assert_eq!(frequency_from_eigenvalue(2.211e5, -1.0), None);
    }

    #[test]
    fn frequency_from_eigenvalue_matches_angular_frequency_over_two_pi() {
        let gyromagnetic_ratio = 2.211e5;
        let eigenvalue = 1.0e6;
        let expected = gyromagnetic_ratio * eigenvalue / (2.0 * std::f64::consts::PI);
        assert_eq!(
            frequency_from_eigenvalue(gyromagnetic_ratio, eigenvalue),
            Some(expected)
        );
    }

    #[test]
    fn thin_film_p00_is_continuous_at_gamma() {
        let reference = thin_film_p00(0.0);
        assert_eq!(reference, 0.0);
        for kd in [1.0e-18, 1.0e-12, 1.0e-9, 1.0e-6, 9.999e-5, 1.0e-4] {
            let value = thin_film_p00(kd);
            assert!(value.is_finite() && value >= 0.0);
            assert!(
                (value - reference).abs() < 1.0e-4,
                "P00 must approach the Kittel limit at kd={kd}: {value}"
            );
        }
    }

    #[test]
    fn thin_film_p00_matches_expm1_branch_away_from_gamma() {
        for kd in [1.0e-3_f64, 0.01, 0.15707963267948966, 1.0] {
            let expected: f64 = 1.0 + (-kd).exp_m1() / kd;
            assert!((thin_film_p00(kd) - expected).abs() < 1.0e-15);
        }
    }
}
