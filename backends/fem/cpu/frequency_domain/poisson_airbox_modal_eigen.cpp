#include "cpu/frequency_domain/poisson_airbox_modal_eigen.hpp"
#include "frequency_domain/mode_kinematics.hpp"

#include <algorithm>
#include <cmath>
#include <complex>
#include <cstdio>
#include <cstring>
#include <limits>
#include <mutex>
#include <vector>

#if FULLMAG_FEM_WITH_SLEPC
#include <petscksp.h>
#include <slepc/slepceps.h>
#endif

namespace fullmag::fem::frequency_domain {

#ifndef FULLMAG_FEM_WITH_SLEPC
#define FULLMAG_FEM_WITH_SLEPC 0
#endif

namespace {

using Complex = std::complex<double>;

constexpr std::uint64_t kMaxPaE2DofCount = 128;

bool string_equals(const char *actual, const char *expected) noexcept
{
    return actual != nullptr && expected != nullptr && std::strcmp(actual, expected) == 0;
}

bool uses_mean_zero_gauge(const PoissonAirboxEigenBlockProblem &problem) noexcept
{
    return string_equals(problem.gauge_policy, "mean_zero_augmented");
}

const char *algebraic_form_for(const PoissonAirboxEigenBlockProblem &problem) noexcept
{
    return uses_mean_zero_gauge(problem) ?
        "full_coupled_descriptor_augmented_gauge" :
        "full_coupled_descriptor_no_gauge_unimplemented";
}

std::uint64_t augmented_dof_count_for(
    const PoissonAirboxEigenBlockProblem &problem) noexcept
{
    return problem.q_dof_count + problem.phi_dof_count +
        (uses_mean_zero_gauge(problem) ? 1U : 0U);
}

void copy_message(char *destination, std::size_t destination_size, const char *message) noexcept
{
    if (destination == nullptr || destination_size == 0) {
        return;
    }
    std::strncpy(destination, message != nullptr ? message : "", destination_size - 1);
    destination[destination_size - 1] = '\0';
}

double complex_l2_norm(const std::vector<Complex> &values) noexcept
{
    long double sum = 0.0L;
    for (const Complex &value : values) {
        sum += static_cast<long double>(std::norm(value));
    }
    return std::sqrt(static_cast<double>(sum));
}

bool csr_shape_is(
    const CsrMatrixView &matrix,
    std::uint64_t rows,
    std::uint64_t columns) noexcept
{
    return matrix.row_count == rows &&
        matrix.column_count == columns &&
        matrix.row_offsets != nullptr &&
        matrix.row_offsets_len == rows + 1 &&
        matrix.column_indices != nullptr &&
        matrix.values != nullptr &&
        matrix.column_indices_len == matrix.values_len;
}

bool finite_valid_csr(const CsrMatrixView &matrix) noexcept
{
    if (matrix.row_count > kMaxPaE2DofCount ||
        matrix.column_count > kMaxPaE2DofCount ||
        matrix.values_len > std::numeric_limits<std::uint32_t>::max()) {
        return false;
    }
    if (matrix.row_offsets[0] != 0 ||
        matrix.row_offsets[matrix.row_count] != matrix.values_len) {
        return false;
    }
    for (std::uint64_t row = 0; row < matrix.row_count; ++row) {
        if (matrix.row_offsets[row] > matrix.row_offsets[row + 1]) {
            return false;
        }
    }
    for (std::uint64_t entry = 0; entry < matrix.values_len; ++entry) {
        if (matrix.column_indices[entry] >= matrix.column_count ||
            !std::isfinite(matrix.values[entry])) {
            return false;
        }
    }
    return true;
}

bool positive_normalized_weights(const double *weights, std::uint64_t count) noexcept
{
    if (weights == nullptr || count == 0) {
        return false;
    }
    long double sum = 0.0L;
    for (std::uint64_t index = 0; index < count; ++index) {
        const double weight = weights[index];
        if (!std::isfinite(weight) || !(weight > 0.0)) {
            return false;
        }
        sum += static_cast<long double>(weight);
    }
    return std::abs(static_cast<double>(sum - 1.0L)) <= 1.0e-10;
}

bool csr_has_nonzero_value(const CsrMatrixView &matrix) noexcept
{
    for (std::uint64_t entry = 0; entry < matrix.values_len; ++entry) {
        if (std::abs(matrix.values[entry]) > 0.0) {
            return true;
        }
    }
    return false;
}

void write_diagnostics_json(
    const PoissonAirboxEigenBlockProblem &problem,
    const PoissonAirboxModalEigenResult &result,
    const char *status,
    const char *reason,
    PoissonAirboxModalEigenResult *out) noexcept
{
    if (out == nullptr) {
        return;
    }
    const ModeKinematics kinematics = map_eigenvalue(
        {result.eigenvalue_real, result.eigenvalue_imag},
        FrequencyDomainPhaseConvention::exp_i_omega_t);
    std::snprintf(
        out->diagnostics_json,
        sizeof(out->diagnostics_json),
        "{"
        "\"schema_version\":\"poisson_airbox_modal_eigen_slepc.v1\","
        "\"status\":\"%s\","
        "\"reason\":\"%s\","
        "\"study_product\":\"modal_eigen\","
        "\"test_id\":\"%s\","
        "\"solver_adapter\":\"%s\","
        "\"demag_kind\":\"%s\","
        "\"outer_boundary_kind\":\"%s\","
        "\"robin_beta\":%.17g,"
        "\"gauge_policy\":\"%s\","
        "\"gauge_reason\":\"%s\","
        "\"assembly_kind\":\"%s\","
        "\"production_implication\":false,"
        "\"phasor_convention\":\"%s\","
        "\"eigenvalue_convention\":\"%s\","
        "\"algebraic_form\":\"%s\","
        "\"matrix_format\":\"monolithic_seq_aij\","
        "\"periodic_mesh_certificate\":{"
        "\"schema_version\":\"%s\","
        "\"magnetic_pair_count\":%llu,"
        "\"airbox_pair_count\":%llu,"
        "\"certificate_required\":%s"
        "},"
        "\"k_vector_rad_per_m\":[0.0,0.0,0.0],"
        "\"alpha\":0.0,"
        "\"q_dof_count\":%llu,"
        "\"phi_dof_count\":%llu,"
        "\"augmented_dof_count\":%llu,"
        "\"slepc\":{"
        "\"eps_type\":\"krylovschur\","
        "\"problem_type\":\"gnhep\","
        "\"spectral_transform\":\"shift_invert\","
        "\"which_eigenpairs\":\"target_magnitude\","
        "\"ksp_type\":\"preonly\","
        "\"pc_type\":\"lu\","
        "\"converged_eigenpair_count\":%u,"
        "\"accepted_mode_count\":%u,"
        "\"outer_iterations\":%u"
        "},"
        "\"metrics\":{"
        "\"full_residual_reconstruction_relative_error\":%.17g,"
        "\"slepc_reported_backward_error\":%.17g,"
        "\"reconstructed_full_descriptor_backward_error\":%.17g,"
        "\"reconstruction_vs_slepc_ratio\":%.17g,"
        "\"magnetic_block_backward_error\":%.17g,"
        "\"poisson_block_backward_error\":%.17g,"
        "\"gauge_constraint_backward_error\":%.17g,"
        "\"poisson_constraint_relative_residual\":%.17g,"
        "\"gauge_mean_abs\":%.17g,"
        "\"eigen_residual_relative\":%.17g,"
        "\"relative_reference_frequency_error\":%.17g"
        "},"
        "\"eigenpair\":{"
        "\"eigenvalue_real\":%.17g,"
        "\"eigenvalue_imag\":%.17g,"
        "\"lambda_real_per_s\":%.17g,"
        "\"lambda_imag_rad_per_s\":%.17g,"
        "\"omega_rad_s\":%.17g,"
        "\"frequency_hz\":%.17g,"
        "\"decay_rate_per_s\":%.17g,"
        "\"branch_sign\":%d,"
        "\"stable\":%s,"
        "\"positive_frequency_branch_found\":%s"
        "},"
        "\"certification\":{"
        "\"full_residual_certified\":%s,"
        "\"reference_frequency_certified\":%s"
        "}"
        "}",
        status != nullptr ? status : "unknown",
        reason != nullptr ? reason : "",
        problem.test_id != nullptr ? problem.test_id : "",
        problem.solver_adapter != nullptr ? problem.solver_adapter : "",
        problem.demag_kind != nullptr ? problem.demag_kind : "",
        problem.outer_boundary_kind != nullptr ? problem.outer_boundary_kind : "",
        problem.robin_beta,
        problem.gauge_policy != nullptr ? problem.gauge_policy : "",
        problem.gauge_reason != nullptr ? problem.gauge_reason : "",
        problem.assembly_kind != nullptr ? problem.assembly_kind : "",
        problem.phasor_convention != nullptr ? problem.phasor_convention : "",
        problem.eigenvalue_convention != nullptr ? problem.eigenvalue_convention : "",
        algebraic_form_for(problem),
        problem.periodic_mesh_certificate_schema != nullptr ?
            problem.periodic_mesh_certificate_schema : "",
        static_cast<unsigned long long>(result.magnetic_pair_count),
        static_cast<unsigned long long>(result.airbox_pair_count),
        problem.periodic_mesh_certificate_required ? "true" : "false",
        static_cast<unsigned long long>(result.q_dof_count),
        static_cast<unsigned long long>(result.phi_dof_count),
        static_cast<unsigned long long>(result.augmented_dof_count),
        result.converged_eigenpair_count,
        result.accepted_mode_count,
        result.outer_iterations,
        result.full_residual_reconstruction_relative_error,
        result.slepc_reported_backward_error,
        result.reconstructed_full_descriptor_backward_error,
        result.reconstruction_vs_slepc_ratio,
        result.magnetic_block_backward_error,
        result.poisson_block_backward_error,
        result.gauge_constraint_backward_error,
        result.poisson_constraint_relative_residual,
        result.gauge_mean_abs,
        result.eigen_residual_relative,
        result.relative_reference_frequency_error,
        result.eigenvalue_real,
        result.eigenvalue_imag,
        kinematics.lambda.real_per_s,
        kinematics.lambda.imag_rad_per_s,
        kinematics.omega_rad_s,
        kinematics.frequency_hz,
        kinematics.decay_rate_per_s,
        kinematics.branch_sign,
        result.positive_frequency_branch_found && kinematics.stable ? "true" : "false",
        result.positive_frequency_branch_found ? "true" : "false",
        result.full_residual_certified ? "true" : "false",
        result.reference_frequency_certified ? "true" : "false");
}

FrequencyDomainStatus fail(
    const PoissonAirboxEigenBlockProblem &problem,
    PoissonAirboxModalEigenResult *result,
    FrequencyDomainStatus status,
    const char *message,
    const char *reason) noexcept
{
    if (result != nullptr) {
        result->status = status;
        copy_message(result->error_message, sizeof(result->error_message), message);
        const char *status_json = "failed";
        if (status == FrequencyDomainStatus::unavailable) {
            status_json = "unavailable";
        } else if (status == FrequencyDomainStatus::validation_error) {
            status_json = "validation_error";
        } else if (status == FrequencyDomainStatus::operator_error) {
            status_json = "operator_error";
        } else if (status == FrequencyDomainStatus::solve_error) {
            status_json = "solve_error";
        }
        write_diagnostics_json(problem, *result, status_json, reason, result);
    }
    return status;
}

FrequencyDomainStatus validate_problem(
    const PoissonAirboxEigenBlockProblem &problem,
    PoissonAirboxModalEigenResult *result) noexcept
{
    if (result == nullptr) {
        return FrequencyDomainStatus::validation_error;
    }
    *result = PoissonAirboxModalEigenResult{};
    result->q_dof_count = problem.q_dof_count;
    result->phi_dof_count = problem.phi_dof_count;
    result->augmented_dof_count = augmented_dof_count_for(problem);
    result->magnetic_pair_count = problem.magnetic_pair_count;
    result->airbox_pair_count = problem.airbox_pair_count;
    result->expected_reference_frequency_hz = problem.expected_reference_frequency_hz;

    if (problem.abi_version != kPoissonAirboxEigenBlockProblemAbiVersion ||
        problem.struct_size < sizeof(PoissonAirboxEigenBlockProblem)) {
        return fail(
            problem,
            result,
            FrequencyDomainStatus::validation_error,
            "PA-E2 Poisson-airbox modal eigensolver requires ABI version 2",
            "poisson_airbox_eigen_unsupported_abi");
    }
    const bool robin = string_equals(problem.outer_boundary_kind, "poisson_robin");
    const bool dirichlet = string_equals(problem.outer_boundary_kind, "poisson_dirichlet");
    const bool pure_neumann = string_equals(problem.outer_boundary_kind, "pure_neumann");
    if (!robin && !dirichlet && !pure_neumann) {
        return fail(
            problem,
            result,
            FrequencyDomainStatus::validation_error,
            "PA-E2 Poisson-airbox modal eigensolver requires a supported outer boundary kind",
            "poisson_airbox_eigen_unsupported_outer_boundary");
    }
    if (!std::isfinite(problem.robin_beta) ||
        (robin ? !(problem.robin_beta > 0.0) : problem.robin_beta != 0.0)) {
        return fail(
            problem,
            result,
            FrequencyDomainStatus::validation_error,
            "PA-E2 Poisson-airbox modal eigensolver requires positive robin_beta only for poisson_robin",
            "poisson_airbox_eigen_invalid_robin_beta");
    }
    if ((robin || dirichlet) && !string_equals(problem.gauge_policy, "none")) {
        return fail(
            problem,
            result,
            FrequencyDomainStatus::validation_error,
            "PA-E2 Poisson-airbox Robin/Dirichlet boundaries require gauge_policy=none",
            "poisson_airbox_eigen_boundary_gauge_mismatch");
    }
    if (pure_neumann && !string_equals(problem.gauge_policy, "mean_zero_augmented")) {
        return fail(
            problem,
            result,
            FrequencyDomainStatus::validation_error,
            "PA-E2 Poisson-airbox pure Neumann boundary requires gauge_policy=mean_zero_augmented",
            "poisson_airbox_eigen_boundary_gauge_mismatch");
    }
    const char *expected_gauge_reason = pure_neumann ?
        "pure_neumann_nullspace" : "coercive_outer_boundary";
    if (!string_equals(problem.gauge_reason, expected_gauge_reason)) {
        return fail(
            problem,
            result,
            FrequencyDomainStatus::validation_error,
            "PA-E2 Poisson-airbox modal eigensolver requires boundary-consistent gauge provenance",
            "poisson_airbox_eigen_gauge_reason_mismatch");
    }
    if (!string_equals(problem.assembly_kind, "synthetic_algebraic_oracle")) {
        return fail(
            problem,
            result,
            FrequencyDomainStatus::validation_error,
            "PA-E2 Poisson-airbox modal eigensolver currently accepts only synthetic_algebraic_oracle assembly",
            "poisson_airbox_eigen_unsupported_assembly_kind");
    }
    if ((robin || dirichlet) &&
        (problem.phi_mean_weights != nullptr || problem.phi_mean_weights_count != 0)) {
        return fail(
            problem,
            result,
            FrequencyDomainStatus::validation_error,
            "PA-E2 Poisson-airbox no-gauge boundary must not carry phi mean weights",
            "poisson_airbox_eigen_unexpected_phi_mean_weights");
    }
    if (robin || dirichlet) {
        return fail(
            problem,
            result,
            FrequencyDomainStatus::validation_error,
            "PA-E2 Poisson-airbox gauge_policy=none is not implemented by the augmented SLEPc descriptor",
            "poisson_airbox_eigen_gauge_policy_not_implemented");
    }
    if (problem.q_dof_count == 0 ||
        problem.phi_dof_count == 0 ||
        problem.q_dof_count > kMaxPaE2DofCount ||
        problem.phi_dof_count > kMaxPaE2DofCount ||
        problem.q_dof_count + problem.phi_dof_count + 1 > kMaxPaE2DofCount) {
        return fail(
            problem,
            result,
            FrequencyDomainStatus::validation_error,
            "PA-E2 Poisson-airbox modal eigensolver requires positive small q/phi dimensions",
            "poisson_airbox_eigen_invalid_dimensions");
    }
    if (!csr_shape_is(problem.A_qq, problem.q_dof_count, problem.q_dof_count) ||
        !csr_shape_is(problem.A_qphi, problem.q_dof_count, problem.phi_dof_count) ||
        !csr_shape_is(problem.A_phiq, problem.phi_dof_count, problem.q_dof_count) ||
        !csr_shape_is(problem.A_phiphi, problem.phi_dof_count, problem.phi_dof_count) ||
        !csr_shape_is(problem.B_qq, problem.q_dof_count, problem.q_dof_count)) {
        return fail(
            problem,
            result,
            FrequencyDomainStatus::validation_error,
            "PA-E2 Poisson-airbox modal eigensolver CSR shape mismatch",
            "poisson_airbox_eigen_csr_shape_mismatch");
    }
    if (!finite_valid_csr(problem.A_qq) ||
        !finite_valid_csr(problem.A_qphi) ||
        !finite_valid_csr(problem.A_phiq) ||
        !finite_valid_csr(problem.A_phiphi) ||
        !finite_valid_csr(problem.B_qq)) {
        return fail(
            problem,
            result,
            FrequencyDomainStatus::validation_error,
            "PA-E2 Poisson-airbox modal eigensolver requires finite valid CSR blocks",
            "poisson_airbox_eigen_invalid_csr");
    }
    if (problem.phi_mean_weights == nullptr ||
        problem.phi_mean_weights_count != problem.phi_dof_count) {
        return fail(
            problem,
            result,
            FrequencyDomainStatus::validation_error,
            "PA-E2 Poisson-airbox modal eigensolver requires mean-zero gauge weights",
            "poisson_airbox_eigen_requires_mean_zero_gauge");
    }
    if (!positive_normalized_weights(
            problem.phi_mean_weights,
            problem.phi_mean_weights_count)) {
        return fail(
            problem,
            result,
            FrequencyDomainStatus::validation_error,
            "PA-E2 Poisson-airbox modal eigensolver gauge weights must be positive normalized mean-zero weights",
            "poisson_airbox_eigen_requires_mean_zero_gauge");
    }
    if (!string_equals(problem.demag_kind, "periodic_airbox_k0")) {
        return fail(
            problem,
            result,
            FrequencyDomainStatus::validation_error,
            "PA-E2 Poisson-airbox modal eigensolver requires demag_kind=periodic_airbox_k0",
            "poisson_airbox_eigen_requires_periodic_airbox_k0");
    }
    if (!string_equals(problem.phasor_convention, "exp_plus_i_omega_t") ||
        !string_equals(problem.eigenvalue_convention, "lambda_imag_positive_frequency")) {
        return fail(
            problem,
            result,
            FrequencyDomainStatus::validation_error,
            "PA-E2 Poisson-airbox modal eigensolver requires exp_plus_i_omega_t and lambda_imag_positive_frequency",
            "poisson_airbox_eigen_convention_mismatch");
    }
    if (!string_equals(problem.solver_adapter, "k0_poisson_airbox_cpu_full_coupled_slepc")) {
        return fail(
            problem,
            result,
            FrequencyDomainStatus::validation_error,
            "PA-E2 Poisson-airbox modal eigensolver requires the full-coupled SLEPc adapter",
            "poisson_airbox_eigen_solver_adapter_mismatch");
    }
    if (!problem.k0_only ||
        !problem.alpha_zero_required ||
        !problem.symmetric_mesh_certificate_required ||
        !problem.periodic_mesh_certificate_required ||
        !problem.real_fem_blocks) {
        return fail(
            problem,
            result,
            FrequencyDomainStatus::validation_error,
            "PA-E2 Poisson-airbox modal eigensolver is limited to k=0, alpha=0, real FEM blocks with a mesh certificate",
            "poisson_airbox_eigen_pa_e2_scope_mismatch");
    }
    if (!string_equals(problem.periodic_mesh_certificate_schema, "periodic_mesh_certificate.v5") ||
        problem.magnetic_pair_count == 0 ||
        problem.airbox_pair_count == 0) {
        return fail(
            problem,
            result,
            FrequencyDomainStatus::validation_error,
            "PA-E2 Poisson-airbox modal eigensolver requires periodic_mesh_certificate.v5 magnetic and airbox pair counts",
            "poisson_airbox_eigen_requires_periodic_mesh_certificate");
    }
    if (!csr_has_nonzero_value(problem.A_qphi) ||
        !csr_has_nonzero_value(problem.A_phiq)) {
        return fail(
            problem,
            result,
            FrequencyDomainStatus::validation_error,
            "PA-E2 Poisson-airbox modal eigensolver requires nonzero q-phi and phi-q demag coupling blocks",
            "poisson_airbox_eigen_requires_full_coupled_blocks");
    }
    if (!(problem.residual_tolerance > 0.0) ||
        !std::isfinite(problem.residual_tolerance) ||
        (problem.target_frequency_hz < 0.0) ||
        !std::isfinite(problem.target_frequency_hz) ||
        (problem.expected_reference_frequency_hz < 0.0) ||
        !std::isfinite(problem.expected_reference_frequency_hz)) {
        return fail(
            problem,
            result,
            FrequencyDomainStatus::validation_error,
            "PA-E2 Poisson-airbox modal eigensolver requires finite non-negative frequencies and positive tolerance",
            "poisson_airbox_eigen_invalid_tolerance_or_frequency");
    }
    return FrequencyDomainStatus::ok;
}

std::vector<Complex> csr_matvec(
    const CsrMatrixView &matrix,
    const std::vector<Complex> &x)
{
    std::vector<Complex> y(static_cast<std::size_t>(matrix.row_count), Complex{});
    if (matrix.column_count != x.size()) {
        return y;
    }
    for (std::uint64_t row = 0; row < matrix.row_count; ++row) {
        Complex value{};
        for (std::uint32_t entry = matrix.row_offsets[row];
             entry < matrix.row_offsets[row + 1];
             ++entry) {
            value += matrix.values[entry] * x[static_cast<std::size_t>(matrix.column_indices[entry])];
        }
        y[static_cast<std::size_t>(row)] = value;
    }
    return y;
}

void add_csr_to_dense(
    const CsrMatrixView &matrix,
    std::uint64_t row_offset,
    std::uint64_t column_offset,
    std::vector<Complex> &dense,
    std::uint64_t dense_columns)
{
    for (std::uint64_t row = 0; row < matrix.row_count; ++row) {
        for (std::uint32_t entry = matrix.row_offsets[row];
             entry < matrix.row_offsets[row + 1];
             ++entry) {
            dense[static_cast<std::size_t>(
                (row_offset + row) * dense_columns + column_offset + matrix.column_indices[entry])] +=
                matrix.values[entry];
        }
    }
}

std::vector<Complex> dense_matvec(
    const std::vector<Complex> &matrix,
    std::uint64_t rows,
    std::uint64_t columns,
    const std::vector<Complex> &x)
{
    std::vector<Complex> y(static_cast<std::size_t>(rows), Complex{});
    if (x.size() != columns) {
        return y;
    }
    for (std::uint64_t row = 0; row < rows; ++row) {
        Complex value{};
        for (std::uint64_t column = 0; column < columns; ++column) {
            value += matrix[static_cast<std::size_t>(row * columns + column)] *
                x[static_cast<std::size_t>(column)];
        }
        y[static_cast<std::size_t>(row)] = value;
    }
    return y;
}

bool solve_dense_complex_linear_system(
    std::vector<Complex> matrix,
    std::vector<Complex> rhs,
    std::vector<Complex> &solution)
{
    const std::size_t n = rhs.size();
    if (matrix.size() != n * n || n == 0) {
        return false;
    }
    for (std::size_t column = 0; column < n; ++column) {
        std::size_t pivot = column;
        double pivot_norm = std::abs(matrix[column * n + column]);
        for (std::size_t row = column + 1; row < n; ++row) {
            const double candidate_norm = std::abs(matrix[row * n + column]);
            if (candidate_norm > pivot_norm) {
                pivot = row;
                pivot_norm = candidate_norm;
            }
        }
        if (!(pivot_norm > 0.0) || !std::isfinite(pivot_norm)) {
            return false;
        }
        if (pivot != column) {
            for (std::size_t k = column; k < n; ++k) {
                std::swap(matrix[column * n + k], matrix[pivot * n + k]);
            }
            std::swap(rhs[column], rhs[pivot]);
        }
        const Complex pivot_value = matrix[column * n + column];
        for (std::size_t row = column + 1; row < n; ++row) {
            const Complex factor = matrix[row * n + column] / pivot_value;
            matrix[row * n + column] = Complex{};
            for (std::size_t k = column + 1; k < n; ++k) {
                matrix[row * n + k] -= factor * matrix[column * n + k];
            }
            rhs[row] -= factor * rhs[column];
        }
    }
    solution.assign(n, Complex{});
    for (std::size_t reverse = 0; reverse < n; ++reverse) {
        const std::size_t row = n - 1 - reverse;
        Complex value = rhs[row];
        for (std::size_t column = row + 1; column < n; ++column) {
            value -= matrix[row * n + column] * solution[column];
        }
        solution[row] = value / matrix[row * n + row];
    }
    return true;
}

void write_shift_invert_action_diagnostics_json(
    const PoissonAirboxEigenBlockProblem &problem,
    const PoissonAirboxModalShiftInvertActionResult &result,
    const char *status,
    const char *reason,
    PoissonAirboxModalShiftInvertActionResult *out) noexcept
{
    if (out == nullptr) {
        return;
    }
    std::snprintf(
        out->diagnostics_json,
        sizeof(out->diagnostics_json),
        "{"
        "\"schema_version\":\"poisson_airbox_modal_shift_invert_action.v1\","
        "\"status\":\"%s\","
        "\"reason\":\"%s\","
        "\"study_product\":\"modal_eigen\","
        "\"operator_family\":\"full_modal_shift_invert\","
        "\"algebraic_action\":\"(A - sigma B)^-1 Bv\","
        "\"solver_adapter\":\"k0_poisson_airbox_cpu_full_coupled_shift_invert_reference\","
        "\"demag_kind\":\"%s\","
        "\"gauge_policy\":\"%s\","
        "\"phasor_convention\":\"%s\","
        "\"eigenvalue_convention\":\"%s\","
        "\"full_modal_shift_invert_claim\":%s,"
        "\"q_dof_count\":%llu,"
        "\"phi_dof_count\":%llu,"
        "\"augmented_dof_count\":%llu,"
        "\"sigma\":{\"real\":%.17g,\"imag\":%.17g},"
        "\"metrics\":{"
        "\"rhs_l2_norm\":%.17g,"
        "\"output_q_l2_norm\":%.17g,"
        "\"shifted_system_relative_residual\":%.17g"
        "}"
        "}",
        status != nullptr ? status : "unknown",
        reason != nullptr ? reason : "",
        problem.demag_kind != nullptr ? problem.demag_kind : "",
        problem.gauge_policy != nullptr ? problem.gauge_policy : "",
        problem.phasor_convention != nullptr ? problem.phasor_convention : "",
        problem.eigenvalue_convention != nullptr ? problem.eigenvalue_convention : "",
        result.full_modal_shift_invert_claim ? "true" : "false",
        static_cast<unsigned long long>(result.q_dof_count),
        static_cast<unsigned long long>(result.phi_dof_count),
        static_cast<unsigned long long>(result.augmented_dof_count),
        result.sigma_real,
        result.sigma_imag,
        result.rhs_l2_norm,
        result.output_q_l2_norm,
        result.shifted_system_relative_residual);
}

FrequencyDomainStatus fail_shift_invert_action(
    const PoissonAirboxEigenBlockProblem &problem,
    PoissonAirboxModalShiftInvertActionResult *result,
    FrequencyDomainStatus status,
    const char *message,
    const char *reason) noexcept
{
    if (result != nullptr) {
        result->status = status;
        copy_message(result->error_message, sizeof(result->error_message), message);
        const char *status_json = "failed";
        if (status == FrequencyDomainStatus::unavailable) {
            status_json = "unavailable";
        } else if (status == FrequencyDomainStatus::validation_error) {
            status_json = "validation_error";
        } else if (status == FrequencyDomainStatus::operator_error) {
            status_json = "operator_error";
        } else if (status == FrequencyDomainStatus::solve_error) {
            status_json = "solve_error";
        }
        write_shift_invert_action_diagnostics_json(problem, *result, status_json, reason, result);
    }
    return status;
}

std::vector<Complex> slice(
    const std::vector<Complex> &values,
    std::uint64_t begin,
    std::uint64_t count)
{
    return std::vector<Complex>(
        values.begin() + static_cast<std::ptrdiff_t>(begin),
        values.begin() + static_cast<std::ptrdiff_t>(begin + count));
}

struct ResidualMetrics {
    double full_relative = 0.0;
    double q_relative = 0.0;
    double phi_relative = 0.0;
    double gauge_relative = 0.0;
    double gauge_abs = 0.0;
};

ResidualMetrics compute_residual_metrics(
    const PoissonAirboxEigenBlockProblem &problem,
    const std::vector<Complex> &full_vector,
    Complex lambda)
{
    const std::uint64_t nq = problem.q_dof_count;
    const std::uint64_t np = problem.phi_dof_count;
    const std::vector<Complex> q = slice(full_vector, 0, nq);
    const std::vector<Complex> phi = slice(full_vector, nq, np);
    const Complex eta = full_vector[static_cast<std::size_t>(nq + np)];

    std::vector<Complex> a_qq_q = csr_matvec(problem.A_qq, q);
    std::vector<Complex> a_qphi_phi = csr_matvec(problem.A_qphi, phi);
    std::vector<Complex> b_qq_q = csr_matvec(problem.B_qq, q);
    std::vector<Complex> q_residual;
    q_residual.reserve(static_cast<std::size_t>(nq));
    for (std::uint64_t row = 0; row < nq; ++row) {
        q_residual.push_back(
            a_qq_q[static_cast<std::size_t>(row)] +
            a_qphi_phi[static_cast<std::size_t>(row)] -
            lambda * b_qq_q[static_cast<std::size_t>(row)]);
    }

    std::vector<Complex> a_phiq_q = csr_matvec(problem.A_phiq, q);
    std::vector<Complex> a_phiphi_phi = csr_matvec(problem.A_phiphi, phi);
    std::vector<Complex> phi_residual;
    phi_residual.reserve(static_cast<std::size_t>(np));
    for (std::uint64_t row = 0; row < np; ++row) {
        const Complex value =
            a_phiq_q[static_cast<std::size_t>(row)] +
            a_phiphi_phi[static_cast<std::size_t>(row)] +
            problem.phi_mean_weights[row] * eta;
        phi_residual.push_back(value);
    }

    Complex gauge{};
    for (std::uint64_t row = 0; row < np; ++row) {
        gauge += problem.phi_mean_weights[row] * phi[static_cast<std::size_t>(row)];
    }
    long double weight_norm_squared = 0.0L;
    for (std::uint64_t row = 0; row < np; ++row) {
        const long double weight = problem.phi_mean_weights[row];
        weight_norm_squared += weight * weight;
    }
    const double weight_norm = std::sqrt(static_cast<double>(weight_norm_squared));
    ResidualMetrics metrics{};
    metrics.q_relative = complex_l2_norm(q_residual) /
        (complex_l2_norm(a_qq_q) + complex_l2_norm(a_qphi_phi) +
         std::abs(lambda) * complex_l2_norm(b_qq_q) + 1.0e-30);
    metrics.phi_relative = complex_l2_norm(phi_residual) /
        (complex_l2_norm(a_phiq_q) + complex_l2_norm(a_phiphi_phi) +
         weight_norm * std::abs(eta) + 1.0e-30);
    metrics.gauge_abs = std::abs(gauge);
    metrics.gauge_relative = metrics.gauge_abs /
        (weight_norm * complex_l2_norm(phi) + 1.0e-30);
    metrics.full_relative = std::max(
        metrics.q_relative,
        std::max(metrics.phi_relative, metrics.gauge_relative));
    return metrics;
}

#if FULLMAG_FEM_WITH_SLEPC
std::mutex &pa_e2_slepc_mutex()
{
    static std::mutex mutex;
    return mutex;
}

bool ensure_slepc_initialized(PoissonAirboxModalEigenResult *result)
{
    PetscBool initialized = PETSC_FALSE;
    if (SlepcInitialized(&initialized) != 0) {
        copy_message(result->error_message, sizeof(result->error_message), "SLEPc initialization query failed");
        return false;
    }
    if (!initialized && SlepcInitializeNoArguments() != 0) {
        copy_message(result->error_message, sizeof(result->error_message), "SLEPc initialization failed");
        return false;
    }
    return true;
}

void destroy_slepc_objects(EPS *eps, Vec *xr, Vec *xi, Mat *A, Mat *B)
{
    if (xr != nullptr && *xr != nullptr) {
        VecDestroy(xr);
    }
    if (xi != nullptr && *xi != nullptr) {
        VecDestroy(xi);
    }
    if (eps != nullptr && *eps != nullptr) {
        EPSDestroy(eps);
    }
    if (A != nullptr && *A != nullptr) {
        MatDestroy(A);
    }
    if (B != nullptr && *B != nullptr) {
        MatDestroy(B);
    }
}

bool insert_csr_block(
    Mat matrix,
    PetscInt row_offset,
    PetscInt column_offset,
    const CsrMatrixView &block)
{
    for (std::uint64_t row = 0; row < block.row_count; ++row) {
        for (std::uint32_t entry = block.row_offsets[row];
             entry < block.row_offsets[row + 1];
             ++entry) {
            const PetscInt petsc_row = row_offset + static_cast<PetscInt>(row);
            const PetscInt petsc_column =
                column_offset + static_cast<PetscInt>(block.column_indices[entry]);
            const PetscScalar value = static_cast<PetscScalar>(block.values[entry]);
            if (MatSetValue(matrix, petsc_row, petsc_column, value, INSERT_VALUES) != 0) {
                return false;
            }
        }
    }
    return true;
}

std::vector<PetscInt> estimate_a_row_nonzeros(
    const PoissonAirboxEigenBlockProblem &problem)
{
    std::vector<PetscInt> row_nonzeros(
        static_cast<std::size_t>(problem.q_dof_count + problem.phi_dof_count + 1),
        0);
    for (std::uint64_t row = 0; row < problem.q_dof_count; ++row) {
        row_nonzeros[static_cast<std::size_t>(row)] =
            static_cast<PetscInt>(
                (problem.A_qq.row_offsets[row + 1] - problem.A_qq.row_offsets[row]) +
                (problem.A_qphi.row_offsets[row + 1] - problem.A_qphi.row_offsets[row]));
    }
    for (std::uint64_t row = 0; row < problem.phi_dof_count; ++row) {
        row_nonzeros[static_cast<std::size_t>(problem.q_dof_count + row)] =
            static_cast<PetscInt>(
                (problem.A_phiq.row_offsets[row + 1] - problem.A_phiq.row_offsets[row]) +
                (problem.A_phiphi.row_offsets[row + 1] - problem.A_phiphi.row_offsets[row]) +
                1);
    }
    row_nonzeros.back() = static_cast<PetscInt>(problem.phi_dof_count + 1);
    return row_nonzeros;
}

std::vector<PetscInt> estimate_b_row_nonzeros(
    const PoissonAirboxEigenBlockProblem &problem)
{
    std::vector<PetscInt> row_nonzeros(
        static_cast<std::size_t>(problem.q_dof_count + problem.phi_dof_count + 1),
        0);
    for (std::uint64_t row = 0; row < problem.q_dof_count; ++row) {
        row_nonzeros[static_cast<std::size_t>(row)] =
            static_cast<PetscInt>(problem.B_qq.row_offsets[row + 1] - problem.B_qq.row_offsets[row]);
    }
    return row_nonzeros;
}

bool assemble_monolithic_matrices(
    const PoissonAirboxEigenBlockProblem &problem,
    Mat *A,
    Mat *B)
{
    const PetscInt nq = static_cast<PetscInt>(problem.q_dof_count);
    const PetscInt np = static_cast<PetscInt>(problem.phi_dof_count);
    const PetscInt total = nq + np + 1;
    std::vector<PetscInt> a_row_nonzeros = estimate_a_row_nonzeros(problem);
    std::vector<PetscInt> b_row_nonzeros = estimate_b_row_nonzeros(problem);
    if (MatCreateSeqAIJ(PETSC_COMM_SELF, total, total, 0, a_row_nonzeros.data(), A) != 0 ||
        MatCreateSeqAIJ(PETSC_COMM_SELF, total, total, 0, b_row_nonzeros.data(), B) != 0) {
        return false;
    }
    if (MatSetOption(*A, MAT_IGNORE_ZERO_ENTRIES, PETSC_FALSE) != 0) {
        return false;
    }
    const PetscInt q0 = 0;
    const PetscInt p0 = nq;
    const PetscInt g0 = nq + np;
    if (!insert_csr_block(*A, q0, q0, problem.A_qq) ||
        !insert_csr_block(*A, q0, p0, problem.A_qphi) ||
        !insert_csr_block(*A, p0, q0, problem.A_phiq) ||
        !insert_csr_block(*A, p0, p0, problem.A_phiphi) ||
        !insert_csr_block(*B, q0, q0, problem.B_qq)) {
        return false;
    }
    for (PetscInt row = 0; row < np; ++row) {
        const PetscScalar weight = static_cast<PetscScalar>(problem.phi_mean_weights[row]);
        if (MatSetValue(*A, p0 + row, g0, weight, INSERT_VALUES) != 0 ||
            MatSetValue(*A, g0, p0 + row, weight, INSERT_VALUES) != 0) {
            return false;
        }
    }
    if (MatSetValue(*A, g0, g0, static_cast<PetscScalar>(0.0), INSERT_VALUES) != 0) {
        return false;
    }
    return MatAssemblyBegin(*A, MAT_FINAL_ASSEMBLY) == 0 &&
        MatAssemblyEnd(*A, MAT_FINAL_ASSEMBLY) == 0 &&
        MatAssemblyBegin(*B, MAT_FINAL_ASSEMBLY) == 0 &&
        MatAssemblyEnd(*B, MAT_FINAL_ASSEMBLY) == 0;
}

double petsc_eigenvalue_real_part(PetscScalar kr)
{
    return static_cast<double>(PetscRealPart(kr));
}

double petsc_eigenvalue_imaginary_part(PetscScalar kr, PetscScalar ki)
{
    const double scalar_imaginary = static_cast<double>(PetscImaginaryPart(kr));
    if (std::abs(scalar_imaginary) > 0.0) {
        return scalar_imaginary;
    }
    return static_cast<double>(PetscRealPart(ki));
}

std::vector<Complex> copy_eigenvector(Vec xr, Vec xi, PetscInt size)
{
    std::vector<Complex> vector;
    const PetscScalar *real_values = nullptr;
    const PetscScalar *imag_values = nullptr;
    if (VecGetArrayRead(xr, &real_values) != 0 ||
        VecGetArrayRead(xi, &imag_values) != 0) {
        if (real_values != nullptr) {
            VecRestoreArrayRead(xr, &real_values);
        }
        if (imag_values != nullptr) {
            VecRestoreArrayRead(xi, &imag_values);
        }
        return vector;
    }
    vector.reserve(static_cast<std::size_t>(size));
    for (PetscInt index = 0; index < size; ++index) {
        const double real = static_cast<double>(PetscRealPart(real_values[index]));
#if defined(PETSC_USE_COMPLEX)
        const double imag = static_cast<double>(PetscImaginaryPart(real_values[index]));
#else
        const double imag = static_cast<double>(PetscRealPart(imag_values[index]));
#endif
        vector.emplace_back(real, imag);
    }
    VecRestoreArrayRead(xr, &real_values);
    VecRestoreArrayRead(xi, &imag_values);
    return vector;
}
#endif

} // namespace

FrequencyDomainStatus evaluate_poisson_airbox_modal_residuals(
    const PoissonAirboxEigenBlockProblem &problem,
    const double *full_vector_real,
    const double *full_vector_imag,
    std::uint64_t full_vector_count,
    double lambda_real,
    double lambda_imag,
    double slepc_reported_backward_error,
    PoissonAirboxModalResidualMetrics *out_metrics) noexcept
{
    if (out_metrics == nullptr) {
        return FrequencyDomainStatus::validation_error;
    }
    *out_metrics = PoissonAirboxModalResidualMetrics{};
    PoissonAirboxModalEigenResult validation_result{};
    if (validate_problem(problem, &validation_result) != FrequencyDomainStatus::ok) {
        return FrequencyDomainStatus::validation_error;
    }
    const std::uint64_t expected_count = augmented_dof_count_for(problem);
    if (full_vector_real == nullptr || full_vector_count != expected_count ||
        !std::isfinite(lambda_real) || !std::isfinite(lambda_imag) ||
        !std::isfinite(slepc_reported_backward_error) ||
        slepc_reported_backward_error < 0.0) {
        return FrequencyDomainStatus::validation_error;
    }
    std::vector<Complex> full_vector(static_cast<std::size_t>(full_vector_count));
    for (std::uint64_t index = 0; index < full_vector_count; ++index) {
        const double real = full_vector_real[index];
        const double imag = full_vector_imag != nullptr ? full_vector_imag[index] : 0.0;
        if (!std::isfinite(real) || !std::isfinite(imag)) {
            return FrequencyDomainStatus::validation_error;
        }
        full_vector[static_cast<std::size_t>(index)] = Complex{real, imag};
    }
    const ResidualMetrics residuals = compute_residual_metrics(
        problem,
        full_vector,
        Complex{lambda_real, lambda_imag});
    out_metrics->slepc_reported_backward_error = slepc_reported_backward_error;
    out_metrics->reconstructed_full_descriptor_backward_error = residuals.full_relative;
    if (slepc_reported_backward_error > 0.0) {
        const long double ratio =
            static_cast<long double>(residuals.full_relative) /
            static_cast<long double>(slepc_reported_backward_error);
        out_metrics->reconstruction_vs_slepc_ratio = static_cast<double>(
            std::min(
                ratio,
                static_cast<long double>(std::numeric_limits<double>::max())));
    } else {
        out_metrics->reconstruction_vs_slepc_ratio = residuals.full_relative == 0.0 ?
            1.0 : std::numeric_limits<double>::max();
    }
    out_metrics->magnetic_block_backward_error = residuals.q_relative;
    out_metrics->poisson_block_backward_error = residuals.phi_relative;
    out_metrics->gauge_constraint_backward_error = residuals.gauge_relative;
    out_metrics->gauge_mean_abs = residuals.gauge_abs;
    if (!std::isfinite(out_metrics->reconstructed_full_descriptor_backward_error) ||
        !std::isfinite(out_metrics->reconstruction_vs_slepc_ratio) ||
        !std::isfinite(out_metrics->magnetic_block_backward_error) ||
        !std::isfinite(out_metrics->poisson_block_backward_error) ||
        !std::isfinite(out_metrics->gauge_constraint_backward_error) ||
        !std::isfinite(out_metrics->gauge_mean_abs)) {
        *out_metrics = PoissonAirboxModalResidualMetrics{};
        return FrequencyDomainStatus::operator_error;
    }
    return FrequencyDomainStatus::ok;
}

FrequencyDomainStatus apply_poisson_airbox_modal_residual_certification(
    const PoissonAirboxModalResidualMetrics &metrics,
    double residual_tolerance,
    PoissonAirboxModalEigenResult *out_result) noexcept
{
    if (out_result == nullptr || !std::isfinite(residual_tolerance) ||
        !(residual_tolerance > 0.0)) {
        return FrequencyDomainStatus::validation_error;
    }
    const double expected_full = std::max(
        metrics.magnetic_block_backward_error,
        std::max(
            metrics.poisson_block_backward_error,
            metrics.gauge_constraint_backward_error));
    if (!std::isfinite(metrics.slepc_reported_backward_error) ||
        !std::isfinite(metrics.reconstructed_full_descriptor_backward_error) ||
        !std::isfinite(metrics.reconstruction_vs_slepc_ratio) ||
        !std::isfinite(metrics.magnetic_block_backward_error) ||
        !std::isfinite(metrics.poisson_block_backward_error) ||
        !std::isfinite(metrics.gauge_constraint_backward_error) ||
        !std::isfinite(metrics.gauge_mean_abs) ||
        metrics.slepc_reported_backward_error < 0.0 ||
        metrics.reconstructed_full_descriptor_backward_error < 0.0 ||
        metrics.magnetic_block_backward_error < 0.0 ||
        metrics.poisson_block_backward_error < 0.0 ||
        metrics.gauge_constraint_backward_error < 0.0 ||
        metrics.reconstructed_full_descriptor_backward_error != expected_full) {
        return FrequencyDomainStatus::operator_error;
    }
    out_result->eigen_residual_relative = metrics.slepc_reported_backward_error;
    out_result->slepc_reported_backward_error = metrics.slepc_reported_backward_error;
    out_result->reconstructed_full_descriptor_backward_error =
        metrics.reconstructed_full_descriptor_backward_error;
    out_result->reconstruction_vs_slepc_ratio = metrics.reconstruction_vs_slepc_ratio;
    out_result->magnetic_block_backward_error = metrics.magnetic_block_backward_error;
    out_result->poisson_block_backward_error = metrics.poisson_block_backward_error;
    out_result->gauge_constraint_backward_error = metrics.gauge_constraint_backward_error;
    out_result->full_residual_reconstruction_relative_error =
        metrics.reconstructed_full_descriptor_backward_error;
    out_result->poisson_constraint_relative_residual = metrics.poisson_block_backward_error;
    out_result->gauge_mean_abs = metrics.gauge_mean_abs;
    out_result->full_residual_certified =
        metrics.reconstructed_full_descriptor_backward_error <= residual_tolerance;
    out_result->status = out_result->full_residual_certified ?
        FrequencyDomainStatus::ok : FrequencyDomainStatus::solve_error;
    return out_result->status;
}

FrequencyDomainStatus apply_poisson_airbox_modal_shift_invert_action_cpu_reference(
    const PoissonAirboxEigenBlockProblem &problem,
    double sigma_real,
    double sigma_imag,
    const double *v_q_real,
    const double *v_q_imag,
    std::uint64_t v_q_count,
    double *out_q_real,
    double *out_q_imag,
    std::uint64_t out_q_count,
    PoissonAirboxModalShiftInvertActionResult *out_result) noexcept
{
    if (out_result == nullptr) {
        return FrequencyDomainStatus::validation_error;
    }
    *out_result = PoissonAirboxModalShiftInvertActionResult{};
    out_result->q_dof_count = problem.q_dof_count;
    out_result->phi_dof_count = problem.phi_dof_count;
    out_result->augmented_dof_count = augmented_dof_count_for(problem);
    out_result->sigma_real = sigma_real;
    out_result->sigma_imag = sigma_imag;

    PoissonAirboxModalEigenResult validation_result{};
    FrequencyDomainStatus status = validate_problem(problem, &validation_result);
    if (status != FrequencyDomainStatus::ok) {
        return fail_shift_invert_action(
            problem,
            out_result,
            status,
            validation_result.error_message,
            "poisson_airbox_shift_invert_action_invalid_problem");
    }
    if (v_q_real == nullptr ||
        out_q_real == nullptr ||
        out_q_imag == nullptr ||
        v_q_count != problem.q_dof_count ||
        out_q_count != problem.q_dof_count ||
        !std::isfinite(sigma_real) ||
        !std::isfinite(sigma_imag)) {
        return fail_shift_invert_action(
            problem,
            out_result,
            FrequencyDomainStatus::validation_error,
            "PA-G3 shift-invert action requires finite sigma and q-sized complex input/output buffers",
            "poisson_airbox_shift_invert_action_invalid_buffers");
    }

    const std::uint64_t nq = problem.q_dof_count;
    const std::uint64_t np = problem.phi_dof_count;
    const std::uint64_t total = nq + np + 1;
    const Complex sigma{sigma_real, sigma_imag};

    std::vector<Complex> v(static_cast<std::size_t>(nq), Complex{});
    for (std::uint64_t row = 0; row < nq; ++row) {
        const double real = v_q_real[row];
        const double imag = v_q_imag != nullptr ? v_q_imag[row] : 0.0;
        if (!std::isfinite(real) || !std::isfinite(imag)) {
            return fail_shift_invert_action(
                problem,
                out_result,
                FrequencyDomainStatus::validation_error,
                "PA-G3 shift-invert action input vector must be finite",
                "poisson_airbox_shift_invert_action_nonfinite_input");
        }
        v[static_cast<std::size_t>(row)] = Complex{real, imag};
    }

    std::vector<Complex> matrix(static_cast<std::size_t>(total * total), Complex{});
    add_csr_to_dense(problem.A_qq, 0, 0, matrix, total);
    add_csr_to_dense(problem.A_qphi, 0, nq, matrix, total);
    add_csr_to_dense(problem.A_phiq, nq, 0, matrix, total);
    add_csr_to_dense(problem.A_phiphi, nq, nq, matrix, total);
    for (std::uint64_t row = 0; row < np; ++row) {
        matrix[static_cast<std::size_t>((nq + row) * total + nq + np)] +=
            problem.phi_mean_weights[row];
        matrix[static_cast<std::size_t>((nq + np) * total + nq + row)] +=
            problem.phi_mean_weights[row];
    }
    for (std::uint64_t row = 0; row < problem.B_qq.row_count; ++row) {
        for (std::uint32_t entry = problem.B_qq.row_offsets[row];
             entry < problem.B_qq.row_offsets[row + 1];
             ++entry) {
            matrix[static_cast<std::size_t>(row * total + problem.B_qq.column_indices[entry])] -=
                sigma * problem.B_qq.values[entry];
        }
    }

    std::vector<Complex> rhs(static_cast<std::size_t>(total), Complex{});
    const std::vector<Complex> b_v = csr_matvec(problem.B_qq, v);
    for (std::uint64_t row = 0; row < nq; ++row) {
        rhs[static_cast<std::size_t>(row)] = b_v[static_cast<std::size_t>(row)];
    }
    out_result->rhs_l2_norm = complex_l2_norm(rhs);

    std::vector<Complex> solution;
    if (!solve_dense_complex_linear_system(matrix, rhs, solution)) {
        return fail_shift_invert_action(
            problem,
            out_result,
            FrequencyDomainStatus::solve_error,
            "PA-G3 shift-invert action failed to solve the shifted full-coupled descriptor system",
            "poisson_airbox_shift_invert_action_solve_failed");
    }

    std::vector<Complex> residual = dense_matvec(matrix, total, total, solution);
    for (std::uint64_t row = 0; row < total; ++row) {
        residual[static_cast<std::size_t>(row)] -= rhs[static_cast<std::size_t>(row)];
    }
    out_result->shifted_system_relative_residual =
        complex_l2_norm(residual) /
        (complex_l2_norm(rhs) + complex_l2_norm(dense_matvec(matrix, total, total, solution)) + 1.0e-30);

    std::vector<Complex> q(static_cast<std::size_t>(nq), Complex{});
    for (std::uint64_t row = 0; row < nq; ++row) {
        q[static_cast<std::size_t>(row)] = solution[static_cast<std::size_t>(row)];
        out_q_real[row] = q[static_cast<std::size_t>(row)].real();
        out_q_imag[row] = q[static_cast<std::size_t>(row)].imag();
    }
    out_result->output_q_l2_norm = complex_l2_norm(q);
    out_result->full_modal_shift_invert_claim = true;
    out_result->status = FrequencyDomainStatus::ok;
    write_shift_invert_action_diagnostics_json(problem, *out_result, "ok", "", out_result);
    return FrequencyDomainStatus::ok;
}

FrequencyDomainStatus solve_poisson_airbox_modal_eigen_cpu_slepc(
    const PoissonAirboxEigenBlockProblem &problem,
    PoissonAirboxModalEigenResult *out_result) noexcept
{
    FrequencyDomainStatus status = validate_problem(problem, out_result);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }

#if !FULLMAG_FEM_WITH_SLEPC
    return fail(
        problem,
        out_result,
        FrequencyDomainStatus::unavailable,
        "PA-E2 Poisson-airbox modal eigensolver requires PETSc/SLEPc",
        "slepc_not_available");
#else
    const std::lock_guard<std::mutex> lock(pa_e2_slepc_mutex());
    if (!ensure_slepc_initialized(out_result)) {
        return fail(
            problem,
            out_result,
            FrequencyDomainStatus::solve_error,
            out_result->error_message,
            "slepc_initialization_failed");
    }

