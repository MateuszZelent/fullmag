#include "cpu/frequency_domain/poisson_airbox_modal_eigen.hpp"

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

constexpr double kTwoPi = 6.283185307179586476925286766559;
constexpr std::uint64_t kMaxPaE2DofCount = 128;

bool string_equals(const char *actual, const char *expected) noexcept
{
    return actual != nullptr && expected != nullptr && std::strcmp(actual, expected) == 0;
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
        "\"gauge_policy\":\"%s\","
        "\"phasor_convention\":\"%s\","
        "\"eigenvalue_convention\":\"%s\","
        "\"algebraic_form\":\"full_coupled_descriptor_augmented_gauge\","
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
        "\"poisson_constraint_relative_residual\":%.17g,"
        "\"gauge_mean_abs\":%.17g,"
        "\"eigen_residual_relative\":%.17g,"
        "\"relative_reference_frequency_error\":%.17g"
        "},"
        "\"eigenpair\":{"
        "\"eigenvalue_real\":%.17g,"
        "\"eigenvalue_imag\":%.17g,"
        "\"omega_rad_s\":%.17g,"
        "\"frequency_hz\":%.17g,"
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
        problem.gauge_policy != nullptr ? problem.gauge_policy : "",
        problem.phasor_convention != nullptr ? problem.phasor_convention : "",
        problem.eigenvalue_convention != nullptr ? problem.eigenvalue_convention : "",
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
        result.poisson_constraint_relative_residual,
        result.gauge_mean_abs,
        result.eigen_residual_relative,
        result.relative_reference_frequency_error,
        result.eigenvalue_real,
        result.eigenvalue_imag,
        result.omega_rad_s,
        result.frequency_hz,
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
    result->augmented_dof_count = problem.q_dof_count + problem.phi_dof_count + 1;
    result->magnetic_pair_count = problem.magnetic_pair_count;
    result->airbox_pair_count = problem.airbox_pair_count;
    result->expected_reference_frequency_hz = problem.expected_reference_frequency_hz;

    if (problem.abi_version != kPoissonAirboxEigenBlockProblemAbiVersion ||
        problem.struct_size < sizeof(PoissonAirboxEigenBlockProblem)) {
        return fail(
            problem,
            result,
            FrequencyDomainStatus::validation_error,
            "PA-E2 Poisson-airbox modal eigensolver requires ABI version 1",
            "poisson_airbox_eigen_unsupported_abi");
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
    if (!string_equals(problem.gauge_policy, "mean_zero_augmented")) {
        return fail(
            problem,
            result,
            FrequencyDomainStatus::validation_error,
            "PA-E2 Poisson-airbox modal eigensolver requires gauge_policy=mean_zero_augmented",
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
    double phi_relative = 0.0;
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

    std::vector<Complex> residual;
    residual.reserve(static_cast<std::size_t>(nq + np + 1));

    std::vector<Complex> a_qq_q = csr_matvec(problem.A_qq, q);
    std::vector<Complex> a_qphi_phi = csr_matvec(problem.A_qphi, phi);
    std::vector<Complex> b_qq_q = csr_matvec(problem.B_qq, q);
    for (std::uint64_t row = 0; row < nq; ++row) {
        residual.push_back(
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
        residual.push_back(value);
        phi_residual.push_back(value);
    }

    Complex gauge{};
    for (std::uint64_t row = 0; row < np; ++row) {
        gauge += problem.phi_mean_weights[row] * phi[static_cast<std::size_t>(row)];
    }
    residual.push_back(gauge);

    std::vector<Complex> ax_norm_terms;
    ax_norm_terms.reserve(residual.size());
    for (std::uint64_t row = 0; row < nq; ++row) {
        ax_norm_terms.push_back(
            a_qq_q[static_cast<std::size_t>(row)] +
            a_qphi_phi[static_cast<std::size_t>(row)]);
    }
    for (std::uint64_t row = 0; row < np; ++row) {
        ax_norm_terms.push_back(
            a_phiq_q[static_cast<std::size_t>(row)] +
            a_phiphi_phi[static_cast<std::size_t>(row)] +
            problem.phi_mean_weights[row] * eta);
    }
    ax_norm_terms.push_back(gauge);

    const double scale =
        complex_l2_norm(ax_norm_terms) +
        std::abs(lambda) * complex_l2_norm(b_qq_q) +
        1.0e-30;
    ResidualMetrics metrics{};
    metrics.full_relative = complex_l2_norm(residual) / scale;
    metrics.phi_relative = complex_l2_norm(phi_residual) /
        (complex_l2_norm(a_phiq_q) + complex_l2_norm(a_phiphi_phi) + std::abs(eta) + 1.0e-30);
    metrics.gauge_abs = std::abs(gauge);
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
    const double target_omega = std::max(0.0, problem.target_frequency_hz) * kTwoPi;
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
            EPSComputeError(eps, index, EPS_ERROR_RELATIVE, &residual) != 0) {
            continue;
        }
        const double lambda_real = petsc_eigenvalue_real_part(kr);
        const double lambda_imag = petsc_eigenvalue_imaginary_part(kr, ki);
        if (lambda_imag <= 0.0 || !std::isfinite(lambda_real) || !std::isfinite(lambda_imag)) {
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
        const double target_distance = std::abs(lambda_imag - target_omega);
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
    out_result->omega_rad_s = best_lambda_imag;
    out_result->frequency_hz = best_lambda_imag / kTwoPi;
    out_result->eigen_residual_relative = best_residual;
    out_result->gauge_augmented = true;

    ResidualMetrics residual_metrics = compute_residual_metrics(
        problem,
        best_vector,
        Complex(best_lambda_real, best_lambda_imag));
#if !defined(PETSC_USE_COMPLEX)
    std::vector<Complex> conjugated_vector = best_vector;
    for (Complex &value : conjugated_vector) {
        value = std::conj(value);
    }
    const ResidualMetrics conjugated_residual_metrics = compute_residual_metrics(
        problem,
        conjugated_vector,
        Complex(best_lambda_real, best_lambda_imag));
    if (conjugated_residual_metrics.full_relative < residual_metrics.full_relative) {
        residual_metrics = conjugated_residual_metrics;
    }
#endif
    out_result->full_residual_reconstruction_relative_error =
        std::min(residual_metrics.full_relative, best_residual);
    out_result->poisson_constraint_relative_residual = residual_metrics.phi_relative;
    out_result->gauge_mean_abs = residual_metrics.gauge_abs;
    out_result->full_residual_certified =
        out_result->full_residual_reconstruction_relative_error <=
            10.0 * problem.residual_tolerance &&
        residual_metrics.gauge_abs <= 1.0e-12;
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
