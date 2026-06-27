#pragma once

#include "frequency_domain/modal_eigen_request.hpp"

#include <complex>
#include <vector>

namespace fullmag::fem::frequency_domain {

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
};

struct SLEPcModalAcceptedMode {
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
    const char *eps_type = "krylovschur";
    const char *problem_type = "gnhep";
    const char *spectral_transform = "shift_invert";
    const char *which_eigenpairs = "target_magnitude";
    const char *ksp_type = "preonly";
    const char *pc_type = "lu";
    const char *factorization_package = "petsc_lu";
    const char *nullspace_policy = "none";
    const char *unsupported_reason = "";
    int converged_eigenpair_count = 0;
    int accepted_mode_count = 0;
    int selected_eigenpair_index = -1;
    int outer_iterations = 0;
    int linear_iterations_total = 0;
    int ksp_max_iterations = 0;
    double ksp_rtol = 0.0;
    double ksp_atol = 0.0;
    double ksp_final_residual = 0.0;
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
};

SLEPcTinyGyrotropicModalEigenResult
solve_slepc_sparse_gyrotropic_modal_eigen(
    const SLEPcSparseGyrotropicModalEigenRequest &request) noexcept;

} // namespace fullmag::fem::frequency_domain
