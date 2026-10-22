use super::verify_rt0_sample_affinity;

const UNIT_TET: [[f64; 3]; 4] = [
    [0.0, 0.0, 0.0],
    [1.0, 0.0, 0.0],
    [0.0, 1.0, 0.0],
    [0.0, 0.0, 1.0],
];

fn affine_samples(points: &[[f64; 3]; 4], offset: [f64; 3], slope: f64) -> [f64; 12] {
    std::array::from_fn(|index| offset[index % 3] + slope * points[index / 3][index % 3])
}

fn cancellation_witness() -> ([[f64; 3]; 4], [f64; 12]) {
    let points = [
        [0.0, 0.0, 0.0],
        [1.1e-6, 0.0, 0.0],
        [0.0, 0.7e-6, 0.0],
        [0.0, 0.0, 0.3e-6],
    ];
    let currents = [
        0x426d1a94a2000000, 0x3ff0000000000000, 0x3fc0000000000000,
        0x426d1a94a2000385, 0x3ff0000000000000, 0x3fc0000000000000,
        0x426d1a94a2000000, 0x3ff11e88b367a41f, 0x3fc0000000000000,
        0x426d1a94a2000000, 0x3ff0000000000000, 0x3fc3d666f9635745,
    ].map(f64::from_bits);
    (points, currents)
}

#[test]
fn rounded_rt0_samples_survive_an_ill_conditioned_pivot() {
    let (points, currents) = cancellation_witness();
    // The former largest-coordinate pivot fails even for once-rounded exact samples.
    let slope = (currents[3] - currents[0]) / (points[1][0] - points[0][0]);
    let observed = currents[7] - currents[1];
    let predicted = slope * (points[2][1] - points[0][1]);
    let scale = currents[7].abs().max(currents[1].abs()).max(predicted.abs());
    assert!((observed - predicted).abs() > 128.0 * f64::EPSILON * scale);
    assert!(verify_rt0_sample_affinity(&points, &currents).is_ok());
    let mut inconsistent = currents;
    inconsistent[7] += 1e-6;
    assert!(verify_rt0_sample_affinity(&points, &inconsistent).is_err());
}

#[test]
fn one_shared_scalar_slope_rejects_shear_rotation_and_anisotropy() {
    let gradients = [
        [[1.0, 0.25, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
        [[0.0, -1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 0.0]],
        [[1.0, 0.0, 0.0], [0.0, 2.0, 0.0], [0.0, 0.0, 1.0]],
    ];
    for gradient in gradients {
        let currents = std::array::from_fn(|index| {
            (0..3).map(|axis| gradient[index % 3][axis] * UNIT_TET[index / 3][axis]).sum()
        });
        assert!(verify_rt0_sample_affinity(&UNIT_TET, &currents).is_err());
    }
}

#[test]
fn all_vertex_pairs_are_required_for_a_common_intercept() {
    let mut currents = [1e12_f64; 12];
    currents[4] -= 0.02;
    currents[10] += 0.02;
    for index in [4, 10] {
        let width = 64.0 * f64::EPSILON * (currents[index].abs() + currents[1].abs());
        assert!((currents[index] - currents[1]).abs() <= width);
    }
    assert!(verify_rt0_sample_affinity(&UNIT_TET, &currents).is_err());
}

#[test]
fn zero_constant_and_reversed_fields_remain_affine() {
    for (offset, slope) in [([0.0; 3], 0.0), ([2.0, -3.0, 0.25], 0.0), ([2.0, -3.0, 0.25], 4.0)] {
        let currents = affine_samples(&UNIT_TET, offset, slope);
        assert!(verify_rt0_sample_affinity(&UNIT_TET, &currents).is_ok());
        assert!(verify_rt0_sample_affinity(&UNIT_TET, &currents.map(|value| -value)).is_ok());
    }
}

#[test]
fn independent_power_of_two_geometry_and_current_scales_preserve_feasibility() {
    let (points, currents) = cancellation_witness();
    for coordinate_exponent in [-500, 0, 500] {
        for current_exponent in [-600, 0, 600] {
            let scaled_points = points.map(|point| point.map(|value| value * 2.0_f64.powi(coordinate_exponent)));
            let scaled_currents = currents.map(|value| value * 2.0_f64.powi(current_exponent));
            assert!(verify_rt0_sample_affinity(&scaled_points, &scaled_currents).is_ok());
        }
    }
}

#[test]
fn exact_coordinate_translation_preserves_the_same_sampled_field() {
    let points = UNIT_TET.map(|point| point.map(|value| value * 2.0_f64.powi(-20)));
    let currents = affine_samples(&points, [0.25, -0.5, 1.0], 8.0);
    let shift = [2.0_f64.powi(-10), -2.0_f64.powi(-11), 2.0_f64.powi(-12)];
    let translated = points.map(|point| std::array::from_fn(|axis| point[axis] + shift[axis]));
    assert!(verify_rt0_sample_affinity(&translated, &currents).is_ok());
}

#[test]
fn no_absolute_floor_hides_a_subnormal_nonaffine_sample() {
    let smallest = f64::from_bits(1);
    assert!(verify_rt0_sample_affinity(&UNIT_TET, &[smallest; 12]).is_ok());
    let mut currents = [0.0; 12];
    currents[4] = smallest; // y changes between two vertices with identical y.
    assert!(verify_rt0_sample_affinity(&UNIT_TET, &currents).is_err());
}

#[test]
fn an_exact_common_slope_need_not_fit_in_binary64() {
    let points = UNIT_TET.map(|point| point.map(|value| value * 2.0_f64.powi(-1022)));
    let currents = affine_samples(&UNIT_TET, [0.0; 3], 2.0_f64.powi(1023));
    assert!(verify_rt0_sample_affinity(&points, &currents).is_ok());
}

#[test]
fn nonfinite_and_extreme_inconsistent_inputs_fail_closed_without_float_overflow() {
    for invalid in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let mut points = UNIT_TET;
        points[1][0] = invalid;
        assert!(verify_rt0_sample_affinity(&points, &[0.0; 12]).is_err());
        let mut currents = [0.0; 12];
        currents[0] = invalid;
        assert!(verify_rt0_sample_affinity(&UNIT_TET, &currents).is_err());
    }
    let mut currents = [f64::MAX; 12];
    currents[4] = -f64::MAX;
    assert!(verify_rt0_sample_affinity(&UNIT_TET, &currents).is_err());
    assert!(verify_rt0_sample_affinity(&[[0.0; 3]; 4], &[0.0; 12]).is_err());
}
