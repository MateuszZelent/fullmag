//! Pure v1 skyrmion trajectory and Hall-angle observable.
//!
//! This module deliberately consumes only an already accepted, signed-density
//! trajectory series.  The v2 resource layer has no immutable time-series
//! source yet, so this is an integration seam rather than an HTTP resource.

use std::cmp::Ordering;
use std::f64::consts::PI;

pub const MIN_WINDOW_SAMPLES_V1: usize = 21;
pub const MIN_WINDOW_DURATION_S: f64 = 100.0e-12;
pub const MIN_EDGE_DISTANCE_M: f64 = 16.0e-9;
pub const MIN_DISPLACEMENT_M: f64 = 4.0e-9;
pub const MIN_MEAN_SPEED_M_PER_S: f64 = 1.0;
pub const MAX_SPEED_CV_V1: f64 = 0.10;
pub const MIN_ABS_TOPOLOGICAL_CHARGE_V1: f64 = 0.5;
pub const MAX_RELATIVE_CHARGE_DEVIATION_V1: f64 = 0.05;

/// Revision identity that every accepted sample must share before regression.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkyrmionTrajectoryProvenanceV1 {
    pub scene_revision: String,
    pub field_revision: String,
    pub mesh_revision: String,
    pub mesh_generation_id: String,
    pub domain_generation_id: String,
    pub global_node_mapping_id: String,
    pub snapshot_id: Option<String>,
    pub stage_id: Option<String>,
    pub cache_key_digest: String,
}

#[derive(Debug, Clone)]
pub struct AcceptedTrajectorySampleV1 {
    pub accepted_sequence: u64,
    pub time_s: f64,
    /// Centre made from the canonical signed triangle-density moment, in the
    /// reporting frame.  This seam rejects unqualified values; it never
    /// substitutes a renderer or unsigned-density centroid.
    pub centre_m: [f64; 2],
    pub topological_charge: f64,
    pub minimum_edge_distance_m: f64,
    pub signed_current_a_per_m2: f64,
    pub provenance: SkyrmionTrajectoryProvenanceV1,
}

