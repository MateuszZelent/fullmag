#[cfg(feature = "fem-gpu")]
use fullmag_fem_sys as ffi;

use std::ffi::c_void;
#[cfg(feature = "fem-gpu")]
use std::ffi::{c_char, CStr, CString};
use std::path::Path;
use std::sync::atomic::AtomicBool;

use super::availability::FrequencyDomainPhaseConvention;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub(crate) enum NativeFrequencyDomainExecutionLane {
    Validation,
    ProductionCpu,
    ProductionGpu,
}

#[derive(Debug, Clone, Copy, PartialEq)]
#[allow(dead_code)]
pub(crate) struct NativeFrequencyDomainProgress {
    pub frequency_index: u64,
    pub completed_frequency_count: u64,
    pub total_frequency_count: u64,
    pub iteration_count: u64,
    pub frequency_hz: f64,
    pub residual_l2_norm: f64,
    pub relative_residual_l2_norm: f64,
    pub converged: bool,
}

pub(crate) type NativeFrequencyDomainProgressCallback<'a> =
    dyn Fn(NativeFrequencyDomainProgress) + 'a;
pub(crate) type NativeFrequencyDomainCancelCallback<'a> = dyn Fn() -> bool + 'a;
pub(crate) type NativeModalEigenProgressCallback<'a> = dyn Fn(&str) + 'a;
#[cfg(feature = "fem-gpu")]
pub(crate) type NativeFrequencyDomainApplyCallback =
    unsafe extern "C" fn(
        user_data: *mut c_void,
        in_: *const f64,
        out: *mut f64,
        error_message: *mut c_char,
    ) -> ffi::fullmag_fem_frequency_domain_status;
#[cfg(feature = "fem-gpu")]
pub(crate) type NativeFrequencyDomainComplexApplyCallback =
    unsafe extern "C" fn(
        user_data: *mut c_void,
        in_real: *const f64,
        in_imag: *const f64,
        out_real: *mut f64,
        out_imag: *mut f64,
        error_message: *mut c_char,
    ) -> ffi::fullmag_fem_frequency_domain_status;
#[cfg(feature = "fem-gpu")]
pub(crate) type NativeFrequencyDomainApplyWithPotentialCallback =
    unsafe extern "C" fn(
        user_data: *mut c_void,
        in_: *const f64,
        out: *mut f64,
        out_phi: *mut f64,
        out_phi_len: u64,
        error_message: *mut c_char,
    ) -> ffi::fullmag_fem_frequency_domain_status;

#[derive(Clone)]
#[allow(dead_code)]
pub(crate) struct NativeDrivenFrequencyResponseRequest<'a> {
    pub node_count: u64,
    pub tangent_dof_count: u64,
    pub alpha: f64,
    pub gamma0: f64,
    pub execution_lane: NativeFrequencyDomainExecutionLane,
    pub frequencies_hz: &'a [f64],
    pub output_directory: &'a Path,
    pub write_response_fields: bool,
    pub write_partial_artifacts: bool,
    pub operator_diagnostics_json: Option<&'a str>,
    pub interrupt_requested: Option<&'a AtomicBool>,
    pub cancel_requested: Option<&'a NativeFrequencyDomainCancelCallback<'a>>,
    pub progress_callback: Option<&'a NativeFrequencyDomainProgressCallback<'a>>,
    pub requires_periodic_airbox_dynamic_demag: bool,
    pub requires_floquet_airbox_dynamic_demag: bool,
    pub magnetic_periodic_constraint_set_count: u64,
    pub magnetostatic_periodic_constraint_set_count: u64,
    pub periodic_airbox_delta_m_tangent_dof_count: u64,
    pub periodic_airbox_delta_phi_dof_count: u64,
    pub periodic_airbox_magnetostatic_periodic_node_pairs:
        &'a [NativeDrivenFrequencyResponsePeriodicNodePair],
    pub periodic_airbox_coupled_block_problem:
        Option<NativeDrivenFrequencyResponsePeriodicAirboxCoupledBlockProblem<'a>>,
    pub tiny_validation_problem: Option<NativeDrivenFrequencyResponseTinyValidationProblem<'a>>,
    pub mfem_operator_problem: Option<NativeDrivenFrequencyResponseMfemOperatorProblem<'a>>,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(crate) struct NativeDrivenFrequencyResponsePeriodicAirboxCoupledBlockProblem<'a> {
    pub delta_m_tangent_dof_count: u64,
    pub delta_phi_dof_count: u64,
    pub stiffness_matrix_row_major: &'a [f64],
    pub mass_matrix_row_major: &'a [f64],
    #[cfg(feature = "fem-gpu")]
    pub apply_stiffness: Option<NativeFrequencyDomainApplyCallback>,
    #[cfg(feature = "fem-gpu")]
    pub apply_mass: Option<NativeFrequencyDomainApplyCallback>,
    #[cfg(feature = "fem-gpu")]
    pub apply_complex_stiffness: Option<NativeFrequencyDomainComplexApplyCallback>,
    #[cfg(feature = "fem-gpu")]
    pub apply_complex_mass: Option<NativeFrequencyDomainComplexApplyCallback>,
    #[cfg(feature = "fem-gpu")]
    pub operator_user_data: *mut c_void,
    pub drive_real: &'a [f64],
    pub drive_imag: Option<&'a [f64]>,
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
    pub drive_imag: Option<&'a [f64]>,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(crate) struct NativeDrivenFrequencyResponseMfemOperatorProblem<'a> {
    pub equilibrium_m: &'a [[f64; 3]],
    pub h_ext_a_per_m: &'a [f64; 3],
    pub uniaxial_anisotropy_axis: Option<&'a [f64; 3]>,
    pub uniaxial_anisotropy_field_a_per_m: f64,
    pub alpha_per_node: Option<&'a [f64]>,
    pub drive_real: &'a [f64],
    pub drive_imag: Option<&'a [f64]>,
    pub exchange_edges: &'a [NativeDrivenFrequencyResponseExchangeEdge],
    pub dmi_elements: &'a [NativeDrivenFrequencyResponseDmiElement],
    pub dmi_lumped_mass: Option<&'a [f64]>,
    pub dmi_ms_field: Option<&'a [f64]>,
    pub dmi_uniform_ms: f64,
    pub observable_ms_field: Option<&'a [f64]>,
    pub observable_uniform_ms: f64,
    pub include_zeeman: bool,
    pub static_periodic_node_pairs: &'a [NativeDrivenFrequencyResponsePeriodicNodePair],
    pub floquet_k_vector_rad_per_m: Option<[f64; 3]>,
    pub phase_convention: FrequencyDomainPhaseConvention,
    pub floquet_periodic_pairs: &'a [NativeDrivenFrequencyResponseFloquetPeriodicPair<'a>],
    #[cfg(feature = "fem-gpu")]
    pub apply_demag_tangent: Option<NativeFrequencyDomainApplyCallback>,
    #[cfg(feature = "fem-gpu")]
    pub apply_demag_tangent_with_potential: Option<NativeFrequencyDomainApplyWithPotentialCallback>,
    pub demag_tangent_user_data: *mut c_void,
    pub demag_tangent_matrix_row_major: Option<&'a [f64]>,
}

#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub(crate) struct NativeDrivenFrequencyResponseExchangeEdge {
    pub node_i: u64,
    pub node_j: u64,
    pub stiffness: f64,
}

#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub(crate) struct NativeDrivenFrequencyResponsePeriodicNodePair {
    pub node_a: u64,
    pub node_b: u64,
}

#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub(crate) struct NativeDrivenFrequencyResponseFloquetPeriodicPair<'a> {
    pub pair_id: Option<&'a str>,
    pub node_a: u64,
    pub node_b: u64,
    pub translation_m: Option<[f64; 3]>,
    pub phase_rad: Option<f64>,
}

pub(crate) type NativeModalEigenFloquetPeriodicPair<'a> =
    NativeDrivenFrequencyResponseFloquetPeriodicPair<'a>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub(crate) enum NativeDrivenFrequencyResponseDmiKind {
    Interfacial,
    Bulk,
}

#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub(crate) struct NativeDrivenFrequencyResponseDmiElement {
    pub kind: NativeDrivenFrequencyResponseDmiKind,
    pub node_indices: [u32; 4],
    pub shape: [f64; 4],
    pub grad_shape: [f64; 12],
    pub weight: f64,
    pub d: f64,
    pub normal: [f64; 3],
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

#[derive(Clone)]
#[allow(dead_code)]
pub(crate) struct NativeModalEigenRequest<'a> {
    pub mesh_asset_id: &'a str,
    pub equilibrium_source_kind: &'a str,
    pub gamma_rad_s_t: f64,
    pub mu0_t_m_a: f64,
    pub alpha: f64,
    pub include_exchange: bool,
    pub include_demag: bool,
    pub demag_realization: Option<&'a str>,
    pub damping_policy: &'a str,
    pub spin_wave_bc_kind: &'a str,
    pub k_vector_rad_m: Option<&'a [f64]>,
    pub operator_diagnostics_json: Option<&'a str>,
    pub requested_mode_count: i32,
    pub target_kind: &'a str,
    pub target_frequency_hz: f64,
    pub frequency_min_hz: f64,
    pub frequency_max_hz: f64,
    pub residual_tolerance: f64,
    pub max_outer_iterations: i32,
    pub max_linear_iterations: i32,
    pub output_directory: Option<&'a Path>,
    pub write_partial_artifacts: bool,
    pub completeness_policy: i32,
    pub eigensolver_family: i32,
    pub spectral_transform_kind: i32,
    pub cancel_requested: Option<&'a NativeFrequencyDomainCancelCallback<'a>>,
    pub progress_callback: Option<&'a NativeModalEigenProgressCallback<'a>>,
    pub tiny_validation_problem: Option<NativeModalEigenTinyValidationProblem<'a>>,
    pub mfem_operator_problem: Option<NativeModalEigenMfemOperatorProblem<'a>>,
    pub mfem_sparse_operator_problem: Option<NativeModalEigenSparseOperatorProblem<'a>>,
    pub poisson_airbox_block_problem: Option<NativeModalEigenPoissonAirboxBlockProblem<'a>>,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(crate) struct NativeModalEigenTinyValidationProblem<'a> {
    pub tangent_dof_count: u64,
    pub stiffness_matrix_row_major: Option<&'a [f64]>,
    pub mass_matrix_row_major: Option<&'a [f64]>,
    pub stiffness_diagonal: Option<&'a [f64]>,
    pub mass_diagonal: Option<&'a [f64]>,
}

#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub(crate) struct NativeModalEigenMfemOperatorProblem<'a> {
    pub tangent_dof_count: u64,
    pub stiffness_matrix_row_major: Option<&'a [f64]>,
    pub gyrotropic_matrix_row_major: Option<&'a [f64]>,
    pub mass_matrix_row_major: Option<&'a [f64]>,
    pub phase_convention: FrequencyDomainPhaseConvention,
    pub floquet_periodic_pairs: &'a [NativeModalEigenFloquetPeriodicPair<'a>],
}

#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub(crate) struct NativeModalEigenCsrMatrixView<'a> {
    pub row_count: u64,
    pub column_count: u64,
    pub row_offsets: &'a [u32],
    pub column_indices: &'a [u32],
    pub values: &'a [f64],
}

#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub(crate) struct NativeModalEigenSparseOperatorProblem<'a> {
    pub stiffness_csr: NativeModalEigenCsrMatrixView<'a>,
    pub gyrotropic_csr: NativeModalEigenCsrMatrixView<'a>,
    pub mass_csr: NativeModalEigenCsrMatrixView<'a>,
}

#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub(crate) struct NativeModalEigenPoissonAirboxBlockProblem<'a> {
    pub q_dof_count: u64,
    pub phi_dof_count: u64,
    pub a_qq_csr: NativeModalEigenCsrMatrixView<'a>,
    pub a_qphi_csr: NativeModalEigenCsrMatrixView<'a>,
    pub a_phiq_csr: NativeModalEigenCsrMatrixView<'a>,
    pub a_phiphi_csr: NativeModalEigenCsrMatrixView<'a>,
    pub b_qq_csr: NativeModalEigenCsrMatrixView<'a>,
    pub phi_mean_weights: &'a [f64],
    pub target_frequency_hz: f64,
    pub expected_reference_frequency_hz: f64,
    pub periodic_mesh_certificate_schema: &'a str,
    pub magnetic_pair_count: u64,
    pub airbox_pair_count: u64,
    pub shift_invert_action: Option<NativeModalEigenPoissonAirboxShiftInvertAction<'a>>,
}

#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub(crate) struct NativeModalEigenPoissonAirboxShiftInvertAction<'a> {
    pub sigma_real: f64,
    pub sigma_imag: f64,
    pub vector_real: &'a [f64],
    pub vector_imag: Option<&'a [f64]>,
    pub use_gpu_hidden_action: bool,
}

#[derive(Clone)]
#[allow(dead_code)]
pub(crate) struct NativeDrivenResponseContractRequest<'a> {
    pub mesh_asset_id: &'a str,
    pub equilibrium_source_kind: &'a str,
    pub gamma_rad_s_t: f64,
    pub mu0_t_m_a: f64,
    pub alpha: f64,
    pub include_exchange: bool,
    pub include_demag: bool,
    pub demag_realization: Option<&'a str>,
    pub damping_policy: &'a str,
    pub spin_wave_bc_kind: &'a str,
    pub k_vector_rad_m: Option<&'a [f64]>,
    pub operator_diagnostics_json: Option<&'a str>,
    pub frequencies_hz: &'a [f64],
    pub excitation_field_a_m: &'a [f64],
    pub excitation_phase_rad: f64,
    pub residual_tolerance: f64,
    pub max_linear_iterations: i32,
    pub output_directory: Option<&'a Path>,
    pub write_partial_artifacts: bool,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(crate) struct NativeFrequencyDomainContractResult {
    pub status: NativeFrequencyDomainStatus,
    pub error_message: String,
    pub diagnostics_json: String,
    pub result_json: String,
    pub artifact_manifest_path: String,
}

#[allow(dead_code)]
pub(crate) fn solve_native_driven_frequency_response(
    request: NativeDrivenFrequencyResponseRequest<'_>,
) -> Result<NativeDrivenFrequencyResponseResult, String> {
    #[cfg(feature = "fem-gpu")]
    super::configure_managed_openmpi_environment();
    solve_native_driven_frequency_response_impl(request)
}

#[allow(dead_code)]
pub(crate) fn solve_native_modal_eigen(
    request: NativeModalEigenRequest<'_>,
) -> Result<NativeFrequencyDomainContractResult, String> {
    #[cfg(feature = "fem-gpu")]
    super::configure_managed_openmpi_environment();
    solve_native_modal_eigen_impl(request)
}

#[allow(dead_code)]
pub(crate) fn solve_native_driven_response_contract(
    request: NativeDrivenResponseContractRequest<'_>,
) -> Result<NativeFrequencyDomainContractResult, String> {
    #[cfg(feature = "fem-gpu")]
    super::configure_managed_openmpi_environment();
    solve_native_driven_response_contract_impl(request)
}

#[cfg(feature = "fem-gpu")]
fn positive_env_f64(primary: &str, alias: &str) -> f64 {
    std::env::var(primary)
        .ok()
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0)
        .or_else(|| {
            std::env::var(alias)
                .ok()
                .and_then(|value| value.parse::<f64>().ok())
                .filter(|value| value.is_finite() && *value > 0.0)
        })
        .unwrap_or(0.0)
}

#[cfg(feature = "fem-gpu")]
fn positive_env_u64(primary: &str, alias: &str) -> u64 {
    std::env::var(primary)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .or_else(|| {
            std::env::var(alias)
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .filter(|value| *value > 0)
        })
        .unwrap_or(0)
}

