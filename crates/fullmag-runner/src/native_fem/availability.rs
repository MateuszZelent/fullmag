#[cfg(feature = "fem-gpu")]
use fullmag_fem_sys as ffi;

#[cfg(feature = "fem-gpu")]
use std::ffi::CStr;

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub(crate) struct GpuAvailability {
    pub available: bool,
    pub available_any: bool,
    pub available_cpu: bool,
    pub available_gpu: bool,
    pub built_with_mfem_stack: bool,
    pub built_with_cuda_runtime: bool,
    pub built_with_ceed: bool,
    pub native_fem_cpu_available: bool,
    pub native_fem_gpu_available: bool,
    pub native_fem_gpu_full_demag_available: bool,
    pub mfem_cuda_available: bool,
    pub hypre_gpu_available: bool,
    pub libceed_used_hot_path: bool,
    pub visible_cuda_device_count: i32,
    pub requested_gpu_index: i32,
    pub resolved_gpu_index: i32,
    pub memory_free_bytes: u64,
    pub memory_total_bytes: u64,
    pub reason: String,
    pub reason_cpu: String,
    pub reason_gpu: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FrequencyDomainStudyKind {
    FrequencyResponse,
    Eigenmodes,
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub(crate) struct FrequencyDomainAvailabilityRequest {
    pub study_kind: FrequencyDomainStudyKind,
    pub requires_driven_solver: bool,
    pub requires_modal_solver: bool,
    pub requires_static_periodic_boundary: bool,
    pub requires_floquet_boundary: bool,
    pub requires_nonzero_k_dynamic_demag: bool,
    pub requires_gpu: bool,
    pub strict_device: bool,
    pub floquet_k_vector_rad_per_m: Option<[f64; 3]>,
    pub phase_convention: FrequencyDomainPhaseConvention,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FrequencyDomainPhaseConvention {
    ExpIOmegaT,
    ExpMinusIOmegaT,
}

const FLOQUET_ZERO_K_TOLERANCE_RAD_PER_M: f64 = 1.0e-12;

#[allow(dead_code)]
fn floquet_k_vector_is_nonzero_or_invalid(k_vector: [f64; 3]) -> bool {
    k_vector.iter().any(|component| {
        !component.is_finite() || component.abs() > FLOQUET_ZERO_K_TOLERANCE_RAD_PER_M
    })
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub(crate) struct FrequencyDomainAvailability {
    pub status: String,
    pub study_kind: String,
    pub driven_response_available: bool,
    pub modal_solver_available: bool,
    pub static_periodic_response_available: bool,
    pub floquet_modal_available: bool,
    pub floquet_response_available: bool,
    pub dynamic_demag_k_available: bool,
    pub gpu_available: bool,
    pub reason: String,
    pub diagnostics_json: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub(crate) struct FrequencyDomainSweepProgress {
    pub total_frequency_points: u64,
    pub completed_frequency_points: u64,
    pub written_frequency_point_artifacts: u64,
    pub current_frequency_hz: f64,
    pub partial_artifacts_available: bool,
    pub latest_artifact_manifest_path: String,
    pub progress_json: String,
}

impl FrequencyDomainSweepProgress {
    fn progress_json(
        state: &str,
        status: Option<&str>,
        complete: Option<bool>,
        total_frequency_points: u64,
        completed_frequency_points: u64,
        written_frequency_point_artifacts: u64,
        current_frequency_hz: f64,
        partial_artifacts_available: bool,
        latest_artifact_manifest_path: &str,
    ) -> String {
        let mut value = serde_json::json!({
            "schema_version": "frequency_domain_sweep_progress.v1",
            "state": state,
            "total_frequency_points": total_frequency_points,
            "completed_frequency_points": completed_frequency_points,
            "written_frequency_point_artifacts": written_frequency_point_artifacts,
            "current_frequency_hz": current_frequency_hz,
            "partial_artifacts_available": partial_artifacts_available,
            "latest_artifact_manifest_path": latest_artifact_manifest_path,
        });
        let object = value
            .as_object_mut()
            .expect("progress checkpoint should be a JSON object");
        if let Some(status) = status {
            object.insert("status".to_string(), serde_json::json!(status));
        }
        if let Some(complete) = complete {
            object.insert("complete".to_string(), serde_json::json!(complete));
        }
        value.to_string()
    }

    #[allow(dead_code)]
    pub(crate) fn not_started(total_frequency_points: u64) -> Self {
        #[cfg(feature = "fem-gpu")]
        {
            let mut progress = empty_ffi_sweep_progress();
            let rc = unsafe {
                ffi::fullmag_fem_frequency_domain_initial_sweep_progress(
                    total_frequency_points,
                    &mut progress,
                )
            };
            if rc == ffi::FULLMAG_FEM_OK {
                return Self::from_ffi(progress);
            }
        }

        Self::not_started_fallback(total_frequency_points)
    }

    #[allow(dead_code)]
    pub(crate) fn interrupted(
        total_frequency_points: u64,
        completed_frequency_points: u64,
        written_frequency_point_artifacts: u64,
        current_frequency_hz: f64,
        latest_artifact_manifest_path: &str,
    ) -> Self {
        #[cfg(feature = "fem-gpu")]
        {
            let mut progress = empty_ffi_sweep_progress();
            let manifest_path = std::ffi::CString::new(latest_artifact_manifest_path)
                .unwrap_or_else(|_| std::ffi::CString::new("").expect("empty CString is valid"));
            let rc = unsafe {
                ffi::fullmag_fem_frequency_domain_interrupted_sweep_progress(
                    total_frequency_points,
                    completed_frequency_points,
                    written_frequency_point_artifacts,
                    current_frequency_hz,
                    manifest_path.as_ptr(),
                    &mut progress,
                )
            };
            if rc == ffi::FULLMAG_FEM_OK {
                return Self::from_ffi(progress);
            }
        }

        let partial_artifacts_available =
            completed_frequency_points > 0 || written_frequency_point_artifacts > 0;
        Self {
            total_frequency_points,
            completed_frequency_points,
            written_frequency_point_artifacts,
            current_frequency_hz,
            partial_artifacts_available,
            latest_artifact_manifest_path: latest_artifact_manifest_path.to_string(),
            progress_json: Self::progress_json(
                "interrupted",
                Some("interrupted"),
                Some(false),
                total_frequency_points,
                completed_frequency_points,
                written_frequency_point_artifacts,
                current_frequency_hz,
                partial_artifacts_available,
                latest_artifact_manifest_path,
            ),
        }
    }

    #[allow(dead_code)]
    pub(crate) fn cancelling(
        total_frequency_points: u64,
        completed_frequency_points: u64,
        written_frequency_point_artifacts: u64,
        current_frequency_hz: f64,
        latest_artifact_manifest_path: &str,
    ) -> Self {
        #[cfg(feature = "fem-gpu")]
        {
            let mut progress = empty_ffi_sweep_progress();
            let manifest_path = std::ffi::CString::new(latest_artifact_manifest_path)
                .unwrap_or_else(|_| std::ffi::CString::new("").expect("empty CString is valid"));
            let rc = unsafe {
                ffi::fullmag_fem_frequency_domain_cancelling_sweep_progress(
                    total_frequency_points,
                    completed_frequency_points,
                    written_frequency_point_artifacts,
                    current_frequency_hz,
                    manifest_path.as_ptr(),
                    &mut progress,
                )
            };
            if rc == ffi::FULLMAG_FEM_OK {
                return Self::from_ffi(progress);
            }
        }

        let partial_artifacts_available =
            completed_frequency_points > 0 || written_frequency_point_artifacts > 0;
        Self {
            total_frequency_points,
            completed_frequency_points,
            written_frequency_point_artifacts,
            current_frequency_hz,
            partial_artifacts_available,
            latest_artifact_manifest_path: latest_artifact_manifest_path.to_string(),
            progress_json: Self::progress_json(
                "cancel_requested",
                Some("cancel_requested"),
                Some(false),
                total_frequency_points,
                completed_frequency_points,
                written_frequency_point_artifacts,
                current_frequency_hz,
                partial_artifacts_available,
                latest_artifact_manifest_path,
            ),
        }
    }

    pub(crate) fn completed(
        total_frequency_points: u64,
        completed_frequency_points: u64,
        written_frequency_point_artifacts: u64,
        current_frequency_hz: f64,
        latest_artifact_manifest_path: &str,
    ) -> Self {
        #[cfg(feature = "fem-gpu")]
        {
            let mut progress = empty_ffi_sweep_progress();
            let manifest_path = std::ffi::CString::new(latest_artifact_manifest_path)
                .unwrap_or_else(|_| std::ffi::CString::new("").expect("empty CString is valid"));
            let rc = unsafe {
                ffi::fullmag_fem_frequency_domain_completed_sweep_progress(
                    total_frequency_points,
                    completed_frequency_points,
                    written_frequency_point_artifacts,
                    current_frequency_hz,
                    manifest_path.as_ptr(),
                    &mut progress,
                )
            };
            if rc == ffi::FULLMAG_FEM_OK {
                return Self::from_ffi(progress);
            }
        }

        let partial_artifacts_available =
            completed_frequency_points > 0 || written_frequency_point_artifacts > 0;
        Self {
            total_frequency_points,
            completed_frequency_points,
            written_frequency_point_artifacts,
            current_frequency_hz,
            partial_artifacts_available,
            latest_artifact_manifest_path: latest_artifact_manifest_path.to_string(),
            progress_json: Self::progress_json(
                "completed",
                Some("ready"),
                Some(true),
                total_frequency_points,
                completed_frequency_points,
                written_frequency_point_artifacts,
                current_frequency_hz,
                partial_artifacts_available,
                latest_artifact_manifest_path,
            ),
        }
    }

    fn not_started_fallback(total_frequency_points: u64) -> Self {
        Self {
            total_frequency_points,
            completed_frequency_points: 0,
            written_frequency_point_artifacts: 0,
            current_frequency_hz: 0.0,
            partial_artifacts_available: false,
            latest_artifact_manifest_path: String::new(),
            progress_json: Self::progress_json(
                "not_started",
                None,
                None,
                total_frequency_points,
                0,
                0,
                0.0,
                false,
                "",
            ),
        }
    }

    #[cfg(feature = "fem-gpu")]
    fn from_ffi(progress: ffi::fullmag_fem_frequency_domain_sweep_progress) -> Self {
        Self {
            total_frequency_points: progress.total_frequency_points,
            completed_frequency_points: progress.completed_frequency_points,
            written_frequency_point_artifacts: progress.written_frequency_point_artifacts,
            current_frequency_hz: progress.current_frequency_hz,
            partial_artifacts_available: progress.partial_artifacts_available == 1,
            latest_artifact_manifest_path: c_char_array_to_string(
                &progress.latest_artifact_manifest_path,
            ),
            progress_json: c_char_array_to_string(&progress.progress_json),
        }
    }
}

#[cfg(feature = "fem-gpu")]
fn empty_ffi_sweep_progress() -> ffi::fullmag_fem_frequency_domain_sweep_progress {
    ffi::fullmag_fem_frequency_domain_sweep_progress {
        total_frequency_points: 0,
        completed_frequency_points: 0,
        written_frequency_point_artifacts: 0,
        current_frequency_hz: 0.0,
        partial_artifacts_available: 0,
        latest_artifact_manifest_path: [0; 256],
        progress_json: [0; 512],
    }
}

pub(crate) fn is_gpu_available() -> bool {
    native_availability().native_fem_gpu_available
}

pub(crate) fn is_cpu_available() -> bool {
    native_availability().native_fem_cpu_available
}

pub(crate) fn native_availability() -> GpuAvailability {
    #[cfg(feature = "fem-gpu")]
    {
        let mut info = ffi::fullmag_fem_availability_info {
            available: 0,
            built_with_mfem_stack: 0,
            built_with_cuda_runtime: 0,
            built_with_ceed: 0,
            native_fem_cpu_available: 0,
            native_fem_gpu_available: 0,
            native_fem_gpu_full_demag_available: 0,
            mfem_cuda_available: 0,
            hypre_gpu_available: 0,
            libceed_used_hot_path: 0,
            visible_cuda_device_count: 0,
            requested_gpu_index: -1,
            resolved_gpu_index: -1,
            gpu_memory_free_bytes: 0,
            gpu_memory_total_bytes: 0,
            reason: [0; 256],
            available_any: 0,
            available_cpu: 0,
            available_gpu: 0,
            reason_cpu: [0; 256],
            reason_gpu: [0; 256],
        };
        let rc = unsafe { ffi::fullmag_fem_get_availability_info(&mut info) };
        if rc != ffi::FULLMAG_FEM_OK {
            return GpuAvailability {
                available: false,
                available_any: false,
                available_cpu: false,
                available_gpu: false,
                built_with_mfem_stack: false,
                built_with_cuda_runtime: false,
                built_with_ceed: false,
                native_fem_cpu_available: false,
                native_fem_gpu_available: false,
                native_fem_gpu_full_demag_available: false,
                mfem_cuda_available: false,
                hypre_gpu_available: false,
                libceed_used_hot_path: false,
                visible_cuda_device_count: 0,
                requested_gpu_index: -1,
                resolved_gpu_index: -1,
                memory_free_bytes: 0,
                memory_total_bytes: 0,
                reason: last_global_error_or(
                    "fullmag_fem_get_availability_info failed without an error message",
                ),
                reason_cpu: String::new(),
                reason_gpu: String::new(),
            };
        }

        let reason = unsafe { CStr::from_ptr(info.reason.as_ptr()) }
            .to_string_lossy()
            .to_string();
        let reason_cpu = unsafe { CStr::from_ptr(info.reason_cpu.as_ptr()) }
            .to_string_lossy()
            .to_string();
        let reason_gpu = unsafe { CStr::from_ptr(info.reason_gpu.as_ptr()) }
            .to_string_lossy()
            .to_string();

        GpuAvailability {
            available: info.available == 1,
            available_any: info.available_any == 1,
            available_cpu: info.available_cpu == 1,
            available_gpu: info.available_gpu == 1,
            built_with_mfem_stack: info.built_with_mfem_stack == 1,
            built_with_cuda_runtime: info.built_with_cuda_runtime == 1,
            built_with_ceed: info.built_with_ceed == 1,
            native_fem_cpu_available: info.native_fem_cpu_available == 1,
            native_fem_gpu_available: info.native_fem_gpu_available == 1,
            native_fem_gpu_full_demag_available: info.native_fem_gpu_full_demag_available == 1,
            mfem_cuda_available: info.mfem_cuda_available == 1,
            hypre_gpu_available: info.hypre_gpu_available == 1,
            libceed_used_hot_path: info.libceed_used_hot_path == 1,
            visible_cuda_device_count: info.visible_cuda_device_count,
            requested_gpu_index: info.requested_gpu_index,
            resolved_gpu_index: info.resolved_gpu_index,
            memory_free_bytes: info.gpu_memory_free_bytes,
            memory_total_bytes: info.gpu_memory_total_bytes,
            reason,
            reason_cpu,
            reason_gpu,
        }
    }
    #[cfg(not(feature = "fem-gpu"))]
    {
        GpuAvailability {
            available: false,
            available_any: false,
            available_cpu: false,
            available_gpu: false,
            built_with_mfem_stack: false,
            built_with_cuda_runtime: false,
            built_with_ceed: false,
            native_fem_cpu_available: false,
            native_fem_gpu_available: false,
            native_fem_gpu_full_demag_available: false,
            mfem_cuda_available: false,
            hypre_gpu_available: false,
            libceed_used_hot_path: false,
            visible_cuda_device_count: 0,
            requested_gpu_index: -1,
            resolved_gpu_index: -1,
            memory_free_bytes: 0,
            memory_total_bytes: 0,
            reason: "fullmag-runner was built without the fem-gpu feature".to_string(),
            reason_cpu: "fullmag-runner was built without the fem-gpu feature".to_string(),
            reason_gpu: "fullmag-runner was built without the fem-gpu feature".to_string(),
        }
    }
}

#[allow(dead_code)]
pub(crate) fn native_frequency_domain_availability(
    request: FrequencyDomainAvailabilityRequest,
) -> FrequencyDomainAvailability {
    #[cfg(not(feature = "fem-gpu"))]
    {
        if matches!(
            request.study_kind,
            FrequencyDomainStudyKind::FrequencyResponse
        ) && request
            .floquet_k_vector_rad_per_m
            .is_some_and(floquet_k_vector_is_nonzero_or_invalid)
        {
            return frequency_domain_response_floquet_unavailable();
        }
    }

    #[cfg(feature = "fem-gpu")]
    {
        let ffi_request = ffi::fullmag_fem_frequency_domain_availability_request {
            study_kind: match request.study_kind {
                FrequencyDomainStudyKind::FrequencyResponse => {
                    ffi::fullmag_fem_frequency_domain_study_kind::FULLMAG_FEM_FREQUENCY_DOMAIN_STUDY_RESPONSE
                }
                FrequencyDomainStudyKind::Eigenmodes => {
                    ffi::fullmag_fem_frequency_domain_study_kind::FULLMAG_FEM_FREQUENCY_DOMAIN_STUDY_EIGENMODES
                }
            },
            requires_driven_solver: request.requires_driven_solver as i32,
            requires_modal_solver: request.requires_modal_solver as i32,
            requires_static_periodic_boundary: request.requires_static_periodic_boundary as i32,
            requires_floquet_boundary: request.requires_floquet_boundary as i32,
            requires_nonzero_k_dynamic_demag: request.requires_nonzero_k_dynamic_demag as i32,
            requires_gpu: request.requires_gpu as i32,
            strict_device: request.strict_device as i32,
            has_floquet_k_vector: request.floquet_k_vector_rad_per_m.is_some() as i32,
            floquet_k_vector_rad_per_m: request.floquet_k_vector_rad_per_m.unwrap_or([0.0; 3]),
            phase_convention: map_phase_convention(request.phase_convention),
        };
        let mut info = ffi::fullmag_fem_frequency_domain_availability_info {
            status:
                ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OK,
            driven_response_available: 0,
            modal_solver_available: 0,
            static_periodic_response_available: 0,
            floquet_modal_available: 0,
            floquet_response_available: 0,
            dynamic_demag_k_available: 0,
            gpu_available: 0,
            status_name: [0; 64],
            study_kind_name: [0; 64],
            reason: [0; 256],
            diagnostics_json: [0; 512],
        };
        let rc = unsafe {
            ffi::fullmag_fem_get_frequency_domain_availability_info(&ffi_request, &mut info)
        };
        if rc != ffi::FULLMAG_FEM_OK {
            return frequency_domain_unavailable(
                study_kind_label(request.study_kind),
                last_global_error_or(
                    "fullmag_fem_get_frequency_domain_availability_info failed without an error message",
                ),
            );
        }

        FrequencyDomainAvailability {
            status: c_char_array_to_string(&info.status_name),
            study_kind: c_char_array_to_string(&info.study_kind_name),
            driven_response_available: info.driven_response_available == 1,
            modal_solver_available: info.modal_solver_available == 1,
            static_periodic_response_available: info.static_periodic_response_available == 1,
            floquet_modal_available: info.floquet_modal_available == 1,
            floquet_response_available: info.floquet_response_available == 1,
            dynamic_demag_k_available: info.dynamic_demag_k_available == 1,
            gpu_available: info.gpu_available == 1,
            reason: c_char_array_to_string(&info.reason),
            diagnostics_json: c_char_array_to_string(&info.diagnostics_json),
        }
    }
    #[cfg(not(feature = "fem-gpu"))]
    {
        frequency_domain_unavailable(
            study_kind_label(request.study_kind),
            "fullmag-runner was built without the fem-gpu feature".to_string(),
        )
    }
}

#[allow(dead_code)]
fn frequency_domain_unavailable(
    study_kind: &'static str,
    reason: String,
) -> FrequencyDomainAvailability {
    FrequencyDomainAvailability {
        status: "unavailable".to_string(),
        study_kind: study_kind.to_string(),
        driven_response_available: false,
        modal_solver_available: false,
        static_periodic_response_available: false,
        floquet_modal_available: false,
        floquet_response_available: false,
        dynamic_demag_k_available: false,
        gpu_available: false,
        reason,
        diagnostics_json: "{}".to_string(),
    }
}

fn frequency_domain_response_floquet_unavailable() -> FrequencyDomainAvailability {
    FrequencyDomainAvailability {
        status: "unavailable".to_string(),
        study_kind: "frequency_response".to_string(),
        driven_response_available: false,
        modal_solver_available: false,
        static_periodic_response_available: false,
        floquet_modal_available: false,
        floquet_response_available: false,
        dynamic_demag_k_available: false,
        gpu_available: false,
        reason:
            "native FEM driven frequency response does not implement Floquet/Bloch nonzero-k solve"
                .to_string(),
        diagnostics_json:
            "{\"schema_version\":\"frequency_domain_availability.v1\",\"study_kind\":\"frequency_response\",\"status\":\"unavailable\",\"unsupported_reason\":\"floquet_bloch_nonzero_k\"}"
                .to_string(),
    }
}

#[allow(dead_code)]
fn study_kind_label(study_kind: FrequencyDomainStudyKind) -> &'static str {
    match study_kind {
        FrequencyDomainStudyKind::FrequencyResponse => "frequency_response",
        FrequencyDomainStudyKind::Eigenmodes => "eigenmodes",
    }
}

#[cfg(feature = "fem-gpu")]
fn map_phase_convention(
    phase_convention: FrequencyDomainPhaseConvention,
) -> ffi::fullmag_fem_frequency_domain_phase_convention {
    match phase_convention {
        FrequencyDomainPhaseConvention::ExpIOmegaT => {
            ffi::fullmag_fem_frequency_domain_phase_convention::FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_I_OMEGA_T
        }
        FrequencyDomainPhaseConvention::ExpMinusIOmegaT => {
            ffi::fullmag_fem_frequency_domain_phase_convention::FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_MINUS_I_OMEGA_T
        }
    }
}

#[cfg(feature = "fem-gpu")]
fn c_char_array_to_string<const N: usize>(chars: &[std::os::raw::c_char; N]) -> String {
    unsafe { CStr::from_ptr(chars.as_ptr()) }
        .to_string_lossy()
        .to_string()
}

#[cfg(feature = "fem-gpu")]
fn last_global_error_or(fallback: &str) -> String {
    let err = unsafe { ffi::fullmag_fem_backend_last_error(std::ptr::null_mut()) };
    if !err.is_null() {
        let msg = unsafe { CStr::from_ptr(err) }.to_string_lossy().to_string();
        if !msg.is_empty() {
            return msg;
        }
    }
    fallback.to_string()
}

#[cfg(test)]
mod tests {
    use super::{
        native_frequency_domain_availability, FrequencyDomainAvailabilityRequest,
        FrequencyDomainPhaseConvention, FrequencyDomainStudyKind,
    };

    #[test]
    fn frequency_domain_availability_request_can_carry_floquet_k_metadata() {
        let request = FrequencyDomainAvailabilityRequest {
            study_kind: FrequencyDomainStudyKind::FrequencyResponse,
            requires_driven_solver: true,
            requires_modal_solver: false,
            requires_static_periodic_boundary: false,
            requires_floquet_boundary: true,
            requires_nonzero_k_dynamic_demag: false,
            requires_gpu: false,
            strict_device: false,
            floquet_k_vector_rad_per_m: Some([1.0e6, 2.0e6, 0.0]),
            phase_convention: FrequencyDomainPhaseConvention::ExpMinusIOmegaT,
        };

        assert_eq!(
            request.floquet_k_vector_rad_per_m,
            Some([1.0e6, 2.0e6, 0.0])
        );
        assert_eq!(
            request.phase_convention,
            FrequencyDomainPhaseConvention::ExpMinusIOmegaT
        );
    }

    #[test]
    fn frequency_domain_availability_handles_floquet_metadata_by_feature() {
        let availability =
            native_frequency_domain_availability(FrequencyDomainAvailabilityRequest {
                study_kind: FrequencyDomainStudyKind::FrequencyResponse,
                requires_driven_solver: true,
                requires_modal_solver: false,
                requires_static_periodic_boundary: false,
                requires_floquet_boundary: true,
                requires_nonzero_k_dynamic_demag: false,
                requires_gpu: false,
                strict_device: false,
                floquet_k_vector_rad_per_m: Some([1.0e6, 0.0, 0.0]),
                phase_convention: FrequencyDomainPhaseConvention::ExpIOmegaT,
            });

        assert_eq!(availability.study_kind, "frequency_response");
        #[cfg(feature = "fem-gpu")]
        {
            assert_eq!(availability.status, "ok");
            assert!(availability.driven_response_available);
            assert!(availability.floquet_response_available);
            assert!(availability.reason.is_empty());
            assert!(availability
                .diagnostics_json
                .contains("nonzero_k_floquet_no_demag_phase_projection"));
        }
        #[cfg(not(feature = "fem-gpu"))]
        {
            assert_eq!(availability.status, "unavailable");
            assert!(!availability.floquet_response_available);
            assert!(availability.reason.contains("Floquet/Bloch"));
            assert!(availability.reason.contains("nonzero-k"));
            assert!(availability
                .diagnostics_json
                .contains("\"schema_version\":\"frequency_domain_availability.v1\""));
            assert!(availability
                .diagnostics_json
                .contains("\"unsupported_reason\":\"floquet_bloch_nonzero_k\""));
        }
    }

    #[test]
    fn frequency_domain_availability_fallback_keeps_gamma_floquet_as_static_periodic() {
        let availability =
            native_frequency_domain_availability(FrequencyDomainAvailabilityRequest {
                study_kind: FrequencyDomainStudyKind::FrequencyResponse,
                requires_driven_solver: true,
                requires_modal_solver: false,
                requires_static_periodic_boundary: false,
                requires_floquet_boundary: false,
                requires_nonzero_k_dynamic_demag: false,
                requires_gpu: false,
                strict_device: false,
                floquet_k_vector_rad_per_m: Some([0.0, 0.0, 0.0]),
                phase_convention: FrequencyDomainPhaseConvention::ExpIOmegaT,
            });

        assert_eq!(availability.status, "ok");
        assert_eq!(availability.study_kind, "frequency_response");
        assert!(availability.driven_response_available);
        assert!(!availability.reason.contains("nonzero-k"));
        assert!(!availability
            .diagnostics_json
            .contains("\"unsupported_reason\":\"floquet_bloch_nonzero_k\""));
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn frequency_domain_phase_convention_maps_to_c_abi() {
        assert_eq!(
            super::map_phase_convention(FrequencyDomainPhaseConvention::ExpIOmegaT),
            super::ffi::fullmag_fem_frequency_domain_phase_convention::FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_I_OMEGA_T
        );
        assert_eq!(
            super::map_phase_convention(FrequencyDomainPhaseConvention::ExpMinusIOmegaT),
            super::ffi::fullmag_fem_frequency_domain_phase_convention::FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_MINUS_I_OMEGA_T
        );
    }
}
