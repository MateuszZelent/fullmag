//! Fixed time-step integrators for FEM: Heun and RK4.
//!
//! Both methods are explicit single-step methods with a fixed `dt` chosen by
//! the user (or a default heuristic).  They require no per-step error
//! estimation and no dt-rejection logic.

use fullmag_ir::IntegratorChoice;

// ── Heun (2nd order explicit) ─────────────────────────────────────────────────

/// Heun's method configuration.
///
/// Heun is a predictor–corrector (RK2) method.  It needs 2 RHS evaluations
/// per step and achieves 2nd-order accuracy.  Recommended for low-cost
/// exploratory runs or when `dt` is already well-calibrated.
#[derive(Debug, Clone)]
pub struct HeunConfig {
    /// Fixed time step in seconds.
    pub dt: f64,
}

impl HeunConfig {
    pub fn new(dt: f64) -> Self {
        assert!(dt > 0.0, "HeunConfig: dt must be positive");
        Self { dt }
    }

    /// Conservative default dt for Permalloy-like parameters
    /// (γ ≈ 2.21e5 m/A·s, α ≈ 0.5, Ms ≈ 8.6e5 A/m).
    pub fn default_dt() -> f64 {
        1e-13
    }

    pub fn integrator_choice() -> IntegratorChoice {
        IntegratorChoice::Heun
    }
}

// ── RK4 (4th order explicit) ──────────────────────────────────────────────────

/// Classical 4-stage, 4th-order Runge–Kutta configuration.
///
/// RK4 requires 4 RHS evaluations per step and achieves 4th-order accuracy.
/// Use when high accuracy per step is needed and the time step is small enough
/// that the cost of 4 evaluations is acceptable.
#[derive(Debug, Clone)]
pub struct Rk4Config {
    /// Fixed time step in seconds.
    pub dt: f64,
}

impl Rk4Config {
    pub fn new(dt: f64) -> Self {
        assert!(dt > 0.0, "Rk4Config: dt must be positive");
        Self { dt }
    }

    /// Conservative default dt — same as Heun since step cost is higher.
    pub fn default_dt() -> f64 {
        1e-13
    }

    pub fn integrator_choice() -> IntegratorChoice {
        IntegratorChoice::Rk4
    }
}

// ── Validation ────────────────────────────────────────────────────────────────

/// Returns `Err` if the requested fixed dt is outside the physically
/// meaningful range for LLG micromagnetics.
///
/// * `dt < 1e-16 s` → below numerical noise for double precision
/// * `dt > 1e-9 s` → almost certainly too large for LLG; warn, don't reject
pub fn validate_fixed_dt(dt: f64, integrator: IntegratorChoice) -> Result<(), String> {
    if dt <= 0.0 {
        return Err(format!(
            "{:?}: fixed dt must be positive, got {}",
            integrator, dt
        ));
    }
    if dt < 1e-16 {
        return Err(format!(
            "{:?}: fixed dt {:.3e} s is below 1e-16 s (likely a units error)",
            integrator, dt
        ));
    }
    Ok(())
}
