//! Validate terminal host records without loading or calling a native solver.
//! These contracts also run in the default CPU-only Rust test configuration.

use fullmag_fem_sys as ffi;
use crate::types::{FemGpuBbPcgCertificateProvenance, RunError};

#[cfg(test)]
mod bb_certificate_tests {
    use super::*;

    fn certificate() -> ffi::fullmag_fem_gpu_bb_pcg_certificate_v1 {
        ffi::fullmag_fem_gpu_bb_pcg_certificate_v1 {
            abi_version: 1, struct_size: 88, available: 1,
            cooperative_launch_supported: 1, status: 1, iterations: 17,
            nonzero_rhs_mask: 5, rhs_norm_squared: [1.0, 0.0, 4.0],
            residual_norm_squared: [1e-20, 0.0, 4e-20],
            certificate_relative_tolerance: 1e-8,
            ..Default::default()
        }
    }

    #[test]
    fn bb_certificate_preserves_actual_component_norms_and_roundtrips() {
        let raw = certificate();
        let value = gpu_bb_certificate_from_ffi(raw).unwrap().unwrap();
        assert_eq!(value.solver, "cooperative_device_pcg");
        assert_eq!(value.scope, "last_completed_bb_preconditioner_solve");
        assert_eq!(value.iterations, raw.iterations);
        assert_eq!(value.rhs_norm_squared, raw.rhs_norm_squared);
        assert_eq!(value.residual_norm_squared, raw.residual_norm_squared);
        assert_eq!(value.relative_residual, [1e-10, 0.0, 1e-10]);
        let json = serde_json::to_value(&value).unwrap();
        let restored: FemGpuBbPcgCertificateProvenance = serde_json::from_value(json).unwrap();
        assert_eq!(restored, value);
        let mut tiny = raw;
        tiny.rhs_norm_squared[0] = 1e-240;
        tiny.residual_norm_squared[0] = 1e-260;
        assert!(gpu_bb_certificate_from_ffi(tiny).unwrap().is_some());
        tiny.residual_norm_squared[0] = 1e-250;
        assert!(gpu_bb_certificate_from_ffi(tiny).is_err(), "no absolute residual floor");
    }

    #[test]
    fn bb_certificate_distinguishes_absence_from_a_certified_zero_rhs() {
        let empty = ffi::fullmag_fem_gpu_bb_pcg_certificate_v1 {
            abi_version: 1, struct_size: 88, certificate_relative_tolerance: 1e-8,
            ..Default::default()
        };
        assert!(gpu_bb_certificate_from_ffi(empty).unwrap().is_none());
        let zero = ffi::fullmag_fem_gpu_bb_pcg_certificate_v1 {
            available: 1, cooperative_launch_supported: 1, status: 1, ..empty
        };
        let actual = gpu_bb_certificate_from_ffi(zero).unwrap().unwrap();
        assert_eq!(actual.relative_residual, [0.0; 3]);
        assert_eq!(actual.iterations, 0);
    }

    #[test]
    fn bb_certificate_rejects_invalid_identity_nonfinite_norms_and_failed_solves() {
        let raw = certificate();
        for bad in [
            ffi::fullmag_fem_gpu_bb_pcg_certificate_v1 { abi_version: 2, ..raw },
            ffi::fullmag_fem_gpu_bb_pcg_certificate_v1 { struct_size: 87, ..raw },
            ffi::fullmag_fem_gpu_bb_pcg_certificate_v1 { available: 2, ..raw },
            ffi::fullmag_fem_gpu_bb_pcg_certificate_v1 { reserved: 1, ..raw },
            ffi::fullmag_fem_gpu_bb_pcg_certificate_v1 { cooperative_launch_supported: 0, ..raw },
            ffi::fullmag_fem_gpu_bb_pcg_certificate_v1 { status: 2, ..raw },
            ffi::fullmag_fem_gpu_bb_pcg_certificate_v1 { iterations: 513, ..raw },
            ffi::fullmag_fem_gpu_bb_pcg_certificate_v1 { nonzero_rhs_mask: 8, ..raw },
            ffi::fullmag_fem_gpu_bb_pcg_certificate_v1 { nonzero_rhs_mask: 0, ..raw },
            ffi::fullmag_fem_gpu_bb_pcg_certificate_v1 { rhs_norm_squared: [f64::NAN, 0.0, 4.0], ..raw },
            ffi::fullmag_fem_gpu_bb_pcg_certificate_v1 { rhs_norm_squared: [0.0, 0.0, 4.0], ..raw },
            ffi::fullmag_fem_gpu_bb_pcg_certificate_v1 { residual_norm_squared: [-1.0, 0.0, 0.0], ..raw },
            ffi::fullmag_fem_gpu_bb_pcg_certificate_v1 { residual_norm_squared: [f64::INFINITY, 0.0, 0.0], ..raw },
            ffi::fullmag_fem_gpu_bb_pcg_certificate_v1 { residual_norm_squared: [0.0, 1e-30, 0.0], ..raw },
            ffi::fullmag_fem_gpu_bb_pcg_certificate_v1 { certificate_relative_tolerance: 1e-7, ..raw },
        ] {
            assert!(gpu_bb_certificate_from_ffi(bad).is_err(), "{bad:?}");
        }
    }
}

