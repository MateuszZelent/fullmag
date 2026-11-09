use super::{verify_rt0_sample_affinity, verify_rt0_sample_moments};
use std::collections::BTreeMap;

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


// Independent Fraction evaluation of coefficients (0, 1/8, -1/4, 1/8) A
// on an actual benchmark Tet4. The exact first-face moment is zero.
const MOMENT_POINTS: [[f64; 3]; 4] = [
    [1.5058082349688059e-6, 3.1514364492491983e-10, 1e-7],
    [1.647926299341373e-6, 1.0453407445066876e-9, 1e-7],
    [1.4999999999999996e-6, -9.999999999999994e-8, -4.163336342344337e-23],
    [1.5058106326571492e-6, 1.4416104806800113e-10, -1.0000000000000001e-7],
];
const MOMENT_J: [f64; 12] = [
    -6747487252645.16, -8830172301893.402, -0.0030736851685839953,
    -6747487252645.16, -8830172301893.402, -0.0030736851685839953,
    -6747487252645.16, -8830172301893.402, -0.0030736851685839953,
    -6747487252645.16, -8830172301893.402, -0.0030736851685839953,
];
fn golden_moments() -> BTreeMap<[u64; 3], f64> {
    BTreeMap::from([([2, 3, 4], 0.0), ([1, 3, 4], -0.0625),
        ([1, 2, 4], -0.125), ([1, 2, 3], -0.0625)])
}

#[test]
fn canonical_moments_bind_rounded_tangential_current() {
    assert!(verify_rt0_sample_moments(&MOMENT_POINTS, &[1, 2, 3, 4], &MOMENT_J, &golden_moments()).is_ok());
    // Reversing stable IDs reverses each canonical face normal, not the field.
    let reversed = BTreeMap::from([([1, 2, 3], 0.0), ([1, 2, 4], 0.0625),
        ([1, 3, 4], 0.125), ([2, 3, 4], 0.0625)]);
    assert!(verify_rt0_sample_moments(&MOMENT_POINTS, &[4, 3, 2, 1], &MOMENT_J, &reversed).is_ok());
}

#[test]
fn affine_current_and_face_moments_cannot_be_changed_independently() {
    let doubled = MOMENT_J.map(|value| 2.0 * value);
    assert!(verify_rt0_sample_affinity(&MOMENT_POINTS, &doubled).is_ok());
    assert!(verify_rt0_sample_moments(&MOMENT_POINTS, &[1, 2, 3, 4], &doubled, &golden_moments()).is_err());
    let mut moments = golden_moments();
    moments.insert([1, 3, 4], -0.125);
    assert!(verify_rt0_sample_moments(&MOMENT_POINTS, &[1, 2, 3, 4], &MOMENT_J, &moments).is_err());
}


fn center_current_cell() -> super::super::closed_loop_v2::ClosedLoopCurrentCellV2 {
    super::super::closed_loop_v2::ClosedLoopCurrentCellV2 {
        source_element_index: 0,
        vertex_ids: [1, 2, 3, 4],
        vertex_xyz_m: std::array::from_fn(|index| UNIT_TET[index / 3][index % 3]),
        vertex_current_xyz_apm2: [8.0; 12],
        center_xyz_m: [0.25; 3],
        center_current_xyz_apm2: [8.0; 3],
    }
}

fn center_failure_witness(error: &crate::types::RunError) -> serde_json::Value {
    let (reason, witness) = error.message.split_once(" fullmag.rt0_center_failure.v1=")
        .expect("the original J refusal must carry the complete diagnostic");
    assert_eq!(reason, "closed-loop identity refused: cell-local J interpolation mismatch");
    assert!(error.message.is_ascii());
    assert!(error.message.len() <= 2048, "the supervisor must retain the entire witness");
    serde_json::from_str(witness).expect("the witness must be complete JSON")
}

