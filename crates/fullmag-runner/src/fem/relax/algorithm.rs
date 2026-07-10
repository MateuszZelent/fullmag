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
/// This table describes runner-level availability. Keep it aligned with the
/// native backend lanes: projected-gradient BB and nonlinear-CG are implemented
/// on the CPU/MFEM and native CUDA lanes. TPI currently remains a CPU/MFEM-only
/// development lane; its full GPU/libCEED implementation is not production-
/// qualified yet.
pub fn algorithm_supported(algorithm: RelaxationAlgorithmIR, engine: FemEngineKind) -> bool {
    match (algorithm, engine) {
        // LlgOverdamped is the primary production path on both engines.
        (RelaxationAlgorithmIR::LlgOverdamped, _) => true,

        // PG-BB has production native FEM ABI paths on CPU/MFEM and CUDA.
        (RelaxationAlgorithmIR::ProjectedGradientBb, FemEngineKind::CpuNative) => true,
        (RelaxationAlgorithmIR::ProjectedGradientBb, FemEngineKind::NativeGpu) => true,

        // NCG has native FEM ABI paths on CPU/MFEM and CUDA.
        (RelaxationAlgorithmIR::NonlinearCg, FemEngineKind::CpuNative) => true,
        (RelaxationAlgorithmIR::NonlinearCg, FemEngineKind::NativeGpu) => true,

        // TPI solves a global MFEM tangent-plane system on the CPU/MFEM lane,
        // but remains under development and is not part of GPU production gates.
        (RelaxationAlgorithmIR::TangentPlaneImplicit, FemEngineKind::CpuNative) => true,

        (RelaxationAlgorithmIR::TangentPlaneImplicit, FemEngineKind::NativeGpu) => false,
    }
}

/// Whether the algorithm currently requires the CPU/MFEM native relaxation lane.
pub fn requires_cpu_mfem_relaxation_lane(algorithm: RelaxationAlgorithmIR) -> bool {
    matches!(algorithm, RelaxationAlgorithmIR::TangentPlaneImplicit)
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
        let supported = match engine {
            FemEngineKind::CpuNative => {
                "llg_overdamped, projected_gradient_bb, nonlinear_cg, tangent_plane_implicit"
            }
            FemEngineKind::NativeGpu => "llg_overdamped, projected_gradient_bb, nonlinear_cg",
        };
        return Err(RunError {
            message: format!(
                "FEM relaxation algorithm `{}` is not yet supported on engine `{}`. \
                 Supported algorithms on this engine: {}. \
                 tangent_plane_implicit is available only on the CPU/MFEM development lane; \
                 its full GPU/libCEED device-resident algorithm is under development.",
                algorithm_provenance_name(control.algorithm),
                engine.id(),
                supported,
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
                max_relaxation_time_s: None,
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
        assert!(!algorithm_supported(
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
    fn projected_gradient_bb_is_native_fem_cpu_and_gpu_algorithm() {
        let pgbb = control(RelaxationAlgorithmIR::ProjectedGradientBb);
        assert!(!requires_cpu_mfem_relaxation_lane(
            RelaxationAlgorithmIR::ProjectedGradientBb
        ));
        assert!(algorithm_supported(
            RelaxationAlgorithmIR::ProjectedGradientBb,
            FemEngineKind::CpuNative
        ));
        assert!(algorithm_supported(
            RelaxationAlgorithmIR::ProjectedGradientBb,
            FemEngineKind::NativeGpu
        ));
        assert_eq!(
            native_step_control(Some(&pgbb)).map(|control| control.algorithm),
            Some(RelaxationAlgorithmIR::ProjectedGradientBb)
        );
        assert!(check_algorithm_support(Some(&pgbb), FemEngineKind::CpuNative).is_ok());
        assert!(check_algorithm_support(Some(&pgbb), FemEngineKind::NativeGpu).is_ok());
    }

    #[test]
    fn nonlinear_cg_is_native_fem_cpu_and_gpu_algorithm() {
        let ncg = control(RelaxationAlgorithmIR::NonlinearCg);
        assert!(!requires_cpu_mfem_relaxation_lane(
            RelaxationAlgorithmIR::NonlinearCg
        ));
        assert!(algorithm_supported(
            RelaxationAlgorithmIR::NonlinearCg,
            FemEngineKind::CpuNative
        ));
        assert!(algorithm_supported(
            RelaxationAlgorithmIR::NonlinearCg,
            FemEngineKind::NativeGpu
        ));
        assert_eq!(
            native_step_control(Some(&ncg)).map(|control| control.algorithm),
            Some(RelaxationAlgorithmIR::NonlinearCg)
        );
        assert!(check_algorithm_support(Some(&ncg), FemEngineKind::CpuNative).is_ok());
        assert!(check_algorithm_support(Some(&ncg), FemEngineKind::NativeGpu).is_ok());
    }

    #[test]
    fn tangent_plane_implicit_is_not_reported_as_gpu_supported() {
        let control = control(RelaxationAlgorithmIR::TangentPlaneImplicit);
        assert!(requires_cpu_mfem_relaxation_lane(
            RelaxationAlgorithmIR::TangentPlaneImplicit
        ));
        assert!(algorithm_supported(
            RelaxationAlgorithmIR::TangentPlaneImplicit,
            FemEngineKind::CpuNative
        ));
        assert!(!algorithm_supported(
            RelaxationAlgorithmIR::TangentPlaneImplicit,
            FemEngineKind::NativeGpu
        ));
        let err = check_algorithm_support(Some(&control), FemEngineKind::NativeGpu)
            .expect_err("TPI must not advertise GPU support before the global GPU solver exists");
        assert!(err.message.contains("fem_native_gpu"), "{}", err.message);
        assert!(
            err.message.contains("tangent_plane_implicit")
                && err.message.contains("GPU/libCEED")
                && err.message.contains("under development")
                && !err.message.contains("production-executable")
                && err.message.contains("CPU/MFEM"),
            "{}",
            err.message
        );
    }

    #[test]
    fn llg_overdamped_stays_on_time_integrator_path() {
        let llg = control(RelaxationAlgorithmIR::LlgOverdamped);
        assert!(native_step_control(Some(&llg)).is_none());
        assert!(check_algorithm_support(Some(&llg), FemEngineKind::CpuNative).is_ok());
        assert!(check_algorithm_support(Some(&llg), FemEngineKind::NativeGpu).is_ok());
    }
}
