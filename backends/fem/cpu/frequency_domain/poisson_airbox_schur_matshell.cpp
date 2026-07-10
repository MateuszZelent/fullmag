#include "cpu/frequency_domain/poisson_airbox_schur_matshell.hpp"
#include "frequency_domain/mode_kinematics.hpp"

#include <algorithm>
#include <array>
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

constexpr std::uint64_t kFnvOffset = 1469598103934665603ULL;
constexpr std::uint64_t kFnvPrime = 1099511628211ULL;

struct ComplexDenseMatrix {
    std::uint64_t rows = 0;
    std::uint64_t cols = 0;
    std::vector<Complex> values{};

    Complex &operator()(std::uint64_t row, std::uint64_t col) noexcept
    {
        return values[static_cast<std::size_t>(row * cols + col)];
    }

    const Complex &operator()(std::uint64_t row, std::uint64_t col) const noexcept
    {
        return values[static_cast<std::size_t>(row * cols + col)];
    }
};

struct EigenPair2x2 {
    bool ok = false;
    Complex lambda{};
    std::vector<Complex> q{};
};

struct ResidualMetrics {
    double full_relative = 0.0;
    double phi_relative = 0.0;
    double gauge_abs = 0.0;
};

void copy_message(char *destination, std::size_t destination_size, const char *message) noexcept
{
    if (destination == nullptr || destination_size == 0) {
        return;
    }
    std::strncpy(destination, message != nullptr ? message : "", destination_size - 1);
    destination[destination_size - 1] = '\0';
}

std::uint64_t fnv_mix_byte(std::uint64_t hash, unsigned char byte) noexcept
{
    hash ^= static_cast<std::uint64_t>(byte);
    hash *= kFnvPrime;
    return hash;
}

std::uint64_t fnv_mix_u64(std::uint64_t hash, std::uint64_t value) noexcept
{
    for (int shift = 0; shift < 64; shift += 8) {
        hash = fnv_mix_byte(hash, static_cast<unsigned char>((value >> shift) & 0xffU));
    }
    return hash;
}

std::uint64_t fnv_mix_double(std::uint64_t hash, double value) noexcept
{
    std::uint64_t bits = 0;
    static_assert(sizeof(bits) == sizeof(value), "double hash expects 64-bit double");
    std::memcpy(&bits, &value, sizeof(bits));
    return fnv_mix_u64(hash, bits);
}

std::uint64_t fnv_mix_string(std::uint64_t hash, const char *value) noexcept
{
    if (value == nullptr) {
        return fnv_mix_u64(hash, 0);
    }
    while (*value != '\0') {
        hash = fnv_mix_byte(hash, static_cast<unsigned char>(*value));
        ++value;
    }
    return fnv_mix_byte(hash, 0);
}

std::uint64_t hash_csr(const CsrMatrixView &matrix, std::uint64_t seed) noexcept
{
    std::uint64_t hash = fnv_mix_u64(seed, matrix.row_count);
    hash = fnv_mix_u64(hash, matrix.column_count);
    hash = fnv_mix_u64(hash, matrix.values_len);
    if (matrix.row_offsets != nullptr) {
        for (std::uint64_t index = 0; index < matrix.row_offsets_len; ++index) {
            hash = fnv_mix_u64(hash, matrix.row_offsets[index]);
        }
    }
    if (matrix.column_indices != nullptr) {
        for (std::uint64_t index = 0; index < matrix.column_indices_len; ++index) {
            hash = fnv_mix_u64(hash, matrix.column_indices[index]);
        }
    }
    if (matrix.values != nullptr) {
        for (std::uint64_t index = 0; index < matrix.values_len; ++index) {
            hash = fnv_mix_double(hash, matrix.values[index]);
        }
    }
    return hash;
}

double complex_l2_norm(const std::vector<Complex> &values) noexcept
{
    long double sum = 0.0L;
    for (const Complex &value : values) {
        sum += static_cast<long double>(std::norm(value));
    }
    return std::sqrt(static_cast<double>(sum));
}

double relative_error(
    const std::vector<Complex> &actual,
    const std::vector<Complex> &expected) noexcept
{
    if (actual.size() != expected.size()) {
        return std::numeric_limits<double>::infinity();
    }
    std::vector<Complex> delta(actual.size(), Complex{});
    for (std::size_t index = 0; index < actual.size(); ++index) {
        delta[index] = actual[index] - expected[index];
    }
    return complex_l2_norm(delta) / (complex_l2_norm(expected) + 1.0e-300);
}

std::vector<Complex> matvec(
    const ComplexDenseMatrix &matrix,
    const std::vector<Complex> &x)
{
    std::vector<Complex> y(static_cast<std::size_t>(matrix.rows), Complex{});
    if (matrix.cols != x.size()) {
        return y;
    }
    for (std::uint64_t row = 0; row < matrix.rows; ++row) {
        Complex value{};
        for (std::uint64_t col = 0; col < matrix.cols; ++col) {
            value += matrix(row, col) * x[static_cast<std::size_t>(col)];
        }
        y[static_cast<std::size_t>(row)] = value;
    }
    return y;
}

ComplexDenseMatrix csr_to_dense_complex(const CsrMatrixView &matrix)
{
    ComplexDenseMatrix dense{matrix.row_count, matrix.column_count, {}};
    dense.values.assign(
        static_cast<std::size_t>(matrix.row_count * matrix.column_count),
        Complex{});
    for (std::uint64_t row = 0; row < matrix.row_count; ++row) {
        for (std::uint32_t entry = matrix.row_offsets[row];
             entry < matrix.row_offsets[row + 1];
             ++entry) {
            dense(row, matrix.column_indices[entry]) = Complex(matrix.values[entry], 0.0);
        }
    }
    return dense;
}