#[test]
fn center_current_failure_diagnostic_preserves_bits_and_bound() {
    let mut cell = center_current_cell();
    cell.source_element_index = u64::MAX;
    cell.vertex_ids = [u64::MAX, 17, 5, 9];
    cell.vertex_xyz_m[0] = -0.0;
    cell.vertex_current_xyz_apm2[1] = -0.0;
    cell.vertex_current_xyz_apm2[2] = f64::from_bits(1);
    cell.center_xyz_m[1] = -0.0;
    cell.center_current_xyz_apm2 = [f64::from_bits(0x7ff8_1234_5678_9abc), -0.0, f64::MAX];
    let points = std::array::from_fn(|local| {
        std::array::from_fn(|axis| cell.vertex_xyz_m[3 * local + axis])
    });
    let faces = BTreeMap::from([
        ([5, 9, 17], -0.0),
        ([5, 9, u64::MAX], f64::MAX),
        ([9, 17, u64::MAX], f64::from_bits(1)),
    ]);
    let error = super::verify_center_current(&cell, &points, 0, &faces).unwrap_err();
    let hex = |value: f64| format!("{:016x}", value.to_bits());
    let expected = serde_json::json!({
        "schema": "fullmag.rt0_center_failure.v1",
        "element": "ffffffffffffffff",
        "axis": 0,
        "vertex_ids": cell.vertex_ids.map(|id| format!("{id:016x}")),
        "vertex_xyz_bits": cell.vertex_xyz_m.map(hex),
        "vertex_j_bits": cell.vertex_current_xyz_apm2.map(hex),
        "center_xyz_bits": cell.center_xyz_m.map(hex),
        "center_j_bits": cell.center_current_xyz_apm2.map(hex),
        "mean_bits": hex(8.0),
        "scale_bits": hex(8.0),
        "difference_bits": hex((8.0 - cell.center_current_xyz_apm2[0]).abs()),
        "budget_bits": hex(128.0 * f64::EPSILON * 8.0),
        "face_flux_bits": [Some(hex(-0.0)), Some(hex(f64::MAX)),
            Some(hex(f64::from_bits(1))), None::<String>],
    });
    assert_eq!(center_failure_witness(&error), expected);
}

#[test]
fn center_current_failure_diagnostic_keeps_gate() {
    let mut cell = center_current_cell();
    let budget = 128.0 * f64::EPSILON * 8.0;
    let boundary = 8.0 + budget;
    cell.center_current_xyz_apm2[0] = boundary;
    assert!(super::verify_center_current(&cell, &UNIT_TET, 0, &BTreeMap::new()).is_ok());
    cell.center_current_xyz_apm2[0] = f64::from_bits(boundary.to_bits() + 1);
    let error = super::verify_center_current(&cell, &UNIT_TET, 0, &BTreeMap::new()).unwrap_err();
    let witness = center_failure_witness(&error);
    assert_eq!(witness["axis"], 0);
    assert_eq!(witness["budget_bits"], format!("{:016x}", budget.to_bits()));
    assert_eq!(witness["face_flux_bits"], serde_json::json!([null, null, null, null]));
}

// These fields only let the real owned-geometry verifier reach its first cell gate.
// No accepted-source identity, moments or balance qualification is claimed.
fn center_geometry_source(
    cell: super::super::closed_loop_v2::ClosedLoopCurrentCellV2,
) -> super::super::closed_loop_v2::ClosedLoopAcceptedSourceInputV2 {
    use super::super::closed_loop_v2::{ClosedLoopAcceptedSourceInputV2, ClosedLoopSourceMetadataV2};
    ClosedLoopAcceptedSourceInputV2 {
        metadata: ClosedLoopSourceMetadataV2 {
            prepared_execution_digest: String::new(),
            accepted_charge_field_digest: String::new(),
            accepted_source_state_digest: String::new(),
            view_identity_digest: String::new(),
            current_balance_certificate_digest: String::new(),
            digest_encoding: String::new(),
            periodic_operator_version: String::new(),
            closure_operator_version: String::new(),
            conservative_current_operator_version: String::new(),
            weak_reaction_ledger_version: String::new(),
            sampling_policy: String::new(),
            source_current_orientation: String::new(),
            source_current_a: 0.0,
            source_absolute_flux_a: 0.0,
            potential_jump_v: 0.0,
            measured_potential_jump_v: 0.0,
            gauge_mean_v: 0.0,
            charge_relative_residual: 0.0,
            max_paired_weak_flux_mismatch_a: 0.0,
            terminal_observation_currents: BTreeMap::new(),
        },
        stable_vertex_ids: cell.vertex_ids.to_vec(),
        vertex_xyz_m: UNIT_TET.to_vec(),
        electric_potential_v: vec![0.0; 4],
        conductivity_spm: vec![1.0; 4],
        cells: vec![cell],
        canonical_face_records: Vec::new(),
        paired_weak_reactions: Vec::new(),
        prepared_execution_preimage: Vec::new(),
        accepted_charge_field_preimage: Vec::new(),
        accepted_source_state_preimage: Vec::new(),
        canonical_balance_certificate: Vec::new(),
        authored_input_json: Vec::new(),
    }
}