pub(crate) fn gpu_bb_certificate_from_ffi(
    info: ffi::fullmag_fem_gpu_bb_pcg_certificate_v1,
) -> Result<Option<FemGpuBbPcgCertificateProvenance>, RunError> {
    let invalid = || RunError { message: "FEM GPU BB terminal certificate is invalid".into() };
    if info.abi_version != 1
        || info.struct_size as usize != std::mem::size_of::<ffi::fullmag_fem_gpu_bb_pcg_certificate_v1>()
        || info.available > 1 || info.cooperative_launch_supported > 1 || info.reserved != 0
        || info.certificate_relative_tolerance != 1e-8
    {
        return Err(invalid());
    }
    if info.available == 0 {
        if info.status != 0 || info.iterations != 0 || info.nonzero_rhs_mask != 0
            || info.rhs_norm_squared != [0.0; 3] || info.residual_norm_squared != [0.0; 3]
        {
            return Err(invalid());
        }
        return Ok(None);
    }
    if info.cooperative_launch_supported != 1 || info.status != 1
        || info.iterations > 512 || info.nonzero_rhs_mask > 7
    {
        return Err(invalid());
    }
    let mut relative_residual = [0.0; 3];
    for (component, relative) in relative_residual.iter_mut().enumerate() {
        let rhs = info.rhs_norm_squared[component];
        let residual = info.residual_norm_squared[component];
        let nonzero = info.nonzero_rhs_mask & (1 << component) != 0;
        // Mirror the existing GPU certificate, including exact zero RHS and
        // rejection of underflowed nonzero RHS. Do not invent an absolute floor.
        if !rhs.is_finite() || !residual.is_finite() || rhs < 0.0 || residual < 0.0
            || (nonzero && rhs == 0.0) || (!nonzero && rhs != 0.0)
            || residual > info.certificate_relative_tolerance * info.certificate_relative_tolerance * rhs
        {
            return Err(invalid());
        }
        *relative = if nonzero { (residual / rhs).sqrt() } else { 0.0 };
    }
    Ok(Some(FemGpuBbPcgCertificateProvenance {
        schema_version: "fullmag.fem.gpu.bb-pcg-certificate.v1".into(),
        scope: "last_completed_bb_preconditioner_solve".into(),
        solver: "cooperative_device_pcg".into(),
        cooperative_launch_supported: true,
        status: info.status,
        iterations: info.iterations,
        nonzero_rhs_mask: info.nonzero_rhs_mask,
        rhs_norm_squared: info.rhs_norm_squared,
        residual_norm_squared: info.residual_norm_squared,
        relative_residual,
        certificate_relative_tolerance: info.certificate_relative_tolerance,
    }))
}