bool solve_dense_complex_linear_system(
    ComplexDenseMatrix lhs,
    std::vector<Complex> rhs,
    std::vector<Complex> &solution,
    double pivot_tolerance,
    char error_message[256]) noexcept
{
    const std::uint64_t n = lhs.rows;
    if (lhs.rows != lhs.cols || rhs.size() != static_cast<std::size_t>(n)) {
        copy_message(error_message, 256, "dense complex linear solve shape mismatch");
        return false;
    }
    for (std::uint64_t column = 0; column < n; ++column) {
        std::uint64_t pivot = column;
        double best = std::abs(lhs(column, column));
        for (std::uint64_t row = column + 1; row < n; ++row) {
            const double candidate = std::abs(lhs(row, column));
            if (candidate > best) {
                best = candidate;
                pivot = row;
            }
        }
        if (!(best > pivot_tolerance) || !std::isfinite(best)) {
            copy_message(error_message, 256, "singular mean-zero Poisson solve");
            return false;
        }
        if (pivot != column) {
            for (std::uint64_t col = column; col < n; ++col) {
                std::swap(lhs(column, col), lhs(pivot, col));
            }
            std::swap(rhs[static_cast<std::size_t>(column)], rhs[static_cast<std::size_t>(pivot)]);
        }
        const Complex diagonal = lhs(column, column);
        for (std::uint64_t row = column + 1; row < n; ++row) {
            const Complex factor = lhs(row, column) / diagonal;
            lhs(row, column) = Complex{};
            for (std::uint64_t col = column + 1; col < n; ++col) {
                lhs(row, col) -= factor * lhs(column, col);
            }
            rhs[static_cast<std::size_t>(row)] -= factor * rhs[static_cast<std::size_t>(column)];
        }
    }
    solution.assign(static_cast<std::size_t>(n), Complex{});
    for (std::int64_t row = static_cast<std::int64_t>(n) - 1; row >= 0; --row) {
        Complex value = rhs[static_cast<std::size_t>(row)];
        for (std::uint64_t col = static_cast<std::uint64_t>(row) + 1; col < n; ++col) {
            value -= lhs(static_cast<std::uint64_t>(row), col) *
                solution[static_cast<std::size_t>(col)];
        }
        solution[static_cast<std::size_t>(row)] =
            value / lhs(static_cast<std::uint64_t>(row), static_cast<std::uint64_t>(row));
    }
    return true;
}

ComplexDenseMatrix build_mean_zero_augmented_poisson(
    const ComplexDenseMatrix &poisson,
    const double *weights)
{
    const std::uint64_t n = poisson.rows;
    ComplexDenseMatrix augmented{n + 1, n + 1, {}};
    augmented.values.assign(static_cast<std::size_t>((n + 1) * (n + 1)), Complex{});
    for (std::uint64_t row = 0; row < n; ++row) {
        for (std::uint64_t col = 0; col < n; ++col) {
            augmented(row, col) = poisson(row, col);
        }
    }
    for (std::uint64_t index = 0; index < n; ++index) {
        augmented(index, n) = Complex(weights[index], 0.0);
        augmented(n, index) = Complex(weights[index], 0.0);
    }
    return augmented;
}

bool solve_phi_for_q(
    const ComplexDenseMatrix &augmented_poisson,
    const ComplexDenseMatrix &a_phiq,
    const std::vector<Complex> &q,
    std::vector<Complex> &phi,
    Complex &eta,
    char error_message[256]) noexcept
{
    const std::vector<Complex> phiq = matvec(a_phiq, q);
    if (phiq.size() != static_cast<std::size_t>(a_phiq.rows)) {
        copy_message(error_message, 256, "A_phiq q shape mismatch");
        return false;
    }
    std::vector<Complex> rhs(static_cast<std::size_t>(a_phiq.rows + 1), Complex{});
    for (std::uint64_t row = 0; row < a_phiq.rows; ++row) {
        rhs[static_cast<std::size_t>(row)] = -phiq[static_cast<std::size_t>(row)];
    }
    std::vector<Complex> solution;
    if (!solve_dense_complex_linear_system(
            augmented_poisson,
            rhs,
            solution,
            1.0e-14,
            error_message)) {
        return false;
    }
    phi.assign(solution.begin(), solution.begin() + static_cast<std::ptrdiff_t>(a_phiq.rows));
    eta = solution[static_cast<std::size_t>(a_phiq.rows)];
    return true;
}

std::vector<Complex> apply_schur(
    const ComplexDenseMatrix &a_qq,
    const ComplexDenseMatrix &a_qphi,
    const ComplexDenseMatrix &augmented_poisson,
    const ComplexDenseMatrix &a_phiq,
    const std::vector<Complex> &q,
    char error_message[256]) noexcept
{
    std::vector<Complex> phi;
    Complex eta{};
    if (!solve_phi_for_q(augmented_poisson, a_phiq, q, phi, eta, error_message)) {
        return {};
    }
    std::vector<Complex> y = matvec(a_qq, q);
    const std::vector<Complex> feedback = matvec(a_qphi, phi);
    if (y.size() != feedback.size()) {
        copy_message(error_message, 256, "A_qphi phi shape mismatch");
        return {};
    }
    for (std::size_t index = 0; index < y.size(); ++index) {
        y[index] += feedback[index];
    }
    return y;
}

ComplexDenseMatrix build_explicit_schur_by_direct_apply(
    const ComplexDenseMatrix &a_qq,
    const ComplexDenseMatrix &a_qphi,
    const ComplexDenseMatrix &augmented_poisson,
    const ComplexDenseMatrix &a_phiq,
    char error_message[256]) noexcept
{
    const std::uint64_t n = a_qq.rows;
    ComplexDenseMatrix schur{n, n, {}};
    schur.values.assign(static_cast<std::size_t>(n * n), Complex{});
    for (std::uint64_t col = 0; col < n; ++col) {
        std::vector<Complex> basis(static_cast<std::size_t>(n), Complex{});
        basis[static_cast<std::size_t>(col)] = Complex(1.0, 0.0);
        const std::vector<Complex> y =
            apply_schur(a_qq, a_qphi, augmented_poisson, a_phiq, basis, error_message);
        if (y.size() != static_cast<std::size_t>(n)) {
            return {};
        }
        for (std::uint64_t row = 0; row < n; ++row) {
            schur(row, col) = y[static_cast<std::size_t>(row)];
        }
    }
    return schur;
}

