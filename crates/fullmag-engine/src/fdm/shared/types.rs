//! FDM type definitions: grid, material, config structs, error handling.

use std::error::Error;
use std::fmt;

use crate::Vector3;

// ── Error ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineErrorCode {
    Unspecified,
    InvalidInput,
    InvalidTimestep,
    NaNValue,
    InfiniteValue,
    CapabilityUnavailable,
    OutOfMemory,
    SolverFailure,
    NonConvergence,
    Interrupted,
    CoupledSolverFailure,
    AdaptiveDtMinExhausted,
    AdaptiveRetryLimitExhausted,
}

impl EngineErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Unspecified => "unspecified",
            Self::InvalidInput => "invalid_input",
            Self::InvalidTimestep => "invalid_timestep",
            Self::NaNValue => "nan_value",
            Self::InfiniteValue => "infinite_value",
            Self::CapabilityUnavailable => "capability_unavailable",
            Self::OutOfMemory => "out_of_memory",
            Self::SolverFailure => "solver_failure",
            Self::NonConvergence => "non_convergence",
            Self::Interrupted => "interrupted",
            Self::CoupledSolverFailure => "coupled_solver_failure",
            Self::AdaptiveDtMinExhausted => "adaptive_dt_min_exhausted",
            Self::AdaptiveRetryLimitExhausted => "adaptive_retry_limit_exhausted",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineError {
    code: EngineErrorCode,
    message: String,
}

impl EngineError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            code: EngineErrorCode::Unspecified,
            message: message.into(),
        }
    }

    pub fn with_code(code: EngineErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub const fn code(&self) -> EngineErrorCode {
        self.code
    }
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl Error for EngineError {}

pub type Result<T> = std::result::Result<T, EngineError>;

#[cfg(test)]
mod engine_error_code_tests {
    use super::EngineErrorCode;

    #[test]
    fn stable_reason_codes_cover_required_failure_classes() {
        assert_eq!(EngineErrorCode::NaNValue.as_str(), "nan_value");
        assert_eq!(EngineErrorCode::InfiniteValue.as_str(), "infinite_value");
        assert_eq!(
            EngineErrorCode::CapabilityUnavailable.as_str(),
            "capability_unavailable"
        );
        assert_eq!(EngineErrorCode::OutOfMemory.as_str(), "out_of_memory");
        assert_eq!(EngineErrorCode::SolverFailure.as_str(), "solver_failure");
        assert_eq!(EngineErrorCode::NonConvergence.as_str(), "non_convergence");
        assert_eq!(EngineErrorCode::Interrupted.as_str(), "interrupted");
    }
}

/// Dynamic terms supplied by a coupled solver for one explicit integrator
/// stage. Both arrays use the canonical FDM cell ordering.
#[derive(Debug, Clone, PartialEq)]
pub struct ExternalStageTerms {
    /// Additional magnetic field in A/m, assembled before the Gilbert RHS.
    pub additional_field_apm: Vec<Vector3>,
    /// Direct contribution to `dm/dt` in 1/s, added after the Gilbert RHS.
    pub direct_torque_per_s: Vec<Vector3>,
}

/// Stage identity emitted by the one canonical coupled ARS(2,3,2) tableau
/// owner. Transport must solve only the indicated implicit stage and must not
/// start a nested time-integrator step from this callback.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoupledImexArk2Stage {
    ExplicitOrigin,
    ImplicitStageOne,
    ImplicitStageTwo,
    AcceptedObservation,
}

/// Canonical ARS(2,3,2) additive tableau from physics note 0970.
pub struct CoupledImexArk2Tableau;

impl CoupledImexArk2Tableau {
    pub const GAMMA: f64 = (2.0 - std::f64::consts::SQRT_2) / 2.0;
    pub const DELTA: f64 = -2.0 * std::f64::consts::SQRT_2 / 3.0;
    pub const EXPLICIT_A: [[f64; 3]; 3] = [
        [0.0, 0.0, 0.0],
        [Self::GAMMA, 0.0, 0.0],
        [Self::DELTA, 1.0 - Self::DELTA, 0.0],
    ];
    pub const EXPLICIT_B: [f64; 3] = [0.0, 1.0 - Self::GAMMA, Self::GAMMA];
    pub const IMPLICIT_A: [[f64; 2]; 2] = [[Self::GAMMA, 0.0], [1.0 - Self::GAMMA, Self::GAMMA]];
    pub const IMPLICIT_B: [f64; 2] = [1.0 - Self::GAMMA, Self::GAMMA];
}

