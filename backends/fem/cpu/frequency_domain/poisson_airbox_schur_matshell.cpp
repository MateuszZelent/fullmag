#include "cpu/frequency_domain/poisson_airbox_schur_matshell.hpp"
#include "cpu/frequency_domain/mode_deduplication.hpp"
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
#include <slepceps.h>
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

bool production_string_equals(const char *actual, const char *expected) noexcept
{
    return actual != nullptr && expected != nullptr && std::strcmp(actual, expected) == 0;
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
        if (select_positive_frequency_mode(
                kinematics,
                ZeroFrequencyModePolicy::exclude) &&
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
    ComplexEigenvalue lambda = {},
    bool eigenpair_found = false,
    bool eigenpair_accepted = false) noexcept
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
        "\"residual_tolerance\":%.17g,"
        "\"zero_frequency_mode_policy\":\"exclude_zero_frequency\","
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
        "\"finite\":%s,"
        "\"stable\":%s,"
        "\"zero_frequency_mode\":%s,"
        "\"eigenpair_found\":%s,"
        "\"eigenpair_accepted\":%s,"
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
        problem.residual_tolerance,
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
        kinematics.finite ? "true" : "false",
        kinematics.stable ? "true" : "false",
        kinematics.zero_frequency_mode ? "true" : "false",
        eigenpair_found ? "true" : "false",
        eigenpair_accepted ? "true" : "false",
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
        if (!select_positive_frequency_mode(
                kinematics,
                ZeroFrequencyModePolicy::exclude) ||
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

// Production shared-domain context.  The scalar Poisson factorization is
// created once and every Schur MatShell action reuses it.  The context owns no
// input storage; all matrices are assembled from the immutable request and
// destroyed by solve_poisson_airbox_modal_eigen_cpu_schur().
struct ProductionSchurContext {
    Mat a_qq = nullptr;
    Mat a_qphi = nullptr;
    Mat a_phiq = nullptr;
    Mat poisson = nullptr;
    KSP poisson_ksp = nullptr;
    Vec phi_rhs = nullptr;
    Vec poisson_rhs = nullptr;
    Vec poisson_solution = nullptr;
    Vec phi_solution = nullptr;
    Vec feedback = nullptr;
    PetscInt q_count = 0;
    PetscInt phi_count = 0;
    PetscInt augmented_phi_count = 0;
    bool gauge_augmented = false;
    std::uint64_t operator_apply_count = 0;
    std::uint64_t poisson_solve_count = 0;
    std::uint64_t poisson_iteration_count = 0;
    char error_message[256]{};
};

struct ProductionSplitContext {
    ProductionSchurContext *base = nullptr;
    Vec q_real = nullptr;
    Vec q_imag = nullptr;
    Vec y_real = nullptr;
    Vec y_imag = nullptr;
};

PetscErrorCode production_modal_ksp_convergence_test(
    KSP ksp,
    PetscInt iteration,
    PetscReal residual_norm,
    KSPConvergedReason *reason,
    void *raw_problem)
{
    PetscFunctionBeginUser;
    auto *problem = static_cast<const PoissonAirboxEigenBlockProblem *>(raw_problem);
    PetscCheck(problem != nullptr, PETSC_COMM_SELF, PETSC_ERR_ARG_NULL,
               "missing production modal callback problem");
    if (poisson_airbox_modal_cancel_requested(*problem)) {
        if (reason != nullptr) {
            *reason = KSP_DIVERGED_USER;
        }
        poisson_airbox_modal_emit_progress(
            *problem,
            "cancelling_shift_invert",
            "production_cpu",
            static_cast<std::uint32_t>(std::max<PetscInt>(0, iteration)),
            0,
            0,
            static_cast<std::uint32_t>(std::max<PetscInt>(0, iteration)),
            static_cast<double>(residual_norm),
            "cancel_requested");
        PetscFunctionReturn(PETSC_SUCCESS);
    }
    PetscCall(KSPConvergedDefault(ksp, iteration, residual_norm, reason, nullptr));
    poisson_airbox_modal_emit_progress(
        *problem,
        "solving_shift_invert",
        "production_cpu",
        static_cast<std::uint32_t>(std::max<PetscInt>(0, iteration)),
        0,
        0,
        static_cast<std::uint32_t>(std::max<PetscInt>(0, iteration)),
        static_cast<double>(residual_norm));
    PetscFunctionReturn(PETSC_SUCCESS);
}

bool create_production_csr_matrix(
    const CsrMatrixView &csr,
    Mat *matrix)
{
    if (matrix == nullptr ||
        csr.row_count > static_cast<std::uint64_t>(std::numeric_limits<PetscInt>::max()) ||
        csr.column_count > static_cast<std::uint64_t>(std::numeric_limits<PetscInt>::max())) {
        return false;
    }
    const PetscInt rows = static_cast<PetscInt>(csr.row_count);
    const PetscInt columns = static_cast<PetscInt>(csr.column_count);
    std::vector<PetscInt> row_nonzeros(static_cast<std::size_t>(rows), 0);
    for (PetscInt row = 0; row < rows; ++row) {
        const std::uint64_t count =
            csr.row_offsets[static_cast<std::size_t>(row + 1)] -
            csr.row_offsets[static_cast<std::size_t>(row)];
        if (count > static_cast<std::uint64_t>(std::numeric_limits<PetscInt>::max())) {
            return false;
        }
        row_nonzeros[static_cast<std::size_t>(row)] = static_cast<PetscInt>(count);
    }
    if (MatCreateSeqAIJ(PETSC_COMM_SELF, rows, columns, 0, row_nonzeros.data(), matrix) != 0) {
        return false;
    }
    // MFEM CSR blocks have unique entries, but disabling this guard keeps the
    // native contract robust if an accepted payload contains repeated entries.
    if (MatSetOption(*matrix, MAT_NEW_NONZERO_ALLOCATION_ERR, PETSC_FALSE) != 0) {
        return false;
    }
    if (!insert_csr_block(*matrix, csr)) {
        return false;
    }
    return MatAssemblyBegin(*matrix, MAT_FINAL_ASSEMBLY) == 0 &&
        MatAssemblyEnd(*matrix, MAT_FINAL_ASSEMBLY) == 0;
}

bool create_production_augmented_poisson(
    const PoissonAirboxEigenBlockProblem &problem,
    ProductionSchurContext *context)
{
    if (context == nullptr) {
        return false;
    }
    const bool gauge = production_string_equals(
        problem.gauge_policy,
        "mean_zero_augmented");
    const std::uint64_t phi_count = problem.phi_dof_count;
    const std::uint64_t augmented_count = phi_count + (gauge ? 1u : 0u);
    if (augmented_count > static_cast<std::uint64_t>(std::numeric_limits<PetscInt>::max())) {
        return false;
    }
    std::vector<PetscInt> row_nonzeros(static_cast<std::size_t>(augmented_count), 0);
    for (std::uint64_t row = 0; row < phi_count; ++row) {
        const std::uint64_t base =
            problem.A_phiphi.row_offsets[row + 1u] - problem.A_phiphi.row_offsets[row];
        const std::uint64_t count = base + (gauge ? 1u : 0u);
        if (count > static_cast<std::uint64_t>(std::numeric_limits<PetscInt>::max())) {
            return false;
        }
        row_nonzeros[static_cast<std::size_t>(row)] = static_cast<PetscInt>(count);
    }
    if (gauge) {
        // Keep the augmented gauge diagonal structurally present even though
        // its physical value is zero.  PETSc's sparse LU symbolic factorizer
        // requires every row to carry a diagonal slot.
        row_nonzeros.back() = static_cast<PetscInt>(phi_count + 1u);
    }
    const PetscInt dimension = static_cast<PetscInt>(augmented_count);
    if (MatCreateSeqAIJ(
            PETSC_COMM_SELF,
            dimension,
            dimension,
            0,
            row_nonzeros.data(),
            &context->poisson) != 0) {
        return false;
    }
    if (MatSetOption(context->poisson, MAT_NEW_NONZERO_ALLOCATION_ERR, PETSC_FALSE) != 0) {
        return false;
    }
    for (std::uint64_t row = 0; row < phi_count; ++row) {
        for (std::uint32_t entry = problem.A_phiphi.row_offsets[row];
             entry < problem.A_phiphi.row_offsets[row + 1u];
             ++entry) {
            if (MatSetValue(
                    context->poisson,
                    static_cast<PetscInt>(row),
                    static_cast<PetscInt>(problem.A_phiphi.column_indices[entry]),
                    static_cast<PetscScalar>(problem.A_phiphi.values[entry]),
                    INSERT_VALUES) != 0) {
                return false;
            }
        }
        if (gauge && MatSetValue(
                context->poisson,
                static_cast<PetscInt>(row),
                static_cast<PetscInt>(phi_count),
                static_cast<PetscScalar>(problem.phi_mean_weights[row]),
                INSERT_VALUES) != 0) {
            return false;
        }
    }
    if (gauge) {
        for (std::uint64_t column = 0; column < phi_count; ++column) {
            if (MatSetValue(
                    context->poisson,
                    static_cast<PetscInt>(phi_count),
                    static_cast<PetscInt>(column),
                    static_cast<PetscScalar>(problem.phi_mean_weights[column]),
                    INSERT_VALUES) != 0) {
                return false;
            }
        }
        if (MatSetValue(
                context->poisson,
                static_cast<PetscInt>(phi_count),
                static_cast<PetscInt>(phi_count),
                static_cast<PetscScalar>(0.0),
                INSERT_VALUES) != 0) {
            return false;
        }
    }
    return MatAssemblyBegin(context->poisson, MAT_FINAL_ASSEMBLY) == 0 &&
        MatAssemblyEnd(context->poisson, MAT_FINAL_ASSEMBLY) == 0;
}

bool create_production_split_mass(
    const CsrMatrixView &mass,
    Mat *matrix)
{
    if (matrix == nullptr ||
        mass.row_count > static_cast<std::uint64_t>(std::numeric_limits<PetscInt>::max()) / 2u) {
        return false;
    }
    const PetscInt base = static_cast<PetscInt>(mass.row_count);
    const PetscInt dimension = 2 * base;
    std::vector<PetscInt> row_nonzeros(static_cast<std::size_t>(dimension), 0);
    for (PetscInt row = 0; row < base; ++row) {
        const PetscInt count = static_cast<PetscInt>(
            mass.row_offsets[static_cast<std::size_t>(row + 1)] -
            mass.row_offsets[static_cast<std::size_t>(row)]);
        // The rotated mass has zero diagonal values, but STSHIFT treats the
        // generalized problem through B^{-1}A and PETSc's sparse factorizer
        // still requires a structural diagonal slot in every row.
        row_nonzeros[static_cast<std::size_t>(row)] = count + 1;
        row_nonzeros[static_cast<std::size_t>(row + base)] = count + 1;
    }
    if (MatCreateSeqAIJ(
            PETSC_COMM_SELF,
            dimension,
            dimension,
            0,
            row_nonzeros.data(),
            matrix) != 0) {
        return false;
    }
    if (MatSetOption(*matrix, MAT_NEW_NONZERO_ALLOCATION_ERR, PETSC_FALSE) != 0) {
        return false;
    }
    for (std::uint64_t row = 0; row < mass.row_count; ++row) {
        for (std::uint32_t entry = mass.row_offsets[row];
             entry < mass.row_offsets[row + 1u];
             ++entry) {
            const PetscInt column = static_cast<PetscInt>(mass.column_indices[entry]);
            const PetscScalar value = static_cast<PetscScalar>(mass.values[entry]);
            if (MatSetValue(
                    *matrix,
                    static_cast<PetscInt>(row),
                    column + base,
                    -value,
                    INSERT_VALUES) != 0 ||
                MatSetValue(
                    *matrix,
                    static_cast<PetscInt>(row) + base,
                    column,
                    value,
                    INSERT_VALUES) != 0) {
                return false;
            }
        }
        if (MatSetValue(
                *matrix,
                static_cast<PetscInt>(row),
                static_cast<PetscInt>(row),
                static_cast<PetscScalar>(0.0),
                INSERT_VALUES) != 0 ||
            MatSetValue(
                *matrix,
                static_cast<PetscInt>(row) + base,
                static_cast<PetscInt>(row) + base,
                static_cast<PetscScalar>(0.0),
                INSERT_VALUES) != 0) {
            return false;
        }
    }
    return MatAssemblyBegin(*matrix, MAT_FINAL_ASSEMBLY) == 0 &&
        MatAssemblyEnd(*matrix, MAT_FINAL_ASSEMBLY) == 0;
}

// Build the magnetic-only shifted preconditioner used by STSINVERT.  The
// exact shifted operator remains a MatShell because its Schur feedback reuses
// the persistent Poisson factorization.  This sparse matrix retains the
// tangent block and gyrotropic mass coupling, omitting only the scalar-field
// feedback; it is a legitimate right preconditioner, not an alternate
// eigen-operator.
bool create_production_shift_preconditioner(
    const CsrMatrixView &a_qq,
    const CsrMatrixView &mass,
    double shift,
    Mat *matrix)
{
    if (matrix == nullptr ||
        a_qq.row_count == 0 ||
        a_qq.row_count != a_qq.column_count ||
        a_qq.row_count != mass.row_count ||
        mass.row_count != mass.column_count ||
        !std::isfinite(shift) ||
        a_qq.row_count > static_cast<std::uint64_t>(std::numeric_limits<PetscInt>::max()) / 2u) {
        return false;
    }
    const PetscInt base = static_cast<PetscInt>(a_qq.row_count);
    const PetscInt dimension = 2 * base;
    std::vector<PetscInt> row_nonzeros(static_cast<std::size_t>(dimension), 0);
    for (std::uint64_t row = 0; row < a_qq.row_count; ++row) {
        const std::uint64_t a_count =
            a_qq.row_offsets[row + 1u] - a_qq.row_offsets[row];
        const std::uint64_t b_count =
            mass.row_offsets[row + 1u] - mass.row_offsets[row];
        const std::uint64_t count = a_count + b_count + 1u;
        if (count > static_cast<std::uint64_t>(std::numeric_limits<PetscInt>::max())) {
            return false;
        }
        row_nonzeros[static_cast<std::size_t>(row)] = static_cast<PetscInt>(count);
        row_nonzeros[static_cast<std::size_t>(row + a_qq.row_count)] = static_cast<PetscInt>(count);
    }
    if (MatCreateSeqAIJ(
            PETSC_COMM_SELF,
            dimension,
            dimension,
            0,
            row_nonzeros.data(),
            matrix) != 0) {
        return false;
    }
    if (MatSetOption(*matrix, MAT_NEW_NONZERO_ALLOCATION_ERR, PETSC_FALSE) != 0) {
        MatDestroy(matrix);
        return false;
    }
    for (std::uint64_t row = 0; row < a_qq.row_count; ++row) {
        for (std::uint32_t entry = a_qq.row_offsets[row];
             entry < a_qq.row_offsets[row + 1u];
             ++entry) {
            const PetscInt column = static_cast<PetscInt>(a_qq.column_indices[entry]);
            const PetscScalar value = static_cast<PetscScalar>(a_qq.values[entry]);
            if (MatSetValue(
                    *matrix,
                    static_cast<PetscInt>(row),
                    column,
                    value,
                    ADD_VALUES) != 0 ||
                MatSetValue(
                    *matrix,
                    static_cast<PetscInt>(row) + base,
                    column + base,
                    value,
                    ADD_VALUES) != 0) {
                MatDestroy(matrix);
                return false;
            }
        }
        for (std::uint32_t entry = mass.row_offsets[row];
             entry < mass.row_offsets[row + 1u];
             ++entry) {
            const PetscInt column = static_cast<PetscInt>(mass.column_indices[entry]);
            const PetscScalar value = static_cast<PetscScalar>(shift * mass.values[entry]);
            if (MatSetValue(
                    *matrix,
                    static_cast<PetscInt>(row),
                    column + base,
                    value,
                    ADD_VALUES) != 0 ||
                MatSetValue(
                    *matrix,
                    static_cast<PetscInt>(row) + base,
                    column,
                    -value,
                    ADD_VALUES) != 0) {
                MatDestroy(matrix);
                return false;
            }
        }
        if (MatSetValue(
                *matrix,
                static_cast<PetscInt>(row),
                static_cast<PetscInt>(row),
                static_cast<PetscScalar>(0.0),
                ADD_VALUES) != 0 ||
            MatSetValue(
                *matrix,
                static_cast<PetscInt>(row) + base,
                static_cast<PetscInt>(row) + base,
                static_cast<PetscScalar>(0.0),
                ADD_VALUES) != 0) {
            MatDestroy(matrix);
            return false;
        }
    }
    if (MatAssemblyBegin(*matrix, MAT_FINAL_ASSEMBLY) != 0 ||
        MatAssemblyEnd(*matrix, MAT_FINAL_ASSEMBLY) != 0) {
        MatDestroy(matrix);
        return false;
    }
    return true;
}

bool configure_production_context(
    const PoissonAirboxEigenBlockProblem &problem,
    ProductionSchurContext *context)
{
    if (context == nullptr ||
        problem.q_dof_count > static_cast<std::uint64_t>(std::numeric_limits<PetscInt>::max()) / 2u ||
        problem.phi_dof_count > static_cast<std::uint64_t>(std::numeric_limits<PetscInt>::max())) {
        return false;
    }
    context->q_count = static_cast<PetscInt>(problem.q_dof_count);
    context->phi_count = static_cast<PetscInt>(problem.phi_dof_count);
    context->gauge_augmented = production_string_equals(
        problem.gauge_policy,
        "mean_zero_augmented");
    context->augmented_phi_count = context->phi_count +
        (context->gauge_augmented ? 1 : 0);
    if (!create_production_csr_matrix(problem.A_qq, &context->a_qq) ||
        !create_production_csr_matrix(problem.A_qphi, &context->a_qphi) ||
        !create_production_csr_matrix(problem.A_phiq, &context->a_phiq) ||
        !create_production_augmented_poisson(problem, context)) {
        return false;
    }

    PC pc = nullptr;
    if (KSPCreate(PETSC_COMM_SELF, &context->poisson_ksp) != 0 ||
        KSPSetOperators(context->poisson_ksp, context->poisson, context->poisson) != 0 ||
        KSPSetType(context->poisson_ksp, KSPPREONLY) != 0 ||
        KSPGetPC(context->poisson_ksp, &pc) != 0 ||
        PCSetType(pc, PCLU) != 0 ||
        PCFactorSetShiftType(pc, MAT_SHIFT_NONZERO) != 0 ||
        KSPSetTolerances(
            context->poisson_ksp,
            1.0e-12,
            PETSC_DEFAULT,
            PETSC_DEFAULT,
            problem.max_linear_iterations > 0
                ? static_cast<PetscInt>(problem.max_linear_iterations)
                : PETSC_DEFAULT) != 0 ||
        KSPSetConvergenceTest(
            context->poisson_ksp,
            production_modal_ksp_convergence_test,
            const_cast<PoissonAirboxEigenBlockProblem *>(&problem),
            nullptr) != 0 ||
        KSPSetUp(context->poisson_ksp) != 0) {
        return false;
    }

    if (VecCreateSeq(PETSC_COMM_SELF, context->phi_count, &context->phi_rhs) != 0 ||
        VecCreateSeq(PETSC_COMM_SELF, context->augmented_phi_count, &context->poisson_rhs) != 0 ||
        VecCreateSeq(PETSC_COMM_SELF, context->augmented_phi_count, &context->poisson_solution) != 0 ||
        VecCreateSeq(PETSC_COMM_SELF, context->phi_count, &context->phi_solution) != 0 ||
        VecCreateSeq(PETSC_COMM_SELF, context->q_count, &context->feedback) != 0) {
        return false;
    }
    return true;
}

void destroy_production_context(ProductionSchurContext *context) noexcept
{
    if (context == nullptr) {
        return;
    }
    if (context->feedback != nullptr) {
        VecDestroy(&context->feedback);
    }
    if (context->phi_solution != nullptr) {
        VecDestroy(&context->phi_solution);
    }
    if (context->poisson_solution != nullptr) {
        VecDestroy(&context->poisson_solution);
    }
    if (context->poisson_rhs != nullptr) {
        VecDestroy(&context->poisson_rhs);
    }
    if (context->phi_rhs != nullptr) {
        VecDestroy(&context->phi_rhs);
    }
    if (context->poisson_ksp != nullptr) {
        KSPDestroy(&context->poisson_ksp);
    }
    if (context->poisson != nullptr) {
        MatDestroy(&context->poisson);
    }
    if (context->a_phiq != nullptr) {
        MatDestroy(&context->a_phiq);
    }
    if (context->a_qphi != nullptr) {
        MatDestroy(&context->a_qphi);
    }
    if (context->a_qq != nullptr) {
        MatDestroy(&context->a_qq);
    }
}

bool solve_production_phi(
    ProductionSchurContext *context,
    Vec q,
    std::vector<double> *phi,
    double *eta)
{
    if (context == nullptr || q == nullptr || phi == nullptr || eta == nullptr ||
        MatMult(context->a_phiq, q, context->phi_rhs) != 0 ||
        VecScale(context->phi_rhs, static_cast<PetscScalar>(-1.0)) != 0) {
        if (context != nullptr) {
            copy_message(context->error_message, sizeof(context->error_message),
                         "production Schur Poisson RHS assembly failed");
        }
        return false;
    }
    const PetscScalar *rhs_values = nullptr;
    PetscScalar *augmented_rhs = nullptr;
    if (VecGetArrayRead(context->phi_rhs, &rhs_values) != 0 ||
        VecGetArray(context->poisson_rhs, &augmented_rhs) != 0) {
        if (rhs_values != nullptr) {
            VecRestoreArrayRead(context->phi_rhs, &rhs_values);
        }
        if (augmented_rhs != nullptr) {
            VecRestoreArray(context->poisson_rhs, &augmented_rhs);
        }
        copy_message(context->error_message, sizeof(context->error_message),
                     "production Schur Poisson RHS vector access failed");
        return false;
    }
    for (PetscInt index = 0; index < context->phi_count; ++index) {
        augmented_rhs[index] = rhs_values[index];
    }
    if (context->gauge_augmented) {
        augmented_rhs[context->phi_count] = static_cast<PetscScalar>(0.0);
    }
    VecRestoreArray(context->poisson_rhs, &augmented_rhs);
    VecRestoreArrayRead(context->phi_rhs, &rhs_values);

    ++context->poisson_solve_count;
    if (KSPSolve(context->poisson_ksp, context->poisson_rhs, context->poisson_solution) != 0) {
        copy_message(context->error_message, sizeof(context->error_message),
                     "production Schur Poisson factor solve failed");
        return false;
    }
    KSPConvergedReason reason = KSP_CONVERGED_ITERATING;
    if (KSPGetConvergedReason(context->poisson_ksp, &reason) != 0 || reason < 0) {
        copy_message(context->error_message, sizeof(context->error_message),
                     "production Schur Poisson factor solve did not converge");
        return false;
    }
    PetscInt poisson_iterations = 0;
    if (KSPGetTotalIterations(context->poisson_ksp, &poisson_iterations) == 0) {
        context->poisson_iteration_count = static_cast<std::uint64_t>(
            std::max<PetscInt>(0, poisson_iterations));
    }
    const PetscScalar *solution_values = nullptr;
    PetscScalar *phi_values = nullptr;
    if (VecGetArrayRead(context->poisson_solution, &solution_values) != 0 ||
        VecGetArray(context->phi_solution, &phi_values) != 0) {
        if (solution_values != nullptr) {
            VecRestoreArrayRead(context->poisson_solution, &solution_values);
        }
        if (phi_values != nullptr) {
            VecRestoreArray(context->phi_solution, &phi_values);
        }
        copy_message(context->error_message, sizeof(context->error_message),
                     "production Schur Poisson solution access failed");
        return false;
    }
    phi->assign(static_cast<std::size_t>(context->phi_count), 0.0);
    for (PetscInt index = 0; index < context->phi_count; ++index) {
        phi_values[index] = solution_values[index];
        (*phi)[static_cast<std::size_t>(index)] =
            static_cast<double>(solution_values[index]);
    }
    *eta = context->gauge_augmented
        ? static_cast<double>(solution_values[context->phi_count])
        : 0.0;
    VecRestoreArray(context->phi_solution, &phi_values);
    VecRestoreArrayRead(context->poisson_solution, &solution_values);
    return true;
}

// Apply the Schur operator while retaining the reconstructed scalar solution
// in the persistent phi vector.
PetscErrorCode production_schur_apply_vec(
    ProductionSchurContext *context,
    Vec q,
    Vec y)
{
    if (context == nullptr || q == nullptr || y == nullptr ||
        MatMult(context->a_qq, q, y) != 0 ||
        MatMult(context->a_phiq, q, context->phi_rhs) != 0 ||
        VecScale(context->phi_rhs, static_cast<PetscScalar>(-1.0)) != 0) {
        if (context != nullptr) {
            copy_message(context->error_message, sizeof(context->error_message),
                         "production Schur action failed before Poisson solve");
        }
        return PETSC_ERR_LIB;
    }
    ++context->operator_apply_count;
    const PetscScalar *rhs_values = nullptr;
    PetscScalar *augmented_rhs = nullptr;
    if (VecGetArrayRead(context->phi_rhs, &rhs_values) != 0 ||
        VecGetArray(context->poisson_rhs, &augmented_rhs) != 0) {
        if (rhs_values != nullptr) {
            VecRestoreArrayRead(context->phi_rhs, &rhs_values);
        }
        if (augmented_rhs != nullptr) {
            VecRestoreArray(context->poisson_rhs, &augmented_rhs);
        }
        copy_message(context->error_message, sizeof(context->error_message),
                     "production Schur action Poisson RHS access failed");
        return PETSC_ERR_LIB;
    }
    for (PetscInt index = 0; index < context->phi_count; ++index) {
        augmented_rhs[index] = rhs_values[index];
    }
    if (context->gauge_augmented) {
        augmented_rhs[context->phi_count] = static_cast<PetscScalar>(0.0);
    }
    VecRestoreArray(context->poisson_rhs, &augmented_rhs);
    VecRestoreArrayRead(context->phi_rhs, &rhs_values);
    ++context->poisson_solve_count;
    if (KSPSolve(context->poisson_ksp, context->poisson_rhs, context->poisson_solution) != 0) {
        copy_message(context->error_message, sizeof(context->error_message),
                     "production Schur action Poisson factor solve failed");
        return PETSC_ERR_NOT_CONVERGED;
    }
    KSPConvergedReason reason = KSP_CONVERGED_ITERATING;
    if (KSPGetConvergedReason(context->poisson_ksp, &reason) != 0 || reason < 0) {
        copy_message(context->error_message, sizeof(context->error_message),
                     "production Schur action Poisson factor did not converge");
        return PETSC_ERR_NOT_CONVERGED;
    }
    PetscInt poisson_iterations = 0;
    if (KSPGetTotalIterations(context->poisson_ksp, &poisson_iterations) == 0) {
        context->poisson_iteration_count = static_cast<std::uint64_t>(
            std::max<PetscInt>(0, poisson_iterations));
    }
    const PetscScalar *solution_values = nullptr;
    PetscScalar *phi_values = nullptr;
    if (VecGetArrayRead(context->poisson_solution, &solution_values) != 0 ||
        VecGetArray(context->phi_solution, &phi_values) != 0) {
        if (solution_values != nullptr) {
            VecRestoreArrayRead(context->poisson_solution, &solution_values);
        }
        if (phi_values != nullptr) {
            VecRestoreArray(context->phi_solution, &phi_values);
        }
        copy_message(context->error_message, sizeof(context->error_message),
                     "production Schur action Poisson solution access failed");
        return PETSC_ERR_LIB;
    }
    for (PetscInt index = 0; index < context->phi_count; ++index) {
        phi_values[index] = solution_values[index];
    }
    VecRestoreArray(context->phi_solution, &phi_values);
    VecRestoreArrayRead(context->poisson_solution, &solution_values);
    if (MatMult(context->a_qphi, context->phi_solution, context->feedback) != 0 ||
        VecAXPY(y, static_cast<PetscScalar>(1.0), context->feedback) != 0) {
        copy_message(context->error_message, sizeof(context->error_message),
                     "production Schur magnetic feedback apply failed");
        return PETSC_ERR_LIB;
    }
    return 0;
}

PetscErrorCode production_split_schur_matmult(Mat matrix, Vec x, Vec y)
{
    void *raw_context = nullptr;
    if (MatShellGetContext(matrix, &raw_context) != 0 || raw_context == nullptr) {
        return PETSC_ERR_ARG_NULL;
    }
    auto *context = static_cast<ProductionSplitContext *>(raw_context);
    if (context->base == nullptr) {
        return PETSC_ERR_ARG_NULL;
    }
    PetscInt size = 0;
    if (VecGetSize(x, &size) != 0 || size != 2 * context->base->q_count) {
        copy_message(context->base->error_message, sizeof(context->base->error_message),
                     "production real-split Schur input size mismatch");
        return PETSC_ERR_ARG_SIZ;
    }
    const PetscScalar *input = nullptr;
    PetscScalar *output = nullptr;
    if (VecGetArrayRead(x, &input) != 0 || VecGetArray(y, &output) != 0) {
        if (input != nullptr) {
            VecRestoreArrayRead(x, &input);
        }
        if (output != nullptr) {
            VecRestoreArray(y, &output);
        }
        return PETSC_ERR_LIB;
    }
    PetscErrorCode error = 0;
    if (VecPlaceArray(context->q_real, input) != 0 ||
        VecPlaceArray(context->q_imag, input + context->base->q_count) != 0 ||
        VecPlaceArray(context->y_real, output) != 0 ||
        VecPlaceArray(context->y_imag, output + context->base->q_count) != 0) {
        error = PETSC_ERR_LIB;
    } else {
        error = production_schur_apply_vec(context->base, context->q_real, context->y_real);
        if (error == 0) {
            error = production_schur_apply_vec(context->base, context->q_imag, context->y_imag);
        }
    }
    VecResetArray(context->q_real);
    VecResetArray(context->q_imag);
    VecResetArray(context->y_real);
    VecResetArray(context->y_imag);
    VecRestoreArray(y, &output);
    VecRestoreArrayRead(x, &input);
    return error;
}

// For the bounded CPU qualification scope, materialize only the shifted
// Schur *preconditioner* by applying the production MatShell to basis
// vectors.  The eigensolver operator itself remains the persistent MatShell;
// this matrix is used solely by STSINVERT's sparse direct inner solve.  The
// cap keeps the O(n^2) setup explicit and prevents this baseline from being
// mistaken for the scalable Schur path.
bool create_production_exact_shift_preconditioner(
    Mat schur_shell,
    Mat split_mass,
    PetscInt dimension,
    double shift,
    Mat *matrix)
{
    constexpr PetscInt kMaximumDimension = 1024;
    if (matrix == nullptr || schur_shell == nullptr || split_mass == nullptr ||
        dimension <= 0 || dimension > kMaximumDimension || !std::isfinite(shift)) {
        return false;
    }
    if (MatCreateSeqAIJ(
            PETSC_COMM_SELF,
            dimension,
            dimension,
            dimension,
            nullptr,
            matrix) != 0) {
        return false;
    }
    if (MatSetOption(*matrix, MAT_NEW_NONZERO_ALLOCATION_ERR, PETSC_FALSE) != 0) {
        MatDestroy(matrix);
        return false;
    }
    Vec basis = nullptr;
    Vec schur_action = nullptr;
    Vec mass_action = nullptr;
    bool ok =
        VecCreateSeq(PETSC_COMM_SELF, dimension, &basis) == 0 &&
        VecDuplicate(basis, &schur_action) == 0 &&
        VecDuplicate(basis, &mass_action) == 0;
    if (!ok) {
        if (mass_action != nullptr) {
            VecDestroy(&mass_action);
        }
        if (schur_action != nullptr) {
            VecDestroy(&schur_action);
        }
        if (basis != nullptr) {
            VecDestroy(&basis);
        }
        MatDestroy(matrix);
        return false;
    }

    PetscScalar *basis_values = nullptr;
    const PetscScalar *schur_values = nullptr;
    const PetscScalar *mass_values = nullptr;
    for (PetscInt column = 0; column < dimension && ok; ++column) {
        ok = VecGetArray(basis, &basis_values) == 0;
        if (!ok) {
            break;
        }
        for (PetscInt row = 0; row < dimension; ++row) {
            basis_values[row] = static_cast<PetscScalar>(row == column ? 1.0 : 0.0);
        }
        VecRestoreArray(basis, &basis_values);
        basis_values = nullptr;

        ok = MatMult(schur_shell, basis, schur_action) == 0 &&
            MatMult(split_mass, basis, mass_action) == 0;
        if (!ok) {
            break;
        }
        ok = VecGetArrayRead(schur_action, &schur_values) == 0 &&
            VecGetArrayRead(mass_action, &mass_values) == 0;
        if (!ok) {
            if (schur_values != nullptr) {
                VecRestoreArrayRead(schur_action, &schur_values);
            }
            if (mass_values != nullptr) {
                VecRestoreArrayRead(mass_action, &mass_values);
            }
            break;
        }
        for (PetscInt row = 0; row < dimension; ++row) {
            const PetscScalar value =
                schur_values[row] - static_cast<PetscScalar>(shift) * mass_values[row];
            if (MatSetValue(*matrix, row, column, value, INSERT_VALUES) != 0) {
                ok = false;
                break;
            }
        }
        VecRestoreArrayRead(mass_action, &mass_values);
        VecRestoreArrayRead(schur_action, &schur_values);
        schur_values = nullptr;
        mass_values = nullptr;
    }
    if (basis_values != nullptr) {
        VecRestoreArray(basis, &basis_values);
    }
    VecDestroy(&mass_action);
    VecDestroy(&schur_action);
    VecDestroy(&basis);
    if (!ok || MatAssemblyBegin(*matrix, MAT_FINAL_ASSEMBLY) != 0 ||
        MatAssemblyEnd(*matrix, MAT_FINAL_ASSEMBLY) != 0) {
        MatDestroy(matrix);
        return false;
    }
    return true;
}

std::vector<Complex> copy_production_split_eigenvector(
    Vec real_part,
    PetscInt base_count)
{
    std::vector<Complex> result;
    const PetscScalar *values = nullptr;
    if (VecGetArrayRead(real_part, &values) != 0) {
        return result;
    }
    result.reserve(static_cast<std::size_t>(base_count));
    for (PetscInt index = 0; index < base_count; ++index) {
        const double real = static_cast<double>(PetscRealPart(values[index]));
        const double imag = static_cast<double>(PetscRealPart(values[index + base_count]));
        if (!std::isfinite(real) || !std::isfinite(imag)) {
            result.clear();
            break;
        }
        result.emplace_back(real, imag);
    }
    VecRestoreArrayRead(real_part, &values);
    return result;
}

bool reconstruct_production_mode(
    ProductionSchurContext *context,
    const std::vector<Complex> &q,
    std::vector<Complex> *full_vector)
{
    if (context == nullptr || full_vector == nullptr ||
        q.size() != static_cast<std::size_t>(context->q_count)) {
        return false;
    }
    std::vector<PetscScalar> q_real(q.size(), 0.0);
    std::vector<PetscScalar> q_imag(q.size(), 0.0);
    for (std::size_t index = 0; index < q.size(); ++index) {
        q_real[index] = static_cast<PetscScalar>(q[index].real());
        q_imag[index] = static_cast<PetscScalar>(q[index].imag());
    }
    Vec q_real_vec = nullptr;
    Vec q_imag_vec = nullptr;
    if (VecCreateSeqWithArray(
            PETSC_COMM_SELF,
            1,
            context->q_count,
            q_real.data(),
            &q_real_vec) != 0 ||
        VecCreateSeqWithArray(
            PETSC_COMM_SELF,
            1,
            context->q_count,
            q_imag.data(),
            &q_imag_vec) != 0) {
        if (q_real_vec != nullptr) {
            VecDestroy(&q_real_vec);
        }
        if (q_imag_vec != nullptr) {
            VecDestroy(&q_imag_vec);
        }
        return false;
    }
    std::vector<double> phi_real;
    std::vector<double> phi_imag;
    double eta_real = 0.0;
    double eta_imag = 0.0;
    const bool solved = solve_production_phi(
            context,
            q_real_vec,
            &phi_real,
            &eta_real) &&
        solve_production_phi(context, q_imag_vec, &phi_imag, &eta_imag);
    VecDestroy(&q_real_vec);
    VecDestroy(&q_imag_vec);
    if (!solved || phi_real.size() != static_cast<std::size_t>(context->phi_count) ||
        phi_imag.size() != static_cast<std::size_t>(context->phi_count)) {
        return false;
    }
    full_vector->clear();
    full_vector->reserve(static_cast<std::size_t>(
        context->q_count + context->phi_count +
        (context->gauge_augmented ? 1 : 0)));
    full_vector->insert(full_vector->end(), q.begin(), q.end());
    for (PetscInt index = 0; index < context->phi_count; ++index) {
        full_vector->emplace_back(
            phi_real[static_cast<std::size_t>(index)],
            phi_imag[static_cast<std::size_t>(index)]);
    }
    if (context->gauge_augmented) {
        full_vector->emplace_back(eta_real, eta_imag);
    }
    return true;
}

void write_production_schur_diagnostics(
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
        "\"schema_version\":\"poisson_airbox_modal_eigen_schur_slepc.v1\","
        "\"status\":\"%s\","
        "\"complete\":%s,"
        "\"reason\":\"%s\","
        "\"slepc_converged_reason\":\"%s\","
        "\"slepc_converged_reason_code\":%d,"
        "\"stop_reason\":\"%s\","
        "\"study_product\":\"modal_eigen\","
        "\"solver_adapter\":\"k0_poisson_airbox_cpu_schur_slepc\","
        "\"requested_solver_adapter\":\"%s\","
        "\"execution_lane\":\"production_cpu\","
        "\"requested_execution\":\"production_cpu\","
        "\"resolved_execution\":\"production_cpu\","
        "\"production_implication\":%s,"
        "\"validation_only\":%s,"
        "\"persistent_solver_context\":true,"
        "\"gpu_device_resident_modal_eigensolver\":false,"
        "\"per_iteration_h2d_transfer_count\":0,"
        "\"per_iteration_d2h_transfer_count\":0,"
        "\"per_iteration_full_vector_transfers\":0,"
        "\"fallback_used\":false,"
        "\"demag_kind\":\"%s\","
        "\"assembly_kind\":\"%s\","
        "\"outer_boundary_kind\":\"%s\","
        "\"robin_beta\":%.17g,"
        "\"gauge_policy\":\"%s\","
        "\"gauge_reason\":\"%s\","
        "\"residual_tolerance\":%.17g,"
        "\"phasor_convention\":\"%s\","
        "\"eigenvalue_convention\":\"%s\","
        "\"algebraic_form\":\"schur_reduced_descriptor\","
        "\"schur_reduced\":true,"
        "\"static_demag_substitution\":false,"
        "\"poisson_factorization_reused\":true,"
        "\"matrix_format\":\"real_split_matshell_seq_aij\","
        "\"spectral_pencil_kind\":\"real_frequency_rotated\","
        "\"target_representation\":\"tau=omega_target\","
        "\"target_kind\":\"%s\","
        "\"requested_window_hz\":[%.17g,%.17g],"
        "\"target_tau_rad_s\":%.17g,"
        "\"target_omega_rad_s\":%.17g,"
        "\"slepc\":{\"eps_type\":\"krylovschur\",\"problem_type\":\"gnhep\","
        "\"spectral_transform\":\"shift_invert\",\"which_eigenpairs\":\"target_magnitude\","
        "\"ksp_type\":\"%s\",\"pc_type\":\"lu\",\"pc_matrix\":\"%s\","
        "\"converged_eigenpair_count\":%u,\"accepted_mode_count\":%u,\"outer_iterations\":%u},"
        "\"operator_apply_count\":%llu,\"poisson_solve_count\":%llu,"
        "\"poisson_iteration_count\":%llu,\"shift_linear_iteration_count\":%llu,"
        "\"eps_restart_count\":null,"
        "\"finite_real_eigenpair_count\":%u,"
        "\"positive_frequency_eigenpair_count\":%u,"
        "\"action_residual_evaluated_count\":%u,"
        "\"reconstructed_mode_count\":%u,"
        "\"full_residual_accepted_count\":%u,"
        "\"q_dof_count\":%llu,\"phi_dof_count\":%llu,\"augmented_dof_count\":%llu,"
        "\"periodic_mesh_certificate\":{\"schema_version\":\"%s\","
        "\"magnetic_pair_count\":%llu,\"airbox_pair_count\":%llu},"
        "\"metrics\":{\"full_residual_reconstruction_relative_error\":%.17g,"
        "\"slepc_reported_backward_error\":%.17g,\"reconstructed_full_descriptor_backward_error\":%.17g,"
        "\"reconstruction_vs_slepc_ratio\":%.17g,"
        "\"magnetic_block_backward_error\":%.17g,\"poisson_block_backward_error\":%.17g,"
        "\"gauge_constraint_backward_error\":%.17g,\"poisson_constraint_relative_residual\":%.17g,"
        "\"gauge_mean_abs\":%.17g,\"eigen_residual_relative\":%.17g,"
        "\"relative_reference_frequency_error\":%.17g},"
        "\"residual_fields\":{"
        "\"residual_acceptance_name\":\"modal_original_unscaled_full_descriptor_backward_error\","
        "\"modal_original_unscaled_full_descriptor_backward_error\":%.17g,"
        "\"modal_original_unscaled_magnetic_block_backward_error\":%.17g,"
        "\"modal_original_unscaled_poisson_block_backward_error\":%.17g,"
        "\"modal_original_unscaled_gauge_constraint_backward_error\":%.17g,"
        "\"modal_original_unscaled_magnetic_residual_l2\":%.17g,"
        "\"modal_original_unscaled_poisson_residual_l2\":%.17g,"
        "\"modal_original_unscaled_gauge_residual_abs\":%.17g,"
        "\"modal_original_unscaled_full_descriptor_threshold\":%.17g,"
        "\"slepc_reported_backward_error_diagnostic\":%.17g,"
        "\"scaled_descriptor_backward_error_diagnostic\":null,"
        "\"transformed_pencil_backward_error_diagnostic\":null,"
        "\"reconstruction_vs_slepc_ratio\":%.17g,"
        "\"eps_full_original_unscaled\":%.17g,"
        "\"eta_row_present\":%s,"
        "\"finite_mode_filter_status\":\"%s\""
        "},"
        "\"eigenpair\":{\"eigenvalue_real\":%.17g,\"eigenvalue_imag\":%.17g,"
        "\"omega_rad_s\":%.17g,\"frequency_hz\":%.17g,\"eigenpair_found\":%s,"
        "\"eigenpair_accepted\":%s,\"positive_frequency_branch_found\":%s},"
        "\"certification\":{\"full_residual_certified\":%s,\"reference_frequency_certified\":%s},"
        "\"full_residual_reconstruction_relative_error\":%.17g,"
        "\"poisson_constraint_relative_residual\":%.17g,"
        "\"full_residual_certified\":%s,"
        "\"subwindows\":%s,"
        "\"window_completeness\":{\"status\":\"%s\",\"subwindow_count\":%u,"
        "\"completed_subwindow_count\":%u,\"failed_subwindow_count\":%u,"
        "\"empty_subwindow_count\":%u},"
        "\"window_certificate\":%s,"
        "\"cpu_fallback\":\"disabled\""
        "}",
        status != nullptr ? status : "unknown",
        status != nullptr && std::strcmp(status, "ok") == 0 ? "true" : "false",
        reason != nullptr ? reason : "",
        result.slepc_converged_reason[0] != '\0'
            ? result.slepc_converged_reason
            : "not_available",
        result.slepc_converged_reason_code,
        result.stop_reason[0] != '\0'
            ? result.stop_reason
            : (reason != nullptr ? reason : "not_available"),
        problem.solver_adapter != nullptr ? problem.solver_adapter : "",
        problem.production_shared_domain ? "true" : "false",
        problem.production_shared_domain ? "false" : "true",
        problem.demag_kind != nullptr ? problem.demag_kind : "",
        problem.assembly_kind != nullptr ? problem.assembly_kind : "",
        problem.outer_boundary_kind != nullptr ? problem.outer_boundary_kind : "",
        problem.robin_beta,
        problem.gauge_policy != nullptr ? problem.gauge_policy : "",
        problem.gauge_reason != nullptr ? problem.gauge_reason : "",
        problem.residual_tolerance,
        problem.phasor_convention != nullptr ? problem.phasor_convention : "",
        problem.eigenvalue_convention != nullptr ? problem.eigenvalue_convention : "",
        problem.target_kind != nullptr ? problem.target_kind : "",
        problem.frequency_min_hz,
        problem.frequency_max_hz,
        omega_rad_s_from_frequency_hz(std::max(0.0, problem.target_frequency_hz)),
        omega_rad_s_from_frequency_hz(std::max(0.0, problem.target_frequency_hz)),
        std::strcmp(result.shifted_preconditioner_kind, "exact_shifted_schur_action") == 0
            ? "preonly"
            : "gmres",
        result.shifted_preconditioner_kind[0] != '\0'
            ? result.shifted_preconditioner_kind
            : "not_configured",
        result.converged_eigenpair_count,
        result.accepted_mode_count,
        result.outer_iterations,
        static_cast<unsigned long long>(result.operator_apply_count),
        static_cast<unsigned long long>(result.poisson_solve_count),
        static_cast<unsigned long long>(result.poisson_iteration_count),
        static_cast<unsigned long long>(result.shift_linear_iteration_count),
        result.finite_real_eigenpair_count,
        result.positive_frequency_eigenpair_count,
        result.action_residual_evaluated_count,
        result.reconstructed_mode_count,
        result.full_residual_accepted_count,
        static_cast<unsigned long long>(result.q_dof_count),
        static_cast<unsigned long long>(result.phi_dof_count),
        static_cast<unsigned long long>(result.augmented_dof_count),
        problem.periodic_mesh_certificate_schema != nullptr
            ? problem.periodic_mesh_certificate_schema
            : "",
        static_cast<unsigned long long>(result.magnetic_pair_count),
        static_cast<unsigned long long>(result.airbox_pair_count),
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
        result.reconstructed_full_descriptor_backward_error,
        result.magnetic_block_backward_error,
        result.poisson_block_backward_error,
        result.gauge_constraint_backward_error,
        result.magnetic_residual_l2,
        result.poisson_residual_l2,
        result.gauge_residual_abs,
        problem.residual_tolerance,
        result.slepc_reported_backward_error,
        result.reconstruction_vs_slepc_ratio,
        result.reconstructed_full_descriptor_backward_error,
        production_string_equals(problem.gauge_policy, "mean_zero_augmented")
            ? "true"
            : "false",
        result.positive_frequency_branch_found ? "passed" : "failed",
        result.eigenvalue_real,
        result.eigenvalue_imag,
        result.omega_rad_s,
        result.frequency_hz,
        result.converged_eigenpair_count > 0 ? "true" : "false",
        result.accepted_mode_count > 0 ? "true" : "false",
        result.positive_frequency_branch_found ? "true" : "false",
        result.full_residual_certified ? "true" : "false",
        result.reference_frequency_certified ? "true" : "false",
        result.full_residual_reconstruction_relative_error,
        result.poisson_constraint_relative_residual,
        result.full_residual_certified ? "true" : "false",
        result.executed_subwindows_json[0] != '\0'
            ? result.executed_subwindows_json
            : "[]",
        result.window_complete ? "certified" :
            (result.window_failed_subwindow_count > 0u
                 ? "failed"
                 : "not_certified"),
        result.window_subwindow_count,
        result.window_completed_subwindow_count,
        result.window_failed_subwindow_count,
        result.window_empty_subwindow_count,
        result.window_certificate_json[0] != '\0'
            ? result.window_certificate_json
            : "null");
}

FrequencyDomainStatus fail_production_schur(
    const PoissonAirboxEigenBlockProblem &problem,
    PoissonAirboxModalEigenResult *result,
    FrequencyDomainStatus status,
    const char *message,
    const char *reason) noexcept
{
    if (result != nullptr) {
        result->status = status;
        copy_message(result->error_message, sizeof(result->error_message), message);
        copy_message(result->stop_reason, sizeof(result->stop_reason), reason);
        write_production_schur_diagnostics(problem, *result, status == FrequencyDomainStatus::unavailable
            ? "unavailable"
            : status == FrequencyDomainStatus::validation_error
                ? "validation_error"
                : status == FrequencyDomainStatus::operator_error
                    ? "operator_error"
                    : status == FrequencyDomainStatus::interrupted
                        ? "interrupted"
                    : "solve_error", reason, result);
    }
    return status;
}
#endif

} // namespace

