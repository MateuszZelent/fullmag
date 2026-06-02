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
/// Does **not** distinguish "production quality" from "bootstrap/wrapper" —
/// see documentation on each algorithm for quality notes.
pub fn algorithm_supported(algorithm: RelaxationAlgorithmIR, engine: FemEngineKind) -> bool {
    match (algorithm, engine) {
        // LlgOverdamped is the primary production path on both engines.
        (RelaxationAlgorithmIR::LlgOverdamped, _) => true,

        // Bootstrap wrappers: run on the CPU SoA reference kernel regardless
        // of the requested engine, so they are technically callable on both
        // FEM lanes but are not FEM-native.
        (RelaxationAlgorithmIR::ProjectedGradientBb, _) => true,
        (RelaxationAlgorithmIR::NonlinearCg, _) => true,

        // TangentPlaneImplicit: not yet implemented — blocked pending the
        // FEM tangent-space infrastructure (FEM-TPI milestone).
        (RelaxationAlgorithmIR::TangentPlaneImplicit, _) => false,
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
            "tangent-plane implicit method (FEM-TPI — not yet implemented)"
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
                 Supported algorithms: llg_overdamped, projected_gradient_bb, nonlinear_cg.",
                algorithm_provenance_name(control.algorithm),
                engine.id(),
            ),
        });
    }

    Ok(())
}