/// Embedded magnetic-step error available only for the corrected candidate.
/// Coupled transport uses it to bound transport-induced torque error before
/// either subsystem commits state.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TransportStageErrorBudget {
    pub dt_s: f64,
    pub embedded_lte_m: f64,
}

// ── Grid & Cell ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GridShape {
    pub nx: usize,
    pub ny: usize,
    pub nz: usize,
}

impl GridShape {
    pub fn new(nx: usize, ny: usize, nz: usize) -> Result<Self> {
        if nx == 0 || ny == 0 || nz == 0 {
            return Err(EngineError::new("grid shape components must be >= 1"));
        }
        Ok(Self { nx, ny, nz })
    }

    pub fn cell_count(self) -> usize {
        self.nx * self.ny * self.nz
    }

    pub(crate) fn index(self, x: usize, y: usize, z: usize) -> usize {
        x + self.nx * (y + self.ny * z)
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CellSize {
    pub dx: f64,
    pub dy: f64,
    pub dz: f64,
}

impl CellSize {
    pub fn new(dx: f64, dy: f64, dz: f64) -> Result<Self> {
        for (name, value) in [("dx", dx), ("dy", dy), ("dz", dz)] {
            if value <= 0.0 {
                return Err(EngineError::new(format!("{name} must be positive")));
            }
        }
        Ok(Self { dx, dy, dz })
    }

    pub fn volume(self) -> f64 {
        self.dx * self.dy * self.dz
    }
}

// ── Periodic boundary policy ───────────────────────────────────────────

/// Per-axis boundary policy (open = clamp, periodic = wrap).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AxisBoundary {
    #[default]
    Open,
    Periodic,
}

/// FDM boundary policy for each axis.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FdmBoundaryPolicy {
    pub x: AxisBoundary,
    pub y: AxisBoundary,
    pub z: AxisBoundary,
}

/// Planner-resolved periodic FFT workspace contract consumed by runtime
/// allocators.  The runner carries this value across the plan boundary so an
/// allocator cannot silently reinterpret image counts or padding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResolvedFdmPeriodicWorkspace {
    pub image_counts: [u32; 3],
    pub padded_counts: [u64; 3],
    pub image_terms: u64,
    pub estimated_bytes: u64,
}

impl Default for FdmBoundaryPolicy {
    fn default() -> Self {
        Self {
            x: AxisBoundary::Open,
            y: AxisBoundary::Open,
            z: AxisBoundary::Open,
        }
    }
}

impl FdmBoundaryPolicy {
    /// Returns `true` if any axis is periodic.
    pub fn has_any_periodic(&self) -> bool {
        matches!(self.x, AxisBoundary::Periodic)
            || matches!(self.y, AxisBoundary::Periodic)
            || matches!(self.z, AxisBoundary::Periodic)
    }
}

/// Resolved demagnetization kernel boundary realization.
///
/// This is intentionally separate from the local exchange/DMI boundary
/// policy: periodic local stencils with an open demag kernel are a different
/// (and currently unsupported) physical request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FdmDemagBoundary {
    Open,
    PeriodicTruncatedImages { image_counts: [u32; 3] },
}

/// Compute neighbor index along one axis with clamp or wrap semantics.
///
/// - `i`: current index along the axis
/// - `n`: axis extent (number of cells)
/// - `delta`: neighbor offset (`-1` or `+1`)
/// - `periodic`: whether the axis wraps around
#[inline]
pub fn neighbor_index(i: usize, n: usize, delta: i32, periodic: bool) -> usize {
    if periodic {
        ((i as i32 + delta).rem_euclid(n as i32)) as usize
    } else {
        (i as i32 + delta).clamp(0, n as i32 - 1) as usize
    }
}

// ── Material ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MaterialParameters {
    pub saturation_magnetisation: f64,
    pub exchange_stiffness: f64,
    pub damping: f64,
}