FrequencyDomainStatus solve_poisson_airbox_modal_eigen_cpu_schur(
    const PoissonAirboxEigenBlockProblem &problem,
    PoissonAirboxModalEigenResult *out_result) noexcept
{
    if (out_result == nullptr) {
        return FrequencyDomainStatus::validation_error;
    }
    *out_result = PoissonAirboxModalEigenResult{};
    out_result->q_dof_count = problem.q_dof_count;
    out_result->phi_dof_count = problem.phi_dof_count;
    out_result->augmented_dof_count = problem.q_dof_count + problem.phi_dof_count +
        (production_string_equals(problem.gauge_policy, "mean_zero_augmented") ? 1u : 0u);
    out_result->magnetic_pair_count = problem.magnetic_pair_count;
    out_result->airbox_pair_count = problem.airbox_pair_count;
    out_result->expected_reference_frequency_hz = problem.expected_reference_frequency_hz;
    out_result->gauge_augmented = production_string_equals(
        problem.gauge_policy,
        "mean_zero_augmented");
    out_result->q_layout_interleaved_node_component =
        production_string_equals(problem.assembly_kind, "mfem_weak_form_shared_domain");

#if !FULLMAG_FEM_WITH_SLEPC
    copy_message(
        out_result->error_message,
        sizeof(out_result->error_message),
        "production shared-domain K0 Schur eigensolver requires PETSc/SLEPc");
    out_result->status = FrequencyDomainStatus::unavailable;
    std::snprintf(
        out_result->diagnostics_json,
        sizeof(out_result->diagnostics_json),
        "{\"schema_version\":\"poisson_airbox_modal_eigen_schur_slepc.v1\","
        "\"status\":\"unavailable\",\"reason\":\"slepc_not_available\","
        "\"solver_adapter\":\"k0_poisson_airbox_cpu_schur_slepc\","
        "\"cpu_fallback\":\"disabled\"}");
    return out_result->status;
#else
#if defined(PETSC_USE_COMPLEX)
    return fail_production_schur(
        problem,
        out_result,
        FrequencyDomainStatus::unavailable,
        "production shared-domain K0 Schur lane requires a real PETSc scalar runtime",
        "complex_petsc_scalar_unsupported");
#else
    if (problem.requested_mode_count == 0u) {
        return fail_production_schur(
            problem,
            out_result,
            FrequencyDomainStatus::validation_error,
            "production shared-domain K0 Schur eigensolver requires requested_mode_count > 0",
            "poisson_airbox_eigen_invalid_requested_mode_count");
    }
    const bool nearest_target = production_string_equals(
        problem.target_kind,
        "nearest_frequency");
    const bool frequency_window_target = production_string_equals(
        problem.target_kind,
        "frequency_window");
    if (!nearest_target && !frequency_window_target) {
        return fail_production_schur(
            problem,
            out_result,
            FrequencyDomainStatus::validation_error,
            "production shared-domain K0 Schur eigensolver requires a supported target_kind",
            problem.target_kind == nullptr
                ? "poisson_airbox_eigen_missing_target_kind"
                : "poisson_airbox_eigen_unsupported_target_kind");
    }
    if (!std::isfinite(problem.target_frequency_hz) ||
        problem.target_frequency_hz < 0.0 ||
        !std::isfinite(problem.frequency_min_hz) ||
        !std::isfinite(problem.frequency_max_hz) ||
        problem.frequency_min_hz < 0.0 ||
        problem.frequency_max_hz < 0.0 ||
        (frequency_window_target &&
         !(problem.frequency_max_hz > problem.frequency_min_hz)) ||
        (frequency_window_target && problem.target_frequency_hz != 0.0 &&
         (problem.target_frequency_hz < problem.frequency_min_hz ||
          problem.target_frequency_hz > problem.frequency_max_hz))) {
        return fail_production_schur(
            problem,
            out_result,
            FrequencyDomainStatus::validation_error,
            "production shared-domain K0 Schur eigensolver received an invalid target frequency",
            "poisson_airbox_eigen_invalid_frequency_window");
    }
    const bool requested_frequency_window =
        problem.target_kind != nullptr &&
        std::strcmp(problem.target_kind, "frequency_window") == 0;
    if (requested_frequency_window &&
        problem.frequency_min_hz >= 0.0 &&
        problem.frequency_max_hz > problem.frequency_min_hz) {
        struct WindowCandidate {
            PoissonAirboxModalEigenResult::AcceptedMode mode{};
            PoissonAirboxModalEigenResult source{};
            std::uint32_t pass_index = 0;
        };
        std::vector<WindowCandidate> window_candidates;
        constexpr std::uint32_t base_subwindow_count = 16u;
        constexpr std::uint32_t refinement_partition_count = 32u;
        constexpr std::uint32_t refinement_subwindow_count =
            refinement_partition_count + 2u;
        constexpr std::uint32_t pass_count = 2u;
        constexpr double cluster_frequency_relative_tolerance = 1.0e-8;
        constexpr double cluster_frequency_absolute_tolerance_hz = 1.0;
        constexpr double subspace_overlap_threshold = 1.0 - 1.0e-6;
        const std::uint64_t split_dimension = 2u * problem.q_dof_count;
        const std::uint64_t maximum_nev = split_dimension > 0u
            ? split_dimension - 1u
            : 0u;
        const auto resolved_nev = [maximum_nev](std::uint32_t requested_count) {
            return std::min<std::uint64_t>(
                maximum_nev,
                4u * static_cast<std::uint64_t>(requested_count));
        };
        if (problem.requested_mode_count >
                std::numeric_limits<std::uint32_t>::max() / 4u ||
            maximum_nev == 0u) {
            return fail_production_schur(
                problem,
                out_result,
                FrequencyDomainStatus::validation_error,
                "production shared-domain K0 Schur frequency window cannot form a guarded nev",
                "poisson_airbox_eigen_invalid_requested_mode_count");
        }
        const std::uint32_t refined_requested_mode_count =
            std::min<std::uint32_t>(
                std::numeric_limits<std::uint32_t>::max() / 4u,
                problem.requested_mode_count <=
                        std::numeric_limits<std::uint32_t>::max() / 2u
                    ? 2u * problem.requested_mode_count
                    : std::numeric_limits<std::uint32_t>::max() / 4u);
        const std::uint64_t requested_nev = resolved_nev(problem.requested_mode_count);
        const std::uint64_t refined_nev = resolved_nev(refined_requested_mode_count);
        const bool refined_nev_increased = refined_nev > requested_nev;
        std::array<std::uint32_t, pass_count> pass_planned_subwindow_count{
            base_subwindow_count,
            refinement_subwindow_count};
        std::array<std::uint32_t, pass_count> pass_completed_subwindow_count{};
        std::array<std::uint32_t, pass_count> pass_failed_subwindow_count{};
        std::array<bool, pass_count> pass_cancelled{};
        std::uint64_t converged_total = 0;
        std::uint64_t finite_real_total = 0;
        std::uint64_t positive_total = 0;
        std::uint64_t residual_evaluated_total = 0;
        std::uint64_t reconstructed_total = 0;
        std::uint64_t full_residual_accepted_total = 0;
        std::uint64_t outer_iterations_total = 0;
        bool window_interrupted = false;
        bool window_failed = false;
        char window_failure_reason[96]{};
        std::uint32_t window_empty_subwindow_count = 0;
        out_result->window_subwindow_count =
            base_subwindow_count + refinement_subwindow_count;
        out_result->window_completed_subwindow_count = 0;
        out_result->window_failed_subwindow_count = 0;
        out_result->window_empty_subwindow_count = 0;
        out_result->window_complete = false;
        char executed_subwindows_json[sizeof(out_result->executed_subwindows_json)]{};
        std::size_t executed_subwindows_size = 1u;
        executed_subwindows_json[0] = '[';
        bool subwindow_json_complete = true;
        auto append_subwindow_json = [&](const char *format, auto... values) {
            if (!subwindow_json_complete ||
                executed_subwindows_size >= sizeof(executed_subwindows_json)) {
                subwindow_json_complete = false;
                return;
            }
            const int written = std::snprintf(
                executed_subwindows_json + executed_subwindows_size,
                sizeof(executed_subwindows_json) - executed_subwindows_size,
                format,
                values...);
            if (written < 0 ||
                static_cast<std::size_t>(written) >=
                    sizeof(executed_subwindows_json) - executed_subwindows_size) {
                subwindow_json_complete = false;
                return;
            }
            executed_subwindows_size += static_cast<std::size_t>(written);
        };
        auto finalize_subwindow_json = [&]() {
            append_subwindow_json("%s", "]");
            if (!subwindow_json_complete) {
                std::snprintf(
                    executed_subwindows_json,
                    sizeof(executed_subwindows_json),
                    "[{\"status\":\"diagnostics_truncated\"}]");
            }
            copy_message(
                out_result->executed_subwindows_json,
                sizeof(out_result->executed_subwindows_json),
                executed_subwindows_json);
        };
        const double window_width = problem.frequency_max_hz - problem.frequency_min_hz;
        const double refinement_spacing =
            window_width / static_cast<double>(refinement_partition_count);
        const double refinement_first_shift_hz =
            problem.frequency_min_hz - 0.5 * refinement_spacing;
        const double refinement_last_shift_hz =
            problem.frequency_max_hz + 0.5 * refinement_spacing;
        const double lower_coverage_margin_hz =
            problem.frequency_min_hz - refinement_first_shift_hz;
        const double upper_coverage_margin_hz =
            refinement_last_shift_hz - problem.frequency_max_hz;
        for (std::uint32_t pass_index = 0;
             pass_index < pass_count && !window_interrupted;
             ++pass_index) {
            const std::uint32_t subwindow_count =
                pass_planned_subwindow_count[pass_index];
            for (std::uint32_t subwindow_index = 0;
                 subwindow_index < subwindow_count;
                 ++subwindow_index) {
                PoissonAirboxEigenBlockProblem shifted_problem = problem;
                shifted_problem.target_kind = "nearest_frequency";
                shifted_problem.target_frequency_hz = pass_index == 0u
                    ? problem.frequency_min_hz +
                        (static_cast<double>(subwindow_index) + 0.5) *
                            window_width /
                            static_cast<double>(base_subwindow_count)
                    : problem.frequency_min_hz +
                        (static_cast<double>(subwindow_index) - 0.5) *
                            refinement_spacing;
                shifted_problem.requested_mode_count = pass_index == 0u
                    ? problem.requested_mode_count
                    : refined_requested_mode_count;
                shifted_problem.frequency_min_hz = 0.0;
                shifted_problem.frequency_max_hz = 0.0;
                PoissonAirboxModalEigenResult shifted_result{};
                const FrequencyDomainStatus shifted_status =
                    solve_poisson_airbox_modal_eigen_cpu_schur(
                        shifted_problem,
                        &shifted_result);
                std::vector<const PoissonAirboxModalEigenResult::AcceptedMode *>
                    in_window_modes;
                in_window_modes.reserve(shifted_result.accepted_modes.size());
                for (const PoissonAirboxModalEigenResult::AcceptedMode &mode :
                     shifted_result.accepted_modes) {
                    if (mode.frequency_hz >= problem.frequency_min_hz &&
                        mode.frequency_hz <= problem.frequency_max_hz) {
                        in_window_modes.push_back(&mode);
                    }
                }
                append_subwindow_json(
                    "%s{\"pass\":\"%s\",\"subwindow_index\":%u,"
                    "\"shift_frequency_hz\":%.17g,\"requested_nev\":%llu,"
                    "\"status\":\"%s\",\"converged_eigenpair_count\":%u,"
                    "\"candidate_mode_count\":%u,\"accepted_mode_count\":%zu,"
                    "\"stop_reason\":\"%s\",\"accepted_frequencies_hz\":[",
                    pass_index == 0u && subwindow_index == 0u ? "" : ",",
                    pass_index == 0u ? "base" : "refinement",
                    subwindow_index,
                    shifted_problem.target_frequency_hz,
                    static_cast<unsigned long long>(
                        pass_index == 0u ? requested_nev : refined_nev),
                    shifted_status == FrequencyDomainStatus::ok ? "ok" : "failed",
                    shifted_result.converged_eigenpair_count,
                    shifted_result.accepted_mode_count,
                    in_window_modes.size(),
                    shifted_result.stop_reason[0] != '\0'
                        ? shifted_result.stop_reason
                        : (shifted_status == FrequencyDomainStatus::ok
                               ? "converged"
                               : "subwindow_failed"));
                for (std::size_t accepted_index = 0;
                     accepted_index < in_window_modes.size();
                     ++accepted_index) {
                    append_subwindow_json(
                        "%s%.17g",
                        accepted_index == 0u ? "" : ",",
                        in_window_modes[accepted_index]->frequency_hz);
                }
                append_subwindow_json("%s", "]}");
                if (shifted_status != FrequencyDomainStatus::ok) {
                    if (shifted_status == FrequencyDomainStatus::interrupted) {
                        window_interrupted = true;
                        pass_cancelled[pass_index] = true;
                    } else {
                        ++out_result->window_failed_subwindow_count;
                        ++pass_failed_subwindow_count[pass_index];
                        window_failed = true;
                    }
                    if (window_failure_reason[0] == '\0') {
                        copy_message(
                            window_failure_reason,
                            sizeof(window_failure_reason),
                            shifted_result.stop_reason[0] != '\0'
                                ? shifted_result.stop_reason
                                : (shifted_status ==
                                           FrequencyDomainStatus::interrupted
                                       ? "cancel_requested"
                                       : "subwindow_failed"));
                    }
                    if (shifted_status == FrequencyDomainStatus::interrupted) {
                        break;
                    }
                    continue;
                }
                ++out_result->window_completed_subwindow_count;
                ++pass_completed_subwindow_count[pass_index];
                if (in_window_modes.empty()) {
                    ++window_empty_subwindow_count;
                }
                converged_total += shifted_result.converged_eigenpair_count;
                finite_real_total += shifted_result.finite_real_eigenpair_count;
                positive_total += shifted_result.positive_frequency_eigenpair_count;
                residual_evaluated_total +=
                    shifted_result.action_residual_evaluated_count;
                reconstructed_total += shifted_result.reconstructed_mode_count;
                full_residual_accepted_total +=
                    shifted_result.full_residual_accepted_count;
                outer_iterations_total += shifted_result.outer_iterations;
                for (const PoissonAirboxModalEigenResult::AcceptedMode &mode :
                     shifted_result.accepted_modes) {
                    if (mode.frequency_hz < problem.frequency_min_hz ||
                        mode.frequency_hz > problem.frequency_max_hz) {
                        continue;
                    }
                    const bool duplicate = std::any_of(
                        window_candidates.begin(),
                        window_candidates.end(),
                        [&mode, pass_index](const WindowCandidate &existing) {
                            if (existing.pass_index != pass_index) {
                                return false;
                            }
                            const double relative_frequency_difference =
                                std::abs(
                                    existing.mode.frequency_hz -
                                    mode.frequency_hz) /
                                std::max(
                                    {1.0,
                                     std::abs(existing.mode.frequency_hz),
                                     std::abs(mode.frequency_hz)});
                            if (relative_frequency_difference > 1.0e-8 ||
                                existing.mode.full_vector.size() !=
                                    mode.full_vector.size()) {
                                return false;
                            }
                            Complex overlap = 0.0;
                            double existing_norm = 0.0;
                            double candidate_norm = 0.0;
                            for (std::size_t component = 0;
                                 component < mode.full_vector.size();
                                 ++component) {
                                overlap +=
                                    std::conj(existing.mode.full_vector[component]) *
                                    mode.full_vector[component];
                                existing_norm +=
                                    std::norm(existing.mode.full_vector[component]);
                                candidate_norm +=
                                    std::norm(mode.full_vector[component]);
                            }
                            const double normalized_overlap = std::abs(overlap) /
                                (std::sqrt(existing_norm * candidate_norm) +
                                 1.0e-300);
                            return normalized_overlap >= 1.0 - 1.0e-6;
                        });
                    if (!duplicate) {
                        window_candidates.push_back(WindowCandidate{
                            mode,
                            shifted_result,
                            pass_index});
                    }
                }
                if (poisson_airbox_modal_cancel_requested(problem)) {
                    window_interrupted = true;
                    pass_cancelled[pass_index] = true;
                    if (window_failure_reason[0] == '\0') {
                        copy_message(
                            window_failure_reason,
                            sizeof(window_failure_reason),
                            "cancel_requested");
                    }
                    break;
                }
            }
        }
        out_result->window_empty_subwindow_count = window_empty_subwindow_count;
        finalize_subwindow_json();
        if (!subwindow_json_complete) {
            window_failed = true;
            if (window_failure_reason[0] == '\0') {
                copy_message(
                    window_failure_reason,
                    sizeof(window_failure_reason),
                    "subwindow_diagnostics_truncated");
            }
        }
        const auto pass_state = [&](std::uint32_t pass_index) {
            if (pass_cancelled[pass_index]) {
                return "cancelled";
            }
            if (pass_failed_subwindow_count[pass_index] > 0u) {
                return "failed";
            }
            if (pass_completed_subwindow_count[pass_index] ==
                pass_planned_subwindow_count[pass_index]) {
                return "completed";
            }
            return pass_completed_subwindow_count[pass_index] == 0u
                ? "not_run"
                : "incomplete";
        };
        if (window_candidates.empty()) {
            out_result->window_failed_subwindow = window_failed;
            out_result->window_cancelled = window_interrupted;
            const char *empty_stop_reason = window_interrupted
                ? "cancel_requested"
                : (window_failure_reason[0] != '\0'
                       ? window_failure_reason
                       : "frequency_window_no_accepted_mode");
            const int empty_certificate_written = std::snprintf(
                out_result->window_certificate_json,
                sizeof(out_result->window_certificate_json),
                "{\"schema_version\":\"poisson_airbox_frequency_window_certificate.v1\","
                "\"status\":\"%s\","
                "\"method\":\"shift_nev_refinement_subspace_v1\","
                "\"requested_min_hz\":%.17g,\"requested_max_hz\":%.17g,"
                "\"requested_mode_count\":%u,\"requested_nev\":%llu,"
                "\"refined_requested_mode_count\":%u,\"refined_nev\":%llu,"
                "\"base_schedule\":{\"state\":\"%s\","
                "\"planned_subwindow_count\":%u,\"completed_subwindow_count\":%u,"
                "\"failed_subwindow_count\":%u,\"cancelled\":%s},"
                "\"refinement_schedule\":{\"state\":\"%s\","
                "\"planned_subwindow_count\":%u,\"completed_subwindow_count\":%u,"
                "\"failed_subwindow_count\":%u,\"cancelled\":%s},"
                "\"accepted_cluster_frequencies_hz\":[],\"cluster_ranks\":[],"
                "\"coverage_margins_hz\":{\"lower\":%.17g,\"upper\":%.17g},"
                "\"min_subspace_overlap\":0,"
                "\"perturbation_result\":\"%s\","
                "\"base_schedule_summary_ref\":\"executed_subwindows_json#pass=base\","
                "\"refinement_schedule_summary_ref\":\"executed_subwindows_json#pass=refinement\","
                "\"stop_reason\":\"%s\"}",
                window_failed ? "failed" : "not_certified",
                problem.frequency_min_hz,
                problem.frequency_max_hz,
                problem.requested_mode_count,
                static_cast<unsigned long long>(requested_nev),
                refined_requested_mode_count,
                static_cast<unsigned long long>(refined_nev),
                pass_state(0u),
                pass_planned_subwindow_count[0],
                pass_completed_subwindow_count[0],
                pass_failed_subwindow_count[0],
                pass_cancelled[0] ? "true" : "false",
                pass_state(1u),
                pass_planned_subwindow_count[1],
                pass_completed_subwindow_count[1],
                pass_failed_subwindow_count[1],
                pass_cancelled[1] ? "true" : "false",
                lower_coverage_margin_hz,
                upper_coverage_margin_hz,
                window_interrupted ? "cancelled" : "no_accepted_mode",
                empty_stop_reason);
            if (empty_certificate_written <= 0 ||
                static_cast<std::size_t>(empty_certificate_written) >=
                    sizeof(out_result->window_certificate_json)) {
                std::snprintf(
                    out_result->window_certificate_json,
                    sizeof(out_result->window_certificate_json),
                    "{\"schema_version\":\"poisson_airbox_frequency_window_certificate.v1\","
                    "\"status\":\"failed\","
                    "\"method\":\"shift_nev_refinement_subspace_v1\","
                    "\"truncated\":true,"
                    "\"stop_reason\":\"frequency_window_certificate_truncated\"}");
                empty_stop_reason = "frequency_window_certificate_truncated";
            }
            return fail_production_schur(
                problem,
                out_result,
                window_interrupted
                    ? FrequencyDomainStatus::interrupted
                    : FrequencyDomainStatus::solve_error,
                window_interrupted
                    ? "production shared-domain K0 Schur window was cancelled before preserving a mode"
                    : (window_failure_reason[0] != '\0'
                           ? "production shared-domain K0 Schur multi-shift window failed"
                           : "production shared-domain K0 Schur multi-shift window found no accepted mode"),
                empty_stop_reason);
        }
        std::sort(
            window_candidates.begin(),
            window_candidates.end(),
            [](const WindowCandidate &left, const WindowCandidate &right) {
                return left.mode.frequency_hz < right.mode.frequency_hz;
            });
        const std::size_t requested_mode_count = static_cast<std::size_t>(
            std::max<std::uint32_t>(1u, problem.requested_mode_count));
        const std::size_t discovered_mode_count = window_candidates.size();
        struct WindowCluster {
            double frequency_sum_hz = 0.0;
            std::size_t frequency_sample_count = 0;
            std::vector<std::size_t> independent_candidate_indices{};
            std::vector<std::vector<Complex>> orthonormal_basis{};

            double frequency_hz() const noexcept
            {
                return frequency_sample_count > 0u
                    ? frequency_sum_hz /
                        static_cast<double>(frequency_sample_count)
                    : 0.0;
            }
        };
        const auto frequencies_match = [=](double left_hz, double right_hz) {
            const double tolerance_hz = std::max(
                cluster_frequency_absolute_tolerance_hz,
                cluster_frequency_relative_tolerance *
                    std::max(std::abs(left_hz), std::abs(right_hz)));
            return std::abs(left_hz - right_hz) <= tolerance_hz;
        };
        const auto build_clusters = [&](std::uint32_t pass_index) {
            std::vector<WindowCluster> clusters;
            for (std::size_t candidate_index = 0;
                 candidate_index < window_candidates.size();
                 ++candidate_index) {
                const WindowCandidate &candidate = window_candidates[candidate_index];
                if (candidate.pass_index != pass_index ||
                    candidate.mode.full_vector.size() <
                        static_cast<std::size_t>(problem.q_dof_count)) {
                    continue;
                }
                if (clusters.empty() ||
                    !frequencies_match(
                        clusters.back().frequency_hz(),
                        candidate.mode.frequency_hz)) {
                    clusters.emplace_back();
                }
                WindowCluster &cluster = clusters.back();
                cluster.frequency_sum_hz += candidate.mode.frequency_hz;
                ++cluster.frequency_sample_count;
                std::vector<Complex> vector(
                    candidate.mode.full_vector.begin(),
                    candidate.mode.full_vector.begin() +
                        static_cast<std::ptrdiff_t>(problem.q_dof_count));
                for (int orthogonalization_pass = 0;
                     orthogonalization_pass < 2;
                     ++orthogonalization_pass) {
                    for (const std::vector<Complex> &basis_vector :
                         cluster.orthonormal_basis) {
                        Complex projection = 0.0;
                        for (std::size_t component = 0;
                             component < vector.size();
                             ++component) {
                            projection += std::conj(basis_vector[component]) *
                                vector[component];
                        }
                        for (std::size_t component = 0;
                             component < vector.size();
                             ++component) {
                            vector[component] -=
                                projection * basis_vector[component];
                        }
                    }
                }
                double norm_squared = 0.0;
                for (const Complex value : vector) {
                    norm_squared += std::norm(value);
                }
                const double norm = std::sqrt(norm_squared);
                if (!(norm > 1.0e-8) || !std::isfinite(norm)) {
                    continue;
                }
                for (Complex &value : vector) {
                    value /= norm;
                }
                cluster.orthonormal_basis.push_back(std::move(vector));
                cluster.independent_candidate_indices.push_back(candidate_index);
            }
            return clusters;
        };
        const std::vector<WindowCluster> base_clusters = build_clusters(0u);
        const std::vector<WindowCluster> refinement_clusters = build_clusters(1u);
        struct ClusterSelection {
            std::vector<std::size_t> cluster_indices{};
            std::size_t covered_mode_count = 0;
            std::size_t split_cluster_index =
                std::numeric_limits<std::size_t>::max();
            bool complete = false;
            bool splits_cluster = false;
        };
        const auto select_clusters = [requested_mode_count](
            const std::vector<WindowCluster> &clusters) {
            ClusterSelection selection{};
            for (std::size_t cluster_index = 0;
                 cluster_index < clusters.size();
                 ++cluster_index) {
                const std::size_t rank =
                    clusters[cluster_index].orthonormal_basis.size();
                if (rank == 0u) {
                    continue;
                }
                if (selection.covered_mode_count + rank > requested_mode_count) {
                    selection.splits_cluster = true;
                    selection.split_cluster_index = cluster_index;
                    break;
                }
                selection.cluster_indices.push_back(cluster_index);
                selection.covered_mode_count += rank;
                if (selection.covered_mode_count == requested_mode_count) {
                    selection.complete = true;
                    break;
                }
            }
            return selection;
        };
        const ClusterSelection base_selection = select_clusters(base_clusters);
        const ClusterSelection refinement_selection =
            select_clusters(refinement_clusters);
        const bool base_pass_complete =
            pass_completed_subwindow_count[0] == pass_planned_subwindow_count[0] &&
            pass_failed_subwindow_count[0] == 0u &&
            !pass_cancelled[0];
        const bool refinement_pass_complete =
            pass_completed_subwindow_count[1] == pass_planned_subwindow_count[1] &&
            pass_failed_subwindow_count[1] == 0u &&
            !pass_cancelled[1];
        const bool coverage_margins_positive =
            std::isfinite(lower_coverage_margin_hz) &&
            std::isfinite(upper_coverage_margin_hz) &&
            lower_coverage_margin_hz > 0.0 &&
            upper_coverage_margin_hz > 0.0;
        bool refinement_disagreement = false;
        const char *perturbation_result = "stable";
        double min_subspace_overlap = 1.0;
        if (!refined_nev_increased) {
            refinement_disagreement = true;
            perturbation_result = "refined_nev_not_greater";
        } else if (base_selection.splits_cluster ||
                   refinement_selection.splits_cluster) {
            refinement_disagreement = true;
            perturbation_result = "requested_count_splits_cluster";
            min_subspace_overlap = 0.0;
        } else if (base_selection.complete && refinement_selection.complete) {
            if (base_selection.cluster_indices.size() !=
                refinement_selection.cluster_indices.size()) {
                refinement_disagreement = true;
                perturbation_result = "cluster_count_mismatch";
            } else {
                for (std::size_t selected_cluster = 0;
                     selected_cluster < base_selection.cluster_indices.size();
                     ++selected_cluster) {
                    const WindowCluster &base_cluster = base_clusters[
                        base_selection.cluster_indices[selected_cluster]];
                    const WindowCluster &refinement_cluster = refinement_clusters[
                        refinement_selection.cluster_indices[selected_cluster]];
                    const std::size_t base_rank =
                        base_cluster.orthonormal_basis.size();
                    const std::size_t refinement_rank =
                        refinement_cluster.orthonormal_basis.size();
                    if (!frequencies_match(
                            base_cluster.frequency_hz(),
                            refinement_cluster.frequency_hz())) {
                        refinement_disagreement = true;
                        perturbation_result = "cluster_frequency_mismatch";
                        break;
                    }
                    if (base_rank != refinement_rank || base_rank == 0u) {
                        refinement_disagreement = true;
                        perturbation_result = "cluster_rank_mismatch";
                        break;
                    }
                    double squared_overlap_sum = 0.0;
                    for (const std::vector<Complex> &base_vector :
                         base_cluster.orthonormal_basis) {
                        for (const std::vector<Complex> &refinement_vector :
                             refinement_cluster.orthonormal_basis) {
                            Complex overlap = 0.0;
                            for (std::size_t component = 0;
                                 component < base_vector.size();
                                 ++component) {
                                overlap += std::conj(base_vector[component]) *
                                    refinement_vector[component];
                            }
                            squared_overlap_sum += std::norm(overlap);
                        }
                    }
                    const double subspace_overlap = std::sqrt(std::max(
                        0.0,
                        squared_overlap_sum / static_cast<double>(base_rank)));
                    min_subspace_overlap = std::min(
                        min_subspace_overlap,
                        std::min(1.0, subspace_overlap));
                    if (!std::isfinite(subspace_overlap) ||
                        subspace_overlap < subspace_overlap_threshold) {
                        refinement_disagreement = true;
                        perturbation_result = "invariant_subspace_mismatch";
                        break;
                    }
                }
            }
        } else {
            min_subspace_overlap = 0.0;
            if (base_selection.complete != refinement_selection.complete ||
                base_selection.covered_mode_count !=
                    refinement_selection.covered_mode_count) {
                refinement_disagreement = true;
                perturbation_result = "cluster_coverage_mismatch";
            } else {
                perturbation_result = "insufficient_requested_mode_coverage";
            }
        }
        if (!coverage_margins_positive && !refinement_disagreement) {
            refinement_disagreement = true;
            perturbation_result = "nonpositive_coverage_margin";
        }
        const bool mode_coverage_complete =
            base_selection.complete && refinement_selection.complete;
        std::vector<WindowCandidate> selected_base_candidates;
        for (const std::size_t cluster_index : base_selection.cluster_indices) {
            for (const std::size_t candidate_index :
                 base_clusters[cluster_index].independent_candidate_indices) {
                selected_base_candidates.push_back(window_candidates[candidate_index]);
            }
        }
        if (selected_base_candidates.empty()) {
            char observed_cluster_frequencies_json[128] = "[]";
            char observed_cluster_ranks_json[64] = "[]";
            if (base_selection.split_cluster_index < base_clusters.size()) {
                const WindowCluster &split_cluster =
                    base_clusters[base_selection.split_cluster_index];
                std::snprintf(
                    observed_cluster_frequencies_json,
                    sizeof(observed_cluster_frequencies_json),
                    "[%.17g]",
                    split_cluster.frequency_hz());
                std::snprintf(
                    observed_cluster_ranks_json,
                    sizeof(observed_cluster_ranks_json),
                    "[%zu]",
                    split_cluster.orthonormal_basis.size());
            }
            const char *empty_selection_stop_reason = window_interrupted
                ? "cancel_requested"
                : (!subwindow_json_complete
                       ? "frequency_window_schedule_summary_truncated"
                       : (window_failed ||
                          !base_pass_complete ||
                          !refinement_pass_complete
                              ? "frequency_window_subwindow_failed"
                              : (refinement_disagreement
                                     ? "frequency_window_refinement_disagreement"
                                     : "frequency_window_incomplete_mode_coverage")));
            out_result->window_subwindow_count =
                base_subwindow_count + refinement_subwindow_count;
            out_result->window_failed_subwindow = window_failed;
            out_result->window_cancelled = window_interrupted;
            out_result->window_complete = false;
            out_result->accepted_modes.clear();
            out_result->accepted_mode_count = 0u;
            copy_message(
                out_result->executed_subwindows_json,
                sizeof(out_result->executed_subwindows_json),
                executed_subwindows_json);
            const int empty_selection_certificate_written = std::snprintf(
                out_result->window_certificate_json,
                sizeof(out_result->window_certificate_json),
                "{\"schema_version\":\"poisson_airbox_frequency_window_certificate.v1\","
                "\"status\":\"%s\","
                "\"method\":\"shift_nev_refinement_subspace_v1\","
                "\"requested_min_hz\":%.17g,\"requested_max_hz\":%.17g,"
                "\"requested_mode_count\":%u,\"requested_nev\":%llu,"
                "\"refined_requested_mode_count\":%u,\"refined_nev\":%llu,"
                "\"discovered_mode_count\":%zu,\"accepted_mode_count\":0,"
                "\"base_schedule\":{\"state\":\"%s\","
                "\"planned_subwindow_count\":%u,\"completed_subwindow_count\":%u,"
                "\"failed_subwindow_count\":%u,\"cancelled\":%s},"
                "\"refinement_schedule\":{\"state\":\"%s\","
                "\"planned_subwindow_count\":%u,\"completed_subwindow_count\":%u,"
                "\"failed_subwindow_count\":%u,\"cancelled\":%s},"
                "\"accepted_cluster_frequencies_hz\":%s,\"cluster_ranks\":%s,"
                "\"coverage_margins_hz\":{\"lower\":%.17g,\"upper\":%.17g},"
                "\"min_subspace_overlap\":%.17g,"
                "\"subspace_overlap_threshold\":%.17g,"
                "\"perturbation_result\":\"%s\","
                "\"base_schedule_summary_ref\":\"executed_subwindows_json#pass=base\","
                "\"refinement_schedule_summary_ref\":\"executed_subwindows_json#pass=refinement\","
                "\"stop_reason\":\"%s\"}",
                window_failed ? "failed" : "not_certified",
                problem.frequency_min_hz,
                problem.frequency_max_hz,
                problem.requested_mode_count,
                static_cast<unsigned long long>(requested_nev),
                refined_requested_mode_count,
                static_cast<unsigned long long>(refined_nev),
                discovered_mode_count,
                pass_state(0u),
                pass_planned_subwindow_count[0],
                pass_completed_subwindow_count[0],
                pass_failed_subwindow_count[0],
                pass_cancelled[0] ? "true" : "false",
                pass_state(1u),
                pass_planned_subwindow_count[1],
                pass_completed_subwindow_count[1],
                pass_failed_subwindow_count[1],
                pass_cancelled[1] ? "true" : "false",
                observed_cluster_frequencies_json,
                observed_cluster_ranks_json,
                lower_coverage_margin_hz,
                upper_coverage_margin_hz,
                min_subspace_overlap,
                subspace_overlap_threshold,
                window_interrupted ? "cancelled" : perturbation_result,
                empty_selection_stop_reason);
            if (empty_selection_certificate_written <= 0 ||
                static_cast<std::size_t>(empty_selection_certificate_written) >=
                    sizeof(out_result->window_certificate_json)) {
                std::snprintf(
                    out_result->window_certificate_json,
                    sizeof(out_result->window_certificate_json),
                    "{\"schema_version\":\"poisson_airbox_frequency_window_certificate.v1\","
                    "\"status\":\"failed\","
                    "\"method\":\"shift_nev_refinement_subspace_v1\","
                    "\"truncated\":true,"
                    "\"stop_reason\":\"frequency_window_certificate_truncated\"}");
                empty_selection_stop_reason =
                    "frequency_window_certificate_truncated";
            }
            return fail_production_schur(
                problem,
                out_result,
                window_interrupted
                    ? FrequencyDomainStatus::interrupted
                    : FrequencyDomainStatus::solve_error,
                window_interrupted
                    ? "production shared-domain K0 Schur window was cancelled before preserving a complete mode"
                    : "production shared-domain K0 Schur window preserved no complete base cluster",
                empty_selection_stop_reason);
        }
        window_candidates = std::move(selected_base_candidates);
        char cluster_frequencies_json[2048]{};
        char cluster_ranks_json[1024]{};
        std::size_t cluster_frequencies_size = 1u;
        std::size_t cluster_ranks_size = 1u;
        cluster_frequencies_json[0] = '[';
        cluster_ranks_json[0] = '[';
        bool cluster_json_complete = true;
        for (std::size_t selected_cluster = 0;
             selected_cluster < base_selection.cluster_indices.size();
             ++selected_cluster) {
            const WindowCluster &cluster = base_clusters[
                base_selection.cluster_indices[selected_cluster]];
            const int frequency_written = std::snprintf(
                cluster_frequencies_json + cluster_frequencies_size,
                sizeof(cluster_frequencies_json) - cluster_frequencies_size,
                "%s%.17g",
                selected_cluster == 0u ? "" : ",",
                cluster.frequency_hz());
            const int rank_written = std::snprintf(
                cluster_ranks_json + cluster_ranks_size,
                sizeof(cluster_ranks_json) - cluster_ranks_size,
                "%s%zu",
                selected_cluster == 0u ? "" : ",",
                cluster.orthonormal_basis.size());
            if (frequency_written < 0 || rank_written < 0 ||
                static_cast<std::size_t>(frequency_written) >=
                    sizeof(cluster_frequencies_json) - cluster_frequencies_size ||
                static_cast<std::size_t>(rank_written) >=
                    sizeof(cluster_ranks_json) - cluster_ranks_size) {
                cluster_json_complete = false;
                break;
            }
            cluster_frequencies_size += static_cast<std::size_t>(frequency_written);
            cluster_ranks_size += static_cast<std::size_t>(rank_written);
        }
        if (cluster_json_complete) {
            const int frequency_closed = std::snprintf(
                cluster_frequencies_json + cluster_frequencies_size,
                sizeof(cluster_frequencies_json) - cluster_frequencies_size,
                "]");
            const int rank_closed = std::snprintf(
                cluster_ranks_json + cluster_ranks_size,
                sizeof(cluster_ranks_json) - cluster_ranks_size,
                "]");
            cluster_json_complete = frequency_closed == 1 && rank_closed == 1;
        }
        if (!cluster_json_complete) {
            window_failed = true;
            copy_message(
                window_failure_reason,
                sizeof(window_failure_reason),
                "frequency_window_cluster_summary_truncated");
            std::snprintf(
                cluster_frequencies_json,
                sizeof(cluster_frequencies_json),
                "[]");
            std::snprintf(
                cluster_ranks_json,
                sizeof(cluster_ranks_json),
                "[]");
        }
        PoissonAirboxModalEigenResult aggregate = window_candidates.front().source;
        aggregate.accepted_modes.clear();
        aggregate.accepted_modes.reserve(window_candidates.size());
        for (const WindowCandidate &candidate : window_candidates) {
            aggregate.accepted_modes.push_back(candidate.mode);
        }
        const auto &selected = aggregate.accepted_modes.front();
        aggregate.accepted_mode_count =
            static_cast<std::uint32_t>(aggregate.accepted_modes.size());
        aggregate.selected_eigenpair_index = selected.eigenpair_index;
        aggregate.eigenvalue_real = selected.eigenvalue_real;
        aggregate.eigenvalue_imag = selected.eigenvalue_imag;
        aggregate.omega_rad_s = selected.omega_rad_s;
        aggregate.frequency_hz = selected.frequency_hz;
        aggregate.slepc_reported_backward_error =
            selected.slepc_reported_backward_error;
        aggregate.full_residual_reconstruction_relative_error =
            selected.full_residual_reconstruction_relative_error;
        aggregate.eigen_residual_relative = selected.relative_residual;
        aggregate.magnetic_block_backward_error =
            selected.magnetic_block_backward_error;
        aggregate.poisson_block_backward_error = selected.poisson_block_backward_error;
        aggregate.gauge_constraint_backward_error =
            selected.gauge_constraint_backward_error;
        aggregate.magnetic_residual_l2 = selected.magnetic_residual_l2;
        aggregate.poisson_residual_l2 = selected.poisson_residual_l2;
        aggregate.gauge_residual_abs = selected.gauge_residual_abs;
        aggregate.gauge_mean_abs = selected.gauge_mean_abs;
        aggregate.converged_eigenpair_count = static_cast<std::uint32_t>(
            std::min<std::uint64_t>(
                converged_total,
                std::numeric_limits<std::uint32_t>::max()));
        aggregate.finite_real_eigenpair_count = static_cast<std::uint32_t>(
            std::min<std::uint64_t>(
                finite_real_total,
                std::numeric_limits<std::uint32_t>::max()));
        aggregate.positive_frequency_eigenpair_count = static_cast<std::uint32_t>(
            std::min<std::uint64_t>(
                positive_total,
                std::numeric_limits<std::uint32_t>::max()));
        aggregate.action_residual_evaluated_count = static_cast<std::uint32_t>(
            std::min<std::uint64_t>(
                residual_evaluated_total,
                std::numeric_limits<std::uint32_t>::max()));
        aggregate.reconstructed_mode_count = static_cast<std::uint32_t>(
            std::min<std::uint64_t>(
                reconstructed_total,
                std::numeric_limits<std::uint32_t>::max()));
        aggregate.full_residual_accepted_count = static_cast<std::uint32_t>(
            std::min<std::uint64_t>(
                full_residual_accepted_total,
                std::numeric_limits<std::uint32_t>::max()));
        aggregate.outer_iterations = static_cast<std::uint32_t>(
            std::min<std::uint64_t>(
                outer_iterations_total,
                std::numeric_limits<std::uint32_t>::max()));
        aggregate.window_subwindow_count =
            base_subwindow_count + refinement_subwindow_count;
        aggregate.window_completed_subwindow_count =
            out_result->window_completed_subwindow_count;
        aggregate.window_failed_subwindow_count =
            out_result->window_failed_subwindow_count;
        aggregate.window_empty_subwindow_count = window_empty_subwindow_count;
        aggregate.window_failed_subwindow = window_failed;
        aggregate.window_cancelled = window_interrupted;
        aggregate.window_complete =
            !window_failed && !window_interrupted &&
            base_pass_complete && refinement_pass_complete &&
            mode_coverage_complete && !refinement_disagreement &&
            coverage_margins_positive && cluster_json_complete;
        const char *window_certificate_status = aggregate.window_complete
            ? "certified"
            : (window_failed ? "failed" : "not_certified");
        const char *window_stop_reason = aggregate.window_complete
            ? "window_complete"
            : (window_interrupted
                   ? "cancel_requested"
                   : (!subwindow_json_complete
                          ? "frequency_window_schedule_summary_truncated"
                          : (window_failed ||
                             !base_pass_complete ||
                             !refinement_pass_complete
                                 ? "frequency_window_subwindow_failed"
                                 : (refinement_disagreement
                                        ? "frequency_window_refinement_disagreement"
                                        : "frequency_window_incomplete_mode_coverage"))));
        if (window_interrupted) {
            perturbation_result = "cancelled";
            min_subspace_overlap = 0.0;
        } else if (window_failed || !base_pass_complete ||
                   !refinement_pass_complete) {
            perturbation_result = "pass_incomplete";
            min_subspace_overlap = 0.0;
        }
        copy_message(
            aggregate.stop_reason,
            sizeof(aggregate.stop_reason),
            window_stop_reason);
        const int certificate_written = std::snprintf(
            aggregate.window_certificate_json,
            sizeof(aggregate.window_certificate_json),
            "{\"schema_version\":\"poisson_airbox_frequency_window_certificate.v1\","
            "\"status\":\"%s\","
            "\"method\":\"shift_nev_refinement_subspace_v1\","
            "\"requested_min_hz\":%.17g,\"requested_max_hz\":%.17g,"
            "\"requested_mode_count\":%u,\"requested_nev\":%llu,"
            "\"refined_requested_mode_count\":%u,\"refined_nev\":%llu,"
            "\"discovered_mode_count\":%zu,\"accepted_mode_count\":%u,"
            "\"base_schedule\":{\"state\":\"%s\","
            "\"planned_subwindow_count\":%u,\"completed_subwindow_count\":%u,"
            "\"failed_subwindow_count\":%u,\"cancelled\":%s,"
            "\"first_shift_hz\":%.17g,\"last_shift_hz\":%.17g},"
            "\"refinement_schedule\":{\"state\":\"%s\","
            "\"planned_subwindow_count\":%u,\"completed_subwindow_count\":%u,"
            "\"failed_subwindow_count\":%u,\"cancelled\":%s,"
            "\"first_shift_hz\":%.17g,\"last_shift_hz\":%.17g},"
            "\"accepted_cluster_frequencies_hz\":%s,\"cluster_ranks\":%s,"
            "\"coverage_margins_hz\":{\"lower\":%.17g,\"upper\":%.17g},"
            "\"min_subspace_overlap\":%.17g,"
            "\"subspace_overlap_threshold\":%.17g,"
            "\"perturbation_result\":\"%s\","
            "\"base_schedule_summary_ref\":\"executed_subwindows_json#pass=base\","
            "\"refinement_schedule_summary_ref\":\"executed_subwindows_json#pass=refinement\","
            "\"stop_reason\":\"%s\"}",
            window_certificate_status,
            problem.frequency_min_hz,
            problem.frequency_max_hz,
            problem.requested_mode_count,
            static_cast<unsigned long long>(requested_nev),
            refined_requested_mode_count,
            static_cast<unsigned long long>(refined_nev),
            discovered_mode_count,
            aggregate.accepted_mode_count,
            pass_state(0u),
            pass_planned_subwindow_count[0],
            pass_completed_subwindow_count[0],
            pass_failed_subwindow_count[0],
            pass_cancelled[0] ? "true" : "false",
            problem.frequency_min_hz +
                0.5 * window_width / static_cast<double>(base_subwindow_count),
            problem.frequency_max_hz -
                0.5 * window_width / static_cast<double>(base_subwindow_count),
            pass_state(1u),
            pass_planned_subwindow_count[1],
            pass_completed_subwindow_count[1],
            pass_failed_subwindow_count[1],
            pass_cancelled[1] ? "true" : "false",
            refinement_first_shift_hz,
            refinement_last_shift_hz,
            cluster_frequencies_json,
            cluster_ranks_json,
            lower_coverage_margin_hz,
            upper_coverage_margin_hz,
            min_subspace_overlap,
            subspace_overlap_threshold,
            perturbation_result,
            window_stop_reason);
        const bool certificate_complete = certificate_written > 0 &&
            static_cast<std::size_t>(certificate_written) <
                sizeof(aggregate.window_certificate_json);
        if (!certificate_complete) {
            aggregate.window_complete = false;
            copy_message(
                aggregate.stop_reason,
                sizeof(aggregate.stop_reason),
                "frequency_window_certificate_truncated");
            std::snprintf(
                aggregate.window_certificate_json,
                sizeof(aggregate.window_certificate_json),
                "{\"schema_version\":\"poisson_airbox_frequency_window_certificate.v1\","
                "\"status\":\"failed\","
                "\"method\":\"shift_nev_refinement_subspace_v1\","
                "\"truncated\":true,"
                "\"perturbation_result\":\"certificate_truncated\","
                "\"stop_reason\":\"frequency_window_certificate_truncated\"}");
            window_stop_reason = aggregate.stop_reason;
        }
        aggregate.status = aggregate.window_complete
            ? FrequencyDomainStatus::ok
            : (window_interrupted
                   ? FrequencyDomainStatus::interrupted
                   : FrequencyDomainStatus::solve_error);
        copy_message(
            aggregate.error_message,
            sizeof(aggregate.error_message),
            aggregate.window_complete
                ? ""
                : (window_interrupted
                       ? "production shared-domain K0 Schur window was cancelled"
                       : "production shared-domain K0 Schur frequency window was not certified"));
        copy_message(
            aggregate.executed_subwindows_json,
            sizeof(aggregate.executed_subwindows_json),
            executed_subwindows_json);
        *out_result = std::move(aggregate);
        write_production_schur_diagnostics(
            problem,
            *out_result,
            out_result->status == FrequencyDomainStatus::ok
                ? "ok"
                : (out_result->status == FrequencyDomainStatus::interrupted
                       ? "interrupted"
                       : "solve_error"),
            out_result->stop_reason,
            out_result);
        return out_result->status;
    }
    const std::lock_guard<std::mutex> lock(pa_e3_slepc_mutex());
    if (!ensure_slepc_initialized(out_result->error_message)) {
        return fail_production_schur(
            problem,
            out_result,
            FrequencyDomainStatus::solve_error,
            out_result->error_message,
            "slepc_initialization_failed");
    }

    ProductionSchurContext context{};
    if (!configure_production_context(problem, &context)) {
        destroy_production_context(&context);
        return fail_production_schur(
            problem,
            out_result,
            FrequencyDomainStatus::operator_error,
            "production shared-domain K0 Schur Poisson factorization setup failed",
            "poisson_factorization_setup_failed");
    }

    ProductionSplitContext split_context{};
    split_context.base = &context;
    Mat schur_shell = nullptr;
    Mat split_mass = nullptr;
    EPS eps = nullptr;
    Vec xr = nullptr;
    Vec xi = nullptr;
    const PetscInt base_count = context.q_count;
    const double target_omega = omega_rad_s_from_frequency_hz(
        std::max(0.0, problem.target_frequency_hz));
    if (VecCreateSeq(PETSC_COMM_SELF, base_count, &split_context.q_real) != 0 ||
        VecCreateSeq(PETSC_COMM_SELF, base_count, &split_context.q_imag) != 0 ||
        VecCreateSeq(PETSC_COMM_SELF, base_count, &split_context.y_real) != 0 ||
        VecCreateSeq(PETSC_COMM_SELF, base_count, &split_context.y_imag) != 0 ||
        MatCreateShell(
            PETSC_COMM_SELF,
            2 * base_count,
            2 * base_count,
            2 * base_count,
            2 * base_count,
            &split_context,
            &schur_shell) != 0 ||
        MatShellSetOperation(
            schur_shell,
            MATOP_MULT,
            reinterpret_cast<void (*)(void)>(production_split_schur_matmult)) != 0 ||
        MatSetUp(schur_shell) != 0 ||
        !create_production_split_mass(problem.B_qq, &split_mass)) {
        if (schur_shell != nullptr) {
            MatDestroy(&schur_shell);
        }
        if (split_mass != nullptr) {
            MatDestroy(&split_mass);
        }
        if (split_context.y_imag != nullptr) {
            VecDestroy(&split_context.y_imag);
        }
        if (split_context.y_real != nullptr) {
            VecDestroy(&split_context.y_real);
        }
        if (split_context.q_imag != nullptr) {
            VecDestroy(&split_context.q_imag);
        }
        if (split_context.q_real != nullptr) {
            VecDestroy(&split_context.q_real);
        }
        destroy_production_context(&context);
        return fail_production_schur(
            problem,
            out_result,
            FrequencyDomainStatus::operator_error,
            "production shared-domain K0 Schur real-split operator setup failed",
            "real_split_matshell_setup_failed");
    }

    const PetscInt split_count = 2 * base_count;
    const PetscInt requested_pairs = std::max<PetscInt>(
        1,
        // Each physical mode is a two-dimensional J-equivalence class in the
        // rotated-real pencil, and its conjugate branch contributes another
        // two real Ritz vectors.  Request both branches so target-magnitude
        // ties cannot return only the negative-frequency half.
        static_cast<PetscInt>(std::max<std::uint32_t>(1u, problem.requested_mode_count) * 4u));
    // Krylov-Schur requires a proper subspace: asking for the complete
    // spectrum (nev == n) reaches an invalid dense projected problem in
    // SLEPc/LAPACK and may terminate through XERBLA before the caller can
    // observe a failure.  The production lane is selected-spectrum only.
    const PetscInt nev = std::min(split_count - 1, requested_pairs);
    const PetscReal tolerance = static_cast<PetscReal>(problem.residual_tolerance);
    const PetscInt max_outer = problem.max_outer_iterations > 0
        ? static_cast<PetscInt>(problem.max_outer_iterations)
        : PETSC_DEFAULT;
    Mat shifted_preconditioner = nullptr;
    bool exact_shifted_preconditioner =
        create_production_exact_shift_preconditioner(
            schur_shell,
            split_mass,
            split_count,
            target_omega,
            &shifted_preconditioner);
    if (!exact_shifted_preconditioner) {
        exact_shifted_preconditioner = false;
        if (!create_production_shift_preconditioner(
                problem.A_qq,
                problem.B_qq,
                target_omega,
                &shifted_preconditioner)) {
            destroy_slepc_objects(&eps, &xr, &xi, &schur_shell, &split_mass);
            if (shifted_preconditioner != nullptr) {
                MatDestroy(&shifted_preconditioner);
            }
            VecDestroy(&split_context.y_imag);
            VecDestroy(&split_context.y_real);
            VecDestroy(&split_context.q_imag);
            VecDestroy(&split_context.q_real);
            destroy_production_context(&context);
            return fail_production_schur(
                problem,
                out_result,
                FrequencyDomainStatus::operator_error,
                "production shared-domain K0 Schur shifted preconditioner setup failed",
                "shifted_preconditioner_setup_failed");
        }
    }
    std::snprintf(
        out_result->shifted_preconditioner_kind,
        sizeof(out_result->shifted_preconditioner_kind),
        "%s",
        exact_shifted_preconditioner
            ? "exact_shifted_schur_action"
            : "magnetic_shift_preconditioner");
    if (shifted_preconditioner == nullptr) {
        destroy_slepc_objects(&eps, &xr, &xi, &schur_shell, &split_mass);
        VecDestroy(&split_context.y_imag);
        VecDestroy(&split_context.y_real);
        VecDestroy(&split_context.q_imag);
        VecDestroy(&split_context.q_real);
        destroy_production_context(&context);
        return fail_production_schur(
            problem,
            out_result,
            FrequencyDomainStatus::operator_error,
            "production shared-domain K0 Schur shifted preconditioner setup failed",
            "shifted_preconditioner_setup_failed");
    }

    if (poisson_airbox_modal_cancel_requested(problem)) {
        destroy_slepc_objects(&eps, &xr, &xi, &schur_shell, &split_mass);
        MatDestroy(&shifted_preconditioner);
        VecDestroy(&split_context.y_imag);
        VecDestroy(&split_context.y_real);
        VecDestroy(&split_context.q_imag);
        VecDestroy(&split_context.q_real);
        destroy_production_context(&context);
        return fail_production_schur(
            problem,
            out_result,
            FrequencyDomainStatus::interrupted,
            "production shared-domain K0 Schur solve was cancelled before EPSSolve",
            "cancel_requested");
    }

    ST st = nullptr;
    KSP st_ksp = nullptr;
    PC st_pc = nullptr;
    bool configured =
        EPSCreate(PETSC_COMM_SELF, &eps) == 0 &&
        EPSSetOperators(eps, schur_shell, split_mass) == 0 &&
        EPSSetProblemType(eps, EPS_GNHEP) == 0 &&
        EPSSetType(eps, EPSKRYLOVSCHUR) == 0 &&
        EPSSetDimensions(eps, nev, PETSC_DEFAULT, PETSC_DEFAULT) == 0 &&
        EPSSetWhichEigenpairs(eps, EPS_TARGET_MAGNITUDE) == 0 &&
        EPSSetTarget(eps, static_cast<PetscScalar>(target_omega)) == 0 &&
        EPSSetTolerances(eps, tolerance, max_outer) == 0 &&
        EPSGetST(eps, &st) == 0 &&
        // The selected-spectrum lane must use shift-and-invert.  STSHIFT only
        // forms (A-tau B), which does not amplify the interior eigenvalues and
        // leaves the KSP/PC configuration below unused.  STSINVERT applies the
        // requested real-frequency shift to the rotated pencil as
        // (A-tau B)^-1, matching ADR-017 and the full descriptor CPU lane.
        STSetType(st, STSINVERT) == 0 &&
        STSetShift(st, static_cast<PetscScalar>(target_omega)) == 0 &&
        STSetPreconditionerMat(st, shifted_preconditioner) == 0 &&
        STGetKSP(st, &st_ksp) == 0;
    if (configured) {
        // For bounded qualification problems the materialized matrix is the
        // exact shifted Schur action, so a direct PREONLY solve avoids an
        // unnecessary GMRES iteration and its exact-preconditioner breakdown.
        // Larger problems retain the shell operator with an approximate
        // magnetic preconditioner and therefore require GMRES.
        configured = KSPSetType(
                st_ksp,
                exact_shifted_preconditioner ? KSPPREONLY : KSPGMRES) == 0;
    }
    if (configured && !exact_shifted_preconditioner) {
        configured = KSPGMRESSetRestart(
            st_ksp,
            std::min<PetscInt>(split_count, static_cast<PetscInt>(256))) == 0;
    }
    configured = configured &&
        KSPGetPC(st_ksp, &st_pc) == 0 &&
        PCSetType(st_pc, PCLU) == 0 &&
        // MATSOLVERUMFPACK/MATSOLVERKLU are public string constants even
        // when PETSc was built without those packages.  Do not use their
        // preprocessor presence as an availability probe; PETSc's default
        // sequential factorization is always valid for this bounded path.
        PCFactorReorderForNonzeroDiagonal(st_pc, 1.0e-12) == 0 &&
        // The physical FEM pencil is assembled in SI units, so its bounded
        // shifted Schur entries can be O(1e-19) even though the matrix is
        // nonsingular.  PETSc's default absolute zero-pivot threshold is
        // then larger than valid pivots and aborts the direct preconditioner.
        // Keep a small absolute guard for this unit-scaled preconditioner;
        // genuine singularity is still rejected by the factorization itself.
        PCFactorSetZeroPivot(st_pc, 1.0e-30) == 0 &&
        PCFactorSetShiftType(st_pc, MAT_SHIFT_NONE) == 0 &&
        KSPSetTolerances(
            st_ksp,
            std::min(0.01 * tolerance, 1.0e-10),
            1.0e-14,
            PETSC_DEFAULT,
            std::max<PetscInt>(
                1000,
                problem.max_linear_iterations > 0
                    ? static_cast<PetscInt>(problem.max_linear_iterations)
                    : 0)) == 0 &&
        KSPSetConvergenceTest(
            st_ksp,
            production_modal_ksp_convergence_test,
            const_cast<PoissonAirboxEigenBlockProblem *>(&problem),
            nullptr) == 0 &&
        VecCreateSeq(PETSC_COMM_SELF, split_count, &xr) == 0 &&
        VecCreateSeq(PETSC_COMM_SELF, split_count, &xi) == 0;
    if (!configured) {
        destroy_slepc_objects(&eps, &xr, &xi, &schur_shell, &split_mass);
        MatDestroy(&shifted_preconditioner);
        VecDestroy(&split_context.y_imag);
        VecDestroy(&split_context.y_real);
        VecDestroy(&split_context.q_imag);
        VecDestroy(&split_context.q_real);
        destroy_production_context(&context);
        return fail_production_schur(
            problem,
            out_result,
            FrequencyDomainStatus::solve_error,
            "production shared-domain K0 Schur SLEPc configuration failed",
            "slepc_solver_configuration_failed");
    }

    PetscInt outer_iterations = 0;
    PetscInt converged = 0;
    const PetscErrorCode eps_solve_status = EPSSolve(eps);
    const bool solve_interrupted = poisson_airbox_modal_cancel_requested(problem);
    EPSConvergedReason eps_reason = EPS_CONVERGED_ITERATING;
    const PetscErrorCode iteration_status = EPSGetIterationNumber(eps, &outer_iterations);
    const PetscErrorCode converged_status = EPSGetConverged(eps, &converged);
    const PetscErrorCode reason_status = EPSGetConvergedReason(eps, &eps_reason);
    if ((eps_solve_status != 0 && !solve_interrupted) ||
        iteration_status != 0 ||
        converged_status != 0 ||
        reason_status != 0) {
        destroy_slepc_objects(&eps, &xr, &xi, &schur_shell, &split_mass);
        MatDestroy(&shifted_preconditioner);
        VecDestroy(&split_context.y_imag);
        VecDestroy(&split_context.y_real);
        VecDestroy(&split_context.q_imag);
        VecDestroy(&split_context.q_real);
        destroy_production_context(&context);
        return fail_production_schur(
            problem,
            out_result,
            solve_interrupted
                ? FrequencyDomainStatus::interrupted
                : FrequencyDomainStatus::solve_error,
            solve_interrupted
                ? "production shared-domain K0 Schur SLEPc solve was cancelled"
                : "production shared-domain K0 Schur SLEPc solve failed",
            solve_interrupted ? "cancel_requested" : "slepc_solve_failed");
    }
    out_result->slepc_converged_reason_code = static_cast<int>(eps_reason);
    copy_message(
        out_result->slepc_converged_reason,
        sizeof(out_result->slepc_converged_reason),
        eps_reason > 0 ? "eps_converged" :
            eps_reason < 0 ? "eps_diverged" : "eps_iterating");
    if (!solve_interrupted && eps_reason <= 0) {
        destroy_slepc_objects(&eps, &xr, &xi, &schur_shell, &split_mass);
        MatDestroy(&shifted_preconditioner);
        VecDestroy(&split_context.y_imag);
        VecDestroy(&split_context.y_real);
        VecDestroy(&split_context.q_imag);
        VecDestroy(&split_context.q_real);
        destroy_production_context(&context);
        return fail_production_schur(
            problem,
            out_result,
            FrequencyDomainStatus::solve_error,
            "production shared-domain K0 Schur SLEPc did not report convergence",
            eps_reason < 0 ? "slepc_diverged" : "slepc_not_converged");
    }
    copy_message(
        out_result->stop_reason,
        sizeof(out_result->stop_reason),
        solve_interrupted ? "cancel_requested" : "converged");
    PetscInt shift_linear_iterations = 0;
    if (KSPGetTotalIterations(st_ksp, &shift_linear_iterations) == 0) {
        out_result->shift_linear_iteration_count = static_cast<std::uint64_t>(
            std::max<PetscInt>(0, shift_linear_iterations));
    }
    out_result->outer_iterations = static_cast<std::uint32_t>(
        std::max<PetscInt>(0, outer_iterations));
    out_result->converged_eigenpair_count = static_cast<std::uint32_t>(
        std::max<PetscInt>(0, converged));

    // Cancellation stops the outer SLEPc/KSP iteration, but already
    // converged Ritz pairs still need one final Schur action to reconstruct
    // their phi and block residuals.  Keep cancellation active for the solve
    // itself and then use a short-lived callback context with cancellation
    // disabled only during this read-only extraction pass.
    PoissonAirboxEigenBlockProblem extraction_problem = problem;
    if (solve_interrupted && context.poisson_ksp != nullptr) {
        extraction_problem.cancel_requested = nullptr;
        extraction_problem.progress_callback = nullptr;
        if (KSPSetConvergenceTest(
                context.poisson_ksp,
                production_modal_ksp_convergence_test,
                &extraction_problem,
                nullptr) != 0) {
            destroy_slepc_objects(&eps, &xr, &xi, &schur_shell, &split_mass);
            MatDestroy(&shifted_preconditioner);
            VecDestroy(&split_context.y_imag);
            VecDestroy(&split_context.y_real);
            VecDestroy(&split_context.q_imag);
            VecDestroy(&split_context.q_real);
            destroy_production_context(&context);
            return fail_production_schur(
                problem,
                out_result,
                FrequencyDomainStatus::interrupted,
                "production shared-domain K0 cancellation extraction setup failed",
                "cancel_requested");
        }
    }

    struct Candidate {
        PetscInt eigenpair_index = -1;
        double target_distance = 0.0;
        double lambda_real = 0.0;
        double lambda_imag = 0.0;
        double omega_rad_s = 0.0;
        double frequency_hz = 0.0;
        double slepc_residual = 0.0;
        std::vector<Complex> q_vector{};
        std::vector<Complex> full_vector{};
        PoissonAirboxModalResidualMetrics metrics{};
    };
    std::vector<Candidate> candidates;
    bool saw_positive = false;
    const bool frequency_window =
        problem.target_kind != nullptr &&
        std::strcmp(problem.target_kind, "frequency_window") == 0;
    for (PetscInt index = 0; index < converged; ++index) {
        PetscScalar kr = 0.0;
        PetscScalar ki = 0.0;
        PetscReal residual = 0.0;
        if (EPSGetEigenpair(eps, index, &kr, &ki, xr, xi) != 0) {
            continue;
        }
        const double split_eigenvalue = static_cast<double>(PetscRealPart(kr));
        const double split_imaginary = static_cast<double>(PetscRealPart(ki));
        if (!std::isfinite(split_eigenvalue) ||
            std::abs(split_imaginary) >
                std::max(1.0e-10, 1.0e-10 * std::abs(split_eigenvalue))) {
            continue;
        }
        ++out_result->finite_real_eigenpair_count;
        const ModeKinematics kinematics = map_eigenvalue(
            {0.0, split_eigenvalue},
            FrequencyDomainPhaseConvention::exp_i_omega_t);
        if (!select_positive_frequency_mode(
                kinematics,
                ZeroFrequencyModePolicy::exclude)) {
            continue;
        }
        saw_positive = true;
        ++out_result->positive_frequency_eigenpair_count;
        if (frequency_window &&
            (kinematics.frequency_hz < problem.frequency_min_hz ||
             kinematics.frequency_hz > problem.frequency_max_hz)) {
            continue;
        }

        // SLEPc cannot call EPSComputeError for a MatShell because the shell
        // intentionally has no matrix norm operation.  Recompute the
        // backward error from the original shell and mass actions instead of
        // accepting a library-side sentinel or silently dropping the mode.
        Vec residual_vec = nullptr;
        Vec action_vec = nullptr;
        Vec mass_vec = nullptr;
        PetscReal action_norm = 0.0;
        PetscReal mass_norm = 0.0;
        PetscReal residual_norm = 0.0;
        PetscErrorCode residual_error = VecDuplicate(xr, &residual_vec);
        if (residual_error == 0) {
            residual_error = VecDuplicate(xr, &action_vec);
        }
        if (residual_error == 0) {
            residual_error = VecDuplicate(xr, &mass_vec);
        }
        if (residual_error == 0) {
            residual_error = MatMult(schur_shell, xr, action_vec);
        }
        if (residual_error == 0) {
            residual_error = MatMult(split_mass, xr, mass_vec);
        }
        if (residual_error == 0) {
            residual_error = VecWAXPY(
                residual_vec,
                static_cast<PetscScalar>(-split_eigenvalue),
                mass_vec,
                action_vec);
        }
        if (residual_error == 0) {
            residual_error = VecNorm(action_vec, NORM_2, &action_norm);
        }
        if (residual_error == 0) {
            residual_error = VecNorm(mass_vec, NORM_2, &mass_norm);
        }
        if (residual_error == 0) {
            residual_error = VecNorm(residual_vec, NORM_2, &residual_norm);
        }
        const bool residual_ok = residual_error == 0;
        if (residual_vec != nullptr) {
            VecDestroy(&residual_vec);
        }
        if (action_vec != nullptr) {
            VecDestroy(&action_vec);
        }
        if (mass_vec != nullptr) {
            VecDestroy(&mass_vec);
        }
        if (!residual_ok) {
            continue;
        }
        ++out_result->action_residual_evaluated_count;
        residual = residual_norm /
            (action_norm + std::abs(split_eigenvalue) * mass_norm + 1.0e-300);
        const std::vector<Complex> q = copy_production_split_eigenvector(xr, base_count);
        if (q.size() != static_cast<std::size_t>(base_count)) {
            continue;
        }
        std::vector<Complex> full_vector;
        if (!reconstruct_production_mode(&context, q, &full_vector)) {
            continue;
        }
        bool finite_full_vector = true;
        for (std::size_t component = 0; component < full_vector.size(); ++component) {
            if (!std::isfinite(full_vector[component].real()) ||
                !std::isfinite(full_vector[component].imag())) {
                finite_full_vector = false;
                break;
            }
        }
        if (!finite_full_vector) {
            continue;
        }
        ++out_result->reconstructed_mode_count;
        std::vector<double> vector_real(full_vector.size(), 0.0);
        std::vector<double> vector_imag(full_vector.size(), 0.0);
        for (std::size_t component = 0; component < full_vector.size(); ++component) {
            vector_real[component] = full_vector[component].real();
            vector_imag[component] = full_vector[component].imag();
        }
        PoissonAirboxModalResidualMetrics metrics{};
        if (evaluate_poisson_airbox_modal_residuals(
                problem,
                vector_real.data(),
                vector_imag.data(),
                static_cast<std::uint64_t>(full_vector.size()),
                0.0,
                split_eigenvalue,
                static_cast<double>(residual),
                &metrics) != FrequencyDomainStatus::ok ||
            metrics.reconstructed_full_descriptor_backward_error > problem.residual_tolerance) {
            continue;
        }
        ++out_result->full_residual_accepted_count;
        candidates.push_back(Candidate{
            index,
            std::abs(kinematics.omega_rad_s - target_omega),
            0.0,
            split_eigenvalue,
            kinematics.omega_rad_s,
            kinematics.frequency_hz,
            static_cast<double>(residual),
            q,
            std::move(full_vector),
            metrics});
    }

    out_result->operator_apply_count = context.operator_apply_count;
    out_result->poisson_solve_count = context.poisson_solve_count;
    out_result->poisson_iteration_count = context.poisson_iteration_count;
    destroy_slepc_objects(&eps, &xr, &xi, &schur_shell, &split_mass);
    MatDestroy(&shifted_preconditioner);
    VecDestroy(&split_context.y_imag);
    VecDestroy(&split_context.y_real);
    VecDestroy(&split_context.q_imag);
    VecDestroy(&split_context.q_real);
    destroy_production_context(&context);

    std::sort(
        candidates.begin(),
        candidates.end(),
        [frequency_window](const Candidate &left, const Candidate &right) {
            if (frequency_window) {
                return left.frequency_hz < right.frequency_hz;
            }
            if (left.target_distance != right.target_distance) {
                return left.target_distance < right.target_distance;
            }
            return left.frequency_hz < right.frequency_hz;
        });
    // The rotated-real pencil emits a two-vector J-equivalence class for one
    // physical complex mode.  Collapse those representations before applying
    // requested_mode_count, otherwise a request for two modes can publish the
    // same physical frequency twice and hide the next branch.
    std::vector<ModalCandidate> modal_candidates;
    modal_candidates.reserve(candidates.size());
    for (std::size_t index = 0; index < candidates.size(); ++index) {
        ModalCandidate modal_candidate{};
        modal_candidate.frequency_hz = candidates[index].frequency_hz;
        modal_candidate.relative_residual =
            candidates[index].metrics.reconstructed_full_descriptor_backward_error;
        modal_candidate.source_index = static_cast<int>(index);
        modal_candidate.mode = candidates[index].q_vector;
        modal_candidates.push_back(std::move(modal_candidate));
    }
    const std::vector<ModalCandidate> deduplicated =
        deduplicate_modes_by_frequency_and_overlap(
            modal_candidates,
            nullptr,
            static_cast<std::size_t>(base_count),
            1.0e-8,
            1.0e-12,
            0.90);
    std::vector<Candidate> physical_candidates;
    physical_candidates.reserve(deduplicated.size());
    for (std::size_t index = 0; index < candidates.size(); ++index) {
        const bool retained = std::any_of(
            deduplicated.begin(),
            deduplicated.end(),
            [index](const ModalCandidate &candidate) {
                return candidate.source_index == static_cast<int>(index);
            });
        if (retained) {
            physical_candidates.push_back(std::move(candidates[index]));
        }
    }
    candidates = std::move(physical_candidates);
    const std::size_t requested_mode_count = static_cast<std::size_t>(
        std::max<std::uint32_t>(1u, problem.requested_mode_count));
    if (candidates.empty()) {
        return fail_production_schur(
            problem,
            out_result,
            solve_interrupted
                ? FrequencyDomainStatus::interrupted
                : FrequencyDomainStatus::solve_error,
            solve_interrupted
                ? "production shared-domain K0 Schur cancellation preserved no complete mode"
                : (saw_positive
                      ? "production shared-domain K0 Schur found no accepted positive-frequency mode"
                      : "production shared-domain K0 Schur found no positive-frequency mode"),
            solve_interrupted
                ? "cancel_requested"
                : (saw_positive
                      ? "no_accepted_positive_frequency_mode"
                      : "no_positive_frequency_eigenpair"));
    }
    if (candidates.size() > requested_mode_count) {
        candidates.resize(requested_mode_count);
    }

    out_result->accepted_modes.clear();
    out_result->accepted_modes.reserve(candidates.size());
    for (const Candidate &candidate : candidates) {
        PoissonAirboxModalEigenResult::AcceptedMode mode{};
        mode.eigenpair_index = static_cast<std::uint32_t>(candidate.eigenpair_index);
        mode.eigenvalue_real = candidate.lambda_real;
        mode.eigenvalue_imag = candidate.lambda_imag;
        mode.omega_rad_s = candidate.omega_rad_s;
        mode.frequency_hz = candidate.frequency_hz;
        mode.slepc_reported_backward_error = candidate.slepc_residual;
        mode.full_residual_reconstruction_relative_error =
            candidate.metrics.reconstructed_full_descriptor_backward_error;
        mode.relative_residual = mode.full_residual_reconstruction_relative_error;
        mode.magnetic_block_backward_error = candidate.metrics.magnetic_block_backward_error;
        mode.poisson_block_backward_error = candidate.metrics.poisson_block_backward_error;
        mode.gauge_constraint_backward_error = candidate.metrics.gauge_constraint_backward_error;
        mode.magnetic_residual_l2 = candidate.metrics.magnetic_residual_l2;
        mode.poisson_residual_l2 = candidate.metrics.poisson_residual_l2;
        mode.gauge_residual_abs = candidate.metrics.gauge_residual_abs;
        mode.gauge_mean_abs = candidate.metrics.gauge_mean_abs;
        mode.full_vector = candidate.full_vector;
        out_result->accepted_modes.push_back(std::move(mode));
    }
    const Candidate &selected = candidates.front();
    out_result->accepted_mode_count = static_cast<std::uint32_t>(out_result->accepted_modes.size());
    out_result->selected_eigenpair_index = static_cast<std::uint32_t>(selected.eigenpair_index);
    out_result->positive_frequency_branch_found = true;
    out_result->eigenvalue_real = selected.lambda_real;
    out_result->eigenvalue_imag = selected.lambda_imag;
    out_result->omega_rad_s = selected.omega_rad_s;
    out_result->frequency_hz = selected.frequency_hz;
    const FrequencyDomainStatus certification_status =
        apply_poisson_airbox_modal_residual_certification(
            selected.metrics,
            problem.residual_tolerance,
            out_result);
    if (certification_status != FrequencyDomainStatus::ok) {
        return fail_production_schur(
            problem,
            out_result,
            FrequencyDomainStatus::solve_error,
            "production shared-domain K0 Schur full descriptor residual failed certification",
            "poisson_airbox_eigen_full_residual_not_certified");
    }
    if (problem.expected_reference_frequency_hz > 0.0) {
        out_result->relative_reference_frequency_error =
            std::abs(out_result->frequency_hz - problem.expected_reference_frequency_hz) /
            problem.expected_reference_frequency_hz;
    }
    out_result->reference_frequency_certified =
        problem.expected_reference_frequency_hz <= 0.0 ||
        out_result->relative_reference_frequency_error <= 1.0e-10;
    out_result->status = solve_interrupted
        ? FrequencyDomainStatus::interrupted
        : FrequencyDomainStatus::ok;
    copy_message(out_result->error_message, sizeof(out_result->error_message), "");
    write_production_schur_diagnostics(
        problem,
        *out_result,
        solve_interrupted ? "interrupted" : "ok",
        solve_interrupted ? "cancel_requested" : "",
        out_result);
    return out_result->status;
#endif
#endif
}

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
        {lambda.real(), lambda.imag()},
        true,
        true);
    return out_result->status;
#endif
}

} // namespace fullmag::fem::frequency_domain
