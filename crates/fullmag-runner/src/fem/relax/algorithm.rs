//! Algorithm support matrix and validation for FEM relaxation.
//!
//! Each `RelaxationAlgorithmIR` variant has different support characteristics
//! across FEM backends.  This module centralises the support table so that
//! the rest of the codebase has one place to check and update.

use fullmag_ir::{RelaxationAlgorithmIR, RelaxationControlIR};

use crate::types::RunError;

use super::super::engine::FemEngineKind;

// ── Support table ─────────────────────────────────────────────────────────────

/// Whether a given algorithm is executable on a given FEM engine.
///
/// This table describes runner-level availability. Native backend lane
/// restrictions, such as CPU/MFEM-only direct minimizers, are reported by the
/// backend when the ABI step is executed.
pub fn algorithm_supported(algorithm: RelaxationAlgorithmIR, engine: FemEngineKind) -> bool {
    match (algorithm, engine) {
        // LlgOverdamped is the primary production path on both engines.
        (RelaxationAlgorithmIR::LlgOverdamped, _) => true,

        // Direct minimizers are native FEM ABI paths. The current native
        // implementation accepts CPU/MFEM contexts and rejects GPU-resident
        // minimization explicitly at the backend boundary.
        (RelaxationAlgorithmIR::ProjectedGradientBb, _) => true,
        (RelaxationAlgorithmIR::NonlinearCg, _) => true,

        (RelaxationAlgorithmIR::TangentPlaneImplicit, _) => true,
    }
}

/// Whether the algorithm uses the direct energy-minimization code path
/// (Barzilai–Borwein or Nonlinear CG) rather than LLG time-stepping.
pub fn is_direct_minimizer(algorithm: RelaxationAlgorithmIR) -> bool {
    matches!(
        algorithm,
        RelaxationAlgorithmIR::ProjectedGradientBb | RelaxationAlgorithmIR::NonlinearCg
    )
}

/// Returns the relaxation control for native FEM algorithms that advance
/// through `fullmag_fem_backend_relax_step`.
pub(crate) fn native_step_control(
    relaxation: Option<&RelaxationControlIR>,
) -> Option<&RelaxationControlIR> {
    let control = relaxation?;
    match control.algorithm {
        RelaxationAlgorithmIR::ProjectedGradientBb
        | RelaxationAlgorithmIR::NonlinearCg
        | RelaxationAlgorithmIR::TangentPlaneImplicit => Some(control),
        RelaxationAlgorithmIR::LlgOverdamped => None,
    }
}

/// Whether this algorithm runs the LLG RHS with the precession term disabled
/// (pure damping).
pub fn is_pure_damping(algorithm: RelaxationAlgorithmIR) -> bool {
    matches!(algorithm, RelaxationAlgorithmIR::LlgOverdamped)
}

/// Canonical provenance name for each algorithm, as stored in run artifacts.
pub fn algorithm_provenance_name(algorithm: RelaxationAlgorithmIR) -> &'static str {
    match algorithm {
        RelaxationAlgorithmIR::LlgOverdamped => "llg_overdamped",
        RelaxationAlgorithmIR::ProjectedGradientBb => "projected_gradient_bb",
        RelaxationAlgorithmIR::NonlinearCg => "nonlinear_cg",
        RelaxationAlgorithmIR::TangentPlaneImplicit => "tangent_plane_implicit",
    }
}

/// Short human-readable description of the algorithm for log messages.
pub fn algorithm_description(algorithm: RelaxationAlgorithmIR) -> &'static str {
    match algorithm {
        RelaxationAlgorithmIR::LlgOverdamped => {
            "overdamped LLG time-stepping (precession disabled)"
        }
        RelaxationAlgorithmIR::ProjectedGradientBb => {
            "projected gradient with Barzilai–Borwein step (sphere manifold)"
        }
        RelaxationAlgorithmIR::NonlinearCg => {
            "nonlinear conjugate gradient Polak–Ribière+ with backtracking line search"
        }
        RelaxationAlgorithmIR::TangentPlaneImplicit => {
            "tangent-plane implicit method on the FEM tangent space"
        }
    }
}

// ── Validation ────────────────────────────────────────────────────────────────

/// Returns `Err` if the algorithm in `control` is not supported on `engine`.
///
/// Call this before delegating to the backend to get a clear user-facing error
/// rather than a cryptic ABI failure.
pub fn check_algorithm_support(
    control: Option<&RelaxationControlIR>,
    engine: FemEngineKind,
) -> Result<(), RunError> {
    let Some(control) = control else {
        // No relaxation control means this is a time-evolution stage — always OK.
        return Ok(());
    };

    if !algorithm_supported(control.algorithm, engine) {
        return Err(RunError {
            message: format!(
                "FEM relaxation algorithm `{}` is not yet supported on engine `{}`. \
                 Supported algorithms: llg_overdamped, projected_gradient_bb, nonlinear_cg, tangent_plane_implicit.",
                algorithm_provenance_name(control.algorithm),
                engine.id(),
            ),
        });
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::RelaxStopIR;

    fn control(algorithm: RelaxationAlgorithmIR) -> RelaxationControlIR {
        RelaxationControlIR {
            algorithm,
            stop: RelaxStopIR {
                torque_tolerance_apm: None,
                energy_tolerance_j: None,
                max_steps: Some(3),
                max_pseudotime_s: None,
                max_physical_time_s: None,
            },
        }
    }

    #[test]
    fn tangent_plane_implicit_is_native_fem_step_algorithm() {
        let tpi = control(RelaxationAlgorithmIR::TangentPlaneImplicit);
        assert!(algorithm_supported(
            RelaxationAlgorithmIR::TangentPlaneImplicit,
            FemEngineKind::CpuNative
        ));
        assert!(algorithm_supported(
            RelaxationAlgorithmIR::TangentPlaneImplicit,
            FemEngineKind::NativeGpu
        ));
        assert_eq!(
            native_step_control(Some(&tpi)).map(|control| control.algorithm),
            Some(RelaxationAlgorithmIR::TangentPlaneImplicit)
        );
        assert!(check_algorithm_support(Some(&tpi), FemEngineKind::CpuNative).is_ok());
    }

    #[test]
    fn llg_overdamped_stays_on_time_integrator_path() {
        let llg = control(RelaxationAlgorithmIR::LlgOverdamped);
        assert!(native_step_control(Some(&llg)).is_none());
        assert!(check_algorithm_support(Some(&llg), FemEngineKind::CpuNative).is_ok());
    }
}
