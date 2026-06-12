#[cfg(feature = "fem-gpu")]
use fullmag_fem_sys as ffi;

#[cfg(feature = "fem-gpu")]
use std::ffi::{c_void, CStr, CString};
use std::path::Path;
use std::sync::atomic::AtomicBool;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub(crate) enum NativeFrequencyDomainStatus {
    Ok,
    Unavailable,
    ValidationError,
    OperatorError,
    SolveError,
    ArtifactError,
    Interrupted,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(crate) struct NativeDrivenFrequencyResponseRequest<'a> {
    pub node_count: u64,
    pub tangent_dof_count: u64,
    pub alpha: f64,
    pub gamma0: f64,
    pub frequencies_hz: &'a [f64],
    pub output_directory: &'a Path,
    pub write_response_fields: bool,
    pub write_partial_artifacts: bool,
    pub interrupt_requested: Option<&'a AtomicBool>,
    pub tiny_validation_problem: Option<NativeDrivenFrequencyResponseTinyValidationProblem<'a>>,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(crate) struct NativeDrivenFrequencyResponseTinyValidationProblem<'a> {
    pub tangent_dof_count: u64,
    pub stiffness_matrix_row_major: Option<&'a [f64]>,
    pub mass_matrix_row_major: Option<&'a [f64]>,
    pub stiffness_diagonal: Option<&'a [f64]>,
    pub mass_diagonal: Option<&'a [f64]>,
    pub drive_real: &'a [f64],
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(crate) struct NativeDrivenFrequencyResponseResult {
    pub status: NativeFrequencyDomainStatus,
    pub total_frequency_count: u64,
    pub completed_frequency_count: u64,
    pub written_frequency_point_artifacts: u64,
    pub error_message: String,
    pub diagnostics_json: String,
    pub result_json: String,
    pub artifact_manifest_path: String,
}

#[allow(dead_code)]
pub(crate) fn solve_native_driven_frequency_response(
    request: NativeDrivenFrequencyResponseRequest<'_>,
) -> Result<NativeDrivenFrequencyResponseResult, String> {
    solve_native_driven_frequency_response_impl(request)
}

#[cfg(feature = "fem-gpu")]
fn solve_native_driven_frequency_response_impl(
    request: NativeDrivenFrequencyResponseRequest<'_>,
) -> Result<NativeDrivenFrequencyResponseResult, String> {
    let output_directory = CString::new(request.output_directory.to_string_lossy().as_bytes())
        .map_err(|_| "native FEM frequency response output path contains NUL".to_string())?;
    let (cancel_requested, cancel_user_data) = request.interrupt_requested.map_or(
        (None, std::ptr::null_mut()),
        |flag| {
            (
                Some(poll_atomic_interrupt_flag as unsafe extern "C" fn(*mut c_void) -> i32),
                flag as *const AtomicBool as *mut c_void,
            )
        },
    );
    let tiny_validation = request.tiny_validation_problem.as_ref();
    let ffi_request = ffi::fullmag_fem_frequency_domain_driven_response_request {
        node_count: request.node_count,
        tangent_dof_count: request.tangent_dof_count,
        alpha: request.alpha,
        gamma0: request.gamma0,
        frequencies_hz: if request.frequencies_hz.is_empty() {
            std::ptr::null()
        } else {
            request.frequencies_hz.as_ptr()
        },
        frequency_count: request.frequencies_hz.len() as u64,
        output_directory: output_directory.as_ptr(),
        write_response_fields: request.write_response_fields as i32,
        write_partial_artifacts: request.write_partial_artifacts as i32,
        cancel_requested,
        cancel_user_data,
        tiny_validation_enabled: tiny_validation.is_some() as i32,
        tiny_validation_tangent_dof_count: tiny_validation
            .map(|problem| problem.tangent_dof_count)
            .unwrap_or(0),
        tiny_validation_stiffness_matrix_row_major: tiny_validation
            .and_then(|problem| problem.stiffness_matrix_row_major)
            .map_or(std::ptr::null(), |values| values.as_ptr()),
        tiny_validation_mass_matrix_row_major: tiny_validation
            .and_then(|problem| problem.mass_matrix_row_major)
            .map_or(std::ptr::null(), |values| values.as_ptr()),
        tiny_validation_stiffness_diagonal: tiny_validation
            .and_then(|problem| problem.stiffness_diagonal)
            .map_or(std::ptr::null(), |values| values.as_ptr()),
        tiny_validation_mass_diagonal: tiny_validation
            .and_then(|problem| problem.mass_diagonal)
            .map_or(std::ptr::null(), |values| values.as_ptr()),
        tiny_validation_drive_real: tiny_validation
            .map_or(std::ptr::null(), |problem| problem.drive_real.as_ptr()),
    };
    let mut ffi_result = NativeDrivenFrequencyResponseFfiResult::default();
    let rc = unsafe {
        ffi::fullmag_fem_frequency_domain_solve_driven_response(
            &ffi_request,
            &mut ffi_result.inner,
        )
    };
    if rc != ffi::FULLMAG_FEM_OK {
        return Err(format!(
            "native FEM frequency response solve failed before result ownership transfer (rc={rc})"
        ));
    }
    Ok(ffi_result.to_owned_result())
}

#[cfg(not(feature = "fem-gpu"))]
fn solve_native_driven_frequency_response_impl(
    request: NativeDrivenFrequencyResponseRequest<'_>,
) -> Result<NativeDrivenFrequencyResponseResult, String> {
    let _ = request;
    Err("native FEM frequency response requires the fem-gpu feature".to_string())
}

#[cfg(feature = "fem-gpu")]
unsafe extern "C" fn poll_atomic_interrupt_flag(user_data: *mut c_void) -> i32 {
    let flag = user_data.cast::<AtomicBool>();
    if flag.is_null() {
        return 0;
    }
    if unsafe { (*flag).load(std::sync::atomic::Ordering::Relaxed) } {
        1
    } else {
        0
    }
}

#[cfg(feature = "fem-gpu")]
struct NativeDrivenFrequencyResponseFfiResult {
    inner: ffi::fullmag_fem_frequency_domain_solve_result,
}

#[cfg(feature = "fem-gpu")]
impl Default for NativeDrivenFrequencyResponseFfiResult {
    fn default() -> Self {
        Self {
            inner: ffi::fullmag_fem_frequency_domain_solve_result {
                status: ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OK,
                total_frequency_count: 0,
                completed_frequency_count: 0,
                written_frequency_point_artifacts: 0,
                error_message: std::ptr::null_mut(),
                diagnostics_json: std::ptr::null_mut(),
                result_json: std::ptr::null_mut(),
                artifact_manifest_path: std::ptr::null_mut(),
            },
        }
    }
}

#[cfg(feature = "fem-gpu")]
impl NativeDrivenFrequencyResponseFfiResult {
    fn to_owned_result(&self) -> NativeDrivenFrequencyResponseResult {
        NativeDrivenFrequencyResponseResult {
            status: map_status(self.inner.status),
            total_frequency_count: self.inner.total_frequency_count,
            completed_frequency_count: self.inner.completed_frequency_count,
            written_frequency_point_artifacts: self.inner.written_frequency_point_artifacts,
            error_message: ffi_string(self.inner.error_message),
            diagnostics_json: ffi_string(self.inner.diagnostics_json),
            result_json: ffi_string(self.inner.result_json),
            artifact_manifest_path: ffi_string(self.inner.artifact_manifest_path),
        }
    }
}

#[cfg(feature = "fem-gpu")]
impl Drop for NativeDrivenFrequencyResponseFfiResult {
    fn drop(&mut self) {
        unsafe {
            ffi::fullmag_fem_frequency_domain_solve_result_release(&mut self.inner);
        }
    }
}

#[cfg(feature = "fem-gpu")]
fn ffi_string(value: *const std::os::raw::c_char) -> String {
    if value.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(value) }.to_string_lossy().to_string()
    }
}