ComplexDenseMatrix left_solve_matrix(
    const ComplexDenseMatrix &lhs,
    const ComplexDenseMatrix &rhs,
    char error_message[256]) noexcept
{
    if (lhs.rows != lhs.cols || lhs.rows != rhs.rows) {
        copy_message(error_message, 256, "left solve matrix shape mismatch");
        return {};
    }
    ComplexDenseMatrix result{rhs.rows, rhs.cols, {}};
    result.values.assign(static_cast<std::size_t>(rhs.rows * rhs.cols), Complex{});
    for (std::uint64_t col = 0; col < rhs.cols; ++col) {
        std::vector<Complex> rhs_col(static_cast<std::size_t>(rhs.rows), Complex{});
        for (std::uint64_t row = 0; row < rhs.rows; ++row) {
            rhs_col[static_cast<std::size_t>(row)] = rhs(row, col);
        }
        std::vector<Complex> solved;
        if (!solve_dense_complex_linear_system(lhs, rhs_col, solved, 1.0e-14, error_message)) {
            return {};
        }
        for (std::uint64_t row = 0; row < rhs.rows; ++row) {
            result(row, col) = solved[static_cast<std::size_t>(row)];
        }
    }
    return result;
}

bool solve_2x2_standard_eigen(
    const ComplexDenseMatrix &matrix,
    Complex lambda[2],
    std::array<Complex, 2> vec[2]) noexcept
{
    if (matrix.rows != 2 || matrix.cols != 2) {
        return false;
    }
    const Complex a = matrix(0, 0);
    const Complex b = matrix(0, 1);
    const Complex c = matrix(1, 0);
    const Complex d = matrix(1, 1);
    const Complex trace = a + d;
    const Complex determinant = a * d - b * c;
    const Complex discriminant =
        std::sqrt(trace * trace - Complex(4.0, 0.0) * determinant);
    lambda[0] = Complex(0.5, 0.0) * (trace + discriminant);
    lambda[1] = Complex(0.5, 0.0) * (trace - discriminant);

    for (int index = 0; index < 2; ++index) {
        const Complex l = lambda[index];
        if (std::abs(b) + std::abs(a - l) > std::abs(d - l) + std::abs(c)) {
            vec[index] = {b, l - a};
        } else {
            vec[index] = {l - d, c};
        }
        double norm = std::sqrt(std::norm(vec[index][0]) + std::norm(vec[index][1]));
        if (!(norm > 0.0) || !std::isfinite(norm)) {
            return false;
        }
        vec[index][0] /= norm;
        vec[index][1] /= norm;
    }
    return true;
}

EigenPair2x2 solve_tiny_positive_frequency_eigen(
    const ComplexDenseMatrix &schur,
    const ComplexDenseMatrix &b_qq,
    char error_message[256]) noexcept
{
    EigenPair2x2 out{};
    const ComplexDenseMatrix standard = left_solve_matrix(b_qq, schur, error_message);
    if (standard.rows != 2 || standard.cols != 2) {
        return out;
    }
    Complex lambda[2]{};
    std::array<Complex, 2> vec[2]{};
    if (!solve_2x2_standard_eigen(standard, lambda, vec)) {
        copy_message(error_message, 256, "2x2 Schur eigen solve failed");
        return out;
    }
    int best = -1;
    double best_omega_rad_s = -std::numeric_limits<double>::infinity();
    for (int index = 0; index < 2; ++index) {
        const ModeKinematics kinematics = map_eigenvalue(
            {lambda[index].real(), lambda[index].imag()},
            FrequencyDomainPhaseConvention::exp_i_omega_t);
        if (kinematics.finite &&
            kinematics.branch_sign == 1 &&
            kinematics.omega_rad_s > best_omega_rad_s) {
            best = index;
            best_omega_rad_s = kinematics.omega_rad_s;
        }
    }
    if (best < 0) {
        copy_message(error_message, 256, "positive-frequency Schur eigen branch not found");
        return out;
    }
    out.ok = true;
    out.lambda = lambda[best];
    out.q = {vec[best][0], vec[best][1]};
    return out;
}

double vector_weight_norm(const double *weights, std::uint64_t count) noexcept
{
    long double sum = 0.0L;
    for (std::uint64_t index = 0; index < count; ++index) {
        sum += static_cast<long double>(weights[index] * weights[index]);
    }
    return std::sqrt(static_cast<double>(sum));
}

Complex weighted_mean(const std::vector<Complex> &phi, const double *weights)
{
    Complex value{};
    for (std::size_t index = 0; index < phi.size(); ++index) {
        value += weights[index] * phi[index];
    }
    return value;
}

ResidualMetrics compute_full_descriptor_residual(
    const ComplexDenseMatrix &a_qq,
    const ComplexDenseMatrix &a_qphi,
    const ComplexDenseMatrix &a_phiq,
    const ComplexDenseMatrix &a_phiphi,
    const ComplexDenseMatrix &b_qq,
    const double *phi_weights,
    Complex lambda,
    const std::vector<Complex> &q,
    const std::vector<Complex> &phi,
    Complex eta)
{
    ResidualMetrics out{};
    std::vector<Complex> r_q = matvec(a_qq, q);
    const std::vector<Complex> qphi = matvec(a_qphi, phi);
    const std::vector<Complex> bq = matvec(b_qq, q);
    for (std::size_t index = 0; index < r_q.size(); ++index) {
        r_q[index] += qphi[index] - lambda * bq[index];
    }

    std::vector<Complex> r_phi = matvec(a_phiq, q);
    const std::vector<Complex> pphi = matvec(a_phiphi, phi);
    for (std::size_t index = 0; index < r_phi.size(); ++index) {
        r_phi[index] += pphi[index] + phi_weights[index] * eta;
    }
    const Complex gauge = weighted_mean(phi, phi_weights);
    const double q_denom =
        complex_l2_norm(matvec(a_qq, q)) +
        complex_l2_norm(qphi) +
        std::abs(lambda) * complex_l2_norm(bq) +
        1.0e-300;
    const double phi_denom =
        complex_l2_norm(matvec(a_phiq, q)) +
        complex_l2_norm(pphi) +
        std::abs(eta) * vector_weight_norm(phi_weights, a_phiphi.rows) +
        1.0e-300;
    const double rq = complex_l2_norm(r_q);
    const double rp = complex_l2_norm(r_phi);
    const double rg = std::abs(gauge);
    out.phi_relative = std::sqrt(rp * rp + rg * rg) / phi_denom;
    out.gauge_abs = rg;
    out.full_relative = std::sqrt(rq * rq + rp * rp + rg * rg) / (q_denom + phi_denom);
    return out;
}