fn owned_center_failure(
    cell: super::super::closed_loop_v2::ClosedLoopCurrentCellV2,
) -> crate::types::RunError {
    let source = center_geometry_source(cell);
    let by_id = BTreeMap::from([(1, 0), (2, 1), (3, 2), (4, 3)]);
    super::verify_owned_geometry(&source, &by_id, &BTreeMap::new(), &BTreeMap::new(), &[])
        .unwrap_err()
}

#[test]
fn center_current_failure_diagnostic_reports_first_current_axis() {
    let mut cell = center_current_cell();
    cell.center_current_xyz_apm2[0] = 9.0;
    cell.center_current_xyz_apm2[1] = 10.0;
    assert_eq!(center_failure_witness(&owned_center_failure(cell))["axis"], 0);
}

#[test]
fn center_current_failure_diagnostic_preserves_interleaved_geometry_order() {
    let mut cell = center_current_cell();
    cell.center_current_xyz_apm2[0] = 9.0;
    cell.center_xyz_m[1] = 0.5;
    assert_eq!(center_failure_witness(&owned_center_failure(cell.clone()))["axis"], 0);
    cell.center_xyz_m[0] = 0.5;
    assert_eq!(owned_center_failure(cell).message,
        "closed-loop identity refused: sampled center geometry mismatch");
}

#[test]
fn center_current_failure_diagnostic_preserves_earlier_nonfinite_vertex_refusal() {
    let mut cell = center_current_cell();
    cell.vertex_current_xyz_apm2[0] = f64::from_bits(0x7ff8_1234_5678_9abc);
    cell.center_current_xyz_apm2[0] = 9.0;
    assert_eq!(owned_center_failure(cell).message, "closed-loop identity refused: nonfinite flux");
}

fn actual_stored_point_cell() -> (
    super::super::closed_loop_v2::ClosedLoopCurrentCellV2,
    BTreeMap<[u64; 3], f64>,
) {
    let value: serde_json::Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../examples/sushruth_2020_closed_gsg/rt0_center_diagnostic_20261108/offline-analysis/fixtures/actual-first-center-refusal.json",
    ))).unwrap();
    let integer = |v: &serde_json::Value| u64::from_str_radix(v.as_str().unwrap(), 16).unwrap();
    let scalar = |v: &serde_json::Value| f64::from_bits(integer(v));
    let mut cell = center_current_cell();
    cell.source_element_index = integer(&value["element"]);
    cell.vertex_ids = std::array::from_fn(|i| integer(&value["vertex_ids"][i]));
    cell.vertex_xyz_m = std::array::from_fn(|i| scalar(&value["vertex_xyz_bits"][i]));
    cell.vertex_current_xyz_apm2 = std::array::from_fn(|i| scalar(&value["vertex_j_bits"][i]));
    cell.center_xyz_m = std::array::from_fn(|i| scalar(&value["center_xyz_bits"][i]));
    cell.center_current_xyz_apm2 = std::array::from_fn(|i| scalar(&value["center_j_bits"][i]));
    let faces = (0..4).map(|opposite| {
        let mut ids = [0; 3];
        let mut index = 0;
        for local in 0..4 {
            if local != opposite {
                ids[index] = cell.vertex_ids[local];
                index += 1;
            }
        }
        ids.sort_unstable();
        (ids, scalar(&value["face_flux_bits"][opposite]))
    }).collect();
    (cell, faces)
}

#[test]
fn stored_point_center_accepts_actual_28881() {
    let (cell, faces) = actual_stored_point_cell();
    assert_eq!(cell.source_element_index, 28881);
    let points = std::array::from_fn(|i|
        std::array::from_fn(|axis| cell.vertex_xyz_m[3 * i + axis]));
    assert!(verify_rt0_sample_moments(&points, &cell.vertex_ids,
        &cell.vertex_current_xyz_apm2, &faces).is_ok());
    for axis in 0..3 {
        let result = super::verify_center_current(&cell, &points, axis, &faces);
        assert!(result.is_ok(), "stored point axis {axis}: {result:?}");
    }
}