    Mat A = nullptr;
    Mat B = nullptr;
    EPS eps = nullptr;
    Vec xr = nullptr;
    Vec xi = nullptr;
    const PetscInt total = static_cast<PetscInt>(
        problem.q_dof_count + problem.phi_dof_count + 1);
    if (!assemble_monolithic_matrices(problem, &A, &B)) {
        destroy_slepc_objects(nullptr, nullptr, nullptr, &A, &B);
        return fail(
            problem,
            out_result,
            FrequencyDomainStatus::operator_error,
            "PA-E2 failed to assemble monolithic SeqAIJ descriptor matrices",
            "poisson_airbox_eigen_seqaij_assembly_failed");
    }

    ST st = nullptr;
    KSP ksp = nullptr;
    PC pc = nullptr;
    const PetscInt requested_pairs = std::max<PetscInt>(
        1,
        static_cast<PetscInt>(std::max<std::uint32_t>(1, problem.requested_mode_count) * 2));
    const PetscInt nev = std::min<PetscInt>(total, requested_pairs);
    const PetscReal tolerance = static_cast<PetscReal>(problem.residual_tolerance);
    const PetscInt max_outer = problem.max_outer_iterations > 0 ?
        static_cast<PetscInt>(problem.max_outer_iterations) :
        PETSC_DEFAULT;
    const PetscInt max_linear = problem.max_linear_iterations > 0 ?
        static_cast<PetscInt>(problem.max_linear_iterations) :
        PETSC_DEFAULT;
    const double target_omega =
        omega_rad_s_from_frequency_hz(std::max(0.0, problem.target_frequency_hz));
    bool configured =
        EPSCreate(PETSC_COMM_SELF, &eps) == 0 &&
        EPSSetOperators(eps, A, B) == 0 &&
        EPSSetProblemType(eps, EPS_GNHEP) == 0 &&
        EPSSetType(eps, EPSKRYLOVSCHUR) == 0 &&
        EPSSetDimensions(eps, nev, PETSC_DEFAULT, PETSC_DEFAULT) == 0 &&
        EPSGetST(eps, &st) == 0 &&
        STSetType(st, STSINVERT) == 0 &&
        EPSSetWhichEigenpairs(eps, EPS_TARGET_MAGNITUDE) == 0 &&
        EPSSetTarget(eps, static_cast<PetscScalar>(target_omega)) == 0 &&
        EPSSetTolerances(eps, tolerance, max_outer) == 0 &&
        STGetKSP(st, &ksp) == 0 &&
        KSPSetType(ksp, KSPPREONLY) == 0 &&
        KSPGetPC(ksp, &pc) == 0 &&
        PCSetType(pc, PCLU) == 0 &&
#if defined(MATSOLVERUMFPACK)
        PCFactorSetMatSolverType(pc, MATSOLVERUMFPACK) == 0 &&
#elif defined(MATSOLVERKLU)
        PCFactorSetMatSolverType(pc, MATSOLVERKLU) == 0 &&
#else
        PCFactorSetShiftType(pc, MAT_SHIFT_NONZERO) == 0 &&
#endif
        KSPSetTolerances(ksp, std::min(0.01 * tolerance, 1.0e-10), 1.0e-14, PETSC_DEFAULT, max_linear) == 0 &&
        VecCreateSeq(PETSC_COMM_SELF, total, &xr) == 0 &&
        VecCreateSeq(PETSC_COMM_SELF, total, &xi) == 0;
    if (!configured) {
        destroy_slepc_objects(&eps, &xr, &xi, &A, &B);
        return fail(
            problem,
            out_result,
            FrequencyDomainStatus::solve_error,
            "PA-E2 failed to configure SLEPc shift-invert descriptor eigensolver",
            "slepc_solver_configuration_failed");
    }

