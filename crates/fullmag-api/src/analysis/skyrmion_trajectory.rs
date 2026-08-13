//! Pure v1 skyrmion trajectory and Hall-angle observable.
//!
//! This module deliberately consumes only an already accepted, signed-density
//! trajectory series.  The v2 resource layer has no immutable time-series
//! source yet, so this is an integration seam rather than an HTTP resource.

use std::cmp::Ordering;
use std::f64::consts::PI;

use serde::{Deserialize, Serialize};

pub const SKYRMION_HALL_ARTIFACT_SCHEMA_V1: &str = "skyrmion_hall_angle.v1";
pub const SKYRMION_HALL_ALGORITHM_VERSION_V1: &str = "weighted_gls.v1";
pub const MIN_WINDOW_SAMPLES_V1: usize = 21;
pub const MIN_WINDOW_DURATION_S: f64 = 100.0e-12;
pub const MIN_EDGE_DISTANCE_M: f64 = 16.0e-9;
pub const MIN_DISPLACEMENT_M: f64 = 4.0e-9;
pub const MIN_MEAN_SPEED_M_PER_S: f64 = 1.0;
pub const MAX_SPEED_CV_V1: f64 = 0.10;
pub const MIN_ABS_TOPOLOGICAL_CHARGE_V1: f64 = 0.5;
pub const MAX_RELATIVE_CHARGE_DEVIATION_V1: f64 = 0.05;
pub const MAX_REDUCED_CHI_SQUARE_V1: f64 = 4.0;
pub const MIN_DIRECTIONAL_COHERENCE_V1: f64 = 0.95;

/// Revision identity that every accepted sample must share before regression.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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

/// Identity of the accepted $m(t)$ series and its physical discretization.
/// This is intentionally an analysis seam: the v2 resource producer must
/// construct it from the accepted field/geometry/grid resource identities.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkyrmionTrajectorySourceV1 {
    pub magnetization_quantity_id: String,
    pub magnetization_series_id: String,
    pub object_id: String,
    pub geometry_id: String,
    pub grid_or_mesh_id: String,
    pub support_id: String,
    pub topological_charge_method_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    /// Calibrated covariance of the signed-density centre in $\mathrm{m^2}$.
    /// It is required: a position series with unknown uncertainty cannot be
    /// promoted to a weighted Hall-angle artifact.
    pub centre_covariance_m2: [[f64; 2]; 2],
    pub provenance: SkyrmionTrajectoryProvenanceV1,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcceptedTrajectorySeriesV1 {
    pub samples: Vec<AcceptedTrajectorySampleV1>,
    /// Reporting-only transformation; the solver trajectory remains unchanged.
    pub reverse_transverse_axis: bool,
    pub source: SkyrmionTrajectorySourceV1,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkyrmionTrajectoryV1 {
    pub time_s: Vec<f64>,
    pub x_m: Vec<f64>,
    pub y_m: Vec<f64>,
    pub q: Vec<f64>,
    pub edge_distance_m: Vec<f64>,
    pub source: Option<SkyrmionTrajectorySourceV1>,
    pub provenance: Option<SkyrmionTrajectoryProvenanceV1>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkyrmionHallReasonCodeV1 {
    NoMotion,
    TopologyLost,
    EdgeContaminated,
    NoStationaryWindow,
    InsufficientSamples,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct AcceptedIntervalV1 {
    pub start_index: usize,
    pub end_index: usize,
    pub sample_count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
    pub reduced_chi_square: Option<f64>,
    pub directional_coherence: Option<f64>,
    pub reason_code: Option<SkyrmionHallReasonCodeV1>,
}

/// Stable on-disk payload consumed by `validate_skyrmion_hall_angle.py`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkyrmionHallArtifactV1 {
    pub schema_version: String,
    pub algorithm_version: String,
    pub trajectory: SkyrmionTrajectoryV1,
    pub hall_angle: SkyrmionHallAnglePayloadV1,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkyrmionHallAnglePayloadV1 {
    pub v_parallel_m_per_s: Option<f64>,
    pub v_perp_m_per_s: Option<f64>,
    pub angle_rad: Option<f64>,
    pub angle_deg: Option<f64>,
    pub angle_variance_rad2: Option<f64>,
    pub velocity_covariance_m2_per_s2: Option<[[f64; 2]; 2]>,
    pub residuals_m: Option<Vec<[f64; 2]>>,
    pub accepted_interval: Option<AcceptedIntervalV1>,
    pub mean_signed_current_a_per_m2: Option<f64>,
    pub reduced_chi_square: Option<f64>,
    pub directional_coherence: Option<f64>,
    pub provenance: Option<SkyrmionTrajectoryProvenanceV1>,
    pub reason_code: Option<SkyrmionHallReasonCodeV1>,
}

impl SkyrmionHallAngleV1 {
    pub fn artifact_v1(&self) -> SkyrmionHallArtifactV1 {
        SkyrmionHallArtifactV1 {
            schema_version: SKYRMION_HALL_ARTIFACT_SCHEMA_V1.to_owned(),
            algorithm_version: SKYRMION_HALL_ALGORITHM_VERSION_V1.to_owned(),
            trajectory: self.trajectory.clone(),
            hall_angle: SkyrmionHallAnglePayloadV1 {
                v_parallel_m_per_s: self.v_parallel_m_per_s,
                v_perp_m_per_s: self.v_perp_m_per_s,
                angle_rad: self.angle_rad,
                angle_deg: self.angle_deg,
                angle_variance_rad2: self.angle_variance_rad2,
                velocity_covariance_m2_per_s2: self.velocity_covariance_m2_per_s2,
                residuals_m: self.residuals_m.clone(),
                accepted_interval: self.accepted_interval,
                mean_signed_current_a_per_m2: self.mean_signed_current_a_per_m2,
                reduced_chi_square: self.reduced_chi_square,
                directional_coherence: self.directional_coherence,
                provenance: self.trajectory.provenance.clone(),
                reason_code: self.reason_code,
            },
        }
    }
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
        reduced_chi_square: Some(fit.reduced_chi_square),
        directional_coherence: Some(fit.directional_coherence),
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
        source: Some(series.source.clone()),
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
        reduced_chi_square: None,
        directional_coherence: None,
        reason_code: Some(reason_code),
    }
}

fn series_has_topology_and_provenance(series: &AcceptedTrajectorySeriesV1) -> bool {
    let Some(first) = series.samples.first() else {
        return false;
    };
    if !source_is_complete(&series.source) {
        return false;
    }
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
                && centre_covariance_is_positive_definite(sample.centre_covariance_m2)
                && sample.provenance == first.provenance
        })
}

