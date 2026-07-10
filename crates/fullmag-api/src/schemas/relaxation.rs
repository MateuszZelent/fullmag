use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

pub const MU0_T_PER_APM: f64 = 4.0 * std::f64::consts::PI * 1.0e-7;

pub fn canonical_torque_apm(value: f64) -> Option<f64> {
    (value.is_finite() && value >= 0.0).then_some(value)
}

pub fn torque_t_from_apm(value: f64) -> Option<f64> {
    canonical_torque_apm(value)
        .map(|torque_apm| torque_apm * MU0_T_PER_APM)
        .filter(|torque_t| torque_t.is_finite())
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RelaxationAlgorithm {
    LlgOverdamped,
    ProjectedGradientBb,
    NonlinearCg,
    TangentPlaneImplicit,
}

impl RelaxationAlgorithm {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::LlgOverdamped => "llg_overdamped",
            Self::ProjectedGradientBb => "projected_gradient_bb",
            Self::NonlinearCg => "nonlinear_cg",
            Self::TangentPlaneImplicit => "tangent_plane_implicit",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "llg_overdamped" => Some(Self::LlgOverdamped),
            "projected_gradient_bb" => Some(Self::ProjectedGradientBb),
            "nonlinear_cg" => Some(Self::NonlinearCg),
            "tangent_plane_implicit" => Some(Self::TangentPlaneImplicit),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StageStopReason {
    Torque,
    Energy,
    MaxSteps,
    MaxPseudotime,
    MaxPhysicalTime,
    UserCancelled,
    BackendError,
    Gradient,
}

impl From<fullmag_ir::StageStopReason> for StageStopReason {
    fn from(value: fullmag_ir::StageStopReason) -> Self {
        match value {
            fullmag_ir::StageStopReason::Torque => Self::Torque,
            fullmag_ir::StageStopReason::Energy => Self::Energy,
            fullmag_ir::StageStopReason::MaxSteps => Self::MaxSteps,
            fullmag_ir::StageStopReason::MaxPseudotime => Self::MaxPseudotime,
            fullmag_ir::StageStopReason::MaxPhysicalTime => Self::MaxPhysicalTime,
            fullmag_ir::StageStopReason::UserCancelled => Self::UserCancelled,
            fullmag_ir::StageStopReason::BackendError => Self::BackendError,
            fullmag_ir::StageStopReason::Gradient => Self::Gradient,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StageMetricKind {
    MaxTorqueApm,
    TotalEnergyPlateauRangeJ,
    RelaxationTimeS,
    Steps,
    NumericalStagnation,
}

impl From<fullmag_ir::StageMetricKind> for StageMetricKind {
    fn from(value: fullmag_ir::StageMetricKind) -> Self {
        match value {
            fullmag_ir::StageMetricKind::MaxTorqueApm => Self::MaxTorqueApm,
            fullmag_ir::StageMetricKind::TotalEnergyPlateauRangeJ => Self::TotalEnergyPlateauRangeJ,
            fullmag_ir::StageMetricKind::RelaxationTimeS => Self::RelaxationTimeS,
            fullmag_ir::StageMetricKind::Steps => Self::Steps,
            fullmag_ir::StageMetricKind::NumericalStagnation => Self::NumericalStagnation,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
pub enum StageMetricUnit {
    #[serde(rename = "A/m")]
    AmperePerMeter,
    #[serde(rename = "J")]
    Joule,
    #[serde(rename = "s")]
    Second,
    #[serde(rename = "1")]
    Dimensionless,
}

impl From<fullmag_ir::StageMetricKind> for StageMetricUnit {
    fn from(value: fullmag_ir::StageMetricKind) -> Self {
        match value {
            fullmag_ir::StageMetricKind::MaxTorqueApm => Self::AmperePerMeter,
            fullmag_ir::StageMetricKind::TotalEnergyPlateauRangeJ => Self::Joule,
            fullmag_ir::StageMetricKind::RelaxationTimeS => Self::Second,
            fullmag_ir::StageMetricKind::Steps
            | fullmag_ir::StageMetricKind::NumericalStagnation => Self::Dimensionless,
        }
    }
}