impl MaterialParameters {
    pub fn new(
        saturation_magnetisation: f64,
        exchange_stiffness: f64,
        damping: f64,
    ) -> Result<Self> {
        if saturation_magnetisation <= 0.0 {
            return Err(EngineError::new(
                "saturation_magnetisation must be positive",
            ));
        }
        if exchange_stiffness <= 0.0 {
            return Err(EngineError::new("exchange_stiffness must be positive"));
        }
        if damping < 0.0 {
            return Err(EngineError::new("damping must be >= 0"));
        }
        Ok(Self {
            saturation_magnetisation,
            exchange_stiffness,
            damping,
        })
    }
}

// ── Integrator & dynamics config ───────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimeIntegrator {
    Heun,
    RK4,
    RK23,
    RK45,
    /// Adams–Bashforth–Moulton 3rd-order predictor-corrector.
    /// After 3-step Heun warmup, uses only 1 RHS evaluation per step.
    ABM3,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AdaptiveStepConfig {
    pub max_error: f64,
    pub dt_min: f64,
    pub dt_max: f64,
    pub headroom: f64,
    /// Relative tolerance for mixed atol/rtol error norm.  0.0 = pure atol.
    pub rtol: f64,
    /// Maximum factor by which dt can grow in one accepted step (e.g. 2.0).
    /// `f64::INFINITY` disables the limit.
    pub growth_limit: f64,
    /// Minimum factor by which dt can shrink on rejection (e.g. 0.2).
    /// 0.0 disables the limit.
    pub shrink_limit: f64,
}

impl Default for AdaptiveStepConfig {
    fn default() -> Self {
        Self {
            max_error: 1e-5,
            dt_min: 1e-18,
            dt_max: 1e-10,
            headroom: 0.8,
            rtol: 0.0,
            growth_limit: f64::INFINITY,
            shrink_limit: 0.0,
        }
    }
}

/// Stable identity of the Rust FDM CPU adaptive-step controller policy.
///
/// Attempt telemetry carries this value so a recorded retry trace cannot be
/// interpreted with a different accept/reject policy after a solver change.
pub const FDM_ADAPTIVE_CONTROLLER_POLICY_VERSION: &str = "fullmag.fdm.adaptive_controller.v1";

/// Default bounded retry budget for one adaptive outer-step transaction.
pub const FDM_ADAPTIVE_CONTROLLER_MAX_REJECTED_ATTEMPTS: u32 = 50;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum AdaptiveStepDecision {
    Accepted(f64),
    Retry(f64),
    DtMinExhausted,
    NonFinite(EngineErrorCode),
    RetryLimitExhausted,
}

/// Public, versioned PI controller shared by all Rust FDM CPU embedded-RK
/// representations.  It owns the previous accepted error and retry budget;
/// rejected attempts never update the PI history.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AdaptiveStepController {
    order_estimate: i32,
    config: AdaptiveStepConfig,
    previous_error: Option<f64>,
    rejected_attempts: u32,
    max_rejected_attempts: u32,
}

impl AdaptiveStepController {
    pub const POLICY_VERSION: &'static str = FDM_ADAPTIVE_CONTROLLER_POLICY_VERSION;
    pub const DEFAULT_MAX_REJECTED_ATTEMPTS: u32 = FDM_ADAPTIVE_CONTROLLER_MAX_REJECTED_ATTEMPTS;

    pub fn new(
        order_estimate: i32,
        config: AdaptiveStepConfig,
        previous_error: Option<f64>,
    ) -> Self {
        Self {
            order_estimate,
            config,
            previous_error,
            rejected_attempts: 0,
            max_rejected_attempts: Self::DEFAULT_MAX_REJECTED_ATTEMPTS,
        }
    }

    pub fn with_max_rejected_attempts(mut self, max_rejected_attempts: u32) -> Self {
        self.max_rejected_attempts = max_rejected_attempts;
        self
    }