pub(crate) fn gpu_pcg_control_experiment_from_ffi(
    info: ffi::fullmag_fem_gpu_pcg_control_info_v1,
    requested_stride: u32,
) -> Result<crate::types::FemGpuPcgControlExperimentProvenance, RunError> {
    if info.abi_version != 1
        || info.struct_size as usize != std::mem::size_of::<ffi::fullmag_fem_gpu_pcg_control_info_v1>()
        || !matches!(requested_stride, 4 | 8)
        || info.requested_status_batch_stride != requested_stride
        || info.resolved_status_batch_stride != requested_stride
        || info.hot_loop_solve_attempts > info.solve_attempts
        || info.hot_loop_enqueued_iterations > info.enqueued_iterations
        || info.hot_loop_amg_apply_calls > info.amg_apply_calls
    {
        return Err(RunError { message: "FEM GPU PCG control experiment native identity/counters mismatch".into() });
    }
    Ok(crate::types::FemGpuPcgControlExperimentProvenance {
        schema_version: fullmag_ir::FemGpuPcgControlExperimentIR::SCHEMA_VERSION.into(),
        requested_status_batch_stride: info.requested_status_batch_stride,
        resolved_status_batch_stride: info.resolved_status_batch_stride,
        counter_scope: "raw_context_lifetime_api_submissions_including_failed_and_rejected".into(),
        solve_attempts: info.solve_attempts,
        enqueued_iterations: info.enqueued_iterations,
        amg_apply_calls: info.amg_apply_calls,
        hot_loop_solve_attempts: info.hot_loop_solve_attempts,
        hot_loop_enqueued_iterations: info.hot_loop_enqueued_iterations,
        hot_loop_amg_apply_calls: info.hot_loop_amg_apply_calls,
    })
}

#[cfg(test)]
mod pcg_control_experiment_tests {
    use super::*;

    fn info() -> ffi::fullmag_fem_gpu_pcg_control_info_v1 {
        ffi::fullmag_fem_gpu_pcg_control_info_v1 {
            abi_version: 1, struct_size: 64,
            requested_status_batch_stride: 4, resolved_status_batch_stride: 4,
            solve_attempts: 3, enqueued_iterations: 24, amg_apply_calls: 29,
            hot_loop_solve_attempts: 2, hot_loop_enqueued_iterations: 16, hot_loop_amg_apply_calls: 20,
        }
    }

    #[test]
    fn pcg_control_terminal_provenance_preserves_raw_scope_and_legacy_absence() {
        let actual = gpu_pcg_control_experiment_from_ffi(info(), 4).unwrap();
        assert_eq!(actual.amg_apply_calls, 29);
        assert_eq!(actual.hot_loop_amg_apply_calls, 20);
        assert!(actual.counter_scope.contains("including_failed_and_rejected"));
        let raw = serde_json::to_value(&actual).unwrap();
        let restored: crate::types::FemGpuPcgControlExperimentProvenance = serde_json::from_value(raw).unwrap();
        assert_eq!(actual, restored);
        let legacy = serde_json::to_value(crate::types::ExecutionProvenance::default()).unwrap();
        assert!(legacy.get("fem_gpu_pcg_control_experiment").is_none());
        let restored: crate::types::ExecutionProvenance = serde_json::from_value(legacy).unwrap();
        assert!(restored.fem_gpu_pcg_control_experiment.is_none());
    }

    #[test]
    fn pcg_control_terminal_rejects_native_identity_and_counter_mismatch() {
        for invalid in [
            ffi::fullmag_fem_gpu_pcg_control_info_v1 { abi_version: 2, ..info() },
            ffi::fullmag_fem_gpu_pcg_control_info_v1 { struct_size: 63, ..info() },
            ffi::fullmag_fem_gpu_pcg_control_info_v1 { requested_status_batch_stride: 0, ..info() },
            ffi::fullmag_fem_gpu_pcg_control_info_v1 { resolved_status_batch_stride: 8, ..info() },
            ffi::fullmag_fem_gpu_pcg_control_info_v1 { hot_loop_solve_attempts: 4, ..info() },
            ffi::fullmag_fem_gpu_pcg_control_info_v1 { hot_loop_enqueued_iterations: 25, ..info() },
            ffi::fullmag_fem_gpu_pcg_control_info_v1 { hot_loop_amg_apply_calls: 30, ..info() },
        ] {
            assert!(gpu_pcg_control_experiment_from_ffi(invalid, 4).is_err());
        }
        assert!(gpu_pcg_control_experiment_from_ffi(info(), 5).is_err());
    }
}