#[derive(Debug, Clone)]
pub struct AcceptedTrajectorySeriesV1 {
    pub samples: Vec<AcceptedTrajectorySampleV1>,
    /// Reporting-only transformation; the solver trajectory remains unchanged.
    pub reverse_transverse_axis: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SkyrmionTrajectoryV1 {
    pub time_s: Vec<f64>,
    pub x_m: Vec<f64>,
    pub y_m: Vec<f64>,
    pub q: Vec<f64>,
    pub edge_distance_m: Vec<f64>,
    pub provenance: Option<SkyrmionTrajectoryProvenanceV1>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkyrmionHallReasonCodeV1 {
    NoMotion,
    TopologyLost,
    EdgeContaminated,
    NoStationaryWindow,
    InsufficientSamples,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AcceptedIntervalV1 {
    pub start_index: usize,
    pub end_index: usize,
    pub sample_count: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SkyrmionHallAngleV1 {
    pub trajectory: SkyrmionTrajectoryV1,
    pub v_parallel_m_per_s: Option<f64>,
    pub v_perp_m_per_s: Option<f64>,
    pub angle_rad: Option<f64>,
    pub angle_deg: Option<f64>,
    pub angle_variance_rad2: Option<f64>,
    pub velocity_covariance_m2_per_s2: Option<[[f64; 2]; 2]>,
    pub residuals_m: Option<Vec<[f64; 2]>>,
    pub accepted_interval: Option<AcceptedIntervalV1>,
    pub mean_signed_current_a_per_m2: Option<f64>,
    pub reason_code: Option<SkyrmionHallReasonCodeV1>,
}

pub fn analyze_skyrmion_hall_angle_v1(series: &AcceptedTrajectorySeriesV1) -> SkyrmionHallAngleV1 {
    let trajectory = published_trajectory(series);
    let unavailable = |reason_code| unavailable_result(trajectory.clone(), reason_code);

    if !series_has_topology_and_provenance(series) {
        return unavailable(SkyrmionHallReasonCodeV1::TopologyLost);
    }
    if series
        .samples
        .iter()
        .any(|sample| sample.minimum_edge_distance_m < MIN_EDGE_DISTANCE_M)
    {
        return unavailable(SkyrmionHallReasonCodeV1::EdgeContaminated);
    }
    if series.samples.len() < MIN_WINDOW_SAMPLES_V1 {
        return unavailable(SkyrmionHallReasonCodeV1::InsufficientSamples);
    }

    let motion_exists = series.samples.windows(2).any(|pair| {
        displacement(pair[0].centre_m, pair[1].centre_m) >= MIN_DISPLACEMENT_M
            && displacement(pair[0].centre_m, pair[1].centre_m) / (pair[1].time_s - pair[0].time_s)
                >= MIN_MEAN_SPEED_M_PER_S
    }) || displacement(
        series.samples.first().expect("length checked").centre_m,
        series.samples.last().expect("length checked").centre_m,
    ) >= MIN_DISPLACEMENT_M;

    let mut selected: Option<WindowFit> = None;
    for start_index in 0..series.samples.len() {
        for end_index in start_index + MIN_WINDOW_SAMPLES_V1 - 1..series.samples.len() {
            let samples = &series.samples[start_index..=end_index];
            let Some(fit) =
                qualify_and_fit_window(samples, start_index, series.reverse_transverse_axis)
            else {
                continue;
            };
            let replace = selected.as_ref().is_none_or(|current| {
                fit.duration_s > current.duration_s
                    || (fit.duration_s == current.duration_s
                        && (fit.start_index, fit.end_index)
                            < (current.start_index, current.end_index))
            });
            if replace {
                selected = Some(fit);
            }
        }
    }

    let Some(fit) = selected else {
        return unavailable(if motion_exists {
            SkyrmionHallReasonCodeV1::NoStationaryWindow
        } else {
            SkyrmionHallReasonCodeV1::NoMotion
        });
    };
    SkyrmionHallAngleV1 {
        trajectory,
        v_parallel_m_per_s: Some(fit.velocity[0]),
        v_perp_m_per_s: Some(fit.velocity[1]),
        angle_rad: Some(fit.angle_rad),
        angle_deg: Some(fit.angle_rad * 180.0 / PI),
        angle_variance_rad2: Some(fit.angle_variance_rad2),
        velocity_covariance_m2_per_s2: Some(fit.velocity_covariance),
        residuals_m: Some(fit.residuals),
        accepted_interval: Some(AcceptedIntervalV1 {
            start_index: fit.start_index,
            end_index: fit.end_index,
            sample_count: fit.end_index - fit.start_index + 1,
        }),
        mean_signed_current_a_per_m2: Some(fit.mean_signed_current_a_per_m2),
        reason_code: None,
    }
}

fn published_trajectory(series: &AcceptedTrajectorySeriesV1) -> SkyrmionTrajectoryV1 {
    let transverse_sign = if series.reverse_transverse_axis {
        -1.0
    } else {
        1.0
    };
    SkyrmionTrajectoryV1 {
        time_s: series.samples.iter().map(|sample| sample.time_s).collect(),
        x_m: series
            .samples
            .iter()
            .map(|sample| sample.centre_m[0])
            .collect(),
        y_m: series
            .samples
            .iter()
            .map(|sample| sample.centre_m[1] * transverse_sign)
            .collect(),
        q: series
            .samples
            .iter()
            .map(|sample| sample.topological_charge)
            .collect(),
        edge_distance_m: series
            .samples
            .iter()
            .map(|sample| sample.minimum_edge_distance_m)
            .collect(),
        provenance: series
            .samples
            .first()
            .map(|sample| sample.provenance.clone()),
    }
}

fn unavailable_result(
    trajectory: SkyrmionTrajectoryV1,
    reason_code: SkyrmionHallReasonCodeV1,
) -> SkyrmionHallAngleV1 {
    SkyrmionHallAngleV1 {
        trajectory,
        v_parallel_m_per_s: None,
        v_perp_m_per_s: None,
        angle_rad: None,
        angle_deg: None,
        angle_variance_rad2: None,
        velocity_covariance_m2_per_s2: None,
        residuals_m: None,
        accepted_interval: None,
        mean_signed_current_a_per_m2: None,
        reason_code: Some(reason_code),
    }
}

fn series_has_topology_and_provenance(series: &AcceptedTrajectorySeriesV1) -> bool {
    let Some(first) = series.samples.first() else {
        return false;
    };
    let sign = first.topological_charge.signum();
    series
        .samples
        .windows(2)
        .all(|pair| pair[0].accepted_sequence < pair[1].accepted_sequence)
        && series
            .samples
            .windows(2)
            .all(|pair| pair[0].time_s < pair[1].time_s)
        && series.samples.iter().all(|sample| {
            sample.time_s.is_finite()
                && sample.centre_m.into_iter().all(f64::is_finite)
                && sample.topological_charge.is_finite()
                && sample.topological_charge.abs() >= MIN_ABS_TOPOLOGICAL_CHARGE_V1
                && sample.topological_charge.signum() == sign
                && sample.minimum_edge_distance_m.is_finite()
                && sample.minimum_edge_distance_m >= 0.0
                && sample.signed_current_a_per_m2.is_finite()
                && sample.provenance == first.provenance
        })
}

struct WindowFit {
    start_index: usize,
    end_index: usize,
    duration_s: f64,
    velocity: [f64; 2],
    velocity_covariance: [[f64; 2]; 2],
    residuals: Vec<[f64; 2]>,
    angle_rad: f64,
    angle_variance_rad2: f64,
    mean_signed_current_a_per_m2: f64,
}

fn qualify_and_fit_window(
    samples: &[AcceptedTrajectorySampleV1],
    start_index: usize,
    reverse_transverse_axis: bool,
) -> Option<WindowFit> {
    let duration_s = samples.last()?.time_s - samples.first()?.time_s;
    if duration_s < MIN_WINDOW_DURATION_S || !charges_are_stable(samples) {
        return None;
    }
    let speeds: Vec<f64> = samples
        .windows(2)
        .map(|pair| {
            displacement(pair[0].centre_m, pair[1].centre_m) / (pair[1].time_s - pair[0].time_s)
        })
        .collect();
    let mean_speed = mean(&speeds)?;
    let speed_cv = (speeds
        .iter()
        .map(|speed| (speed - mean_speed).powi(2))
        .sum::<f64>()
        / speeds.len() as f64)
        .sqrt()
        / mean_speed.max(MIN_MEAN_SPEED_M_PER_S);
    let net_displacement = displacement(samples.first()?.centre_m, samples.last()?.centre_m);
    if net_displacement < MIN_DISPLACEMENT_M
        || mean_speed < MIN_MEAN_SPEED_M_PER_S
        || speed_cv > MAX_SPEED_CV_V1
    {
        return None;
    }
    fit(samples, start_index, reverse_transverse_axis, duration_s)
}

fn charges_are_stable(samples: &[AcceptedTrajectorySampleV1]) -> bool {
    let mut values: Vec<f64> = samples
        .iter()
        .map(|sample| sample.topological_charge)
        .collect();
    values.sort_by(|left, right| left.partial_cmp(right).unwrap_or(Ordering::Equal));
    let middle = values.len() / 2;
    let median = if values.len() % 2 == 0 {
        (values[middle - 1] + values[middle]) / 2.0
    } else {
        values[middle]
    };
    median != 0.0
        && samples.iter().all(|sample| {
            (sample.topological_charge - median).abs()
                <= MAX_RELATIVE_CHARGE_DEVIATION_V1 * median.abs()
        })
}

fn fit(
    samples: &[AcceptedTrajectorySampleV1],
    start_index: usize,
    reverse_transverse_axis: bool,
    duration_s: f64,
) -> Option<WindowFit> {
    let t_mean = mean(
        &samples
            .iter()
            .map(|sample| sample.time_s)
            .collect::<Vec<_>>(),
    )?;
    let transverse_sign = if reverse_transverse_axis { -1.0 } else { 1.0 };
    let x_mean =
        samples.iter().map(|sample| sample.centre_m[0]).sum::<f64>() / samples.len() as f64;
    let y_mean = samples
        .iter()
        .map(|sample| sample.centre_m[1] * transverse_sign)
        .sum::<f64>()
        / samples.len() as f64;
    let s_tt = samples
        .iter()
        .map(|sample| (sample.time_s - t_mean).powi(2))
        .sum::<f64>();
    if s_tt <= 0.0 || samples.len() <= 2 {
        return None;
    }
    let velocity = [
        samples
            .iter()
            .map(|sample| (sample.time_s - t_mean) * (sample.centre_m[0] - x_mean))
            .sum::<f64>()
            / s_tt,
        samples
            .iter()
            .map(|sample| {
                (sample.time_s - t_mean) * (sample.centre_m[1] * transverse_sign - y_mean)
            })
            .sum::<f64>()
            / s_tt,
    ];
    let intercept = [x_mean - velocity[0] * t_mean, y_mean - velocity[1] * t_mean];
    let residuals: Vec<[f64; 2]> = samples
        .iter()
        .map(|sample| {
            [
                sample.centre_m[0] - (intercept[0] + velocity[0] * sample.time_s),
                sample.centre_m[1] * transverse_sign - (intercept[1] + velocity[1] * sample.time_s),
            ]
        })
        .collect();
    let degrees_of_freedom = (samples.len() - 2) as f64;
    let velocity_covariance = [
        [
            residuals
                .iter()
                .map(|residual| residual[0] * residual[0])
                .sum::<f64>()
                / degrees_of_freedom
                / s_tt,
            residuals
                .iter()
                .map(|residual| residual[0] * residual[1])
                .sum::<f64>()
                / degrees_of_freedom
                / s_tt,
        ],
        [
            residuals
                .iter()
                .map(|residual| residual[0] * residual[1])
                .sum::<f64>()
                / degrees_of_freedom
                / s_tt,
            residuals
                .iter()
                .map(|residual| residual[1] * residual[1])
                .sum::<f64>()
                / degrees_of_freedom
                / s_tt,
        ],
    ];
    let speed_squared = velocity[0].powi(2) + velocity[1].powi(2);
    if speed_squared <= 0.0 {
        return None;
    }
    let angle_variance_rad2 = (velocity[1].powi(2) * velocity_covariance[0][0]
        + velocity[0].powi(2) * velocity_covariance[1][1]
        - 2.0 * velocity[0] * velocity[1] * velocity_covariance[0][1])
        / speed_squared.powi(2);
    Some(WindowFit {
        start_index,
        end_index: start_index + samples.len() - 1,
        duration_s,
        velocity,
        velocity_covariance,
        residuals,
        angle_rad: velocity[1].atan2(velocity[0]),
        angle_variance_rad2,
        mean_signed_current_a_per_m2: samples
            .iter()
            .map(|sample| sample.signed_current_a_per_m2)
            .sum::<f64>()
            / samples.len() as f64,
    })
}

fn displacement(left: [f64; 2], right: [f64; 2]) -> f64 {
    (right[0] - left[0]).hypot(right[1] - left[1])
}

fn mean(values: &[f64]) -> Option<f64> {
    (!values.is_empty()).then_some(values.iter().sum::<f64>() / values.len() as f64)
}