    pub const fn policy_version(&self) -> &'static str {
        Self::POLICY_VERSION
    }

    pub const fn previous_error(&self) -> Option<f64> {
        self.previous_error
    }

    pub const fn rejected_attempts(&self) -> u32 {
        self.rejected_attempts
    }

    pub const fn max_rejected_attempts(&self) -> u32 {
        self.max_rejected_attempts
    }

    fn retry_or_fail(&mut self, dt_next: f64) -> AdaptiveStepDecision {
        if self.rejected_attempts >= self.max_rejected_attempts {
            AdaptiveStepDecision::RetryLimitExhausted
        } else {
            self.rejected_attempts += 1;
            AdaptiveStepDecision::Retry(dt_next)
        }
    }

    pub fn decide(&mut self, dt: f64, error: f64) -> AdaptiveStepDecision {
        if error.is_nan() {
            return AdaptiveStepDecision::NonFinite(EngineErrorCode::NaNValue);
        }
        if error.is_infinite() {
            return AdaptiveStepDecision::NonFinite(EngineErrorCode::InfiniteValue);
        }
        // Treat a representationally rounded value just above `dt_min` as the
        // minimum-step boundary.  Otherwise a rejected attempt can schedule
        // one redundant retry at the same clamped `dt_min`.
        let at_dt_min = dt <= self.config.dt_min
            || (dt - self.config.dt_min).abs() <= self.config.dt_min * (4.0 * f64::EPSILON);
        if error > 1.0 && at_dt_min {
            return AdaptiveStepDecision::DtMinExhausted;
        }
        let accepted = error <= 1.0;
        let raw_ratio = if error == 0.0 {
            self.config.growth_limit
        } else {
            let scale = 1.0 / f64::from(self.order_estimate + 1);
            if accepted {
                self.previous_error
                    .filter(|value| *value > 0.0)
                    .map_or_else(
                        || self.config.headroom * error.powf(-scale),
                        |previous| {
                            self.config.headroom
                                * error.powf(-0.7 * scale)
                                * previous.powf(0.4 * scale)
                        },
                    )
            } else {
                self.config.headroom * error.powf(-scale)
            }
        };
        let next = (dt * raw_ratio.clamp(self.config.shrink_limit, self.config.growth_limit))
            .clamp(self.config.dt_min, self.config.dt_max);
        if accepted {
            self.previous_error = Some(error);
            AdaptiveStepDecision::Accepted(next)
        } else if next < dt {
            self.retry_or_fail(next)
        } else {
            let decreased = dt.next_down();
            if decreased > 0.0 && decreased >= self.config.dt_min {
                self.retry_or_fail(decreased)
            } else {
                AdaptiveStepDecision::DtMinExhausted
            }
        }
    }
}

use crate::DEFAULT_GYROMAGNETIC_RATIO;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LlgConfig {
    pub gyromagnetic_ratio: f64,
    pub integrator: TimeIntegrator,
    /// True only when the public problem selected an adaptive timestep policy.
    /// Embedded RK tableaus remain fixed-step when this is false.
    pub adaptive_enabled: bool,
    pub adaptive: AdaptiveStepConfig,
    pub precession_enabled: bool,
}

impl Default for LlgConfig {
    fn default() -> Self {
        Self {
            gyromagnetic_ratio: DEFAULT_GYROMAGNETIC_RATIO,
            integrator: TimeIntegrator::Heun,
            adaptive_enabled: false,
            adaptive: AdaptiveStepConfig::default(),
            precession_enabled: true,
        }
    }
}

impl LlgConfig {
    pub fn new(gyromagnetic_ratio: f64, integrator: TimeIntegrator) -> Result<Self> {
        if gyromagnetic_ratio <= 0.0 {
            return Err(EngineError::new("gyromagnetic_ratio must be positive"));
        }
        Ok(Self {
            gyromagnetic_ratio,
            integrator,
            adaptive_enabled: false,
            adaptive: AdaptiveStepConfig::default(),
            precession_enabled: true,
        })
    }

    pub fn with_adaptive(mut self, config: AdaptiveStepConfig) -> Self {
        self.adaptive_enabled = true;
        self.adaptive = config;
        self
    }

    pub fn with_precession_enabled(mut self, enabled: bool) -> Self {
        self.precession_enabled = enabled;
        self
    }
}

// ── EvaluationRequest (B3: Physics/Observables separation) ─────────────

/// Policy controlling which quantities are computed at step end.
///
/// Integrators need `h_eff` and `rhs`, but energy decomposition and per-term
/// field amplitudes are only required for artefacts / preview / diagnostics.
/// Using `Minimal` skips the costly scratch-buffer passes that separate
/// exchange / demag / external energies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvaluationRequest {
    /// Compute only h_eff, rhs, and max amplitudes.
    /// Energies are returned as 0.0 (not computed).
    Minimal,
    /// Compute h_eff, rhs, amplitudes, and per-term energies.
    /// This is the current default behaviour.
    Full,
}