double eigen_residual_relative(
    const ComplexDenseMatrix &schur,
    const ComplexDenseMatrix &b_qq,
    Complex lambda,
    const std::vector<Complex> &q) noexcept
{
    std::vector<Complex> residual = matvec(schur, q);
    const std::vector<Complex> bq = matvec(b_qq, q);
    if (residual.size() != bq.size()) {
        return std::numeric_limits<double>::infinity();
    }
    for (std::size_t index = 0; index < residual.size(); ++index) {
        residual[index] -= lambda * bq[index];
    }
    return complex_l2_norm(residual) /
        (complex_l2_norm(matvec(schur, q)) +
         std::abs(lambda) * complex_l2_norm(bq) +
         1.0e-300);
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

PoissonAirboxSchurMatShellCertificateKey make_certificate_key(
    const PoissonAirboxEigenBlockProblem &problem) noexcept
{
    PoissonAirboxSchurMatShellCertificateKey key{};
    key.mesh_signature = fnv_mix_u64(kFnvOffset, problem.q_dof_count);
    key.mesh_signature = fnv_mix_u64(key.mesh_signature, problem.phi_dof_count);
    key.material_signature = hash_csr(problem.B_qq, fnv_mix_string(kFnvOffset, "B_qq"));
    if (problem.phi_mean_weights != nullptr) {
        for (std::uint64_t index = 0; index < problem.phi_mean_weights_count; ++index) {
            key.material_signature = fnv_mix_double(
                key.material_signature,
                problem.phi_mean_weights[index]);
        }
    }
    key.m0_signature = fnv_mix_string(kFnvOffset, "uniform_m0_pa_e3");
    key.h_eff0_signature = hash_csr(problem.A_qq, fnv_mix_string(kFnvOffset, "A_qq"));
    key.static_demag_signature = fnv_mix_string(kFnvOffset, problem.demag_kind);
    key.boundary_signature = fnv_mix_string(kFnvOffset, "periodic_airbox_k0");
    key.k_signature = fnv_mix_string(kFnvOffset, "k=0");
    key.gauge_signature = fnv_mix_string(kFnvOffset, problem.gauge_policy);
    key.operator_signature = hash_csr(problem.A_qphi, fnv_mix_string(kFnvOffset, "A_qphi"));
    key.operator_signature = hash_csr(problem.A_phiq, key.operator_signature);
    key.operator_signature = hash_csr(problem.A_phiphi, key.operator_signature);
    return key;
}

void write_certificate_key_json(
    const PoissonAirboxSchurMatShellCertificateKey &key,
    PoissonAirboxSchurMatShellCertificationResult *out) noexcept
{
    if (out == nullptr) {
        return;
    }
    std::snprintf(
        out->certificate_key_json,
        sizeof(out->certificate_key_json),
        "{"
        "\"schema_version\":\"poisson_airbox_schur_certificate_key.v1\","
        "\"mesh_signature\":%llu,"
        "\"material_signature\":%llu,"
        "\"m0_signature\":%llu,"
        "\"h_eff0_signature\":%llu,"
        "\"static_demag_signature\":%llu,"
        "\"boundary_signature\":%llu,"
        "\"k_signature\":%llu,"
        "\"gauge_signature\":%llu,"
        "\"operator_signature\":%llu"
        "}",
        static_cast<unsigned long long>(key.mesh_signature),
        static_cast<unsigned long long>(key.material_signature),
        static_cast<unsigned long long>(key.m0_signature),
        static_cast<unsigned long long>(key.h_eff0_signature),
        static_cast<unsigned long long>(key.static_demag_signature),
        static_cast<unsigned long long>(key.boundary_signature),
        static_cast<unsigned long long>(key.k_signature),
        static_cast<unsigned long long>(key.gauge_signature),
        static_cast<unsigned long long>(key.operator_signature));
}

void write_diagnostics_json(
    const PoissonAirboxEigenBlockProblem &problem,
    const PoissonAirboxSchurMatShellCertificationResult &result,
    const char *status,
    const char *reason,
    PoissonAirboxSchurMatShellCertificationResult *out,
    ComplexEigenvalue lambda = {}) noexcept
{
    if (out == nullptr) {
        return;
    }
    const ModeKinematics kinematics = map_eigenvalue(
        lambda,
        FrequencyDomainPhaseConvention::exp_i_omega_t);
    std::snprintf(
        out->diagnostics_json,
        sizeof(out->diagnostics_json),
        "{"
        "\"schema_version\":\"poisson_airbox_schur_matshell.v1\","
        "\"status\":\"%s\","
        "\"reason\":\"%s\","
        "\"study_product\":\"modal_eigen\","
        "\"test_id\":\"pa_e3_poisson_airbox_schur_matshell\","
        "\"solver_adapter\":\"k0_poisson_airbox_cpu_schur_matshell_slepc\","
        "\"demag_kind\":\"%s\","
        "\"gauge_policy\":\"%s\","
        "\"algebraic_form\":\"schur_reduced_matrix_free_mean_zero_poisson\","
        "\"reference_adapter\":\"k0_poisson_airbox_cpu_full_coupled_slepc\","
        "\"created_petsc_matshell\":%s,"
        "\"reused_mean_zero_poisson_setup\":%s,"
        "\"q_dof_count\":%llu,"
        "\"phi_dof_count\":%llu,"
        "\"augmented_phi_dof_count\":%llu,"
        "\"metrics\":{"
        "\"schur_apply_relative_error\":%.17g,"
        "\"schur_eigen_residual_relative\":%.17g,"
        "\"full_residual_reconstruction_relative_error\":%.17g,"
        "\"poisson_constraint_relative_residual\":%.17g,"
        "\"gauge_mean_abs\":%.17g,"
        "\"full_sparse_reference_relative_frequency_error\":%.17g"
        "},"
        "\"eigenpair\":{"
        "\"lambda_real_per_s\":%.17g,"
        "\"lambda_imag_rad_per_s\":%.17g,"
        "\"omega_rad_s\":%.17g,"
        "\"frequency_hz\":%.17g,"
        "\"decay_rate_per_s\":%.17g,"
        "\"branch_sign\":%d,"
        "\"stable\":%s,"
        "\"schur_frequency_hz\":%.17g,"
        "\"full_sparse_reference_frequency_hz\":%.17g"
        "},"
        "\"certification\":{"
        "\"schur_certified\":%s,"
        "\"full_sparse_reference_certified\":%s,"
        "\"full_residual_certified\":%s"
        "},"
        "\"certificate_key\":%s"
        "}",
        status != nullptr ? status : "unknown",
        reason != nullptr ? reason : "",
        problem.demag_kind != nullptr ? problem.demag_kind : "",
        problem.gauge_policy != nullptr ? problem.gauge_policy : "",
        result.created_petsc_matshell ? "true" : "false",
        result.reused_mean_zero_poisson_setup ? "true" : "false",
        static_cast<unsigned long long>(result.q_dof_count),
        static_cast<unsigned long long>(result.phi_dof_count),
        static_cast<unsigned long long>(result.augmented_phi_dof_count),
        result.schur_apply_relative_error,
        result.schur_eigen_residual_relative,
        result.full_residual_reconstruction_relative_error,
        result.poisson_constraint_relative_residual,
        result.gauge_mean_abs,
        result.full_sparse_reference_relative_frequency_error,
        kinematics.lambda.real_per_s,
        kinematics.lambda.imag_rad_per_s,
        kinematics.omega_rad_s,
        kinematics.frequency_hz,
        kinematics.decay_rate_per_s,
        kinematics.branch_sign,
        kinematics.finite && kinematics.branch_sign != 0 && kinematics.stable ? "true" : "false",
        result.schur_frequency_hz,
        result.full_sparse_reference_frequency_hz,
        result.schur_certified ? "true" : "false",
        result.full_sparse_reference_certified ? "true" : "false",
        result.full_residual_certified ? "true" : "false",
        result.certificate_key_json[0] != '\0' ? result.certificate_key_json : "{}");
}

FrequencyDomainStatus fail(
    const PoissonAirboxEigenBlockProblem &problem,
    PoissonAirboxSchurMatShellCertificationResult *result,
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

#if FULLMAG_FEM_WITH_SLEPC
struct SchurMatShellContext {
    const ComplexDenseMatrix *a_qq = nullptr;
    const ComplexDenseMatrix *a_qphi = nullptr;
    const ComplexDenseMatrix *augmented_poisson = nullptr;
    const ComplexDenseMatrix *a_phiq = nullptr;
    char error_message[256]{};
};

std::mutex &pa_e3_slepc_mutex()
{
    static std::mutex mutex;
    return mutex;
}

bool ensure_slepc_initialized(char error_message[256])
{
    PetscBool initialized = PETSC_FALSE;
    if (SlepcInitialized(&initialized) != 0) {
        copy_message(error_message, 256, "SLEPc initialization query failed");
        return false;
    }
    if (!initialized && SlepcInitializeNoArguments() != 0) {
        copy_message(error_message, 256, "SLEPc initialization failed");
        return false;
    }
    return true;
}

PetscErrorCode schur_matmult(Mat matrix, Vec x, Vec y)
{
    void *raw_context = nullptr;
    if (MatShellGetContext(matrix, &raw_context) != 0 || raw_context == nullptr) {
        return PETSC_ERR_ARG_NULL;
    }
    auto *context = static_cast<SchurMatShellContext *>(raw_context);
    PetscInt size = 0;
    if (VecGetSize(x, &size) != 0 ||
        size < 0 ||
        context->a_qq == nullptr ||
        static_cast<std::uint64_t>(size) != context->a_qq->cols) {
        copy_message(context->error_message, sizeof(context->error_message), "Schur MatShell input shape mismatch");
        return PETSC_ERR_ARG_SIZ;
    }
    const PetscScalar *x_values = nullptr;
    PetscScalar *y_values = nullptr;
    if (VecGetArrayRead(x, &x_values) != 0) {
        return PETSC_ERR_LIB;
    }
    std::vector<Complex> q(static_cast<std::size_t>(size), Complex{});
    for (PetscInt index = 0; index < size; ++index) {
        q[static_cast<std::size_t>(index)] = Complex(
            static_cast<double>(PetscRealPart(x_values[index])),
#if defined(PETSC_USE_COMPLEX)
            static_cast<double>(PetscImaginaryPart(x_values[index]))
#else
            0.0
#endif
        );
    }
    VecRestoreArrayRead(x, &x_values);
    const std::vector<Complex> schur_y = apply_schur(
        *context->a_qq,
        *context->a_qphi,
        *context->augmented_poisson,
        *context->a_phiq,
        q,
        context->error_message);
    if (schur_y.size() != static_cast<std::size_t>(size)) {
        return PETSC_ERR_ARG_SIZ;
    }
    if (VecGetArray(y, &y_values) != 0) {
        return PETSC_ERR_LIB;
    }
    for (PetscInt index = 0; index < size; ++index) {
#if defined(PETSC_USE_COMPLEX)
        y_values[index] = PetscScalar(
            schur_y[static_cast<std::size_t>(index)].real(),
            schur_y[static_cast<std::size_t>(index)].imag());
#else
        y_values[index] = static_cast<PetscScalar>(
            schur_y[static_cast<std::size_t>(index)].real());
#endif
    }
    VecRestoreArray(y, &y_values);
    return 0;
}

bool insert_csr_block(Mat matrix, const CsrMatrixView &block)
{
    for (std::uint64_t row = 0; row < block.row_count; ++row) {
        for (std::uint32_t entry = block.row_offsets[row];
             entry < block.row_offsets[row + 1];
             ++entry) {
            const PetscInt petsc_row = static_cast<PetscInt>(row);
            const PetscInt petsc_column =
                static_cast<PetscInt>(block.column_indices[entry]);
            const PetscScalar value = static_cast<PetscScalar>(block.values[entry]);
            if (MatSetValue(matrix, petsc_row, petsc_column, value, INSERT_VALUES) != 0) {
                return false;
            }
        }
    }
    return true;
}

bool create_b_matrix(const PoissonAirboxEigenBlockProblem &problem, Mat *B)
{
    const PetscInt n = static_cast<PetscInt>(problem.q_dof_count);
    std::vector<PetscInt> row_nonzeros(static_cast<std::size_t>(problem.q_dof_count), 0);
    for (std::uint64_t row = 0; row < problem.q_dof_count; ++row) {
        row_nonzeros[static_cast<std::size_t>(row)] =
            static_cast<PetscInt>(
                problem.B_qq.row_offsets[row + 1] - problem.B_qq.row_offsets[row]);
    }
    if (MatCreateSeqAIJ(PETSC_COMM_SELF, n, n, 0, row_nonzeros.data(), B) != 0) {
        return false;
    }
    if (!insert_csr_block(*B, problem.B_qq)) {
        return false;
    }
    return MatAssemblyBegin(*B, MAT_FINAL_ASSEMBLY) == 0 &&
        MatAssemblyEnd(*B, MAT_FINAL_ASSEMBLY) == 0;
}

bool apply_petsc_matshell(
    Mat shell,
    const std::vector<Complex> &q,
    std::vector<Complex> &y)
{
    Vec x = nullptr;
    Vec out = nullptr;
    const PetscInt n = static_cast<PetscInt>(q.size());
    if (VecCreateSeq(PETSC_COMM_SELF, n, &x) != 0 ||
        VecCreateSeq(PETSC_COMM_SELF, n, &out) != 0) {
        if (x != nullptr) {
            VecDestroy(&x);
        }
        if (out != nullptr) {
            VecDestroy(&out);
        }
        return false;
    }
    for (PetscInt index = 0; index < n; ++index) {
#if defined(PETSC_USE_COMPLEX)
        const PetscScalar value = PetscScalar(
            q[static_cast<std::size_t>(index)].real(),
            q[static_cast<std::size_t>(index)].imag());
#else
        const PetscScalar value = static_cast<PetscScalar>(
            q[static_cast<std::size_t>(index)].real());
#endif
        if (VecSetValue(x, index, value, INSERT_VALUES) != 0) {
            VecDestroy(&x);
            VecDestroy(&out);
            return false;
        }
    }
    if (VecAssemblyBegin(x) != 0 ||
        VecAssemblyEnd(x) != 0 ||
        MatMult(shell, x, out) != 0) {
        VecDestroy(&x);
        VecDestroy(&out);
        return false;
    }
    const PetscScalar *values = nullptr;
    if (VecGetArrayRead(out, &values) != 0) {
        VecDestroy(&x);
        VecDestroy(&out);
        return false;
    }
    y.assign(q.size(), Complex{});
    for (PetscInt index = 0; index < n; ++index) {
        y[static_cast<std::size_t>(index)] = Complex(
            static_cast<double>(PetscRealPart(values[index])),
#if defined(PETSC_USE_COMPLEX)
            static_cast<double>(PetscImaginaryPart(values[index]))
#else
            0.0
#endif
        );
    }
    VecRestoreArrayRead(out, &values);
    VecDestroy(&x);
    VecDestroy(&out);
    return true;
}

ComplexDenseMatrix build_explicit_schur_from_matshell(
    Mat shell,
    std::uint64_t q_dof_count,
    char error_message[256])
{
    ComplexDenseMatrix schur{q_dof_count, q_dof_count, {}};
    schur.values.assign(static_cast<std::size_t>(q_dof_count * q_dof_count), Complex{});
    for (std::uint64_t col = 0; col < q_dof_count; ++col) {
        std::vector<Complex> basis(static_cast<std::size_t>(q_dof_count), Complex{});
        basis[static_cast<std::size_t>(col)] = Complex(1.0, 0.0);
        std::vector<Complex> y;
        if (!apply_petsc_matshell(shell, basis, y) ||
            y.size() != static_cast<std::size_t>(q_dof_count)) {
            copy_message(error_message, 256, "Schur MatShell column apply failed");
            return {};
        }
        for (std::uint64_t row = 0; row < q_dof_count; ++row) {
            schur(row, col) = y[static_cast<std::size_t>(row)];
        }
    }
    return schur;
}

void destroy_slepc_objects(EPS *eps, Vec *xr, Vec *xi, Mat *S, Mat *B)
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
    if (S != nullptr && *S != nullptr) {
        MatDestroy(S);
    }
    if (B != nullptr && *B != nullptr) {
        MatDestroy(B);
    }
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

bool solve_schur_matshell_slepc(
    const PoissonAirboxEigenBlockProblem &problem,
    Mat shell,
    Mat b_matrix,
    Complex &lambda,
    std::vector<Complex> &q,
    double &relative_residual,
    char error_message[256])
{
    EPS eps = nullptr;
    Vec xr = nullptr;
    Vec xi = nullptr;
    const PetscInt n = static_cast<PetscInt>(problem.q_dof_count);
    const PetscInt requested = std::min<PetscInt>(
        n,
        std::max<PetscInt>(1, static_cast<PetscInt>(problem.requested_mode_count) * 2));
    if (EPSCreate(PETSC_COMM_SELF, &eps) != 0 ||
        EPSSetOperators(eps, shell, b_matrix) != 0 ||
        EPSSetProblemType(eps, EPS_GNHEP) != 0 ||
        EPSSetType(eps, EPSKRYLOVSCHUR) != 0 ||
        EPSSetDimensions(eps, requested, PETSC_DEFAULT, PETSC_DEFAULT) != 0 ||
        EPSSetWhichEigenpairs(eps, EPS_TARGET_MAGNITUDE) != 0 ||
        EPSSetTarget(
            eps,
            static_cast<PetscScalar>(omega_rad_s_from_frequency_hz(
                std::max(0.0, problem.target_frequency_hz)))) != 0 ||
        EPSSetTolerances(
            eps,
            static_cast<PetscReal>(problem.residual_tolerance),
            problem.max_outer_iterations > 0 ?
                static_cast<PetscInt>(problem.max_outer_iterations) :
                PETSC_DEFAULT) != 0 ||
        VecCreateSeq(PETSC_COMM_SELF, n, &xr) != 0 ||
        VecCreateSeq(PETSC_COMM_SELF, n, &xi) != 0) {
        destroy_slepc_objects(&eps, &xr, &xi, nullptr, nullptr);
        copy_message(error_message, 256, "PA-E3 failed to configure Schur MatShell SLEPc eigensolver");
        return false;
    }
    PetscInt converged = 0;
    if (EPSSolve(eps) != 0 || EPSGetConverged(eps, &converged) != 0) {
        destroy_slepc_objects(&eps, &xr, &xi, nullptr, nullptr);
        copy_message(error_message, 256, "PA-E3 Schur MatShell SLEPc solve failed");
        return false;
    }
    bool found = false;
    double best_target_distance = std::numeric_limits<double>::infinity();
    const double target_omega =
        omega_rad_s_from_frequency_hz(std::max(0.0, problem.target_frequency_hz));
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
        const ModeKinematics kinematics = map_eigenvalue(
            {lambda_real, lambda_imag},
            FrequencyDomainPhaseConvention::exp_i_omega_t);
        if (!kinematics.finite ||
            kinematics.branch_sign != 1 ||
            static_cast<double>(residual) > problem.residual_tolerance) {
            continue;
        }
        const double target_distance = std::abs(kinematics.omega_rad_s - target_omega);
        if (target_distance < best_target_distance) {
            std::vector<Complex> vector = copy_eigenvector(xr, xi, n);
            if (vector.size() != static_cast<std::size_t>(n)) {
                continue;
            }
            found = true;
            best_target_distance = target_distance;
            lambda = Complex(lambda_real, lambda_imag);
            q = std::move(vector);
            relative_residual = static_cast<double>(residual);
        }
    }
    destroy_slepc_objects(&eps, &xr, &xi, nullptr, nullptr);
    if (!found) {
        copy_message(error_message, 256, "PA-E3 found no accepted positive-frequency Schur MatShell eigenpair");
    }
    return found;
}
#endif

} // namespace

