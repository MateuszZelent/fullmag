//! Adaptive time-step integrators for FEM: RK23 (Bogacki–Shampine) and
//! RK45 (Dormand–Prince).
//!
//! Both embed a lower-order solution to estimate the local truncation error.
//! The step controller adjusts `dt` at every step to keep the error below
//! the requested tolerances.  On rejection the step is retried with a smaller
//! `dt`.

use fullmag_ir::{AdaptiveTimeStepIR, IntegratorChoice};

// ── RK23 (Bogacki–Shampine 3/2) ──────────────────────────────────────────────

/// Bogacki–Shampine RK23 configuration.
///
/// 3-stage, 2nd-order method with an embedded 1st-order solution for error
/// estimation.  RK23 is FSAL: the last stage of step k equals the first stage
/// of step k+1, saving one RHS evaluation per accepted step.
///
/// Suitable for moderately stiff LLG dynamics or when the damping is moderate
/// (α ∼ 0.1–0.5).
#[derive(Debug, Clone)]
pub struct Rk23Config {
    /// Adaptive time-step parameters.
    pub adaptive: AdaptiveTimeStepIR,
}

impl Rk23Config {
    pub fn new(adaptive: AdaptiveTimeStepIR) -> Self {
        Self { adaptive }
    }

    pub fn integrator_choice() -> IntegratorChoice {
        IntegratorChoice::Rk23
    }
}

// ── RK45 (Dormand–Prince 5/4) ─────────────────────────────────────────────────

/// Dormand–Prince RK45 configuration.
///
/// 6-stage, 4th-order method with an embedded 5th-order solution for error
/// estimation.  Also FSAL.  The default choice for production FEM runs
/// requiring high accuracy or large time budgets.
///
/// Provides better error control than RK23 at the cost of more evaluations
/// per step, but the FSAL property limits the overhead.
#[derive(Debug, Clone)]
pub struct Rk45Config {
    /// Adaptive time-step parameters.
    pub adaptive: AdaptiveTimeStepIR,
}

impl Rk45Config {
    pub fn new(adaptive: AdaptiveTimeStepIR) -> Self {
        Self { adaptive }
    }

    pub fn integrator_choice() -> IntegratorChoice {
        IntegratorChoice::Rk45
    }
}

// ── Error-controller helpers ──────────────────────────────────────────────────

/// Computes the new proposed dt after a step attempt with the given error
/// estimate, using the standard PI controller formula:
///
/// ```text
/// dt_new = dt * safety * min(growth_limit, max(shrink_limit, (tol / err)^(1/(p+1))))
/// ```
///
/// where `p` is the order of the *error estimate* (lower of the two embedded
/// orders: 1 for RK23, 4 for RK45).
pub fn pi_controller_dt(
    dt_current: f64,
    error_ratio: f64, // err / tol; < 1 means accept
    order_error_estimate: u32,
    cfg: &AdaptiveTimeStepIR,
) -> Result<f64, String> {
    let exponent = 1.0 / (order_error_estimate as f64 + 1.0);
    let factor = cfg.safety * error_ratio.powf(-exponent);
    let factor = factor.clamp(cfg.shrink_limit, cfg.growth_limit);
    let dt_max = cfg
        .dt_max
        .ok_or_else(|| "adaptive timestep requires explicit dt_max".to_string())?;
    Ok((dt_current * factor).clamp(cfg.dt_min, dt_max))
}

/// Returns `true` if an error ratio ≤ 1.0 (step is accepted).
#[inline]
pub fn step_accepted(error_ratio: f64) -> bool {
    error_ratio <= 1.0
}

// ── Validation ────────────────────────────────────────────────────────────────

/// Returns `Err` if the adaptive configuration is internally inconsistent.
pub fn validate_adaptive_config(cfg: &AdaptiveTimeStepIR) -> Result<(), String> {
    if cfg.dt_min <= 0.0 {
        return Err(format!(
            "adaptive dt_min must be positive, got {:.3e}",
            cfg.dt_min
        ));
    }
    let dt_max = cfg
        .dt_max
        .ok_or_else(|| "adaptive timestep requires explicit dt_max".to_string())?;
    if dt_max <= cfg.dt_min {
        return Err(format!(
            "adaptive dt_max ({:.3e}) must exceed dt_min ({:.3e})",
            dt_max, cfg.dt_min
        ));
    }
    if cfg.atol < 0.0 || cfg.rtol < 0.0 || (cfg.atol == 0.0 && cfg.rtol == 0.0) {
        return Err(format!(
            "adaptive atol and rtol must be non-negative and not both zero, got atol={:.3e} rtol={:.3e}",
            cfg.atol, cfg.rtol
        ));
    }
    if !(0.0 < cfg.safety && cfg.safety <= 1.0) {
        return Err(format!(
            "adaptive safety factor must be in (0, 1], got {:.3}",
            cfg.safety
        ));
    }
    if cfg.shrink_limit <= 0.0 || cfg.shrink_limit > 1.0 {
        return Err(format!(
            "adaptive shrink_limit must be in (0, 1], got {:.3}",
            cfg.shrink_limit
        ));
    }
    if cfg.growth_limit < 1.0 {
        return Err(format!(
            "adaptive growth_limit must be ≥ 1, got {:.3}",
            cfg.growth_limit
        ));
    }
    Ok(())
}