fn source_is_complete(source: &SkyrmionTrajectorySourceV1) -> bool {
    [
        &source.magnetization_quantity_id,
        &source.magnetization_series_id,
        &source.object_id,
        &source.geometry_id,
        &source.grid_or_mesh_id,
        &source.support_id,
        &source.topological_charge_method_version,
    ]
    .iter()
    .all(|field| !field.trim().is_empty())
}

fn centre_covariance_is_positive_definite(covariance: [[f64; 2]; 2]) -> bool {
    covariance[0][0].is_finite()
        && covariance[0][1].is_finite()
        && covariance[1][0].is_finite()
        && covariance[1][1].is_finite()
        && (covariance[0][1] - covariance[1][0]).abs() <= 1.0e-30
        && covariance[0][0] > 0.0
        && covariance[1][1] > 0.0
        && covariance[0][0] * covariance[1][1] - covariance[0][1] * covariance[1][0] > 0.0
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
    reduced_chi_square: f64,
    directional_coherence: f64,
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
    let transverse_sign = if reverse_transverse_axis { -1.0 } else { 1.0 };
    if samples.len() <= 2 {
        return None;
    }
    let mut normal = [[0.0; 4]; 4];
    let mut rhs = [0.0; 4];
    for sample in samples {
        let covariance = reporting_covariance(sample.centre_covariance_m2, transverse_sign);
        let inverse = invert_2x2(covariance)?;
        let design = [
            [1.0, 0.0, sample.time_s, 0.0],
            [0.0, 1.0, 0.0, sample.time_s],
        ];
        let observation = [sample.centre_m[0], sample.centre_m[1] * transverse_sign];
        for parameter_i in 0..4 {
            for parameter_j in 0..4 {
                normal[parameter_i][parameter_j] += (0..2)
                    .flat_map(|coordinate_i| {
                        (0..2).map(move |coordinate_j| {
                            design[coordinate_i][parameter_i]
                                * inverse[coordinate_i][coordinate_j]
                                * design[coordinate_j][parameter_j]
                        })
                    })
                    .sum::<f64>();
            }
            rhs[parameter_i] += (0..2)
                .flat_map(|coordinate_i| {
                    (0..2).map(move |coordinate_j| {
                        design[coordinate_i][parameter_i]
                            * inverse[coordinate_i][coordinate_j]
                            * observation[coordinate_j]
                    })
                })
                .sum::<f64>();
        }
    }
    let parameter_covariance = invert_4x4(normal)?;
    let parameters = multiply_4x4_vector(parameter_covariance, rhs);
    let intercept = [parameters[0], parameters[1]];
    let velocity = [parameters[2], parameters[3]];
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
    let normalized_residual_sum = samples
        .iter()
        .zip(&residuals)
        .map(|(sample, residual)| {
            let inverse = invert_2x2(reporting_covariance(
                sample.centre_covariance_m2,
                transverse_sign,
            ))?;
            Some(
                residual[0] * (inverse[0][0] * residual[0] + inverse[0][1] * residual[1])
                    + residual[1] * (inverse[1][0] * residual[0] + inverse[1][1] * residual[1]),
            )
        })
        .collect::<Option<Vec<_>>>()?
        .into_iter()
        .sum::<f64>();
    let reduced_chi_square = normalized_residual_sum / (2.0 * degrees_of_freedom);
    if !reduced_chi_square.is_finite() || reduced_chi_square > MAX_REDUCED_CHI_SQUARE_V1 {
        return None;
    }
    let velocity_covariance = [
        [parameter_covariance[2][2], parameter_covariance[2][3]],
        [parameter_covariance[3][2], parameter_covariance[3][3]],
    ];
    let speed_squared = velocity[0].powi(2) + velocity[1].powi(2);
    if speed_squared <= 0.0 {
        return None;
    }
    let directional_coherence = directional_coherence(samples, velocity, transverse_sign)?;
    if directional_coherence < MIN_DIRECTIONAL_COHERENCE_V1 {
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
        reduced_chi_square,
        directional_coherence,
    })
}