FrequencyDomainStatus certify_poisson_airbox_schur_matshell_cpu(
    const PoissonAirboxEigenBlockProblem &problem,
    PoissonAirboxSchurMatShellCertificationResult *out_result) noexcept
{
    if (out_result == nullptr) {
        return FrequencyDomainStatus::validation_error;
    }
    *out_result = PoissonAirboxSchurMatShellCertificationResult{};
    out_result->q_dof_count = problem.q_dof_count;
    out_result->phi_dof_count = problem.phi_dof_count;
    out_result->augmented_phi_dof_count = problem.phi_dof_count + 1;
    if (problem.phi_mean_weights == nullptr ||
        problem.phi_mean_weights_count != problem.phi_dof_count ||
        !positive_normalized_weights(
            problem.phi_mean_weights,
            problem.phi_mean_weights_count)) {
        return fail(
            problem,
            out_result,
            FrequencyDomainStatus::validation_error,
            "PA-E3 Schur MatShell gauge weights must be positive normalized mean-zero weights",
            "poisson_airbox_schur_requires_mean_zero_gauge");
    }
    out_result->certificate_key = make_certificate_key(problem);
    write_certificate_key_json(out_result->certificate_key, out_result);

#if !FULLMAG_FEM_WITH_SLEPC
    return fail(
        problem,
        out_result,
        FrequencyDomainStatus::unavailable,
        "PA-E3 Schur MatShell certification requires PETSc/SLEPc",
        "slepc_not_available");
#else
    PoissonAirboxModalEigenResult sparse_reference{};
    FrequencyDomainStatus reference_status =
        solve_poisson_airbox_modal_eigen_cpu_slepc(problem, &sparse_reference);
    if (reference_status != FrequencyDomainStatus::ok) {
        copy_message(out_result->error_message, sizeof(out_result->error_message), sparse_reference.error_message);
        return fail(
            problem,
            out_result,
            reference_status,
            out_result->error_message,
            "pa_e2_full_coupled_sparse_reference_failed");
    }
    out_result->full_sparse_reference_frequency_hz = sparse_reference.frequency_hz;

    const std::lock_guard<std::mutex> lock(pa_e3_slepc_mutex());
    if (!ensure_slepc_initialized(out_result->error_message)) {
        return fail(
            problem,
            out_result,
            FrequencyDomainStatus::solve_error,
            out_result->error_message,
            "slepc_initialization_failed");
    }

    ComplexDenseMatrix a_qq = csr_to_dense_complex(problem.A_qq);
    ComplexDenseMatrix a_qphi = csr_to_dense_complex(problem.A_qphi);
    ComplexDenseMatrix a_phiq = csr_to_dense_complex(problem.A_phiq);
    ComplexDenseMatrix a_phiphi = csr_to_dense_complex(problem.A_phiphi);
    ComplexDenseMatrix b_qq = csr_to_dense_complex(problem.B_qq);
    ComplexDenseMatrix augmented_poisson =
        build_mean_zero_augmented_poisson(a_phiphi, problem.phi_mean_weights);
    out_result->reused_mean_zero_poisson_setup = true;

    SchurMatShellContext context{};
    context.a_qq = &a_qq;
    context.a_qphi = &a_qphi;
    context.augmented_poisson = &augmented_poisson;
    context.a_phiq = &a_phiq;

    Mat shell = nullptr;
    Mat b_matrix = nullptr;
    const PetscInt q_count = static_cast<PetscInt>(problem.q_dof_count);
    if (MatCreateShell(
            PETSC_COMM_SELF,
            q_count,
            q_count,
            q_count,
            q_count,
            &context,
            &shell) != 0 ||
        MatShellSetOperation(
            shell,
            MATOP_MULT,
            reinterpret_cast<void (*)(void)>(schur_matmult)) != 0 ||
        MatSetUp(shell) != 0 ||
        !create_b_matrix(problem, &b_matrix)) {
        destroy_slepc_objects(nullptr, nullptr, nullptr, &shell, &b_matrix);
        return fail(
            problem,
            out_result,
            FrequencyDomainStatus::operator_error,
            "PA-E3 failed to create Schur MatShell or B_qq matrix",
            "schur_matshell_creation_failed");
    }
    out_result->created_petsc_matshell = true;

    std::vector<Complex> q_test(static_cast<std::size_t>(problem.q_dof_count), Complex{});
    q_test[0] = Complex(1.0, 0.0);
    if (q_test.size() > 1) {
        q_test[1] = Complex(-0.25, 0.0);
    }
    std::vector<Complex> matshell_apply;
    if (!apply_petsc_matshell(shell, q_test, matshell_apply)) {
        copy_message(out_result->error_message, sizeof(out_result->error_message), context.error_message);
        destroy_slepc_objects(nullptr, nullptr, nullptr, &shell, &b_matrix);
        return fail(
            problem,
            out_result,
            FrequencyDomainStatus::operator_error,
            out_result->error_message,
            "schur_matshell_apply_failed");
    }
    const std::vector<Complex> direct_apply = apply_schur(
        a_qq,
        a_qphi,
        augmented_poisson,
        a_phiq,
        q_test,
        out_result->error_message);
    out_result->schur_apply_relative_error = relative_error(matshell_apply, direct_apply);

    ComplexDenseMatrix schur =
        build_explicit_schur_from_matshell(shell, problem.q_dof_count, out_result->error_message);
    if (schur.rows != problem.q_dof_count || schur.cols != problem.q_dof_count) {
        destroy_slepc_objects(nullptr, nullptr, nullptr, &shell, &b_matrix);
        return fail(
            problem,
            out_result,
            FrequencyDomainStatus::operator_error,
            out_result->error_message,
            "schur_matshell_explicit_build_failed");
    }
    ComplexDenseMatrix direct_schur = build_explicit_schur_by_direct_apply(
        a_qq,
        a_qphi,
        augmented_poisson,
        a_phiq,
        out_result->error_message);
    if (direct_schur.rows != problem.q_dof_count ||
        direct_schur.cols != problem.q_dof_count) {
        destroy_slepc_objects(nullptr, nullptr, nullptr, &shell, &b_matrix);
        return fail(
            problem,
            out_result,
            FrequencyDomainStatus::operator_error,
            out_result->error_message,
            "schur_direct_explicit_build_failed");
    }

    Complex lambda{};
    std::vector<Complex> q;
    double eps_residual = 0.0;
    if (!solve_schur_matshell_slepc(
            problem,
            shell,
            b_matrix,
            lambda,
            q,
            eps_residual,
            out_result->error_message)) {
        destroy_slepc_objects(nullptr, nullptr, nullptr, &shell, &b_matrix);
        return fail(
            problem,
            out_result,
            FrequencyDomainStatus::solve_error,
            out_result->error_message,
            "schur_matshell_slepc_solve_failed");
    }
    destroy_slepc_objects(nullptr, nullptr, nullptr, &shell, &b_matrix);

    EigenPair2x2 fallback_eigen =
        solve_tiny_positive_frequency_eigen(direct_schur, b_qq, out_result->error_message);
    if (!fallback_eigen.ok) {
        return fail(
            problem,
            out_result,
            FrequencyDomainStatus::solve_error,
            out_result->error_message,
            "schur_explicit_eigen_reference_failed");
    }
    if (problem.q_dof_count == 2 &&
        std::abs(lambda.imag() - fallback_eigen.lambda.imag()) >
            std::max(1.0, std::abs(fallback_eigen.lambda.imag())) * 1.0e-8) {
        return fail(
            problem,
            out_result,
            FrequencyDomainStatus::solve_error,
            "PA-E3 Schur MatShell SLEPc eigenvalue does not match explicit Schur reference",
            "schur_matshell_slepc_explicit_mismatch");
    }

    const ModeKinematics selected_kinematics = map_eigenvalue(
        {lambda.real(), lambda.imag()},
        FrequencyDomainPhaseConvention::exp_i_omega_t);
    out_result->schur_frequency_hz = selected_kinematics.frequency_hz;
    out_result->schur_eigen_residual_relative =
        eigen_residual_relative(direct_schur, b_qq, lambda, q);
    if (eps_residual > out_result->schur_eigen_residual_relative) {
        out_result->schur_eigen_residual_relative = eps_residual;
    }

    std::vector<Complex> phi;
    Complex eta{};
    if (!solve_phi_for_q(augmented_poisson, a_phiq, q, phi, eta, out_result->error_message)) {
        return fail(
            problem,
            out_result,
            FrequencyDomainStatus::operator_error,
            out_result->error_message,
            "schur_phi_reconstruction_failed");
    }
    const ResidualMetrics full = compute_full_descriptor_residual(
        a_qq,
        a_qphi,
        a_phiq,
        a_phiphi,
        b_qq,
        problem.phi_mean_weights,
        lambda,
        q,
        phi,
        eta);
    out_result->full_residual_reconstruction_relative_error = full.full_relative;
    out_result->poisson_constraint_relative_residual = full.phi_relative;
    out_result->gauge_mean_abs = full.gauge_abs;
    out_result->full_sparse_reference_relative_frequency_error =
        std::abs(out_result->schur_frequency_hz - sparse_reference.frequency_hz) /
        std::max(std::abs(sparse_reference.frequency_hz), 1.0e-300);

    out_result->schur_certified =
        out_result->schur_apply_relative_error <= problem.residual_tolerance &&
        out_result->schur_eigen_residual_relative <= 10.0 * problem.residual_tolerance;
    out_result->full_sparse_reference_certified =
        out_result->full_sparse_reference_relative_frequency_error <= 1.0e-10;
    out_result->full_residual_certified =
        out_result->full_residual_reconstruction_relative_error <= 10.0 * problem.residual_tolerance &&
        out_result->poisson_constraint_relative_residual <= 10.0 * problem.residual_tolerance &&
        out_result->gauge_mean_abs <= 1.0e-12;

    const bool all_ok =
        out_result->schur_certified &&
        out_result->full_sparse_reference_certified &&
        out_result->full_residual_certified;
    out_result->status = all_ok ? FrequencyDomainStatus::ok : FrequencyDomainStatus::solve_error;
    if (!all_ok) {
        copy_message(
            out_result->error_message,
            sizeof(out_result->error_message),
            "PA-E3 Schur MatShell certification failed");
    }
    write_diagnostics_json(
        problem,
        *out_result,
        all_ok ? "ok" : "failed",
        all_ok ? "" : "pa_e3_schur_matshell_certification_failed",
        out_result,
        {lambda.real(), lambda.imag()});
    return out_result->status;
#endif
}

} // namespace fullmag::fem::frequency_domain