    PetscInt outer_iterations = 0;
    PetscInt converged = 0;
    if (EPSSolve(eps) != 0 ||
        EPSGetIterationNumber(eps, &outer_iterations) != 0 ||
        EPSGetConverged(eps, &converged) != 0) {
        destroy_slepc_objects(&eps, &xr, &xi, &A, &B);
        return fail(
            problem,
            out_result,
            FrequencyDomainStatus::solve_error,
            "PA-E2 SLEPc eigensolve failed",
            "slepc_solve_failed");
    }
    out_result->outer_iterations = static_cast<std::uint32_t>(std::max<PetscInt>(0, outer_iterations));
    out_result->converged_eigenpair_count = static_cast<std::uint32_t>(std::max<PetscInt>(0, converged));

    bool saw_positive = false;
    double best_target_distance = std::numeric_limits<double>::infinity();
    std::vector<Complex> best_vector;
    PetscInt best_index = -1;
    double best_lambda_real = 0.0;
    double best_lambda_imag = 0.0;
    double best_residual = 0.0;
    for (PetscInt index = 0; index < converged; ++index) {
        PetscScalar kr = 0.0;
        PetscScalar ki = 0.0;
        PetscReal residual = 0.0;
        if (EPSGetEigenpair(eps, index, &kr, &ki, xr, xi) != 0 ||
            EPSComputeError(eps, index, EPS_ERROR_BACKWARD, &residual) != 0) {
            continue;
        }
        const double lambda_real = petsc_eigenvalue_real_part(kr);
        const double lambda_imag = petsc_eigenvalue_imaginary_part(kr, ki);
        const ModeKinematics kinematics = map_eigenvalue(
            {lambda_real, lambda_imag},
            FrequencyDomainPhaseConvention::exp_i_omega_t);
        if (!kinematics.finite || kinematics.branch_sign != 1) {
            continue;
        }
        saw_positive = true;
        if (static_cast<double>(residual) > problem.residual_tolerance) {
            continue;
        }
        std::vector<Complex> vector = copy_eigenvector(xr, xi, total);
        if (vector.size() != static_cast<std::size_t>(total)) {
            continue;
        }
        const double target_distance = std::abs(kinematics.omega_rad_s - target_omega);
        if (target_distance < best_target_distance) {
            best_target_distance = target_distance;
            best_vector = std::move(vector);
            best_index = index;
            best_lambda_real = lambda_real;
            best_lambda_imag = lambda_imag;
            best_residual = static_cast<double>(residual);
        }
    }
    destroy_slepc_objects(&eps, &xr, &xi, &A, &B);

