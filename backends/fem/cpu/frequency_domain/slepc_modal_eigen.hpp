#pragma once

#include "frequency_domain/modal_eigen_request.hpp"

#include <complex>
#include <vector>

namespace fullmag::fem::frequency_domain {

struct FloquetSharedDomainSparseModalOperator;

struct SLEPcModalEigenAdapterStatus {
    const char *solver_adapter = "slepc_modal_eigen";
    const char *solver_adapter_status = "pending";
    const char *unavailable_message = "";
    const char *unsupported_reason = "";
    const char *eps_type = "";
    const char *problem_type = "";
    const char *which_eigenpairs = "";
    const char *ksp_type = "";
    const char *pc_type = "";
    const char *factorization_package = "";
    const char *factorization_shift_policy = "";
    const char *nullspace_policy = "";
    const char *linear_tolerance_policy = "";
    const char *algebraic_form = "";
    const char *positive_frequency_filter = "";
    const char *eigenvalue_to_frequency = "";
    bool requires_slepc = true;
    bool slepc_available = false;
};

SLEPcModalEigenAdapterStatus slepc_modal_eigen_adapter_status() noexcept;

struct SLEPcTinyGyrotropicModalEigenRequest {
    int tangent_dof_count = 0;
    const double *stiffness_matrix_row_major = nullptr;
    const double *gyrotropic_matrix_row_major = nullptr;
    int requested_mode_count = 1;
    double target_frequency_hz = 0.0;
    double frequency_min_hz = 0.0;
    double frequency_max_hz = 0.0;
    double residual_tolerance = 1.0e-10;
    int max_outer_iterations = 64;
    int max_linear_iterations = 128;
    FrequencyDomainPhaseConvention phase_convention =
        FrequencyDomainPhaseConvention::exp_i_omega_t;
};

struct SLEPcModalAcceptedMode {
    bool floquet_descriptor_certified = false;
    bool floquet_mode_vector_physical_complex = false;
    double floquet_magnetic_residual = 0.0;
    double floquet_potential_residual = 0.0;
    std::vector<std::complex<double>> floquet_potential_real_split;
    int eigenpair_index = -1;
    int positive_frequency_pair_index = -1;
    double lambda_real = 0.0;
    double lambda_imag = 0.0;
    double frequency_hz = 0.0;
    double relative_residual = 0.0;
    std::vector<std::complex<double>> mode_vector{};
};

struct SLEPcTinyGyrotropicModalEigenResult {
    bool ok = false;
    const char *status = "unavailable";
    const char *solver_adapter = "slepc_modal_eigen";
    // The current native modal adapter uses sequential PETSc objects. Keep
    // this execution scope explicit in every diagnostic result so a passing
    // solve cannot be mistaken for MPI/distributed scalability evidence.
    const char *execution_policy = "petsc_sequential_cpu";
    const char *execution_scope = "single_process_shared_memory";
    const char *communicator = "PETSC_COMM_SELF";
    const char *scalability_scope = "single_process_only";
    const char *eps_type = "krylovschur";
    const char *problem_type = "gnhep";
    const char *spectral_transform = "shift_invert";
    const char *which_eigenpairs = "target_magnitude";
    const char *ksp_type = "preonly";
    const char *pc_type = "lu";
    const char *factorization_package = "petsc_lu_shift_nonzero";
    const char *factorization_shift_policy =
        "positive_relative_operator_norm_amount";
    const char *poisson_ksp_type = "";
    const char *poisson_pc_type = "";
    const char *poisson_factorization_package = "";
    const char *poisson_iteration_semantics = "";
    const char *nullspace_policy = "none";
    const char *unsupported_reason = "";
    int converged_eigenpair_count = 0;
    int positive_frequency_candidate_count = 0;
    int frequency_window_candidate_count = 0;
    int residual_rejection_count = 0;
    int non_real_rotated_eigenvalue_count = 0;
    int accepted_mode_count = 0;
    int selected_eigenpair_index = -1;
    int outer_iterations = 0;
    int max_outer_iterations = 0;
    int linear_iterations_total = 0;
    int ksp_max_iterations = 0;
    int poisson_ksp_max_iterations = 0;
    double ksp_rtol = 0.0;
    double ksp_atol = 0.0;
    double poisson_ksp_rtol = 0.0;
    double poisson_ksp_atol = 0.0;
    double ksp_final_residual = 0.0;
    double factorization_shift_amount = 0.0;
    double operator_normalization_scale = 1.0;
    double preconditioner_normalization_scale = 1.0;
    double max_candidate_relative_residual = 0.0;
    double min_candidate_frequency_hz = 0.0;
    double max_candidate_frequency_hz = 0.0;
    double lambda_real = 0.0;
    double lambda_imag = 0.0;
    double frequency_hz = 0.0;
    double relative_residual = 0.0;
    double max_relative_residual = 0.0;
    std::vector<SLEPcModalAcceptedMode> accepted_modes{};
};

SLEPcTinyGyrotropicModalEigenResult
solve_slepc_tiny_gyrotropic_modal_eigen(
    const SLEPcTinyGyrotropicModalEigenRequest &request) noexcept;

struct SLEPcSparseGyrotropicModalEigenRequest {
    int tangent_dof_count = 0;
    CsrMatrixView stiffness_csr{};
    CsrMatrixView gyrotropic_csr{};
    int requested_mode_count = 1;
    double target_frequency_hz = 0.0;
    double frequency_min_hz = 0.0;
    double frequency_max_hz = 0.0;
    double residual_tolerance = 1.0e-10;
    int max_outer_iterations = 64;
    int max_linear_iterations = 128;
    FrequencyDomainPhaseConvention phase_convention =
        FrequencyDomainPhaseConvention::exp_i_omega_t;
    /* Optional native shared-domain Floquet owner.  When present, the
       stiffness/gyrotropic CSR views above are not materialised by the
       caller; the owner builds the phase-reduced static blocks and applies
       the scalar-potential Schur complement through a PETSc MatShell. */
    const FloquetSharedDomainSparseModalOperator *floquet_shared_domain_operator = nullptr;
};

SLEPcTinyGyrotropicModalEigenResult
solve_slepc_sparse_gyrotropic_modal_eigen(
    const SLEPcSparseGyrotropicModalEigenRequest &request) noexcept;

} // namespace fullmag::fem::frequency_domain