fn reporting_covariance(mut covariance: [[f64; 2]; 2], transverse_sign: f64) -> [[f64; 2]; 2] {
    covariance[0][1] *= transverse_sign;
    covariance[1][0] *= transverse_sign;
    covariance
}

fn invert_2x2(matrix: [[f64; 2]; 2]) -> Option<[[f64; 2]; 2]> {
    if !centre_covariance_is_positive_definite(matrix) {
        return None;
    }
    let determinant = matrix[0][0] * matrix[1][1] - matrix[0][1] * matrix[1][0];
    Some([
        [matrix[1][1] / determinant, -matrix[0][1] / determinant],
        [-matrix[1][0] / determinant, matrix[0][0] / determinant],
    ])
}

fn invert_4x4(matrix: [[f64; 4]; 4]) -> Option<[[f64; 4]; 4]> {
    let mut augmented = [[0.0; 8]; 4];
    for row in 0..4 {
        for column in 0..4 {
            augmented[row][column] = matrix[row][column];
            augmented[row][column + 4] = if row == column { 1.0 } else { 0.0 };
        }
    }
    for pivot_column in 0..4 {
        let pivot_row = (pivot_column..4).max_by(|&left, &right| {
            augmented[left][pivot_column]
                .abs()
                .total_cmp(&augmented[right][pivot_column].abs())
        })?;
        if !augmented[pivot_row][pivot_column].is_finite()
            || augmented[pivot_row][pivot_column].abs() <= f64::EPSILON
        {
            return None;
        }
        augmented.swap(pivot_column, pivot_row);
        let pivot = augmented[pivot_column][pivot_column];
        for column in 0..8 {
            augmented[pivot_column][column] /= pivot;
        }
        for row in 0..4 {
            if row == pivot_column {
                continue;
            }
            let factor = augmented[row][pivot_column];
            for column in 0..8 {
                augmented[row][column] -= factor * augmented[pivot_column][column];
            }
        }
    }
    Some(std::array::from_fn(|row| {
        std::array::from_fn(|column| augmented[row][column + 4])
    }))
}

fn multiply_4x4_vector(matrix: [[f64; 4]; 4], vector: [f64; 4]) -> [f64; 4] {
    std::array::from_fn(|row| {
        (0..4)
            .map(|column| matrix[row][column] * vector[column])
            .sum()
    })
}

fn directional_coherence(
    samples: &[AcceptedTrajectorySampleV1],
    velocity: [f64; 2],
    transverse_sign: f64,
) -> Option<f64> {
    let speed = velocity[0].hypot(velocity[1]);
    (speed > 0.0).then_some(())?;
    let direction = [velocity[0] / speed, velocity[1] / speed];
    let mut projected_distance = 0.0;
    let mut total_distance = 0.0;
    for pair in samples.windows(2) {
        let delta = [
            pair[1].centre_m[0] - pair[0].centre_m[0],
            (pair[1].centre_m[1] - pair[0].centre_m[1]) * transverse_sign,
        ];
        projected_distance += delta[0] * direction[0] + delta[1] * direction[1];
        total_distance += delta[0].hypot(delta[1]);
    }
    (total_distance > 0.0).then_some(projected_distance / total_distance)
}

fn displacement(left: [f64; 2], right: [f64; 2]) -> f64 {
    (right[0] - left[0]).hypot(right[1] - left[1])
}

fn mean(values: &[f64]) -> Option<f64> {
    (!values.is_empty()).then_some(values.iter().sum::<f64>() / values.len() as f64)
}