#[cfg(feature = "fem-gpu")]
fn map_status(
    status: ffi::fullmag_fem_frequency_domain_status,
) -> NativeFrequencyDomainStatus {
    match status {
        ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OK => {
            NativeFrequencyDomainStatus::Ok
        }
        ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_UNAVAILABLE => {
            NativeFrequencyDomainStatus::Unavailable
        }
        ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_VALIDATION_ERROR => {
            NativeFrequencyDomainStatus::ValidationError
        }
        ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OPERATOR_ERROR => {
            NativeFrequencyDomainStatus::OperatorError
        }
        ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_SOLVE_ERROR => {
            NativeFrequencyDomainStatus::SolveError
        }
        ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_ARTIFACT_ERROR => {
            NativeFrequencyDomainStatus::ArtifactError
        }
        ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_INTERRUPTED => {
            NativeFrequencyDomainStatus::Interrupted
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_frequency_response_reports_unavailable_without_fem_gpu_feature() {
        #[cfg(not(feature = "fem-gpu"))]
        {
            let frequencies_hz = [1.0e9];
            let err = solve_native_driven_frequency_response(NativeDrivenFrequencyResponseRequest {
                node_count: 2,
                tangent_dof_count: 4,
                alpha: 0.01,
                gamma0: 2.211e5,
                frequencies_hz: &frequencies_hz,
                output_directory: Path::new(""),
                write_response_fields: false,
                write_partial_artifacts: false,
                interrupt_requested: None,
                tiny_validation_problem: None,
            })
            .expect_err("native solve should require fem-gpu feature");
            assert!(err.contains("fem-gpu"));
        }
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn native_frequency_response_runs_tiny_validation_and_releases_ffi_strings() {
        let frequencies_hz = [1.0e9];
        let stiffness_diagonal = [2.0, 4.0];
        let mass_diagonal = [1.0, 2.0];
        let drive_real = [1.0, 2.0];
        let unique_suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-runner-native-frequency-response-{}-{}",
            std::process::id(),
            unique_suffix
        ));

        let result =
            solve_native_driven_frequency_response(NativeDrivenFrequencyResponseRequest {
                node_count: 1,
                tangent_dof_count: 2,
                alpha: 0.01,
                gamma0: 2.211e5,
                frequencies_hz: &frequencies_hz,
                output_directory: &output_dir,
                write_response_fields: false,
                write_partial_artifacts: false,
                interrupt_requested: None,
                tiny_validation_problem: Some(NativeDrivenFrequencyResponseTinyValidationProblem {
                    tangent_dof_count: 2,
                    stiffness_matrix_row_major: None,
                    mass_matrix_row_major: None,
                    stiffness_diagonal: Some(&stiffness_diagonal),
                    mass_diagonal: Some(&mass_diagonal),
                    drive_real: &drive_real,
                }),
            })
            .expect("native frequency response boundary should return a structured result");

        assert_eq!(result.status, NativeFrequencyDomainStatus::Ok);
        assert_eq!(result.total_frequency_count, 1);
        assert_eq!(result.completed_frequency_count, 1);
        assert_eq!(result.written_frequency_point_artifacts, 0);
        assert!(result.diagnostics_json.contains("frequency_domain_driven_response_result.v1"));
        assert!(result.diagnostics_json.contains("\"tiny_validation_solver\":true"));
        assert!(result.result_json.contains("\"status\":\"ok\""));
        assert!(result.result_json.contains("\"max_abs_response\""));
        assert_eq!(result.artifact_manifest_path, "");
        assert!(!output_dir.join("frequency_domain/manifest.v1.json").exists());
    }
}
