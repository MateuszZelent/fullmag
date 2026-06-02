//! FEM integrator selection and configuration.
//!
//! Maps `IntegratorChoice` IR values to the concrete configurations that the
//! native C ABI and the Rust reference backend understand.

pub mod adaptive;
pub mod fixed;

use fullmag_ir::{AdaptiveTimeStepIR, IntegratorChoice};

// ── Integrator families ───────────────────────────────────────────────────────

/// Broad classification of an integrator — used to decide which code-path to
/// invoke at the backend boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IntegratorFamily {
    /// Fixed time-step explicit methods (Heun, RK4).
    Fixed,
    /// Embedded adaptive explicit methods (RK23-BS, RK45-DP54).
    Adaptive,
    /// Linear multistep (ABM3). Not yet available on the GPU native path.
    Multistep,
}

impl IntegratorFamily {
    pub fn of(choice: IntegratorChoice) -> Self {
        match choice {
            IntegratorChoice::Heun | IntegratorChoice::Rk4 => IntegratorFamily::Fixed,
            IntegratorChoice::Rk23 | IntegratorChoice::Rk45 => IntegratorFamily::Adaptive,
            IntegratorChoice::Abm3 => IntegratorFamily::Multistep,
        }
    }
}

// ── Integration order (accuracy) ─────────────────────────────────────────────

/// Nominal convergence order of each integrator (global error ≈ O(dt^order)).
pub fn integration_order(choice: IntegratorChoice) -> u32 {
    match choice {
        IntegratorChoice::Heun => 2,
        IntegratorChoice::Rk4 => 4,
        IntegratorChoice::Rk23 => 2, // embedded 2/3 — error is O(dt²)
        IntegratorChoice::Rk45 => 4, // embedded 4/5 — error is O(dt⁴)
        IntegratorChoice::Abm3 => 3,
    }
}

// ── FSAL property ─────────────────────────────────────────────────────────────

/// Whether the integrator can reuse the last stage evaluation of step k as the
/// first stage of step k+1 (First-Same-As-Last).
///
/// Only RK23 (Bogacki–Shampine) and RK45 (Dormand–Prince) are FSAL.
pub fn is_fsal(choice: IntegratorChoice) -> bool {
    matches!(choice, IntegratorChoice::Rk23 | IntegratorChoice::Rk45)
}

// ── ABI integrator code ───────────────────────────────────────────────────────

/// Maps `IntegratorChoice` to the integer constant used in the native C ABI
/// (`fullmag_fem.h`, `fullmag_fem_integrator` enum).
///
/// ```text
/// FULLMAG_FEM_INTEGRATOR_HEUN      = 1
/// FULLMAG_FEM_INTEGRATOR_RK4       = 2
/// FULLMAG_FEM_INTEGRATOR_RK23_BS   = 3
/// FULLMAG_FEM_INTEGRATOR_RK45_DP54 = 4
/// ```
pub fn abi_integrator_code(choice: IntegratorChoice) -> i32 {
    match choice {
        IntegratorChoice::Heun => 1,
        IntegratorChoice::Rk4 => 2,
        IntegratorChoice::Rk23 => 3,
        IntegratorChoice::Rk45 => 4,
        IntegratorChoice::Abm3 => {
            // ABM3 is not in the native ABI yet; callers should check
            // `IntegratorFamily::of(choice)` and route to the reference path.
            panic!("ABM3 is not supported on the native FEM GPU backend");
        }
    }
}

/// Human-readable provenance label for an integrator (matches canonical Python
/// DSL names and `IntegratorChoice` serde representations).
pub fn integrator_label(choice: IntegratorChoice) -> &'static str {
    match choice {
        IntegratorChoice::Heun => "heun",
        IntegratorChoice::Rk4 => "rk4",
        IntegratorChoice::Rk23 => "rk23",
        IntegratorChoice::Rk45 => "rk45",
        IntegratorChoice::Abm3 => "abm3",
    }
}

// ── Default adaptive configuration ───────────────────────────────────────────

/// Returns default adaptive time-step parameters for a given integrator when
/// the user has not specified them.
///
/// Values are conservative and suitable for LLG relaxation in the range
/// α ∈ [0.05, 1.0].  Production scripts should supply explicit values.
pub fn default_adaptive_config(choice: IntegratorChoice) -> AdaptiveTimeStepIR {
    let (atol, rtol) = match choice {
        IntegratorChoice::Rk23 => (1e-5, 1e-4),
        IntegratorChoice::Rk45 => (1e-6, 1e-5),
        _ => (1e-5, 1e-4),
    };
    AdaptiveTimeStepIR {
        atol,
        rtol,
        dt_initial: Some(crate::DEFAULT_ADAPTIVE_DT_INITIAL),
        dt_min: 1e-16,
        dt_max: Some(crate::DEFAULT_ADAPTIVE_DT_MAX),
        safety: 0.9,
        growth_limit: 5.0,
        shrink_limit: 0.1,
        max_spin_rotation: None,
        norm_tolerance: None,
    }
}