#[cfg(feature = "fem-gpu")]
fn solve_native_driven_frequency_response_impl(
    request: NativeDrivenFrequencyResponseRequest<'_>,
) -> Result<NativeDrivenFrequencyResponseResult, String> {
    let output_directory = CString::new(request.output_directory.to_string_lossy().as_bytes())
        .map_err(|_| "native FEM frequency response output path contains NUL".to_string())?;
    let operator_diagnostics_json = request
        .operator_diagnostics_json
        .map(|value| CString::new(value.as_bytes()))
        .transpose()
        .map_err(|_| {
            "native FEM frequency response operator_diagnostics_json contains NUL".to_string()
        })?;
    let cancel_callback = request.cancel_requested;
    let (cancel_requested, cancel_user_data) = if cancel_callback.is_some() {
        (
            Some(
                dispatch_native_frequency_domain_cancel as unsafe extern "C" fn(*mut c_void) -> i32,
            ),
            (&cancel_callback as *const Option<&NativeFrequencyDomainCancelCallback<'_>>)
                as *mut c_void,
        )
    } else {
        request
            .interrupt_requested
            .map_or((None, std::ptr::null_mut()), |flag| {
                (
                    Some(poll_atomic_interrupt_flag as unsafe extern "C" fn(*mut c_void) -> i32),
                    flag as *const AtomicBool as *mut c_void,
                )
            })
    };
    let progress_callback = request.progress_callback;
    let (progress_callback_fn, progress_user_data) = if progress_callback.is_some() {
        (
            Some(
                dispatch_native_frequency_domain_progress
                    as unsafe extern "C" fn(
                        *mut c_void,
                        *const ffi::fullmag_fem_frequency_domain_progress,
                    ),
            ),
            (&progress_callback as *const Option<&NativeFrequencyDomainProgressCallback<'_>>)
                as *mut c_void,
        )
    } else {
        (None, std::ptr::null_mut())
    };
    let tiny_validation = request.tiny_validation_problem.as_ref();
    let mfem_operator = request.mfem_operator_problem.as_ref();
    let periodic_airbox_coupled_block = request.periodic_airbox_coupled_block_problem.as_ref();
    let exchange_edges = mfem_operator
        .map(|problem| {
            problem
                .exchange_edges
                .iter()
                .map(|edge| ffi::fullmag_fem_frequency_domain_exchange_edge {
                    node_i: edge.node_i,
                    node_j: edge.node_j,
                    stiffness: edge.stiffness,
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let dmi_elements = mfem_operator
        .map(|problem| {
            problem
                .dmi_elements
                .iter()
                .map(|element| ffi::fullmag_fem_frequency_domain_dmi_element {
                    kind: map_dmi_kind(element.kind),
                    node_indices: element.node_indices,
                    shape: element.shape,
                    grad_shape: element.grad_shape,
                    weight: element.weight,
                    d: element.d,
                    normal: element.normal,
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let static_periodic_node_pairs = mfem_operator
        .map(|problem| {
            problem
                .static_periodic_node_pairs
                .iter()
                .map(
                    |pair| ffi::fullmag_fem_frequency_domain_periodic_node_pair {
                        node_a: pair.node_a,
                        node_b: pair.node_b,
                    },
                )
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let periodic_airbox_magnetostatic_periodic_node_pairs = request
        .periodic_airbox_magnetostatic_periodic_node_pairs
        .iter()
        .map(
            |pair| ffi::fullmag_fem_frequency_domain_periodic_node_pair {
                node_a: pair.node_a,
                node_b: pair.node_b,
            },
        )
        .collect::<Vec<_>>();
    let floquet_pair_ids = mfem_operator
        .map(|problem| {
            problem
                .floquet_periodic_pairs
                .iter()
                .map(|pair| {
                    pair.pair_id
                        .map(|pair_id| {
                            CString::new(pair_id.as_bytes()).map_err(|_| {
                                "native FEM frequency response Floquet pair id contains NUL"
                                    .to_string()
                            })
                        })
                        .transpose()
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .unwrap_or_default();
    let floquet_periodic_pairs = mfem_operator
        .map(|problem| {
            problem
                .floquet_periodic_pairs
                .iter()
                .zip(floquet_pair_ids.iter())
                .map(
                    |(pair, pair_id)| ffi::fullmag_fem_frequency_domain_floquet_periodic_pair {
                        pair_id: pair_id
                            .as_ref()
                            .map_or(std::ptr::null(), |value| value.as_ptr()),
                        node_a: pair.node_a,
                        node_b: pair.node_b,
                        has_translation: pair.translation_m.is_some() as i32,
                        translation_m: pair.translation_m.unwrap_or([0.0; 3]),
                        has_phase: pair.phase_rad.is_some() as i32,
                        phase_rad: pair.phase_rad.unwrap_or(0.0),
                    },
                )
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if let Some(problem) = mfem_operator {
        validate_floquet_pair_phase_metadata(
            problem.floquet_k_vector_rad_per_m,
            problem.floquet_periodic_pairs,
        )?;
    }
    let ffi_request = ffi::fullmag_fem_frequency_domain_driven_response_request {
        node_count: request.node_count,
        tangent_dof_count: request.tangent_dof_count,
        alpha: request.alpha,
        gamma0: request.gamma0,
        requested_execution_lane: map_execution_lane(request.execution_lane),
        frequencies_hz: if request.frequencies_hz.is_empty() {
            std::ptr::null()
        } else {
            request.frequencies_hz.as_ptr()
        },
        frequency_count: request.frequencies_hz.len() as u64,
        output_directory: output_directory.as_ptr(),
        write_response_fields: request.write_response_fields as i32,
        write_partial_artifacts: request.write_partial_artifacts as i32,
        operator_diagnostics_json: optional_str_ptr(operator_diagnostics_json.as_ref()),
        cancel_requested,
        cancel_user_data,
        progress_callback: progress_callback_fn,
        progress_user_data,
        tiny_validation_enabled: tiny_validation.is_some() as i32,
        tiny_validation_tangent_dof_count: tiny_validation
            .map(|problem| problem.tangent_dof_count)
            .unwrap_or(0),
        tiny_validation_stiffness_matrix_row_major: tiny_validation
            .and_then(|problem| problem.stiffness_matrix_row_major)
            .map_or(std::ptr::null(), slice_ptr_or_null),
        tiny_validation_mass_matrix_row_major: tiny_validation
            .and_then(|problem| problem.mass_matrix_row_major)
            .map_or(std::ptr::null(), slice_ptr_or_null),
        tiny_validation_stiffness_diagonal: tiny_validation
            .and_then(|problem| problem.stiffness_diagonal)
            .map_or(std::ptr::null(), slice_ptr_or_null),
        tiny_validation_mass_diagonal: tiny_validation
            .and_then(|problem| problem.mass_diagonal)
            .map_or(std::ptr::null(), slice_ptr_or_null),
        tiny_validation_drive_real: tiny_validation.map_or(std::ptr::null(), |problem| {
            slice_ptr_or_null(problem.drive_real)
        }),
        mfem_operator_enabled: mfem_operator.is_some() as i32,
        mfem_include_zeeman: mfem_operator.is_some_and(|problem| problem.include_zeeman) as i32,
        mfem_equilibrium_m: mfem_operator.map_or(std::ptr::null(), |problem| {
            if problem.equilibrium_m.is_empty() {
                std::ptr::null()
            } else {
                problem.equilibrium_m.as_ptr().cast::<f64>()
            }
        }),
        mfem_h_ext_a_per_m: mfem_operator
            .map_or(std::ptr::null(), |problem| problem.h_ext_a_per_m.as_ptr()),
        mfem_uniaxial_anisotropy_axis: mfem_operator
            .and_then(|problem| problem.uniaxial_anisotropy_axis)
            .map_or(std::ptr::null(), |axis| axis.as_ptr()),
        mfem_uniaxial_anisotropy_field_a_per_m: mfem_operator
            .map_or(0.0, |problem| problem.uniaxial_anisotropy_field_a_per_m),
        mfem_alpha_per_node: mfem_operator
            .and_then(|problem| problem.alpha_per_node)
            .map_or(std::ptr::null(), slice_ptr_or_null),
        mfem_drive_real: mfem_operator.map_or(std::ptr::null(), |problem| {
            slice_ptr_or_null(problem.drive_real)
        }),
        mfem_exchange_edges: if exchange_edges.is_empty() {
            std::ptr::null()
        } else {
            exchange_edges.as_ptr()
        },
        mfem_exchange_edge_count: exchange_edges.len() as u64,
        mfem_dmi_elements: if dmi_elements.is_empty() {
            std::ptr::null()
        } else {
            dmi_elements.as_ptr()
        },
        mfem_dmi_element_count: dmi_elements.len() as u64,
        mfem_dmi_lumped_mass: mfem_operator
            .and_then(|problem| problem.dmi_lumped_mass)
            .map_or(std::ptr::null(), slice_ptr_or_null),
        mfem_dmi_ms_field: mfem_operator
            .and_then(|problem| problem.dmi_ms_field)
            .map_or(std::ptr::null(), slice_ptr_or_null),
        mfem_dmi_uniform_ms: mfem_operator.map_or(0.0, |problem| problem.dmi_uniform_ms),
        tiny_validation_drive_imag: tiny_validation
            .and_then(|problem| problem.drive_imag)
            .map_or(std::ptr::null(), slice_ptr_or_null),
        mfem_drive_imag: mfem_operator
            .and_then(|problem| problem.drive_imag)
            .map_or(std::ptr::null(), slice_ptr_or_null),
        mfem_static_periodic_node_pairs: if static_periodic_node_pairs.is_empty() {
            std::ptr::null()
        } else {
            static_periodic_node_pairs.as_ptr()
        },
        mfem_static_periodic_node_pair_count: static_periodic_node_pairs.len() as u64,
        has_floquet_k_vector: mfem_operator
            .and_then(|problem| problem.floquet_k_vector_rad_per_m)
            .is_some() as i32,
        floquet_k_vector_rad_per_m: mfem_operator
            .and_then(|problem| problem.floquet_k_vector_rad_per_m)
            .unwrap_or([0.0; 3]),
        phase_convention: map_phase_convention(
            mfem_operator
                .map(|problem| problem.phase_convention)
                .unwrap_or(FrequencyDomainPhaseConvention::ExpIOmegaT),
        ),
        drive_kind:
            ffi::fullmag_fem_frequency_domain_drive_kind::FULLMAG_FEM_FREQUENCY_DOMAIN_DRIVE_UNSPECIFIED,
        require_nonzero_rhs: 0,
        mfem_floquet_periodic_pairs: if floquet_periodic_pairs.is_empty() {
            std::ptr::null()
        } else {
            floquet_periodic_pairs.as_ptr()
        },
        mfem_floquet_periodic_pair_count: floquet_periodic_pairs.len() as u64,
        requires_periodic_airbox_dynamic_demag: request.requires_periodic_airbox_dynamic_demag
            as i32,
        requires_floquet_airbox_dynamic_demag: request.requires_floquet_airbox_dynamic_demag as i32,
        magnetic_periodic_constraint_set_count: request.magnetic_periodic_constraint_set_count,
        magnetostatic_periodic_constraint_set_count: request
            .magnetostatic_periodic_constraint_set_count,
        periodic_airbox_delta_m_tangent_dof_count: request
            .periodic_airbox_delta_m_tangent_dof_count,
        periodic_airbox_delta_phi_dof_count: request.periodic_airbox_delta_phi_dof_count,
        periodic_airbox_magnetostatic_periodic_node_pairs:
            if periodic_airbox_magnetostatic_periodic_node_pairs.is_empty() {
                std::ptr::null()
            } else {
                periodic_airbox_magnetostatic_periodic_node_pairs.as_ptr()
            },
        periodic_airbox_magnetostatic_periodic_node_pair_count:
            periodic_airbox_magnetostatic_periodic_node_pairs.len() as u64,
        periodic_airbox_coupled_block_enabled: periodic_airbox_coupled_block.is_some() as i32,
        periodic_airbox_coupled_block_delta_m_tangent_dof_count: periodic_airbox_coupled_block
            .map(|problem| problem.delta_m_tangent_dof_count)
            .unwrap_or(0),
        periodic_airbox_coupled_block_delta_phi_dof_count: periodic_airbox_coupled_block
            .map(|problem| problem.delta_phi_dof_count)
            .unwrap_or(0),
        periodic_airbox_coupled_block_stiffness_matrix_row_major: periodic_airbox_coupled_block
            .map_or(std::ptr::null(), |problem| {
                slice_ptr_or_null(problem.stiffness_matrix_row_major)
            }),
        periodic_airbox_coupled_block_mass_matrix_row_major: periodic_airbox_coupled_block
            .map_or(std::ptr::null(), |problem| {
                slice_ptr_or_null(problem.mass_matrix_row_major)
            }),
        periodic_airbox_coupled_block_apply_stiffness: periodic_airbox_coupled_block
            .and_then(|problem| problem.apply_stiffness),
        periodic_airbox_coupled_block_apply_mass: periodic_airbox_coupled_block
            .and_then(|problem| problem.apply_mass),
        periodic_airbox_coupled_block_apply_complex_stiffness: periodic_airbox_coupled_block
            .and_then(|problem| problem.apply_complex_stiffness),
        periodic_airbox_coupled_block_apply_complex_mass: periodic_airbox_coupled_block
            .and_then(|problem| problem.apply_complex_mass),
        periodic_airbox_coupled_block_operator_user_data: periodic_airbox_coupled_block
            .map_or(std::ptr::null_mut(), |problem| problem.operator_user_data),
        periodic_airbox_coupled_block_drive_real: periodic_airbox_coupled_block
            .map_or(std::ptr::null(), |problem| {
                slice_ptr_or_null(problem.drive_real)
            }),
        periodic_airbox_coupled_block_drive_imag: periodic_airbox_coupled_block
            .and_then(|problem| problem.drive_imag)
            .map_or(std::ptr::null(), slice_ptr_or_null),
        mfem_apply_demag_tangent: mfem_operator.and_then(|problem| problem.apply_demag_tangent),
        mfem_demag_tangent_user_data: mfem_operator.map_or(std::ptr::null_mut(), |problem| {
            problem.demag_tangent_user_data
        }),
        mfem_demag_tangent_matrix_row_major: mfem_operator
            .and_then(|problem| problem.demag_tangent_matrix_row_major)
            .map_or(std::ptr::null(), slice_ptr_or_null),
        mfem_observable_ms_field: mfem_operator
            .and_then(|problem| problem.observable_ms_field)
            .map_or(std::ptr::null(), slice_ptr_or_null),
        mfem_observable_ms_field_len: mfem_operator
            .and_then(|problem| problem.observable_ms_field)
            .map_or(0, |values| values.len() as u64),
        mfem_observable_uniform_ms: mfem_operator
            .map_or(0.0, |problem| problem.observable_uniform_ms),
        abi_version: ffi::FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION,
        reserved_contract_flags: 0,
        struct_size: std::mem::size_of::<ffi::fullmag_fem_frequency_domain_driven_response_request>(
        ) as u64,
        solver_relative_tolerance: positive_env_f64(
            "FULLMAG_FEM_FREQUENCY_RESPONSE_RTOL",
            "FULLMAG_FMR_RESPONSE_RTOL",
        ),
        solver_absolute_tolerance: positive_env_f64(
            "FULLMAG_FEM_FREQUENCY_RESPONSE_ATOL",
            "FULLMAG_FMR_RESPONSE_ATOL",
        ),
        solver_max_iterations: positive_env_u64(
            "FULLMAG_FEM_FREQUENCY_RESPONSE_MAX_ITERATIONS",
            "FULLMAG_FMR_RESPONSE_MAX_ITERATIONS",
        ),
        solver_restart_iterations: positive_env_u64(
            "FULLMAG_FEM_FREQUENCY_RESPONSE_RESTART_ITERATIONS",
            "FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS",
        ),
        solver_progress_interval_iterations: positive_env_u64(
            "FULLMAG_FEM_FREQUENCY_RESPONSE_PROGRESS_INTERVAL",
            "FULLMAG_FMR_RESPONSE_PROGRESS_INTERVAL",
        ),
        tiny_validation_stiffness_matrix_value_count: tiny_validation
            .and_then(|problem| problem.stiffness_matrix_row_major)
            .map_or(0, |values| values.len() as u64),
        tiny_validation_mass_matrix_value_count: tiny_validation
            .and_then(|problem| problem.mass_matrix_row_major)
            .map_or(0, |values| values.len() as u64),
        tiny_validation_stiffness_diagonal_value_count: tiny_validation
            .and_then(|problem| problem.stiffness_diagonal)
            .map_or(0, |values| values.len() as u64),
        tiny_validation_mass_diagonal_value_count: tiny_validation
            .and_then(|problem| problem.mass_diagonal)
            .map_or(0, |values| values.len() as u64),
        tiny_validation_drive_real_value_count: tiny_validation
            .map_or(0, |problem| problem.drive_real.len() as u64),
        tiny_validation_drive_imag_value_count: tiny_validation
            .and_then(|problem| problem.drive_imag)
            .map_or(0, |values| values.len() as u64),
        mfem_equilibrium_m_value_count: mfem_operator
            .map_or(0, |problem| (problem.equilibrium_m.len() * 3) as u64),
        mfem_h_ext_value_count: mfem_operator
            .map_or(0, |problem| problem.h_ext_a_per_m.len() as u64),
        mfem_uniaxial_anisotropy_axis_value_count: mfem_operator
            .and_then(|problem| problem.uniaxial_anisotropy_axis)
            .map_or(0, |values| values.len() as u64),
        mfem_alpha_value_count: mfem_operator
            .and_then(|problem| problem.alpha_per_node)
            .map_or(0, |values| values.len() as u64),
        mfem_drive_real_value_count: mfem_operator
            .map_or(0, |problem| problem.drive_real.len() as u64),
        mfem_drive_imag_value_count: mfem_operator
            .and_then(|problem| problem.drive_imag)
            .map_or(0, |values| values.len() as u64),
        mfem_dmi_lumped_mass_value_count: mfem_operator
            .and_then(|problem| problem.dmi_lumped_mass)
            .map_or(0, |values| values.len() as u64),
        mfem_dmi_ms_field_value_count: mfem_operator
            .and_then(|problem| problem.dmi_ms_field)
            .map_or(0, |values| values.len() as u64),
        mfem_demag_tangent_matrix_value_count: mfem_operator
            .and_then(|problem| problem.demag_tangent_matrix_row_major)
            .map_or(0, |values| values.len() as u64),
        periodic_airbox_coupled_block_stiffness_matrix_value_count: periodic_airbox_coupled_block
            .map_or(0, |problem| problem.stiffness_matrix_row_major.len() as u64),
        periodic_airbox_coupled_block_mass_matrix_value_count: periodic_airbox_coupled_block
            .map_or(0, |problem| problem.mass_matrix_row_major.len() as u64),
        periodic_airbox_coupled_block_drive_real_value_count: periodic_airbox_coupled_block
            .map_or(0, |problem| problem.drive_real.len() as u64),
        periodic_airbox_coupled_block_drive_imag_value_count: periodic_airbox_coupled_block
            .and_then(|problem| problem.drive_imag)
            .map_or(0, |values| values.len() as u64),
    };
    let mfem_apply_demag_tangent_with_potential =
        mfem_operator.and_then(|problem| problem.apply_demag_tangent_with_potential);
    let mut ffi_result = NativeDrivenFrequencyResponseFfiResult::default();
    let rc = unsafe {
        if mfem_apply_demag_tangent_with_potential.is_some() {
            ffi::fullmag_fem_frequency_domain_solve_driven_response_v10(
                &ffi_request,
                mfem_apply_demag_tangent_with_potential,
                &mut ffi_result.inner,
            )
        } else {
            ffi::fullmag_fem_frequency_domain_solve_driven_response(
                &ffi_request,
                &mut ffi_result.inner,
            )
        }
    };
    if rc != ffi::FULLMAG_FEM_OK {
        return Err(format!(
            "native FEM frequency response solve failed before result ownership transfer (rc={rc})"
        ));
    }
    Ok(ffi_result.to_owned_result())
}

#[cfg(any(feature = "fem-gpu", test))]
fn validate_floquet_pair_phase_metadata(
    k_vector_rad_per_m: Option<[f64; 3]>,
    pairs: &[NativeDrivenFrequencyResponseFloquetPeriodicPair<'_>],
) -> Result<(), String> {
    if pairs.is_empty() {
        return Ok(());
    }
    let Some(k_vector_rad_per_m) = k_vector_rad_per_m else {
        return Err("Floquet periodic pairs require a single k-vector".to_string());
    };
    if !k_vector_rad_per_m.iter().all(|value| value.is_finite()) {
        return Err("Floquet k-vector contains a non-finite value".to_string());
    }
    for pair in pairs {
        let pair_label = pair.pair_id.unwrap_or("<unnamed>");
        let Some(translation_m) = pair.translation_m else {
            return Err(format!(
                "Floquet phase metadata for pair '{pair_label}' requires a boundary translation"
            ));
        };
        if !translation_m.iter().all(|value| value.is_finite()) {
            return Err(format!(
                "Floquet phase metadata for pair '{pair_label}' contains a non-finite translation"
            ));
        }
        let Some(phase_rad) = pair.phase_rad else {
            return Err(format!(
                "Floquet phase metadata for pair '{pair_label}' requires phase_rad"
            ));
        };
        if !phase_rad.is_finite() {
            return Err(format!(
                "Floquet phase metadata for pair '{pair_label}' contains a non-finite phase"
            ));
        }
        let expected_phase_rad = -(k_vector_rad_per_m[0] * translation_m[0]
            + k_vector_rad_per_m[1] * translation_m[1]
            + k_vector_rad_per_m[2] * translation_m[2]);
        let residual_rad = canonical_phase_residual_rad(phase_rad - expected_phase_rad);
        if residual_rad.abs() > 1.0e-9 {
            return Err(format!(
                "Floquet phase metadata for pair '{pair_label}' is inconsistent with -k dot translation: expected phase_rad equivalent to {expected_phase_rad}, got {phase_rad}, residual {residual_rad}"
            ));
        }
    }
    Ok(())
}

#[cfg(any(feature = "fem-gpu", test))]
fn canonical_phase_residual_rad(phase_rad: f64) -> f64 {
    let two_pi = 2.0 * std::f64::consts::PI;
    let mut value = (phase_rad + std::f64::consts::PI).rem_euclid(two_pi) - std::f64::consts::PI;
    if value <= -std::f64::consts::PI {
        value += two_pi;
    }
    value
}

#[cfg(feature = "fem-gpu")]
fn slice_ptr_or_null<T>(values: &[T]) -> *const T {
    if values.is_empty() {
        std::ptr::null()
    } else {
        values.as_ptr()
    }
}

#[cfg(feature = "fem-gpu")]
fn csr_matrix_view_or_zero(
    value: Option<&NativeModalEigenCsrMatrixView<'_>>,
) -> ffi::FullmagFemCsrMatrixView {
    value.map_or(
        ffi::FullmagFemCsrMatrixView {
            row_count: 0,
            column_count: 0,
            row_offsets: std::ptr::null(),
            row_offsets_len: 0,
            column_indices: std::ptr::null(),
            column_indices_len: 0,
            values: std::ptr::null(),
            values_len: 0,
        },
        |view| ffi::FullmagFemCsrMatrixView {
            row_count: view.row_count,
            column_count: view.column_count,
            row_offsets: slice_ptr_or_null(view.row_offsets),
            row_offsets_len: view.row_offsets.len() as u64,
            column_indices: slice_ptr_or_null(view.column_indices),
            column_indices_len: view.column_indices.len() as u64,
            values: slice_ptr_or_null(view.values),
            values_len: view.values.len() as u64,
        },
    )
}

#[cfg(not(feature = "fem-gpu"))]
fn solve_native_driven_frequency_response_impl(
    request: NativeDrivenFrequencyResponseRequest<'_>,
) -> Result<NativeDrivenFrequencyResponseResult, String> {
    let _ = request;
    Err("native FEM frequency response requires the fem-gpu feature".to_string())
}

#[cfg(feature = "fem-gpu")]
fn solve_native_modal_eigen_impl(
    request: NativeModalEigenRequest<'_>,
) -> Result<NativeFrequencyDomainContractResult, String> {
    let mesh_asset_id = CString::new(request.mesh_asset_id.as_bytes())
        .map_err(|_| "native FEM modal_eigen mesh_asset_id contains NUL".to_string())?;
    let equilibrium_source_kind = CString::new(request.equilibrium_source_kind.as_bytes())
        .map_err(|_| "native FEM modal_eigen equilibrium_source_kind contains NUL".to_string())?;
    let damping_policy = CString::new(request.damping_policy.as_bytes())
        .map_err(|_| "native FEM modal_eigen damping_policy contains NUL".to_string())?;
    let spin_wave_bc_kind = CString::new(request.spin_wave_bc_kind.as_bytes())
        .map_err(|_| "native FEM modal_eigen spin_wave_bc_kind contains NUL".to_string())?;
    let target_kind = CString::new(request.target_kind.as_bytes())
        .map_err(|_| "native FEM modal_eigen target_kind contains NUL".to_string())?;
    let demag_realization = request
        .demag_realization
        .map(|value| CString::new(value.as_bytes()))
        .transpose()
        .map_err(|_| "native FEM modal_eigen demag_realization contains NUL".to_string())?;
    let operator_diagnostics_json = request
        .operator_diagnostics_json
        .map(|value| CString::new(value.as_bytes()))
        .transpose()
        .map_err(|_| "native FEM modal_eigen operator_diagnostics_json contains NUL".to_string())?;
    let output_directory = request
        .output_directory
        .map(|path| CString::new(path.to_string_lossy().as_bytes()))
        .transpose()
        .map_err(|_| "native FEM modal_eigen output_directory contains NUL".to_string())?;
    let cancel_callback = request.cancel_requested;
    let (cancel_requested, cancel_user_data) = if cancel_callback.is_some() {
        (
            Some(
                dispatch_native_frequency_domain_cancel as unsafe extern "C" fn(*mut c_void) -> i32,
            ),
            (&cancel_callback as *const Option<&NativeFrequencyDomainCancelCallback<'_>>)
                as *mut c_void,
        )
    } else {
        (None, std::ptr::null_mut())
    };
    let progress_callback = request.progress_callback;
    let (progress_callback_fn, progress_user_data) = if progress_callback.is_some() {
        (
            Some(
                dispatch_native_modal_eigen_progress_json
                    as unsafe extern "C" fn(*mut c_void, *const c_char),
            ),
            (&progress_callback as *const Option<&NativeModalEigenProgressCallback<'_>>)
                as *mut c_void,
        )
    } else {
        (None, std::ptr::null_mut())
    };
    let tiny_validation = request.tiny_validation_problem.as_ref();
    let mfem_operator = request.mfem_operator_problem.as_ref();
    let mfem_sparse_operator = request.mfem_sparse_operator_problem.as_ref();
    let poisson_airbox_block = request.poisson_airbox_block_problem.as_ref();
    let poisson_airbox_shift_invert_action =
        poisson_airbox_block.and_then(|problem| problem.shift_invert_action.as_ref());
    let poisson_airbox_periodic_mesh_certificate_schema = poisson_airbox_block
        .map(|problem| CString::new(problem.periodic_mesh_certificate_schema.as_bytes()))
        .transpose()
        .map_err(|_| {
            "native FEM modal_eigen Poisson-airbox certificate schema contains NUL".to_string()
        })?;
    let floquet_k_vector_rad_per_m = request.k_vector_rad_m.and_then(|values| {
        if values.len() == 3 {
            Some([values[0], values[1], values[2]])
        } else {
            None
        }
    });
    let has_floquet_k_vector =
        request.spin_wave_bc_kind == "floquet" && floquet_k_vector_rad_per_m.is_some();
    let floquet_pair_ids = mfem_operator
        .map(|problem| {
            problem
                .floquet_periodic_pairs
                .iter()
                .map(|pair| {
                    pair.pair_id
                        .map(|pair_id| {
                            CString::new(pair_id.as_bytes()).map_err(|_| {
                                "native FEM modal_eigen Floquet pair id contains NUL".to_string()
                            })
                        })
                        .transpose()
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .unwrap_or_default();
    let floquet_periodic_pairs = mfem_operator
        .map(|problem| {
            problem
                .floquet_periodic_pairs
                .iter()
                .zip(floquet_pair_ids.iter())
                .map(
                    |(pair, pair_id)| ffi::fullmag_fem_frequency_domain_floquet_periodic_pair {
                        pair_id: pair_id
                            .as_ref()
                            .map_or(std::ptr::null(), |value| value.as_ptr()),
                        node_a: pair.node_a,
                        node_b: pair.node_b,
                        has_translation: pair.translation_m.is_some() as i32,
                        translation_m: pair.translation_m.unwrap_or([0.0; 3]),
                        has_phase: pair.phase_rad.is_some() as i32,
                        phase_rad: pair.phase_rad.unwrap_or(0.0),
                    },
                )
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if let Some(problem) = mfem_operator {
        validate_floquet_pair_phase_metadata(
            floquet_k_vector_rad_per_m,
            problem.floquet_periodic_pairs,
        )?;
    }

    let ffi_request = ffi::FullmagFemModalEigenRequest {
        abi_version: ffi::FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION,
        operator_request: ffi::FullmagFemLinearizedOperatorRequest {
            abi_version: ffi::FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION,
            mesh_asset_id: mesh_asset_id.as_ptr(),
            equilibrium_source_kind: equilibrium_source_kind.as_ptr(),
            gamma_rad_s_T: request.gamma_rad_s_t,
            mu0_T_m_A: request.mu0_t_m_a,
            alpha: request.alpha,
            include_exchange: i32::from(request.include_exchange),
            include_demag: i32::from(request.include_demag),
            demag_realization: optional_str_ptr(demag_realization.as_ref()),
            damping_policy: damping_policy.as_ptr(),
            spin_wave_bc_kind: spin_wave_bc_kind.as_ptr(),
            k_vector_rad_m: request
                .k_vector_rad_m
                .map_or(std::ptr::null(), |values| values.as_ptr()),
            k_vector_len: request
                .k_vector_rad_m
                .map_or(0, |values| values.len() as i32),
            operator_diagnostics_json: optional_str_ptr(operator_diagnostics_json.as_ref()),
        },
        requested_mode_count: request.requested_mode_count,
        target_kind: target_kind.as_ptr(),
        target_frequency_hz: request.target_frequency_hz,
        frequency_min_hz: request.frequency_min_hz,
        frequency_max_hz: request.frequency_max_hz,
        residual_tolerance: request.residual_tolerance,
        max_outer_iterations: request.max_outer_iterations,
        max_linear_iterations: request.max_linear_iterations,
        output_directory: optional_str_ptr(output_directory.as_ref()),
        write_partial_artifacts: i32::from(request.write_partial_artifacts),
        completeness_policy: request.completeness_policy,
        eigensolver_family: request.eigensolver_family,
        spectral_transform_kind: request.spectral_transform_kind,
        cancel_user_data,
        cancel_requested,
        progress_user_data,
        progress_callback: progress_callback_fn,
        tiny_validation_enabled: tiny_validation.is_some() as i32,
        tiny_validation_tangent_dof_count: tiny_validation
            .map(|problem| problem.tangent_dof_count)
            .unwrap_or(0),
        tiny_validation_stiffness_matrix_row_major: tiny_validation
            .and_then(|problem| problem.stiffness_matrix_row_major)
            .map_or(std::ptr::null(), slice_ptr_or_null),
        tiny_validation_mass_matrix_row_major: tiny_validation
            .and_then(|problem| problem.mass_matrix_row_major)
            .map_or(std::ptr::null(), slice_ptr_or_null),
        tiny_validation_stiffness_diagonal: tiny_validation
            .and_then(|problem| problem.stiffness_diagonal)
            .map_or(std::ptr::null(), slice_ptr_or_null),
        tiny_validation_mass_diagonal: tiny_validation
            .and_then(|problem| problem.mass_diagonal)
            .map_or(std::ptr::null(), slice_ptr_or_null),
        mfem_operator_enabled: mfem_operator.is_some() as i32,
        mfem_tangent_dof_count: mfem_operator
            .map(|problem| problem.tangent_dof_count)
            .unwrap_or(0),
        mfem_stiffness_matrix_row_major: mfem_operator
            .and_then(|problem| problem.stiffness_matrix_row_major)
            .map_or(std::ptr::null(), slice_ptr_or_null),
        mfem_gyrotropic_matrix_row_major: mfem_operator
            .and_then(|problem| problem.gyrotropic_matrix_row_major)
            .map_or(std::ptr::null(), slice_ptr_or_null),
        mfem_mass_matrix_row_major: mfem_operator
            .and_then(|problem| problem.mass_matrix_row_major)
            .map_or(std::ptr::null(), slice_ptr_or_null),
        mfem_sparse_operator_enabled: mfem_sparse_operator.is_some() as i32,
        mfem_sparse_stiffness_csr: csr_matrix_view_or_zero(
            mfem_sparse_operator.map(|problem| &problem.stiffness_csr),
        ),
        mfem_sparse_gyrotropic_csr: csr_matrix_view_or_zero(
            mfem_sparse_operator.map(|problem| &problem.gyrotropic_csr),
        ),
        mfem_sparse_mass_csr: csr_matrix_view_or_zero(
            mfem_sparse_operator.map(|problem| &problem.mass_csr),
        ),
        has_floquet_k_vector: i32::from(has_floquet_k_vector),
        floquet_k_vector_rad_per_m: floquet_k_vector_rad_per_m.unwrap_or([0.0; 3]),
        phase_convention: map_phase_convention(
            mfem_operator
                .map(|problem| problem.phase_convention)
                .unwrap_or(FrequencyDomainPhaseConvention::ExpIOmegaT),
        ),
        mfem_floquet_periodic_pairs: if floquet_periodic_pairs.is_empty() {
            std::ptr::null()
        } else {
            floquet_periodic_pairs.as_ptr()
        },
        mfem_floquet_periodic_pair_count: floquet_periodic_pairs.len() as u64,
        poisson_airbox_block_enabled: poisson_airbox_block.is_some() as i32,
        poisson_airbox_q_dof_count: poisson_airbox_block
            .map(|problem| problem.q_dof_count)
            .unwrap_or(0),
        poisson_airbox_phi_dof_count: poisson_airbox_block
            .map(|problem| problem.phi_dof_count)
            .unwrap_or(0),
        poisson_airbox_a_qq_csr: csr_matrix_view_or_zero(
            poisson_airbox_block.map(|problem| &problem.a_qq_csr),
        ),
        poisson_airbox_a_qphi_csr: csr_matrix_view_or_zero(
            poisson_airbox_block.map(|problem| &problem.a_qphi_csr),
        ),
        poisson_airbox_a_phiq_csr: csr_matrix_view_or_zero(
            poisson_airbox_block.map(|problem| &problem.a_phiq_csr),
        ),
        poisson_airbox_a_phiphi_csr: csr_matrix_view_or_zero(
            poisson_airbox_block.map(|problem| &problem.a_phiphi_csr),
        ),
        poisson_airbox_b_qq_csr: csr_matrix_view_or_zero(
            poisson_airbox_block.map(|problem| &problem.b_qq_csr),
        ),
        poisson_airbox_phi_mean_weights: poisson_airbox_block
            .map(|problem| slice_ptr_or_null(problem.phi_mean_weights))
            .unwrap_or(std::ptr::null()),
        poisson_airbox_phi_mean_weights_count: poisson_airbox_block
            .map(|problem| problem.phi_mean_weights.len() as u64)
            .unwrap_or(0),
        poisson_airbox_target_frequency_hz: poisson_airbox_block
            .map(|problem| problem.target_frequency_hz)
            .unwrap_or(0.0),
        poisson_airbox_expected_reference_frequency_hz: poisson_airbox_block
            .map(|problem| problem.expected_reference_frequency_hz)
            .unwrap_or(0.0),
        poisson_airbox_periodic_mesh_certificate_schema:
            poisson_airbox_periodic_mesh_certificate_schema
                .as_ref()
                .map(|value| value.as_ptr())
                .unwrap_or(std::ptr::null()),
        poisson_airbox_magnetic_pair_count: poisson_airbox_block
            .map(|problem| problem.magnetic_pair_count)
            .unwrap_or(0),
        poisson_airbox_airbox_pair_count: poisson_airbox_block
            .map(|problem| problem.airbox_pair_count)
            .unwrap_or(0),
        poisson_airbox_shift_invert_action_enabled: poisson_airbox_shift_invert_action.is_some()
            as i32,
        poisson_airbox_shift_invert_action_device: poisson_airbox_shift_invert_action
            .map(|action| i32::from(action.use_gpu_hidden_action))
            .unwrap_or(0),
        poisson_airbox_shift_sigma_real: poisson_airbox_shift_invert_action
            .map(|action| action.sigma_real)
            .unwrap_or(0.0),
        poisson_airbox_shift_sigma_imag: poisson_airbox_shift_invert_action
            .map(|action| action.sigma_imag)
            .unwrap_or(0.0),
        poisson_airbox_shift_action_vector_real: poisson_airbox_shift_invert_action
            .map(|action| slice_ptr_or_null(action.vector_real))
            .unwrap_or(std::ptr::null()),
        poisson_airbox_shift_action_vector_imag: poisson_airbox_shift_invert_action
            .and_then(|action| action.vector_imag.map(slice_ptr_or_null))
            .unwrap_or(std::ptr::null()),
        poisson_airbox_shift_action_vector_count: poisson_airbox_shift_invert_action
            .map(|action| action.vector_real.len() as u64)
            .unwrap_or(0),
    };

    let mut ffi_result = NativeFrequencyDomainContractFfiResult {
        inner: unsafe { ffi::fullmag_fem_modal_eigen_solve(&ffi_request) },
    };
    let owned = ffi_result.to_owned_result();
    if ffi_result.inner.error_message.is_null() {
        ffi_result.inner.diagnostics_json = std::ptr::null_mut();
        ffi_result.inner.result_json = std::ptr::null_mut();
        ffi_result.inner.artifact_manifest_path = std::ptr::null_mut();
    } else {
        ffi_result.inner.error_message = std::ptr::null_mut();
        ffi_result.inner.diagnostics_json = std::ptr::null_mut();
        ffi_result.inner.result_json = std::ptr::null_mut();
        ffi_result.inner.artifact_manifest_path = std::ptr::null_mut();
    }
    Ok(owned)
}

#[cfg(feature = "fem-gpu")]
fn solve_native_driven_response_contract_impl(
    request: NativeDrivenResponseContractRequest<'_>,
) -> Result<NativeFrequencyDomainContractResult, String> {
    let mesh_asset_id = CString::new(request.mesh_asset_id.as_bytes())
        .map_err(|_| "native FEM driven_response mesh_asset_id contains NUL".to_string())?;
    let equilibrium_source_kind = CString::new(request.equilibrium_source_kind.as_bytes())
        .map_err(|_| {
            "native FEM driven_response equilibrium_source_kind contains NUL".to_string()
        })?;
    let damping_policy = CString::new(request.damping_policy.as_bytes())
        .map_err(|_| "native FEM driven_response damping_policy contains NUL".to_string())?;
    let spin_wave_bc_kind = CString::new(request.spin_wave_bc_kind.as_bytes())
        .map_err(|_| "native FEM driven_response spin_wave_bc_kind contains NUL".to_string())?;
    let demag_realization = request
        .demag_realization
        .map(|value| CString::new(value.as_bytes()))
        .transpose()
        .map_err(|_| "native FEM driven_response demag_realization contains NUL".to_string())?;
    let operator_diagnostics_json = request
        .operator_diagnostics_json
        .map(|value| CString::new(value.as_bytes()))
        .transpose()
        .map_err(|_| {
            "native FEM driven_response operator_diagnostics_json contains NUL".to_string()
        })?;
    let output_directory = request
        .output_directory
        .map(|path| CString::new(path.to_string_lossy().as_bytes()))
        .transpose()
        .map_err(|_| "native FEM driven_response output_directory contains NUL".to_string())?;

    let ffi_request = ffi::FullmagFemDrivenResponseRequest {
        abi_version: ffi::FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION,
        operator_request: ffi::FullmagFemLinearizedOperatorRequest {
            abi_version: ffi::FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION,
            mesh_asset_id: mesh_asset_id.as_ptr(),
            equilibrium_source_kind: equilibrium_source_kind.as_ptr(),
            gamma_rad_s_T: request.gamma_rad_s_t,
            mu0_T_m_A: request.mu0_t_m_a,
            alpha: request.alpha,
            include_exchange: i32::from(request.include_exchange),
            include_demag: i32::from(request.include_demag),
            demag_realization: optional_str_ptr(demag_realization.as_ref()),
            damping_policy: damping_policy.as_ptr(),
            spin_wave_bc_kind: spin_wave_bc_kind.as_ptr(),
            k_vector_rad_m: request
                .k_vector_rad_m
                .map_or(std::ptr::null(), |values| values.as_ptr()),
            k_vector_len: request
                .k_vector_rad_m
                .map_or(0, |values| values.len() as i32),
            operator_diagnostics_json: optional_str_ptr(operator_diagnostics_json.as_ref()),
        },
        frequencies_hz: request.frequencies_hz.as_ptr(),
        frequency_count: request.frequencies_hz.len() as i32,
        excitation_field_A_m: request.excitation_field_a_m.as_ptr(),
        excitation_field_len: request.excitation_field_a_m.len() as i32,
        excitation_phase_rad: request.excitation_phase_rad,
        residual_tolerance: request.residual_tolerance,
        max_linear_iterations: request.max_linear_iterations,
        output_directory: optional_str_ptr(output_directory.as_ref()),
        write_partial_artifacts: i32::from(request.write_partial_artifacts),
        cancel_user_data: std::ptr::null_mut(),
        cancel_requested: None,
        progress_user_data: std::ptr::null_mut(),
        progress_callback: None,
    };

    let mut ffi_result = NativeFrequencyDomainContractFfiResult {
        inner: unsafe { ffi::fullmag_fem_driven_response_solve(&ffi_request) },
    };
    let owned = ffi_result.to_owned_result();
    if ffi_result.inner.error_message.is_null() {
        ffi_result.inner.diagnostics_json = std::ptr::null_mut();
        ffi_result.inner.result_json = std::ptr::null_mut();
        ffi_result.inner.artifact_manifest_path = std::ptr::null_mut();
    } else {
        ffi_result.inner.error_message = std::ptr::null_mut();
        ffi_result.inner.diagnostics_json = std::ptr::null_mut();
        ffi_result.inner.result_json = std::ptr::null_mut();
        ffi_result.inner.artifact_manifest_path = std::ptr::null_mut();
    }
    Ok(owned)
}

#[cfg(not(feature = "fem-gpu"))]
fn solve_native_modal_eigen_impl(
    request: NativeModalEigenRequest<'_>,
) -> Result<NativeFrequencyDomainContractResult, String> {
    let _ = request;
    Err("native FEM modal eigen solve requires the fem-gpu feature".to_string())
}

#[cfg(not(feature = "fem-gpu"))]
fn solve_native_driven_response_contract_impl(
    request: NativeDrivenResponseContractRequest<'_>,
) -> Result<NativeFrequencyDomainContractResult, String> {
    let _ = request;
    Err("native FEM driven response solve requires the fem-gpu feature".to_string())
}

#[cfg(feature = "fem-gpu")]
fn map_dmi_kind(
    kind: NativeDrivenFrequencyResponseDmiKind,
) -> ffi::fullmag_fem_frequency_domain_dmi_kind {
    match kind {
        NativeDrivenFrequencyResponseDmiKind::Interfacial => {
            ffi::fullmag_fem_frequency_domain_dmi_kind::FULLMAG_FEM_FREQUENCY_DOMAIN_DMI_INTERFACIAL
        }
        NativeDrivenFrequencyResponseDmiKind::Bulk => {
            ffi::fullmag_fem_frequency_domain_dmi_kind::FULLMAG_FEM_FREQUENCY_DOMAIN_DMI_BULK
        }
    }
}

#[cfg(feature = "fem-gpu")]
fn optional_str_ptr(value: Option<&CString>) -> *const std::os::raw::c_char {
    value.map_or(std::ptr::null(), |value| value.as_ptr())
}

#[cfg(feature = "fem-gpu")]
fn map_execution_lane(
    execution_lane: NativeFrequencyDomainExecutionLane,
) -> ffi::fullmag_fem_frequency_domain_execution_lane {
    match execution_lane {
        NativeFrequencyDomainExecutionLane::Validation => {
            ffi::fullmag_fem_frequency_domain_execution_lane::FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_VALIDATION
        }
        NativeFrequencyDomainExecutionLane::ProductionCpu => {
            ffi::fullmag_fem_frequency_domain_execution_lane::FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_PRODUCTION_CPU
        }
        NativeFrequencyDomainExecutionLane::ProductionGpu => {
            ffi::fullmag_fem_frequency_domain_execution_lane::FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_PRODUCTION_GPU
        }
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
unsafe extern "C" fn dispatch_native_frequency_domain_cancel(user_data: *mut c_void) -> i32 {
    if user_data.is_null() {
        return 0;
    }
    let callback =
        unsafe { &*user_data.cast::<Option<&NativeFrequencyDomainCancelCallback<'_>>>() };
    if callback.is_some_and(|callback| callback()) {
        1
    } else {
        0
    }
}

#[cfg(feature = "fem-gpu")]
unsafe extern "C" fn dispatch_native_frequency_domain_progress(
    user_data: *mut c_void,
    progress: *const ffi::fullmag_fem_frequency_domain_progress,
) {
    if user_data.is_null() || progress.is_null() {
        return;
    }
    let callback =
        unsafe { &*user_data.cast::<Option<&NativeFrequencyDomainProgressCallback<'_>>>() };
    if let Some(callback) = callback {
        let progress = unsafe { *progress };
        callback(NativeFrequencyDomainProgress {
            frequency_index: progress.frequency_index,
            completed_frequency_count: progress.completed_frequency_count,
            total_frequency_count: progress.total_frequency_count,
            iteration_count: progress.iteration_count,
            frequency_hz: progress.frequency_hz,
            residual_l2_norm: progress.residual_l2_norm,
            relative_residual_l2_norm: progress.relative_residual_l2_norm,
            converged: progress.converged != 0,
        });
    }
}

#[cfg(feature = "fem-gpu")]
unsafe extern "C" fn dispatch_native_modal_eigen_progress_json(
    user_data: *mut c_void,
    progress_json: *const c_char,
) {
    if user_data.is_null() || progress_json.is_null() {
        return;
    }
    let callback = unsafe { &*user_data.cast::<Option<&NativeModalEigenProgressCallback<'_>>>() };
    if let Some(callback) = callback {
        let progress_json = unsafe { CStr::from_ptr(progress_json) }.to_string_lossy();
        callback(progress_json.as_ref());
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
                status:
                    ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OK,
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
struct NativeFrequencyDomainContractFfiResult {
    inner: ffi::FullmagFemFrequencyDomainResult,
}

#[cfg(feature = "fem-gpu")]
impl Default for NativeFrequencyDomainContractFfiResult {
    fn default() -> Self {
        Self {
            inner: ffi::FullmagFemFrequencyDomainResult {
                abi_version: ffi::FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION,
                status: ffi::FullmagFemFrequencyDomainStatus::FULLMAG_FEM_FD_UNAVAILABLE,
                error_message: std::ptr::null_mut(),
                diagnostics_json: std::ptr::null_mut(),
                result_json: std::ptr::null_mut(),
                artifact_manifest_path: std::ptr::null_mut(),
            },
        }
    }
}

#[cfg(feature = "fem-gpu")]
impl NativeFrequencyDomainContractFfiResult {
    fn to_owned_result(&self) -> NativeFrequencyDomainContractResult {
        NativeFrequencyDomainContractResult {
            status: map_contract_status(self.inner.status),
            error_message: ffi_string(self.inner.error_message),
            diagnostics_json: ffi_string(self.inner.diagnostics_json),
            result_json: ffi_string(self.inner.result_json),
            artifact_manifest_path: ffi_string(self.inner.artifact_manifest_path),
        }
    }
}

#[cfg(feature = "fem-gpu")]
impl Drop for NativeFrequencyDomainContractFfiResult {
    fn drop(&mut self) {
        unsafe {
            ffi::fullmag_fem_frequency_domain_result_destroy(&mut self.inner);
        }
    }
}

#[cfg(feature = "fem-gpu")]
fn ffi_string(value: *const std::os::raw::c_char) -> String {
    if value.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(value) }
            .to_string_lossy()
            .to_string()
    }
}

#[cfg(feature = "fem-gpu")]
fn map_status(status: ffi::fullmag_fem_frequency_domain_status) -> NativeFrequencyDomainStatus {
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

#[cfg(feature = "fem-gpu")]
fn map_contract_status(
    status: ffi::FullmagFemFrequencyDomainStatus,
) -> NativeFrequencyDomainStatus {
    match status {
        ffi::FullmagFemFrequencyDomainStatus::FULLMAG_FEM_FD_OK => NativeFrequencyDomainStatus::Ok,
        ffi::FullmagFemFrequencyDomainStatus::FULLMAG_FEM_FD_UNAVAILABLE => {
            NativeFrequencyDomainStatus::Unavailable
        }
        ffi::FullmagFemFrequencyDomainStatus::FULLMAG_FEM_FD_VALIDATION_ERROR => {
            NativeFrequencyDomainStatus::ValidationError
        }
        ffi::FullmagFemFrequencyDomainStatus::FULLMAG_FEM_FD_OPERATOR_ERROR => {
            NativeFrequencyDomainStatus::OperatorError
        }
        ffi::FullmagFemFrequencyDomainStatus::FULLMAG_FEM_FD_SOLVE_ERROR => {
            NativeFrequencyDomainStatus::SolveError
        }
        ffi::FullmagFemFrequencyDomainStatus::FULLMAG_FEM_FD_ARTIFACT_ERROR => {
            NativeFrequencyDomainStatus::ArtifactError
        }
        ffi::FullmagFemFrequencyDomainStatus::FULLMAG_FEM_FD_INTERRUPTED => {
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
            let err =
                solve_native_driven_frequency_response(NativeDrivenFrequencyResponseRequest {
                    node_count: 2,
                    tangent_dof_count: 4,
                    alpha: 0.01,
                    gamma0: 2.211e5,
                    execution_lane: NativeFrequencyDomainExecutionLane::Validation,
                    frequencies_hz: &frequencies_hz,
                    output_directory: Path::new(""),
                    write_response_fields: false,
                    write_partial_artifacts: false,
                    operator_diagnostics_json: None,
                    interrupt_requested: None,
                    cancel_requested: None,
                    progress_callback: None,
                    requires_periodic_airbox_dynamic_demag: false,
                    requires_floquet_airbox_dynamic_demag: false,
                    magnetic_periodic_constraint_set_count: 0,
                    magnetostatic_periodic_constraint_set_count: 0,
                    periodic_airbox_delta_m_tangent_dof_count: 0,
                    periodic_airbox_delta_phi_dof_count: 0,
                    periodic_airbox_magnetostatic_periodic_node_pairs: &[],
                    periodic_airbox_coupled_block_problem: None,
                    tiny_validation_problem: None,
                    mfem_operator_problem: None,
                })
                .expect_err("native solve should require fem-gpu feature");
            assert!(err.contains("fem-gpu"));
        }
    }

    #[test]
    fn native_frequency_domain_unavailable_modal_contract_is_structured() {
        #[cfg(not(feature = "fem-gpu"))]
        {
            let err = solve_native_modal_eigen(NativeModalEigenRequest {
                mesh_asset_id: "mesh",
                equilibrium_source_kind: "relax",
                gamma_rad_s_t: 1.760859e11,
                mu0_t_m_a: 1.25663706212e-6,
                alpha: 0.01,
                include_exchange: true,
                include_demag: false,
                demag_realization: None,
                damping_policy: "include",
                spin_wave_bc_kind: "free",
                k_vector_rad_m: None,
                operator_diagnostics_json: None,
                requested_mode_count: 8,
                target_kind: "frequency_window",
                target_frequency_hz: 0.0,
                frequency_min_hz: 1.0e8,
                frequency_max_hz: 5.0e9,
                residual_tolerance: 1.0e-8,
                max_outer_iterations: 32,
                max_linear_iterations: 128,
                output_directory: None,
                write_partial_artifacts: false,
                completeness_policy: 0,
                eigensolver_family: 0,
                spectral_transform_kind: 0,
                cancel_requested: None,
                progress_callback: None,
                tiny_validation_problem: None,
                mfem_operator_problem: None,
                mfem_sparse_operator_problem: None,
                poisson_airbox_block_problem: None,
            })
            .expect_err("native modal contract should require fem-gpu feature");
            assert!(err.contains("fem-gpu"));
        }

        #[cfg(feature = "fem-gpu")]
        {
            let result = solve_native_modal_eigen(NativeModalEigenRequest {
                mesh_asset_id: "mesh",
                equilibrium_source_kind: "relax",
                gamma_rad_s_t: 1.760859e11,
                mu0_t_m_a: 1.25663706212e-6,
                alpha: 0.01,
                include_exchange: true,
                include_demag: false,
                demag_realization: None,
                damping_policy: "include",
                spin_wave_bc_kind: "free",
                k_vector_rad_m: None,
                operator_diagnostics_json: None,
                requested_mode_count: 8,
                target_kind: "frequency_window",
                target_frequency_hz: 0.0,
                frequency_min_hz: 1.0e8,
                frequency_max_hz: 5.0e9,
                residual_tolerance: 1.0e-8,
                max_outer_iterations: 32,
                max_linear_iterations: 128,
                output_directory: None,
                write_partial_artifacts: false,
                completeness_policy: 0,
                eigensolver_family: 0,
                spectral_transform_kind: 0,
                cancel_requested: None,
                progress_callback: None,
                tiny_validation_problem: None,
                mfem_operator_problem: None,
                mfem_sparse_operator_problem: None,
                poisson_airbox_block_problem: None,
            })
            .expect("native modal contract should return a structured unavailable result");
            assert_eq!(result.status, NativeFrequencyDomainStatus::Unavailable);
            assert!(result.error_message.contains("modal_eigen"));
            assert!(result
                .diagnostics_json
                .contains("\"study_product\":\"modal_eigen\""));
            assert!(result
                .diagnostics_json
                .contains("\"unsupported_reason\":\"modal_solver_not_implemented\""));
            assert!(result.result_json.contains("\"status\":\"unavailable\""));
        }
    }

    #[test]
    fn native_floquet_pair_phase_metadata_rejects_inconsistent_phase() {
        let pairs = [NativeDrivenFrequencyResponseFloquetPeriodicPair {
            pair_id: Some("x_faces"),
            node_a: 0,
            node_b: 1,
            translation_m: Some([1.0e-6, 0.0, 0.0]),
            phase_rad: Some(-0.5),
        }];

        let err = validate_floquet_pair_phase_metadata(Some([1.0e6, 0.0, 0.0]), &pairs)
            .expect_err("inconsistent Floquet phase metadata should reject");

        assert!(err.contains("Floquet phase"), "{err}");
        assert!(err.contains("x_faces"), "{err}");
        assert!(err.contains("-1"), "{err}");
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn frequency_domain_operator_diagnostics_are_embedded_in_modal_contract_results() {
        let result = solve_native_modal_eigen(NativeModalEigenRequest {
            mesh_asset_id: "mesh",
            equilibrium_source_kind: "relax",
            gamma_rad_s_t: 1.760859e11,
            mu0_t_m_a: 1.25663706212e-6,
            alpha: 0.01,
            include_exchange: true,
            include_demag: false,
            demag_realization: None,
            damping_policy: "include",
            spin_wave_bc_kind: "free",
            k_vector_rad_m: None,
            operator_diagnostics_json: Some(
                "{\"schema_version\":\"frequency_domain_operator_diagnostics.v1\",\"active_node_count\":4,\"tangent_dof_count\":8}",
            ),
            requested_mode_count: 8,
            target_kind: "frequency_window",
            target_frequency_hz: 0.0,
            frequency_min_hz: 1.0e8,
            frequency_max_hz: 5.0e9,
            residual_tolerance: 1.0e-8,
            max_outer_iterations: 32,
            max_linear_iterations: 128,
            output_directory: None,
            write_partial_artifacts: false,
            completeness_policy: 0,
            eigensolver_family: 0,
            spectral_transform_kind: 0,
            cancel_requested: None,
            progress_callback: None,
            tiny_validation_problem: None,
            mfem_operator_problem: None,
            mfem_sparse_operator_problem: None,
        poisson_airbox_block_problem: None,
        })
        .expect("native modal contract should return a structured unavailable result");

        assert_eq!(result.status, NativeFrequencyDomainStatus::Unavailable);
        assert!(result
            .diagnostics_json
            .contains("\"operator_diagnostics\":{\"schema_version\":\"frequency_domain_operator_diagnostics.v1\""), "{}", result.diagnostics_json);
        assert!(
            result.diagnostics_json.contains("\"active_node_count\":4"),
            "{}",
            result.diagnostics_json
        );
        assert!(
            result.diagnostics_json.contains("\"tangent_dof_count\":8"),
            "{}",
            result.diagnostics_json
        );
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn modal_shift_invert_progress_reports_validation_solve() {
        use std::cell::RefCell;

        let stiffness_matrix_row_major = [1.0, 0.0, 0.0, 1.0];
        let gyrotropic_mass_row_major = [0.0, -1.0, 1.0, 0.0];
        let progress_events = RefCell::new(Vec::<String>::new());
        let progress_callback = |progress_json: &str| {
            progress_events.borrow_mut().push(progress_json.to_string());
        };

        let result = solve_native_modal_eigen(NativeModalEigenRequest {
            mesh_asset_id: "macrospin_validation",
            equilibrium_source_kind: "provided",
            gamma_rad_s_t: 1.760859e11,
            mu0_t_m_a: 1.25663706212e-6,
            alpha: 0.0,
            include_exchange: false,
            include_demag: false,
            demag_realization: None,
            damping_policy: "ignore",
            spin_wave_bc_kind: "free",
            k_vector_rad_m: None,
            operator_diagnostics_json: None,
            requested_mode_count: 1,
            target_kind: "nearest_frequency",
            target_frequency_hz: 0.16,
            frequency_min_hz: 0.0,
            frequency_max_hz: 1.0,
            residual_tolerance: 1.0e-12,
            max_outer_iterations: 32,
            max_linear_iterations: 128,
            output_directory: None,
            write_partial_artifacts: false,
            completeness_policy: 0,
            eigensolver_family: 0,
            spectral_transform_kind: 0,
            cancel_requested: None,
            progress_callback: Some(&progress_callback),
            tiny_validation_problem: Some(NativeModalEigenTinyValidationProblem {
                tangent_dof_count: 2,
                stiffness_matrix_row_major: Some(&stiffness_matrix_row_major),
                mass_matrix_row_major: Some(&gyrotropic_mass_row_major),
                stiffness_diagonal: None,
                mass_diagonal: None,
            }),
            mfem_operator_problem: None,
            mfem_sparse_operator_problem: None,
            poisson_airbox_block_problem: None,
        })
        .expect("native modal validation solve should return a structured result");

        assert_eq!(result.status, NativeFrequencyDomainStatus::Ok);
        assert!(result
            .diagnostics_json
            .contains("\"tiny_validation_solver\":true"));
        assert!(result.result_json.contains("\"status\":\"ok\""));
        let progress_events = progress_events.into_inner();
        assert_eq!(progress_events.len(), 1);
        assert!(progress_events[0].contains("\"solver_phase\":\"solving_shift_invert\""));
        assert!(progress_events[0].contains("\"outer_iteration\":1"));
        assert!(progress_events[0].contains("\"linear_iteration\":1"));
        assert!(progress_events[0].contains("\"accepted_mode_count\":1"));
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn modal_shift_invert_progress_cancel_returns_interrupted() {
        let stiffness_matrix_row_major = [1.0, 0.0, 0.0, 1.0];
        let gyrotropic_mass_row_major = [0.0, -1.0, 1.0, 0.0];
        let cancel_callback = || true;

        let result = solve_native_modal_eigen(NativeModalEigenRequest {
            mesh_asset_id: "macrospin_validation",
            equilibrium_source_kind: "provided",
            gamma_rad_s_t: 1.760859e11,
            mu0_t_m_a: 1.25663706212e-6,
            alpha: 0.0,
            include_exchange: false,
            include_demag: false,
            demag_realization: None,
            damping_policy: "ignore",
            spin_wave_bc_kind: "free",
            k_vector_rad_m: None,
            operator_diagnostics_json: None,
            requested_mode_count: 1,
            target_kind: "nearest_frequency",
            target_frequency_hz: 0.16,
            frequency_min_hz: 0.0,
            frequency_max_hz: 1.0,
            residual_tolerance: 1.0e-12,
            max_outer_iterations: 32,
            max_linear_iterations: 128,
            output_directory: None,
            write_partial_artifacts: false,
            completeness_policy: 0,
            eigensolver_family: 0,
            spectral_transform_kind: 0,
            cancel_requested: Some(&cancel_callback),
            progress_callback: None,
            tiny_validation_problem: Some(NativeModalEigenTinyValidationProblem {
                tangent_dof_count: 2,
                stiffness_matrix_row_major: Some(&stiffness_matrix_row_major),
                mass_matrix_row_major: Some(&gyrotropic_mass_row_major),
                stiffness_diagonal: None,
                mass_diagonal: None,
            }),
            mfem_operator_problem: None,
            mfem_sparse_operator_problem: None,
            poisson_airbox_block_problem: None,
        })
        .expect("native modal validation cancel should return a structured result");

        assert_eq!(result.status, NativeFrequencyDomainStatus::Interrupted);
        assert!(result
            .diagnostics_json
            .contains("\"status\":\"interrupted\""));
        assert!(result
            .diagnostics_json
            .contains("\"stop_reason\":\"cancel_requested\""));
        assert!(result.result_json.contains("\"status\":\"interrupted\""));
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn frequency_window_reports_window_diagnostics() {
        let stiffness_matrix_row_major = [1.0, 0.0, 0.0, 1.0];
        let gyrotropic_mass_row_major = [0.0, -1.0, 1.0, 0.0];

        let result = solve_native_modal_eigen(NativeModalEigenRequest {
            mesh_asset_id: "macrospin_validation",
            equilibrium_source_kind: "provided",
            gamma_rad_s_t: 1.760859e11,
            mu0_t_m_a: 1.25663706212e-6,
            alpha: 0.0,
            include_exchange: false,
            include_demag: false,
            demag_realization: None,
            damping_policy: "ignore",
            spin_wave_bc_kind: "free",
            k_vector_rad_m: None,
            operator_diagnostics_json: None,
            requested_mode_count: 1,
            target_kind: "frequency_window",
            target_frequency_hz: 0.0,
            frequency_min_hz: 0.1,
            frequency_max_hz: 0.5,
            residual_tolerance: 1.0e-12,
            max_outer_iterations: 32,
            max_linear_iterations: 128,
            output_directory: None,
            write_partial_artifacts: false,
            completeness_policy: 0,
            eigensolver_family: 0,
            spectral_transform_kind: 0,
            cancel_requested: None,
            progress_callback: None,
            tiny_validation_problem: Some(NativeModalEigenTinyValidationProblem {
                tangent_dof_count: 2,
                stiffness_matrix_row_major: Some(&stiffness_matrix_row_major),
                mass_matrix_row_major: Some(&gyrotropic_mass_row_major),
                stiffness_diagonal: None,
                mass_diagonal: None,
            }),
            mfem_operator_problem: None,
            mfem_sparse_operator_problem: None,
            poisson_airbox_block_problem: None,
        })
        .expect("native modal frequency-window validation solve should return a result");

        assert_eq!(result.status, NativeFrequencyDomainStatus::Ok);
        assert!(
            result.diagnostics_json.contains("\"requested_window_hz\""),
            "{}",
            result.diagnostics_json
        );
        assert!(
            result
                .diagnostics_json
                .contains("\"resolved_search_window_hz\""),
            "{}",
            result.diagnostics_json
        );
        assert!(
            result.diagnostics_json.contains("\"window_completeness\""),
            "{}",
            result.diagnostics_json
        );
        assert!(
            result
                .diagnostics_json
                .contains("\"policy\":\"best_effort\""),
            "{}",
            result.diagnostics_json
        );
        assert!(
            result
                .diagnostics_json
                .contains("\"status\":\"not_certified\""),
            "{}",
            result.diagnostics_json
        );
        assert!(
            result.diagnostics_json.contains("\"subwindows\""),
            "{}",
            result.diagnostics_json
        );
        assert!(
            result
                .result_json
                .contains("\"window_completeness\":\"not_certified\""),
            "{}",
            result.result_json
        );
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn frequency_window_mfem_payload_reaches_production_contour_bridge() {
        use std::cell::RefCell;

        let stiffness_matrix_row_major = [
            1.0, 0.0, 0.0, 0.0, //
            0.0, 1.0, 0.0, 0.0, //
            0.0, 0.0, 2.0, 0.0, //
            0.0, 0.0, 0.0, 2.0,
        ];
        let gyrotropic_mass_row_major = [
            0.0, -1.0, 0.0, 0.0, //
            1.0, 0.0, 0.0, 0.0, //
            0.0, 0.0, 0.0, -1.0, //
            0.0, 0.0, 1.0, 0.0,
        ];
        let mass_matrix_row_major = [
            1.0, 0.0, 0.0, 0.0, //
            0.0, 1.0, 0.0, 0.0, //
            0.0, 0.0, 1.0, 0.0, //
            0.0, 0.0, 0.0, 1.0,
        ];
        let progress_events = RefCell::new(Vec::<String>::new());
        let progress_callback = |progress_json: &str| {
            progress_events.borrow_mut().push(progress_json.to_string());
        };

        let result = solve_native_modal_eigen(NativeModalEigenRequest {
            mesh_asset_id: "mfem_dense_payload",
            equilibrium_source_kind: "provided",
            gamma_rad_s_t: 1.760859e11,
            mu0_t_m_a: 1.25663706212e-6,
            alpha: 0.0,
            include_exchange: false,
            include_demag: false,
            demag_realization: None,
            damping_policy: "ignore",
            spin_wave_bc_kind: "free",
            k_vector_rad_m: None,
            operator_diagnostics_json: Some(
                "{\"schema_version\":\"frequency_domain_operator_diagnostics.v1\",\"payload_kind\":\"dense_linearized_mfem_operator\"}",
            ),
            requested_mode_count: 4,
            target_kind: "frequency_window",
            target_frequency_hz: 0.0,
            frequency_min_hz: 0.1,
            frequency_max_hz: 0.5,
            residual_tolerance: 1.0e-10,
            max_outer_iterations: 32,
            max_linear_iterations: 128,
            output_directory: None,
            write_partial_artifacts: false,
            completeness_policy: 1,
            eigensolver_family: 2,
            spectral_transform_kind: 0,
            cancel_requested: None,
            progress_callback: Some(&progress_callback),
            tiny_validation_problem: None,
            mfem_operator_problem: Some(NativeModalEigenMfemOperatorProblem {
                tangent_dof_count: 4,
                stiffness_matrix_row_major: Some(&stiffness_matrix_row_major),
                gyrotropic_matrix_row_major: Some(&gyrotropic_mass_row_major),
                mass_matrix_row_major: Some(&mass_matrix_row_major),
                phase_convention: FrequencyDomainPhaseConvention::ExpIOmegaT,
                floquet_periodic_pairs: &[],
            }),
            mfem_sparse_operator_problem: None,
        poisson_airbox_block_problem: None,
        })
        .expect("native modal production payload should return a structured result");

        assert_eq!(result.status, NativeFrequencyDomainStatus::Ok);
        assert!(
            result
                .diagnostics_json
                .contains("\"execution_lane\":\"production_cpu\""),
            "{}",
            result.diagnostics_json
        );
        assert!(
            result
                .diagnostics_json
                .contains("\"mfem_operator_payload\":\"dense_gyrotropic_matrix\""),
            "{}",
            result.diagnostics_json
        );
        assert!(
            result
                .diagnostics_json
                .contains("\"resolved_solver_family\":\"contour_interval\""),
            "{}",
            result.diagnostics_json
        );
        assert!(
            result
                .diagnostics_json
                .contains("\"solver_model\":\"contour_interval_production_cpu_dense\""),
            "{}",
            result.diagnostics_json
        );
        assert!(
            result.diagnostics_json.contains(
                "\"operator_diagnostics\":{\"schema_version\":\"frequency_domain_operator_diagnostics.v1\""
            ),
            "{}",
            result.diagnostics_json
        );
        assert!(
            result
                .result_json
                .contains("\"window_completeness\":\"certified\""),
            "{}",
            result.result_json
        );
        assert!(
            result.result_json.contains("\"accepted_mode_count\":2"),
            "{}",
            result.result_json
        );
        assert_eq!(progress_events.into_inner().len(), 16);
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn frequency_window_mfem_payload_uses_production_shift_invert_when_requested() {
        let stiffness_matrix_row_major = [
            1.0, 0.0, 0.0, 0.0, //
            0.0, 1.0, 0.0, 0.0, //
            0.0, 0.0, 2.0, 0.0, //
            0.0, 0.0, 0.0, 2.0,
        ];
        let gyrotropic_mass_row_major = [
            0.0, -1.0, 0.0, 0.0, //
            1.0, 0.0, 0.0, 0.0, //
            0.0, 0.0, 0.0, -1.0, //
            0.0, 0.0, 1.0, 0.0,
        ];
        let mass_matrix_row_major = [
            1.0, 0.0, 0.0, 0.0, //
            0.0, 1.0, 0.0, 0.0, //
            0.0, 0.0, 1.0, 0.0, //
            0.0, 0.0, 0.0, 1.0,
        ];

        let result = solve_native_modal_eigen(NativeModalEigenRequest {
            mesh_asset_id: "mfem_dense_shift_invert_payload",
            equilibrium_source_kind: "provided",
            gamma_rad_s_t: 1.760859e11,
            mu0_t_m_a: 1.25663706212e-6,
            alpha: 0.0,
            include_exchange: false,
            include_demag: false,
            demag_realization: None,
            damping_policy: "ignore",
            spin_wave_bc_kind: "free",
            k_vector_rad_m: None,
            operator_diagnostics_json: Some(
                "{\"schema_version\":\"frequency_domain_operator_diagnostics.v1\",\"payload_kind\":\"dense_linearized_mfem_operator\"}",
            ),
            requested_mode_count: 2,
            target_kind: "frequency_window",
            target_frequency_hz: 0.0,
            frequency_min_hz: 0.1,
            frequency_max_hz: 0.5,
            residual_tolerance: 1.0e-10,
            max_outer_iterations: 32,
            max_linear_iterations: 128,
            output_directory: None,
            write_partial_artifacts: false,
            completeness_policy: 1,
            eigensolver_family: 1,
            spectral_transform_kind: 1,
            cancel_requested: None,
            progress_callback: None,
            tiny_validation_problem: None,
            mfem_operator_problem: Some(NativeModalEigenMfemOperatorProblem {
                tangent_dof_count: 4,
                stiffness_matrix_row_major: Some(&stiffness_matrix_row_major),
                gyrotropic_matrix_row_major: Some(&gyrotropic_mass_row_major),
                mass_matrix_row_major: Some(&mass_matrix_row_major),
                phase_convention: FrequencyDomainPhaseConvention::ExpIOmegaT,
                floquet_periodic_pairs: &[],
            }),
            mfem_sparse_operator_problem: None,
        poisson_airbox_block_problem: None,
        })
        .expect("native modal shift-invert payload should return a structured result");

        assert_eq!(result.status, NativeFrequencyDomainStatus::Ok);
        assert!(
            result
                .diagnostics_json
                .contains("\"resolved_solver_family\":\"shift_invert\""),
            "{}",
            result.diagnostics_json
        );
        assert!(
            result
                .diagnostics_json
                .contains("\"solver_model\":\"slepc_multi_shift_invert_production_cpu_dense\""),
            "{}",
            result.diagnostics_json
        );
        assert!(
            result.result_json.contains("\"accepted_mode_count\":2"),
            "{}",
            result.result_json
        );
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn modal_floquet_periodic_pairs_are_forwarded_to_native_diagnostics() {
        let stiffness_matrix_row_major = [1.0, 0.0, 0.0, 1.0];
        let gyrotropic_mass_row_major = [0.0, -1.0, 1.0, 0.0];
        let k_vector_rad_m = [1.0e6, 0.0, 0.0];
        let floquet_pairs = [NativeModalEigenFloquetPeriodicPair {
            pair_id: Some("x_faces"),
            node_a: 0,
            node_b: 1,
            translation_m: Some([1.0e-6, 0.0, 0.0]),
            phase_rad: Some(-1.0),
        }];

        let result = solve_native_modal_eigen(NativeModalEigenRequest {
            mesh_asset_id: "mfem_modal_floquet_payload",
            equilibrium_source_kind: "provided",
            gamma_rad_s_t: 1.760859e11,
            mu0_t_m_a: 1.25663706212e-6,
            alpha: 0.0,
            include_exchange: true,
            include_demag: false,
            demag_realization: None,
            damping_policy: "ignore",
            spin_wave_bc_kind: "floquet",
            k_vector_rad_m: Some(&k_vector_rad_m),
            operator_diagnostics_json: None,
            requested_mode_count: 2,
            target_kind: "frequency_window",
            target_frequency_hz: 0.0,
            frequency_min_hz: 0.1,
            frequency_max_hz: 0.5,
            residual_tolerance: 1.0e-10,
            max_outer_iterations: 32,
            max_linear_iterations: 128,
            output_directory: None,
            write_partial_artifacts: false,
            completeness_policy: 1,
            eigensolver_family: 1,
            spectral_transform_kind: 1,
            cancel_requested: None,
            progress_callback: None,
            tiny_validation_problem: None,
            mfem_operator_problem: Some(NativeModalEigenMfemOperatorProblem {
                tangent_dof_count: 2,
                stiffness_matrix_row_major: Some(&stiffness_matrix_row_major),
                gyrotropic_matrix_row_major: Some(&gyrotropic_mass_row_major),
                mass_matrix_row_major: None,
                phase_convention: FrequencyDomainPhaseConvention::ExpIOmegaT,
                floquet_periodic_pairs: &floquet_pairs,
            }),
            mfem_sparse_operator_problem: None,
            poisson_airbox_block_problem: None,
        })
        .expect("native modal Floquet payload should return a structured result");

        assert_eq!(result.status, NativeFrequencyDomainStatus::Unavailable);
        assert!(
            result
                .diagnostics_json
                .contains("\"production_cpu_rejection_reason\":\"production_cpu_modal_nonzero_k_floquet_operator_missing\""),
            "{}",
            result.diagnostics_json
        );
        assert!(
            result
                .diagnostics_json
                .contains("\"floquet_periodic_pair_count\":1"),
            "{}",
            result.diagnostics_json
        );
        assert!(
            result
                .diagnostics_json
                .contains("\"modal_periodic_pair_contract_available\":true"),
            "{}",
            result.diagnostics_json
        );
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn frequency_domain_operator_diagnostics_are_embedded_in_driven_contract_results() {
        let frequencies_hz = [1.0e9];
        let excitation_field_a_m = [0.0, 0.0, 1.0];
        let result = solve_native_driven_response_contract(NativeDrivenResponseContractRequest {
            mesh_asset_id: "mesh",
            equilibrium_source_kind: "relax",
            gamma_rad_s_t: 1.760859e11,
            mu0_t_m_a: 1.25663706212e-6,
            alpha: 0.01,
            include_exchange: true,
            include_demag: false,
            demag_realization: None,
            damping_policy: "include",
            spin_wave_bc_kind: "free",
            k_vector_rad_m: None,
            operator_diagnostics_json: Some(
                "{\"schema_version\":\"frequency_domain_operator_diagnostics.v1\",\"active_node_count\":6,\"tangent_dof_count\":12}",
            ),
            frequencies_hz: &frequencies_hz,
            excitation_field_a_m: &excitation_field_a_m,
            excitation_phase_rad: 0.0,
            residual_tolerance: 1.0e-8,
            max_linear_iterations: 64,
            output_directory: None,
            write_partial_artifacts: false,
        })
        .expect("native driven contract should return a structured validation result");

        assert_eq!(result.status, NativeFrequencyDomainStatus::ValidationError);
        assert!(result
            .diagnostics_json
            .contains("\"operator_diagnostics\":{\"schema_version\":\"frequency_domain_operator_diagnostics.v1\""), "{}", result.diagnostics_json);
        assert!(
            result.diagnostics_json.contains("\"active_node_count\":6"),
            "{}",
            result.diagnostics_json
        );
        assert!(
            result.diagnostics_json.contains("\"tangent_dof_count\":12"),
            "{}",
            result.diagnostics_json
        );
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn native_frequency_response_rejects_invalid_floquet_pair_id_before_ffi() {
        let frequencies_hz = [1.0e9];
        let equilibrium_m = [[1.0, 0.0, 0.0], [1.0, 0.0, 0.0]];
        let h_ext_a_per_m = [0.0, 0.0, 1.0];
        let drive_real = [0.0, 1.0, 0.0, 1.0];
        let floquet_pairs = [NativeDrivenFrequencyResponseFloquetPeriodicPair {
            pair_id: Some("bad\0pair"),
            node_a: 0,
            node_b: 1,
            translation_m: Some([1.0e-9, 0.0, 0.0]),
            phase_rad: Some(0.25),
        }];

        let err = solve_native_driven_frequency_response(NativeDrivenFrequencyResponseRequest {
            node_count: 2,
            tangent_dof_count: 4,
            alpha: 0.01,
            gamma0: 2.211e5,
            execution_lane: NativeFrequencyDomainExecutionLane::ProductionCpu,
            frequencies_hz: &frequencies_hz,
            output_directory: Path::new("/tmp"),
            write_response_fields: false,
            write_partial_artifacts: false,
            operator_diagnostics_json: None,
            interrupt_requested: None,
            cancel_requested: None,
            progress_callback: None,
            requires_periodic_airbox_dynamic_demag: false,
            requires_floquet_airbox_dynamic_demag: false,
            magnetic_periodic_constraint_set_count: 0,
            magnetostatic_periodic_constraint_set_count: 0,
            periodic_airbox_delta_m_tangent_dof_count: 0,
            periodic_airbox_delta_phi_dof_count: 0,
            periodic_airbox_magnetostatic_periodic_node_pairs: &[],
            periodic_airbox_coupled_block_problem: None,
            tiny_validation_problem: None,
            mfem_operator_problem: Some(NativeDrivenFrequencyResponseMfemOperatorProblem {
                equilibrium_m: &equilibrium_m,
                h_ext_a_per_m: &h_ext_a_per_m,
                uniaxial_anisotropy_axis: None,
                uniaxial_anisotropy_field_a_per_m: 0.0,
                alpha_per_node: None,
                drive_real: &drive_real,
                drive_imag: None,
                exchange_edges: &[],
                dmi_elements: &[],
                dmi_lumped_mass: None,
                dmi_ms_field: None,
                dmi_uniform_ms: 0.0,
                observable_ms_field: None,
                observable_uniform_ms: 0.0,
                include_zeeman: true,
                static_periodic_node_pairs: &[],
                floquet_k_vector_rad_per_m: Some([1.0e7, 0.0, 0.0]),
                phase_convention: FrequencyDomainPhaseConvention::ExpMinusIOmegaT,
                floquet_periodic_pairs: &floquet_pairs,
                #[cfg(feature = "fem-gpu")]
                apply_demag_tangent: None,
                apply_demag_tangent_with_potential: None,
                demag_tangent_user_data: std::ptr::null_mut(),
                demag_tangent_matrix_row_major: None,
            }),
        })
        .expect_err("invalid Floquet pair id should reject before C ABI call");

        assert!(err.contains("Floquet pair id contains NUL"), "{err}");
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn native_frequency_response_rejects_nonperiodic_floquet_drive_through_native_call() {
        let frequencies_hz = [1.0e9];
        let equilibrium_m = [[1.0, 0.0, 0.0], [1.0, 0.0, 0.0]];
        let h_ext_a_per_m = [0.0, 0.0, 1.0];
        let drive_real = [0.0, 1.0, 0.0, 1.0];
        let floquet_pairs = [NativeDrivenFrequencyResponseFloquetPeriodicPair {
            pair_id: Some("x_faces"),
            node_a: 0,
            node_b: 1,
            translation_m: Some([1.0e-9, 0.0, 0.0]),
            phase_rad: Some(-0.01),
        }];

        let result = solve_native_driven_frequency_response(NativeDrivenFrequencyResponseRequest {
            node_count: 2,
            tangent_dof_count: 4,
            alpha: 0.01,
            gamma0: 2.211e5,
            execution_lane: NativeFrequencyDomainExecutionLane::ProductionCpu,
            frequencies_hz: &frequencies_hz,
            output_directory: Path::new("/tmp"),
            write_response_fields: false,
            write_partial_artifacts: false,
            operator_diagnostics_json: None,
            interrupt_requested: None,
            cancel_requested: None,
            progress_callback: None,
            requires_periodic_airbox_dynamic_demag: false,
            requires_floquet_airbox_dynamic_demag: false,
            magnetic_periodic_constraint_set_count: 0,
            magnetostatic_periodic_constraint_set_count: 0,
            periodic_airbox_delta_m_tangent_dof_count: 0,
            periodic_airbox_delta_phi_dof_count: 0,
            periodic_airbox_magnetostatic_periodic_node_pairs: &[],
            periodic_airbox_coupled_block_problem: None,
            tiny_validation_problem: None,
            mfem_operator_problem: Some(NativeDrivenFrequencyResponseMfemOperatorProblem {
                equilibrium_m: &equilibrium_m,
                h_ext_a_per_m: &h_ext_a_per_m,
                uniaxial_anisotropy_axis: None,
                uniaxial_anisotropy_field_a_per_m: 0.0,
                alpha_per_node: None,
                drive_real: &drive_real,
                drive_imag: None,
                exchange_edges: &[],
                dmi_elements: &[],
                dmi_lumped_mass: None,
                dmi_ms_field: None,
                dmi_uniform_ms: 0.0,
                observable_ms_field: None,
                observable_uniform_ms: 0.0,
                include_zeeman: true,
                static_periodic_node_pairs: &[],
                floquet_k_vector_rad_per_m: Some([1.0e7, 0.0, 0.0]),
                phase_convention: FrequencyDomainPhaseConvention::ExpMinusIOmegaT,
                floquet_periodic_pairs: &floquet_pairs,
                #[cfg(feature = "fem-gpu")]
                apply_demag_tangent: None,
                apply_demag_tangent_with_potential: None,
                demag_tangent_user_data: std::ptr::null_mut(),
                demag_tangent_matrix_row_major: None,
            }),
        })
        .expect("native frequency response boundary should return a structured result");

        assert_eq!(result.status, NativeFrequencyDomainStatus::ValidationError);
        assert_eq!(result.total_frequency_count, 1);
        assert_eq!(result.completed_frequency_count, 0);
        assert_eq!(result.written_frequency_point_artifacts, 0);
        assert!(result
            .error_message
            .contains("Floquet-periodic tangent drive"));
        assert!(result
            .diagnostics_json
            .contains("frequency_domain_response_diagnostics.v1"));
        assert!(result
            .diagnostics_json
            .contains("\"validation_error\":\"floquet_drive_phase_mismatch\""));
        assert!(!result
            .diagnostics_json
            .contains("\"unsupported_reason\":\"floquet_bloch_nonzero_k\""));
        assert!(result
            .result_json
            .contains("\"status\":\"validation_error\""));
        assert_eq!(result.artifact_manifest_path, "");
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn native_frequency_response_floquet_drive_validation_writes_partial_artifacts() {
        let frequencies_hz = [1.0e9, 2.0e9];
        let equilibrium_m = [[1.0, 0.0, 0.0], [1.0, 0.0, 0.0]];
        let h_ext_a_per_m = [0.0, 0.0, 1.0];
        let drive_real = [0.0, 1.0, 0.0, 1.0];
        let floquet_pairs = [NativeDrivenFrequencyResponseFloquetPeriodicPair {
            pair_id: Some("x_faces"),
            node_a: 0,
            node_b: 1,
            translation_m: Some([1.0e-9, 0.0, 0.0]),
            phase_rad: Some(-0.01),
        }];
        let unique_suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-runner-native-frequency-response-floquet-unavailable-{}-{}",
            std::process::id(),
            unique_suffix
        ));

        let result = solve_native_driven_frequency_response(NativeDrivenFrequencyResponseRequest {
            node_count: 2,
            tangent_dof_count: 4,
            alpha: 0.01,
            gamma0: 2.211e5,
            execution_lane: NativeFrequencyDomainExecutionLane::ProductionCpu,
            frequencies_hz: &frequencies_hz,
            output_directory: &output_dir,
            write_response_fields: false,
            write_partial_artifacts: true,
            operator_diagnostics_json: None,
            interrupt_requested: None,
            cancel_requested: None,
            progress_callback: None,
            requires_periodic_airbox_dynamic_demag: false,
            requires_floquet_airbox_dynamic_demag: false,
            magnetic_periodic_constraint_set_count: 0,
            magnetostatic_periodic_constraint_set_count: 0,
            periodic_airbox_delta_m_tangent_dof_count: 0,
            periodic_airbox_delta_phi_dof_count: 0,
            periodic_airbox_magnetostatic_periodic_node_pairs: &[],
            periodic_airbox_coupled_block_problem: None,
            tiny_validation_problem: None,
            mfem_operator_problem: Some(NativeDrivenFrequencyResponseMfemOperatorProblem {
                equilibrium_m: &equilibrium_m,
                h_ext_a_per_m: &h_ext_a_per_m,
                uniaxial_anisotropy_axis: None,
                uniaxial_anisotropy_field_a_per_m: 0.0,
                alpha_per_node: None,
                drive_real: &drive_real,
                drive_imag: None,
                exchange_edges: &[],
                dmi_elements: &[],
                dmi_lumped_mass: None,
                dmi_ms_field: None,
                dmi_uniform_ms: 0.0,
                observable_ms_field: None,
                observable_uniform_ms: 0.0,
                include_zeeman: true,
                static_periodic_node_pairs: &[],
                floquet_k_vector_rad_per_m: Some([1.0e7, 0.0, 0.0]),
                phase_convention: FrequencyDomainPhaseConvention::ExpMinusIOmegaT,
                floquet_periodic_pairs: &floquet_pairs,
                #[cfg(feature = "fem-gpu")]
                apply_demag_tangent: None,
                apply_demag_tangent_with_potential: None,
                demag_tangent_user_data: std::ptr::null_mut(),
                demag_tangent_matrix_row_major: None,
            }),
        })
        .expect("native frequency response boundary should return a structured result");

        assert_eq!(result.status, NativeFrequencyDomainStatus::ValidationError);
        assert_eq!(result.total_frequency_count, 2);
        assert_eq!(result.completed_frequency_count, 0);
        assert_eq!(result.written_frequency_point_artifacts, 0);
        assert!(result
            .diagnostics_json
            .contains("\"validation_error\":\"floquet_drive_phase_mismatch\""));
        assert!(result
            .artifact_manifest_path
            .ends_with("frequency_domain/manifest.v1.json"));
        let manifest = std::fs::read_to_string(&result.artifact_manifest_path)
            .expect("Floquet drive-validation manifest should be readable");
        assert!(manifest.contains("\"status\":\"validation_error\""));
        assert!(manifest.contains("\"validation_error\":\"floquet_drive_phase_mismatch\""));
        assert!(!manifest.contains("response/magnetic_response_sweep.v1.json"));
        let diagnostics =
            std::fs::read_to_string(output_dir.join("response/diagnostics/solver.v1.json"))
                .expect("Floquet drive-validation diagnostics should be readable");
        assert!(diagnostics.contains("\"validation_error\":\"floquet_drive_phase_mismatch\""));
        assert!(!diagnostics.contains("\"unsupported_reason\":\"floquet_bloch_nonzero_k\""));
        let progress = std::fs::read_to_string(output_dir.join("response/progress.v1.json"))
            .expect("Floquet drive-validation progress should be readable");
        assert!(progress.contains("\"total_frequency_points\":2"));
        assert!(progress.contains("\"completed_frequency_points\":0"));
        assert!(progress.contains("\"status\":\"validation_error\""));
        assert!(!output_dir
            .join("response/magnetic_response_sweep.v1.json")
            .exists());
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn native_frequency_response_production_gpu_runs_floquet_exchange_no_demag() {
        let frequencies_hz = [0.15915494309189535];
        let equilibrium_m = [[0.0, 0.0, 1.0], [0.0, 0.0, 1.0]];
        let h_ext_a_per_m = [0.0, 0.0, 1.0];
        let drive_real = [1.0, 0.0, 0.0, 0.0];
        let drive_imag = [0.0, 0.0, -1.0, 0.0];
        let exchange_edges = [NativeDrivenFrequencyResponseExchangeEdge {
            node_i: 0,
            node_j: 1,
            stiffness: 0.25,
        }];
        let floquet_pairs = [NativeDrivenFrequencyResponseFloquetPeriodicPair {
            pair_id: Some("x_faces"),
            node_a: 0,
            node_b: 1,
            translation_m: Some([1.0e-6, 0.0, 0.0]),
            phase_rad: Some(-std::f64::consts::FRAC_PI_2),
        }];
        let unique_suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-runner-native-frequency-response-gpu-floquet-exchange-{}-{}",
            std::process::id(),
            unique_suffix
        ));

        let result = solve_native_driven_frequency_response(NativeDrivenFrequencyResponseRequest {
            node_count: 2,
            tangent_dof_count: 4,
            alpha: 0.01,
            gamma0: 2.211e5,
            execution_lane: NativeFrequencyDomainExecutionLane::ProductionGpu,
            frequencies_hz: &frequencies_hz,
            output_directory: &output_dir,
            write_response_fields: true,
            write_partial_artifacts: true,
            operator_diagnostics_json: None,
            interrupt_requested: None,
            cancel_requested: None,
            progress_callback: None,
            requires_periodic_airbox_dynamic_demag: false,
            requires_floquet_airbox_dynamic_demag: false,
            magnetic_periodic_constraint_set_count: 0,
            magnetostatic_periodic_constraint_set_count: 0,
            periodic_airbox_delta_m_tangent_dof_count: 0,
            periodic_airbox_delta_phi_dof_count: 0,
            periodic_airbox_magnetostatic_periodic_node_pairs: &[],
            periodic_airbox_coupled_block_problem: None,
            tiny_validation_problem: None,
            mfem_operator_problem: Some(NativeDrivenFrequencyResponseMfemOperatorProblem {
                equilibrium_m: &equilibrium_m,
                h_ext_a_per_m: &h_ext_a_per_m,
                uniaxial_anisotropy_axis: None,
                uniaxial_anisotropy_field_a_per_m: 0.0,
                alpha_per_node: None,
                drive_real: &drive_real,
                drive_imag: Some(&drive_imag),
                exchange_edges: &exchange_edges,
                dmi_elements: &[],
                dmi_lumped_mass: None,
                dmi_ms_field: None,
                dmi_uniform_ms: 0.0,
                observable_ms_field: None,
                observable_uniform_ms: 0.0,
                include_zeeman: true,
                static_periodic_node_pairs: &[],
                floquet_k_vector_rad_per_m: Some([1.5707963267948966e6, 0.0, 0.0]),
                phase_convention: FrequencyDomainPhaseConvention::ExpMinusIOmegaT,
                floquet_periodic_pairs: &floquet_pairs,
                #[cfg(feature = "fem-gpu")]
                apply_demag_tangent: None,
                apply_demag_tangent_with_potential: None,
                demag_tangent_user_data: std::ptr::null_mut(),
                demag_tangent_matrix_row_major: None,
            }),
        })
        .expect("native frequency response boundary should return a structured result");

        assert_eq!(
            result.status,
            NativeFrequencyDomainStatus::Ok,
            "error_message={}, diagnostics_json={}",
            result.error_message,
            result.diagnostics_json
        );
        assert_eq!(result.total_frequency_count, 1);
        assert_eq!(result.completed_frequency_count, 1);
        assert!(result
            .diagnostics_json
            .contains("\"requested_execution_lane\":\"production_gpu\""));
        assert!(result
            .diagnostics_json
            .contains("\"resolved_execution_lane\":\"production_gpu\""));
        assert!(result
            .diagnostics_json
            .contains("\"floquet_phase_projection\":true"));
        assert!(result
            .diagnostics_json
            .contains("\"validation_fallback_used\":false"));
        assert!(result
            .diagnostics_json
            .contains("\"operator_terms_included\":[\"exchange\",\"zeeman\"]"));
        assert!(result.result_json.contains("\"status\":\"ok\""));
        assert!(output_dir
            .join("frequency_domain/manifest.v1.json")
            .exists());
        assert!(output_dir
            .join("response/frequency_points/frequency_0000.json")
            .exists());

        let _ = std::fs::remove_dir_all(output_dir);
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

        let result = solve_native_driven_frequency_response(NativeDrivenFrequencyResponseRequest {
            node_count: 1,
            tangent_dof_count: 2,
            alpha: 0.01,
            gamma0: 2.211e5,
            execution_lane: NativeFrequencyDomainExecutionLane::Validation,
            frequencies_hz: &frequencies_hz,
            output_directory: &output_dir,
            write_response_fields: false,
            write_partial_artifacts: false,
            operator_diagnostics_json: None,
            interrupt_requested: None,
            cancel_requested: None,
            progress_callback: None,
            requires_periodic_airbox_dynamic_demag: false,
            requires_floquet_airbox_dynamic_demag: false,
            magnetic_periodic_constraint_set_count: 0,
            magnetostatic_periodic_constraint_set_count: 0,
            periodic_airbox_delta_m_tangent_dof_count: 0,
            periodic_airbox_delta_phi_dof_count: 0,
            periodic_airbox_magnetostatic_periodic_node_pairs: &[],
            periodic_airbox_coupled_block_problem: None,
            mfem_operator_problem: None,
            tiny_validation_problem: Some(NativeDrivenFrequencyResponseTinyValidationProblem {
                tangent_dof_count: 2,
                stiffness_matrix_row_major: None,
                mass_matrix_row_major: None,
                stiffness_diagonal: Some(&stiffness_diagonal),
                mass_diagonal: Some(&mass_diagonal),
                drive_real: &drive_real,
                drive_imag: None,
            }),
        })
        .expect("native frequency response boundary should return a structured result");

        assert_eq!(result.status, NativeFrequencyDomainStatus::Ok);
        assert_eq!(result.total_frequency_count, 1);
        assert_eq!(result.completed_frequency_count, 1);
        assert_eq!(result.written_frequency_point_artifacts, 0);
        assert!(result
            .diagnostics_json
            .contains("frequency_domain_response_diagnostics.v1"));
        assert!(result
            .diagnostics_json
            .contains("\"tiny_validation_solver\":true"));
        assert!(result.result_json.contains("\"status\":\"ok\""));
        assert!(result.result_json.contains("\"max_abs_response\""));
        assert_eq!(result.artifact_manifest_path, "");
        assert!(!output_dir
            .join("frequency_domain/manifest.v1.json")
            .exists());
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn native_frequency_response_preserves_tiny_validation_solve_error() {
        let frequencies_hz = [0.15915494309189535];
        let stiffness_diagonal = [0.0, 0.0];
        let mass_diagonal = [0.0, 0.0];
        let drive_real = [1.0, 0.0];

        let result = solve_native_driven_frequency_response(NativeDrivenFrequencyResponseRequest {
            node_count: 1,
            tangent_dof_count: 2,
            alpha: 0.01,
            gamma0: 2.211e5,
            execution_lane: NativeFrequencyDomainExecutionLane::Validation,
            frequencies_hz: &frequencies_hz,
            output_directory: Path::new(""),
            write_response_fields: false,
            write_partial_artifacts: false,
            operator_diagnostics_json: None,
            interrupt_requested: None,
            cancel_requested: None,
            progress_callback: None,
            requires_periodic_airbox_dynamic_demag: false,
            requires_floquet_airbox_dynamic_demag: false,
            magnetic_periodic_constraint_set_count: 0,
            magnetostatic_periodic_constraint_set_count: 0,
            periodic_airbox_delta_m_tangent_dof_count: 0,
            periodic_airbox_delta_phi_dof_count: 0,
            periodic_airbox_magnetostatic_periodic_node_pairs: &[],
            periodic_airbox_coupled_block_problem: None,
            mfem_operator_problem: None,
            tiny_validation_problem: Some(NativeDrivenFrequencyResponseTinyValidationProblem {
                tangent_dof_count: 2,
                stiffness_matrix_row_major: None,
                mass_matrix_row_major: None,
                stiffness_diagonal: Some(&stiffness_diagonal),
                mass_diagonal: Some(&mass_diagonal),
                drive_real: &drive_real,
                drive_imag: None,
            }),
        })
        .expect("native frequency response boundary should return a structured result");

        assert_eq!(result.status, NativeFrequencyDomainStatus::SolveError);
        assert_eq!(result.completed_frequency_count, 0);
        assert_eq!(result.written_frequency_point_artifacts, 0);
        assert!(result.error_message.contains("singular"));
        assert!(result.result_json.contains("\"status\":\"solve_error\""));
        assert!(result
            .diagnostics_json
            .contains("\"schema_version\":\"frequency_domain_response_diagnostics.v1\""));
        assert!(result
            .diagnostics_json
            .contains("\"status\":\"solve_error\""));
        assert!(!result.result_json.contains("\"status\":\"artifact_error\""));
        assert!(!result
            .diagnostics_json
            .contains("\"status\":\"artifact_error\""));
        assert_eq!(result.artifact_manifest_path, "");
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn native_frequency_response_production_cpu_does_not_fallback_to_validation() {
        let frequencies_hz = [1.0e9];
        let stiffness_diagonal = [2.0, 4.0];
        let mass_diagonal = [1.0, 2.0];
        let drive_real = [1.0, 2.0];

        let result = solve_native_driven_frequency_response(NativeDrivenFrequencyResponseRequest {
            node_count: 1,
            tangent_dof_count: 2,
            alpha: 0.01,
            gamma0: 2.211e5,
            execution_lane: NativeFrequencyDomainExecutionLane::ProductionCpu,
            frequencies_hz: &frequencies_hz,
            output_directory: Path::new(""),
            write_response_fields: false,
            write_partial_artifacts: false,
            operator_diagnostics_json: None,
            interrupt_requested: None,
            cancel_requested: None,
            progress_callback: None,
            requires_periodic_airbox_dynamic_demag: false,
            requires_floquet_airbox_dynamic_demag: false,
            magnetic_periodic_constraint_set_count: 0,
            magnetostatic_periodic_constraint_set_count: 0,
            periodic_airbox_delta_m_tangent_dof_count: 0,
            periodic_airbox_delta_phi_dof_count: 0,
            periodic_airbox_magnetostatic_periodic_node_pairs: &[],
            periodic_airbox_coupled_block_problem: None,
            mfem_operator_problem: None,
            tiny_validation_problem: Some(NativeDrivenFrequencyResponseTinyValidationProblem {
                tangent_dof_count: 2,
                stiffness_matrix_row_major: None,
                mass_matrix_row_major: None,
                stiffness_diagonal: Some(&stiffness_diagonal),
                mass_diagonal: Some(&mass_diagonal),
                drive_real: &drive_real,
                drive_imag: None,
            }),
        })
        .expect("native frequency response boundary should return a structured result");

        assert_eq!(result.status, NativeFrequencyDomainStatus::Unavailable);
        assert_eq!(result.completed_frequency_count, 0);
        assert!(result.error_message.contains("production CPU"));
        assert!(result
            .diagnostics_json
            .contains("\"requested_execution_lane\":\"production_cpu\""));
        assert!(result
            .diagnostics_json
            .contains("\"validation_fallback_used\":false"));
        assert!(!result
            .diagnostics_json
            .contains("\"tiny_validation_solver\":true"));

        let gpu_result =
            solve_native_driven_frequency_response(NativeDrivenFrequencyResponseRequest {
                node_count: 1,
                tangent_dof_count: 2,
                alpha: 0.01,
                gamma0: 2.211e5,
                execution_lane: NativeFrequencyDomainExecutionLane::ProductionGpu,
                frequencies_hz: &frequencies_hz,
                output_directory: Path::new(""),
                write_response_fields: false,
                write_partial_artifacts: false,
                operator_diagnostics_json: None,
                interrupt_requested: None,
                cancel_requested: None,
                progress_callback: None,
                requires_periodic_airbox_dynamic_demag: false,
                requires_floquet_airbox_dynamic_demag: false,
                magnetic_periodic_constraint_set_count: 0,
                magnetostatic_periodic_constraint_set_count: 0,
                periodic_airbox_delta_m_tangent_dof_count: 0,
                periodic_airbox_delta_phi_dof_count: 0,
                periodic_airbox_magnetostatic_periodic_node_pairs: &[],
                periodic_airbox_coupled_block_problem: None,
                mfem_operator_problem: None,
                tiny_validation_problem: Some(NativeDrivenFrequencyResponseTinyValidationProblem {
                    tangent_dof_count: 2,
                    stiffness_matrix_row_major: None,
                    mass_matrix_row_major: None,
                    stiffness_diagonal: Some(&stiffness_diagonal),
                    mass_diagonal: Some(&mass_diagonal),
                    drive_real: &drive_real,
                    drive_imag: None,
                }),
            })
            .expect("native frequency response boundary should return a structured result");

        assert_eq!(gpu_result.status, NativeFrequencyDomainStatus::Unavailable);
        assert_eq!(gpu_result.completed_frequency_count, 0);
        assert!(gpu_result.error_message.contains("production GPU"));
        assert!(gpu_result
            .diagnostics_json
            .contains("\"requested_execution_lane\":\"production_gpu\""));
        assert!(gpu_result
            .diagnostics_json
            .contains("\"validation_fallback_used\":false"));
        assert!(!gpu_result
            .diagnostics_json
            .contains("\"tiny_validation_solver\":true"));
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn native_frequency_domain_status_bridge_maps_all_c_abi_statuses() {
        assert_eq!(
            map_status(
                ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OK
            ),
            NativeFrequencyDomainStatus::Ok
        );
        assert_eq!(
            map_status(
                ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_UNAVAILABLE
            ),
            NativeFrequencyDomainStatus::Unavailable
        );
        assert_eq!(
            map_status(
                ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_VALIDATION_ERROR
            ),
            NativeFrequencyDomainStatus::ValidationError
        );
        assert_eq!(
            map_status(
                ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OPERATOR_ERROR
            ),
            NativeFrequencyDomainStatus::OperatorError
        );
        assert_eq!(
            map_status(
                ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_SOLVE_ERROR
            ),
            NativeFrequencyDomainStatus::SolveError
        );
        assert_eq!(
            map_status(
                ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_ARTIFACT_ERROR
            ),
            NativeFrequencyDomainStatus::ArtifactError
        );
        assert_eq!(
            map_status(
                ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_INTERRUPTED
            ),
            NativeFrequencyDomainStatus::Interrupted
        );
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn native_frequency_response_progress_callback_bridge_maps_c_abi_progress() {
        use std::cell::RefCell;

        let observed = RefCell::new(Vec::new());
        let callback = |progress: NativeFrequencyDomainProgress| {
            observed.borrow_mut().push(progress);
        };
        let callback_ref: Option<&NativeFrequencyDomainProgressCallback<'_>> = Some(&callback);
        let ffi_progress = ffi::fullmag_fem_frequency_domain_progress {
            frequency_index: 2,
            completed_frequency_count: 3,
            total_frequency_count: 5,
            iteration_count: 13,
            frequency_hz: 4.25e9,
            residual_l2_norm: 1.0e-8,
            relative_residual_l2_norm: 2.5e-9,
            converged: 1,
        };

        unsafe {
            dispatch_native_frequency_domain_progress(
                (&callback_ref as *const Option<&NativeFrequencyDomainProgressCallback<'_>>)
                    as *mut c_void,
                &ffi_progress,
            );
        }

        let observed = observed.borrow();
        assert_eq!(
            observed.as_slice(),
            &[NativeFrequencyDomainProgress {
                frequency_index: 2,
                completed_frequency_count: 3,
                total_frequency_count: 5,
                iteration_count: 13,
                frequency_hz: 4.25e9,
                residual_l2_norm: 1.0e-8,
                relative_residual_l2_norm: 2.5e-9,
                converged: true,
            }]
        );
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn native_frequency_response_cancel_callback_bridge_maps_rust_callback() {
        let cancel_requested = || true;
        let cancel_ref: Option<&NativeFrequencyDomainCancelCallback<'_>> = Some(&cancel_requested);

        let cancelled = unsafe {
            dispatch_native_frequency_domain_cancel(
                (&cancel_ref as *const Option<&NativeFrequencyDomainCancelCallback<'_>>)
                    as *mut c_void,
            )
        };

        assert_eq!(cancelled, 1);
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    #[ignore = "requires native FEM library with production CPU MFEM-operator support"]
    fn native_frequency_response_production_cpu_runs_mfem_operator_and_writes_artifacts() {
        let frequencies_hz = [0.15915494309189535];
        let equilibrium_m = [[0.0, 0.0, 1.0]];
        let h_ext_a_per_m = [0.0, 0.0, 2.0];
        let drive_real = [1.0, 0.0];
        let exchange_edges = [];
        let unique_suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-runner-native-frequency-response-production-cpu-{}-{}",
            std::process::id(),
            unique_suffix
        ));

        let result = solve_native_driven_frequency_response(NativeDrivenFrequencyResponseRequest {
            node_count: 1,
            tangent_dof_count: 2,
            alpha: 0.01,
            gamma0: 2.211e5,
            execution_lane: NativeFrequencyDomainExecutionLane::ProductionCpu,
            frequencies_hz: &frequencies_hz,
            output_directory: &output_dir,
            write_response_fields: true,
            write_partial_artifacts: true,
            operator_diagnostics_json: None,
            interrupt_requested: None,
            cancel_requested: None,
            progress_callback: None,
            requires_periodic_airbox_dynamic_demag: false,
            requires_floquet_airbox_dynamic_demag: false,
            magnetic_periodic_constraint_set_count: 0,
            magnetostatic_periodic_constraint_set_count: 0,
            periodic_airbox_delta_m_tangent_dof_count: 0,
            periodic_airbox_delta_phi_dof_count: 0,
            periodic_airbox_magnetostatic_periodic_node_pairs: &[],
            periodic_airbox_coupled_block_problem: None,
            tiny_validation_problem: None,
            mfem_operator_problem: Some(NativeDrivenFrequencyResponseMfemOperatorProblem {
                equilibrium_m: &equilibrium_m,
                h_ext_a_per_m: &h_ext_a_per_m,
                uniaxial_anisotropy_axis: None,
                uniaxial_anisotropy_field_a_per_m: 0.0,
                alpha_per_node: None,
                drive_real: &drive_real,
                drive_imag: None,
                exchange_edges: &exchange_edges,
                dmi_elements: &[],
                dmi_lumped_mass: None,
                dmi_ms_field: None,
                dmi_uniform_ms: 0.0,
                observable_ms_field: None,
                observable_uniform_ms: 0.0,
                include_zeeman: true,
                static_periodic_node_pairs: &[],
                floquet_k_vector_rad_per_m: None,
                phase_convention: FrequencyDomainPhaseConvention::ExpIOmegaT,
                floquet_periodic_pairs: &[],
                #[cfg(feature = "fem-gpu")]
                apply_demag_tangent: None,
                apply_demag_tangent_with_potential: None,
                demag_tangent_user_data: std::ptr::null_mut(),
                demag_tangent_matrix_row_major: None,
            }),
        })
        .expect("native frequency response boundary should return a structured result");

        assert_eq!(
            result.status,
            NativeFrequencyDomainStatus::Ok,
            "error_message={}, diagnostics_json={}",
            result.error_message,
            result.diagnostics_json
        );
        assert_eq!(result.total_frequency_count, 1);
        assert_eq!(result.completed_frequency_count, 1);
        assert_eq!(result.written_frequency_point_artifacts, 1);
        assert!(result
            .diagnostics_json
            .contains("\"requested_execution_lane\":\"production_cpu\""));
        assert!(result
            .diagnostics_json
            .contains("\"matrix_free_solver\":true"));
        assert!(result
            .diagnostics_json
            .contains("\"validation_fallback_used\":false"));
        assert!(!result
            .diagnostics_json
            .contains("\"tiny_validation_solver\":true"));
        assert!(result.result_json.contains("\"status\":\"ok\""));
        assert!(result.result_json.contains("\"max_abs_response\""));
        assert!(output_dir
            .join("frequency_domain/manifest.v1.json")
            .exists());
        assert!(output_dir
            .join("response/magnetic_response_sweep.v2.json")
            .exists());
        assert!(output_dir
            .join("response/field_payloads/frequency_0000/vector.bin")
            .exists());

        let _ = std::fs::remove_dir_all(output_dir);
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    #[ignore = "requires native FEM library with production CPU MFEM-operator support"]
    fn native_frequency_response_production_cpu_passes_explicit_demag_tangent_matrix() {
        let frequencies_hz = [0.15915494309189535];
        let equilibrium_m = [[0.0, 0.0, 1.0]];
        let h_ext_a_per_m = [0.0, 0.0, 1.0];
        let drive_real = [1.0, 0.0];
        let demag_tangent_matrix = [0.5, 0.0, 0.0, 0.25];

        let result = solve_native_driven_frequency_response(NativeDrivenFrequencyResponseRequest {
            node_count: 1,
            tangent_dof_count: 2,
            alpha: 0.01,
            gamma0: 2.211e5,
            execution_lane: NativeFrequencyDomainExecutionLane::ProductionCpu,
            frequencies_hz: &frequencies_hz,
            output_directory: Path::new(""),
            write_response_fields: false,
            write_partial_artifacts: false,
            operator_diagnostics_json: None,
            interrupt_requested: None,
            cancel_requested: None,
            progress_callback: None,
            requires_periodic_airbox_dynamic_demag: false,
            requires_floquet_airbox_dynamic_demag: false,
            magnetic_periodic_constraint_set_count: 0,
            magnetostatic_periodic_constraint_set_count: 0,
            periodic_airbox_delta_m_tangent_dof_count: 0,
            periodic_airbox_delta_phi_dof_count: 0,
            periodic_airbox_magnetostatic_periodic_node_pairs: &[],
            periodic_airbox_coupled_block_problem: None,
            tiny_validation_problem: None,
            mfem_operator_problem: Some(NativeDrivenFrequencyResponseMfemOperatorProblem {
                equilibrium_m: &equilibrium_m,
                h_ext_a_per_m: &h_ext_a_per_m,
                uniaxial_anisotropy_axis: None,
                uniaxial_anisotropy_field_a_per_m: 0.0,
                alpha_per_node: None,
                drive_real: &drive_real,
                drive_imag: None,
                exchange_edges: &[],
                dmi_elements: &[],
                dmi_lumped_mass: None,
                dmi_ms_field: None,
                dmi_uniform_ms: 0.0,
                observable_ms_field: None,
                observable_uniform_ms: 0.0,
                include_zeeman: true,
                static_periodic_node_pairs: &[],
                floquet_k_vector_rad_per_m: None,
                phase_convention: FrequencyDomainPhaseConvention::ExpIOmegaT,
                floquet_periodic_pairs: &[],
                #[cfg(feature = "fem-gpu")]
                apply_demag_tangent: None,
                apply_demag_tangent_with_potential: None,
                demag_tangent_user_data: std::ptr::null_mut(),
                demag_tangent_matrix_row_major: Some(&demag_tangent_matrix),
            }),
        })
        .expect(
            "native frequency response explicit demag matrix should return a structured result",
        );

        assert_eq!(
            result.status,
            NativeFrequencyDomainStatus::Ok,
            "error_message={}, diagnostics_json={}",
            result.error_message,
            result.diagnostics_json
        );
        assert_eq!(result.completed_frequency_count, 1);
        assert!(result
            .diagnostics_json
            .contains("\"matrix_free_solver\":true"));
        assert!(result
            .diagnostics_json
            .contains("\"validation_fallback_used\":false"));
        assert!(result.result_json.contains("\"status\":\"ok\""));
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    #[ignore = "requires native FEM library with production CPU MFEM-operator support"]
    fn native_frequency_response_production_cpu_runs_mfem_dmi_operator() {
        let frequencies_hz = [0.15915494309189535];
        let equilibrium_m = [
            [0.0, 0.0, 1.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, 1.0],
        ];
        let h_ext_a_per_m = [0.0, 0.0, 0.0];
        let drive_real = [1.0, 0.0, 0.5, 0.0, -0.25, 0.0, 0.125, 0.0];
        let exchange_edges = [];
        let volume = 1.0 / 6.0;
        let lumped_mass = volume * 0.25;
        let dmi_lumped_mass = [lumped_mass, lumped_mass, lumped_mass, lumped_mass];
        let dmi_elements = [NativeDrivenFrequencyResponseDmiElement {
            kind: NativeDrivenFrequencyResponseDmiKind::Bulk,
            node_indices: [0, 1, 2, 3],
            shape: [0.25, 0.25, 0.25, 0.25],
            grad_shape: [
                -1.0, -1.0, -1.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0,
            ],
            weight: volume,
            d: 2.0e-3,
            normal: [0.0, 0.0, 1.0],
        }];

        let result = solve_native_driven_frequency_response(NativeDrivenFrequencyResponseRequest {
            node_count: 4,
            tangent_dof_count: 8,
            alpha: 0.01,
            gamma0: 1.0,
            execution_lane: NativeFrequencyDomainExecutionLane::ProductionCpu,
            frequencies_hz: &frequencies_hz,
            output_directory: Path::new(""),
            write_response_fields: false,
            write_partial_artifacts: false,
            operator_diagnostics_json: None,
            interrupt_requested: None,
            cancel_requested: None,
            progress_callback: None,
            requires_periodic_airbox_dynamic_demag: false,
            requires_floquet_airbox_dynamic_demag: false,
            magnetic_periodic_constraint_set_count: 0,
            magnetostatic_periodic_constraint_set_count: 0,
            periodic_airbox_delta_m_tangent_dof_count: 0,
            periodic_airbox_delta_phi_dof_count: 0,
            periodic_airbox_magnetostatic_periodic_node_pairs: &[],
            periodic_airbox_coupled_block_problem: None,
            tiny_validation_problem: None,
            mfem_operator_problem: Some(NativeDrivenFrequencyResponseMfemOperatorProblem {
                equilibrium_m: &equilibrium_m,
                h_ext_a_per_m: &h_ext_a_per_m,
                uniaxial_anisotropy_axis: None,
                uniaxial_anisotropy_field_a_per_m: 0.0,
                alpha_per_node: None,
                drive_real: &drive_real,
                drive_imag: None,
                exchange_edges: &exchange_edges,
                dmi_elements: &dmi_elements,
                dmi_lumped_mass: Some(&dmi_lumped_mass),
                dmi_ms_field: None,
                dmi_uniform_ms: 800000.0,
                observable_ms_field: None,
                observable_uniform_ms: 0.0,
                include_zeeman: false,
                static_periodic_node_pairs: &[],
                floquet_k_vector_rad_per_m: None,
                phase_convention: FrequencyDomainPhaseConvention::ExpIOmegaT,
                floquet_periodic_pairs: &[],
                #[cfg(feature = "fem-gpu")]
                apply_demag_tangent: None,
                apply_demag_tangent_with_potential: None,
                demag_tangent_user_data: std::ptr::null_mut(),
                demag_tangent_matrix_row_major: None,
            }),
        })
        .expect("native frequency response DMI boundary should return a structured result");

        assert_eq!(
            result.status,
            NativeFrequencyDomainStatus::Ok,
            "error_message={}, diagnostics_json={}",
            result.error_message,
            result.diagnostics_json
        );
        assert_eq!(result.completed_frequency_count, 1);
        assert!(result
            .diagnostics_json
            .contains("\"requested_execution_lane\":\"production_cpu\""));
        assert!(result
            .diagnostics_json
            .contains("\"matrix_free_solver\":true"));
        assert!(result
            .diagnostics_json
            .contains("\"validation_fallback_used\":false"));
    }
}