    if (best_index < 0) {
        return fail(
            problem,
            out_result,
            FrequencyDomainStatus::solve_error,
            saw_positive ? "PA-E2 found no accepted positive-frequency mode within residual tolerance" :
                "PA-E2 found no positive-frequency mode",
            saw_positive ? "no_accepted_positive_frequency_mode" : "no_positive_frequency_eigenpair");
    }

    out_result->accepted_mode_count = 1;
    out_result->selected_eigenpair_index = static_cast<std::uint32_t>(best_index);
    out_result->positive_frequency_branch_found = true;
    out_result->eigenvalue_real = best_lambda_real;
    out_result->eigenvalue_imag = best_lambda_imag;
    const ModeKinematics selected_kinematics = map_eigenvalue(
        {best_lambda_real, best_lambda_imag},
        FrequencyDomainPhaseConvention::exp_i_omega_t);
    out_result->omega_rad_s = selected_kinematics.omega_rad_s;
    out_result->frequency_hz = selected_kinematics.frequency_hz;
    out_result->gauge_augmented = true;

    std::vector<double> best_vector_real(best_vector.size(), 0.0);
    std::vector<double> best_vector_imag(best_vector.size(), 0.0);
    for (std::size_t index = 0; index < best_vector.size(); ++index) {
        best_vector_real[index] = best_vector[index].real();
        best_vector_imag[index] = best_vector[index].imag();
    }
    PoissonAirboxModalResidualMetrics residual_metrics{};
    if (evaluate_poisson_airbox_modal_residuals(
            problem,
            best_vector_real.data(),
            best_vector_imag.data(),
            static_cast<std::uint64_t>(best_vector.size()),
            best_lambda_real,
            best_lambda_imag,
            best_residual,
            &residual_metrics) != FrequencyDomainStatus::ok) {
        return fail(
            problem,
            out_result,
            FrequencyDomainStatus::operator_error,
            "PA-E2 failed to evaluate full descriptor residuals",
            "poisson_airbox_eigen_residual_evaluation_failed");
    }
    const FrequencyDomainStatus certification_status =
        apply_poisson_airbox_modal_residual_certification(
            residual_metrics,
            problem.residual_tolerance,
            out_result);
    if (certification_status == FrequencyDomainStatus::operator_error) {
        return fail(
            problem,
            out_result,
            FrequencyDomainStatus::operator_error,
            "PA-E2 residual metrics are non-finite or internally inconsistent",
            "poisson_airbox_eigen_invalid_residual_metrics");
    }
    if (problem.expected_reference_frequency_hz > 0.0) {
        out_result->relative_reference_frequency_error =
            std::abs(out_result->frequency_hz - problem.expected_reference_frequency_hz) /
            problem.expected_reference_frequency_hz;
    }
    out_result->reference_frequency_certified =
        problem.expected_reference_frequency_hz <= 0.0 ||
        out_result->relative_reference_frequency_error <= 1.0e-10;

    if (!out_result->full_residual_certified) {
        return fail(
            problem,
            out_result,
            FrequencyDomainStatus::solve_error,
            "PA-E2 full descriptor residual reconstruction failed certification",
            "poisson_airbox_eigen_full_residual_not_certified");
    }
    if (!out_result->reference_frequency_certified) {
        char message[256]{};
        std::snprintf(
            message,
            sizeof(message),
            "PA-E2 sparse SLEPc frequency %.17g Hz does not match PA-E1 dense oracle %.17g Hz; relative error %.17g",
            out_result->frequency_hz,
            problem.expected_reference_frequency_hz,
            out_result->relative_reference_frequency_error);
        return fail(
            problem,
            out_result,
            FrequencyDomainStatus::solve_error,
            message,
            "poisson_airbox_eigen_dense_reference_mismatch");
    }

    out_result->status = FrequencyDomainStatus::ok;
    copy_message(out_result->error_message, sizeof(out_result->error_message), "");
    write_diagnostics_json(problem, *out_result, "ok", "", out_result);
    return FrequencyDomainStatus::ok;
#endif
}

} // namespace fullmag::fem::frequency_domain
