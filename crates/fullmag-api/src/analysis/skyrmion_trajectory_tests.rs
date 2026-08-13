use std::f64::consts::{FRAC_PI_3, FRAC_PI_6, PI};

use super::skyrmion_trajectory::{
    analyze_skyrmion_hall_angle_v1, AcceptedTrajectorySampleV1, AcceptedTrajectorySeriesV1,
    SkyrmionHallReasonCodeV1, SkyrmionTrajectoryProvenanceV1,
};

const SAMPLE_DT_S: f64 = 10.0e-12;
const STEP_M: f64 = 1.0e-9;

fn provenance() -> SkyrmionTrajectoryProvenanceV1 {
    SkyrmionTrajectoryProvenanceV1 {
        scene_revision: "scene-42".into(),
        field_revision: "field-18".into(),
        mesh_revision: "mesh-7".into(),
        mesh_generation_id: "mesh-generation-3".into(),
        domain_generation_id: "domain-generation-5".into(),
        global_node_mapping_id: "node-map-2".into(),
        snapshot_id: Some("snapshot-11".into()),
        stage_id: Some("drive".into()),
        cache_key_digest: "cache-identity-9".into(),
    }
}

fn straight_series(
    angle_rad: f64,
    count: usize,
    signed_current_a_per_m2: f64,
) -> AcceptedTrajectorySeriesV1 {
    let provenance = provenance();
    AcceptedTrajectorySeriesV1 {
        samples: (0..count)
            .map(|index| AcceptedTrajectorySampleV1 {
                accepted_sequence: index as u64,
                time_s: index as f64 * SAMPLE_DT_S,
                centre_m: [
                    index as f64 * STEP_M * angle_rad.cos(),
                    index as f64 * STEP_M * angle_rad.sin(),
                ],
                topological_charge: -1.0,
                minimum_edge_distance_m: 40.0e-9,
                signed_current_a_per_m2,
                provenance: provenance.clone(),
            })
            .collect(),
        reverse_transverse_axis: false,
    }
}

fn assert_close(actual: f64, expected: f64, tolerance: f64) {
    assert!(
        (actual - expected).abs() <= tolerance,
        "expected {expected:e}, got {actual:e}, tolerance {tolerance:e}"
    );
}

#[test]
fn skyrmion_trajectory_fits_straight_thirty_degree_motion() {
    let result = analyze_skyrmion_hall_angle_v1(&straight_series(FRAC_PI_6, 25, 2.5e11));

    assert_eq!(result.reason_code, None);
    assert_eq!(result.accepted_interval.unwrap().sample_count, 25);
    assert_close(result.angle_rad.unwrap(), FRAC_PI_6, 1.0e-12);
    assert_close(result.angle_deg.unwrap(), 30.0, 1.0e-10);
    assert_close(
        result.v_parallel_m_per_s.unwrap(),
        100.0 * FRAC_PI_6.cos(),
        1.0e-9,
    );
    assert_close(
        result.v_perp_m_per_s.unwrap(),
        100.0 * FRAC_PI_6.sin(),
        1.0e-9,
    );
    assert_eq!(result.trajectory.time_s.len(), 25);
    assert_eq!(result.trajectory.q, vec![-1.0; 25]);
}

#[test]
fn skyrmion_trajectory_reports_current_reversal_with_signed_velocity_and_current() {
    let result = analyze_skyrmion_hall_angle_v1(&straight_series(-5.0 * PI / 6.0, 25, -2.5e11));

    assert_eq!(result.reason_code, None);
    assert_close(result.angle_rad.unwrap(), -5.0 * PI / 6.0, 1.0e-12);
    assert_close(
        result.mean_signed_current_a_per_m2.unwrap(),
        -2.5e11,
        1.0e-3,
    );
    assert!(result.v_parallel_m_per_s.unwrap() < 0.0);
    assert!(result.v_perp_m_per_s.unwrap() < 0.0);
}

#[test]
fn skyrmion_trajectory_respects_swapped_coordinate_axes() {
    let result = analyze_skyrmion_hall_angle_v1(&straight_series(FRAC_PI_3, 25, 2.5e11));

    assert_eq!(result.reason_code, None);
    assert_close(result.angle_rad.unwrap(), FRAC_PI_3, 1.0e-12);
}

#[test]
fn skyrmion_trajectory_uses_equal_weight_covariance_for_heteroscedastic_noise() {
    let mut series = straight_series(FRAC_PI_6, 25, 2.5e11);
    for (index, sample) in series.samples.iter_mut().enumerate() {
        let amplitude = if index % 2 == 0 { 0.01e-9 } else { 0.05e-9 };
        sample.centre_m[0] += amplitude;
        sample.centre_m[1] -= amplitude * 0.5;
    }

    let result = analyze_skyrmion_hall_angle_v1(&series);

    assert_eq!(result.reason_code, None);
    assert_close(result.angle_rad.unwrap(), FRAC_PI_6, 0.03);
    let covariance = result.velocity_covariance_m2_per_s2.unwrap();
    assert!(covariance[0][0].is_finite() && covariance[0][0] > 0.0);
    assert!(covariance[1][1].is_finite() && covariance[1][1] > 0.0);
    assert!(covariance[0][1].is_finite());
    assert_eq!(result.residuals_m.as_ref().unwrap().len(), 25);
}

#[test]
fn skyrmion_trajectory_rejects_no_motion() {
    let mut series = straight_series(FRAC_PI_6, 25, 2.5e11);
    for sample in &mut series.samples {
        sample.centre_m = [0.0, 0.0];
    }

    let result = analyze_skyrmion_hall_angle_v1(&series);

    assert_eq!(result.reason_code, Some(SkyrmionHallReasonCodeV1::NoMotion));
    assert_eq!(result.angle_rad, None);
}

#[test]
fn skyrmion_trajectory_rejects_topology_loss_before_other_gates() {
    let mut series = straight_series(FRAC_PI_6, 25, 2.5e11);
    series.samples[9].topological_charge = -0.49;
    series.samples[12].minimum_edge_distance_m = 1.0e-9;

    let result = analyze_skyrmion_hall_angle_v1(&series);

    assert_eq!(
        result.reason_code,
        Some(SkyrmionHallReasonCodeV1::TopologyLost)
    );
    assert_eq!(result.angle_rad, None);
}

#[test]
fn skyrmion_trajectory_rejects_edge_contamination() {
    let mut series = straight_series(FRAC_PI_6, 25, 2.5e11);
    series.samples[8].minimum_edge_distance_m = 15.9e-9;

    let result = analyze_skyrmion_hall_angle_v1(&series);

    assert_eq!(
        result.reason_code,
        Some(SkyrmionHallReasonCodeV1::EdgeContaminated)
    );
}

#[test]
fn skyrmion_trajectory_rejects_insufficient_samples() {
    let result = analyze_skyrmion_hall_angle_v1(&straight_series(FRAC_PI_6, 20, 2.5e11));

    assert_eq!(
        result.reason_code,
        Some(SkyrmionHallReasonCodeV1::InsufficientSamples)
    );
}

#[test]
fn skyrmion_trajectory_rejects_too_short_stationary_window_without_fixed_frame_index() {
    let mut series = straight_series(FRAC_PI_6, 25, 2.5e11);
    for (index, sample) in series.samples.iter_mut().enumerate() {
        sample.time_s = index as f64 * 3.0e-12;
    }

    let result = analyze_skyrmion_hall_angle_v1(&series);

    assert_eq!(
        result.reason_code,
        Some(SkyrmionHallReasonCodeV1::NoStationaryWindow)
    );
}
