#include "frequency_domain/dense_poisson_airbox_eigen_oracle.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <complex>
#include <cstdio>
#include <cstring>
#include <limits>
#include <vector>

namespace fullmag::fem::frequency_domain {

namespace {

using Complex = std::complex<double>;

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kTwoPi = 2.0 * kPi;
constexpr std::uint64_t kMaxDenseOracleDofCount = 64;

struct ComplexDenseMatrix {
    std::uint64_t rows = 0;
    std::uint64_t cols = 0;
    std::vector<Complex> values;

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
    std::vector<Complex> q;
};

struct FullResidualBreakdown {
    double relative_full = 0.0;
    double relative_phi = 0.0;
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

bool string_equals(const char *actual, const char *expected) noexcept
{
    return actual != nullptr && expected != nullptr && std::strcmp(actual, expected) == 0;
}

bool matrix_shape_is(
    const DenseRealMatrixView &matrix,
    std::uint64_t rows,
    std::uint64_t cols) noexcept
{
    return matrix.values_row_major != nullptr &&
        matrix.row_count == rows &&
        matrix.column_count == cols;
}

bool finite_matrix(const DenseRealMatrixView &matrix) noexcept
{
    if (matrix.values_row_major == nullptr ||
        matrix.row_count > kMaxDenseOracleDofCount ||
        matrix.column_count > kMaxDenseOracleDofCount) {
        return false;
    }
    if (matrix.column_count != 0 &&
        matrix.row_count > std::numeric_limits<std::uint64_t>::max() / matrix.column_count) {
        return false;
    }
    const std::uint64_t count = matrix.row_count * matrix.column_count;
    for (std::uint64_t index = 0; index < count; ++index) {
        if (!std::isfinite(matrix.values_row_major[index])) {
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

void write_diagnostics_json(
    const DensePoissonAirboxEigenOracleProblem &problem,
    const DensePoissonAirboxEigenOracleResult &result,
    const char *status,
    const char *reason,
    DensePoissonAirboxEigenOracleResult *out) noexcept
{
    if (out == nullptr) {
        return;
    }
    std::snprintf(
        out->diagnostics_json,
        sizeof(out->diagnostics_json),
        "{"
        "\"schema_version\":\"poisson_airbox_eigen_oracle.v1\","
        "\"status\":\"%s\","
        "\"reason\":\"%s\","
        "\"study_product\":\"modal_eigen\","
        "\"test_id\":\"%s\","
        "\"scope\":\"synthetic_dense_algebraic_oracle\","
        "\"phasor_convention\":\"%s\","
        "\"eigenvalue_convention\":\"%s\","
        "\"demag_kind\":\"%s\","
        "\"gauge_policy\":\"%s\","
        "\"alpha\":0.0,"
        "\"k_vector_rad_per_m\":[0.0,0.0,0.0],"
        "\"q_dof_count\":%llu,"
        "\"phi_dof_count\":%llu,"
        "\"augmented_phi_dof_count\":%llu,"
        "\"metrics\":{"
        "\"schur_apply_relative_error\":%.17g,"
        "\"full_residual_reconstruction_relative_error\":%.17g,"
        "\"poisson_constraint_relative_residual\":%.17g,"
        "\"gauge_mean_abs\":%.17g,"
        "\"eigen_residual_relative\":%.17g,"
        "\"relative_frequency_error\":%.17g"
        "},"
        "\"eigenpair\":{"
        "\"eigenvalue_real\":%.17g,"
        "\"eigenvalue_imag\":%.17g,"
        "\"omega_rad_s\":%.17g,"
        "\"frequency_hz\":%.17g,"
        "\"positive_frequency_branch_found\":%s"
        "},"
        "\"certification\":{"
        "\"schur_certified\":%s,"
        "\"full_residual_certified\":%s,"
        "\"production_periodic_airbox_claim\":false"
        "}"
        "}",
        status != nullptr ? status : "unknown",
        reason != nullptr ? reason : "",
        problem.test_id != nullptr ? problem.test_id : "",
        problem.phasor_convention != nullptr ? problem.phasor_convention : "",
        problem.eigenvalue_convention != nullptr ? problem.eigenvalue_convention : "",
        problem.demag_kind != nullptr ? problem.demag_kind : "",
        problem.gauge_policy != nullptr ? problem.gauge_policy : "",
        static_cast<unsigned long long>(result.q_dof_count),
        static_cast<unsigned long long>(result.phi_dof_count),
        static_cast<unsigned long long>(result.augmented_phi_dof_count),
        result.schur_apply_relative_error,
        result.full_residual_reconstruction_relative_error,
        result.poisson_constraint_relative_residual,
        result.gauge_mean_abs,
        result.eigen_residual_relative,
        result.relative_frequency_error,
        result.eigenvalue_real,
        result.eigenvalue_imag,
        result.omega_rad_s,
        result.frequency_hz,
        result.positive_frequency_branch_found ? "true" : "false",
        result.schur_certified ? "true" : "false",
        result.full_residual_certified ? "true" : "false");
}

FrequencyDomainStatus fail(
    const DensePoissonAirboxEigenOracleProblem &problem,
    DensePoissonAirboxEigenOracleResult *result,
    FrequencyDomainStatus status,
    const char *message,
    const char *reason = "") noexcept
{
    if (result != nullptr) {
        result->status = status;
        copy_message(result->error_message, sizeof(result->error_message), message);
        const char *status_json = "failed";
        if (status == FrequencyDomainStatus::validation_error) {
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
    const DensePoissonAirboxEigenOracleProblem &problem,
    DensePoissonAirboxEigenOracleResult *result) noexcept
{
    if (result == nullptr) {
        return FrequencyDomainStatus::validation_error;
    }
    *result = DensePoissonAirboxEigenOracleResult{};
    result->q_dof_count = problem.q_dof_count;
    result->phi_dof_count = problem.phi_dof_count;
    result->augmented_phi_dof_count = problem.phi_dof_count + 1;
    result->expected_positive_frequency_hz = problem.expected_positive_frequency_hz;

    if (problem.abi_version != kDensePoissonAirboxEigenOracleAbiVersion ||
        problem.struct_size < sizeof(DensePoissonAirboxEigenOracleProblem)) {
        return fail(
            problem,
            result,
            FrequencyDomainStatus::validation_error,
            "PA-E1 dense Poisson-airbox eigen oracle requires ABI version 1",
            "poisson_airbox_eigen_unsupported_abi");
    }
    if (problem.q_dof_count != 2 ||
        problem.phi_dof_count == 0 ||
        problem.phi_dof_count > kMaxDenseOracleDofCount) {
        return fail(
            problem,
            result,
            FrequencyDomainStatus::validation_error,
            "PA-E1 dense Poisson-airbox eigen oracle requires q_dof_count=2 and positive small phi_dof_count",
            "poisson_airbox_eigen_pa_e1_synthetic_only");
    }
    if (!matrix_shape_is(problem.A_qq, problem.q_dof_count, problem.q_dof_count) ||
        !matrix_shape_is(problem.A_qphi, problem.q_dof_count, problem.phi_dof_count) ||
        !matrix_shape_is(problem.A_phiq, problem.phi_dof_count, problem.q_dof_count) ||
        !matrix_shape_is(problem.A_phiphi, problem.phi_dof_count, problem.phi_dof_count) ||
        !matrix_shape_is(problem.B_qq, problem.q_dof_count, problem.q_dof_count)) {
        return fail(
            problem,
            result,
            FrequencyDomainStatus::validation_error,
            "PA-E1 dense Poisson-airbox eigen oracle matrix shape mismatch",
            "poisson_airbox_eigen_matrix_shape_mismatch");
    }
    if (!finite_matrix(problem.A_qq) ||
        !finite_matrix(problem.A_qphi) ||
        !finite_matrix(problem.A_phiq) ||
        !finite_matrix(problem.A_phiphi) ||
        !finite_matrix(problem.B_qq)) {
        return fail(
            problem,
            result,
            FrequencyDomainStatus::validation_error,
            "PA-E1 dense Poisson-airbox eigen oracle matrices must be finite",
            "poisson_airbox_eigen_nonfinite_input");
    }
    if (problem.phi_mean_weights == nullptr ||
        problem.phi_mean_weights_count != problem.phi_dof_count) {
        return fail(
            problem,
            result,
            FrequencyDomainStatus::validation_error,
            "PA-E1 dense Poisson-airbox eigen oracle requires gauge_policy=mean_zero_augmented with matching gauge weights",
            "poisson_airbox_eigen_requires_mean_zero_gauge");
    }
    if (!positive_normalized_weights(
            problem.phi_mean_weights,
            problem.phi_mean_weights_count)) {
        return fail(
            problem,
            result,
            FrequencyDomainStatus::validation_error,
            "PA-E1 dense Poisson-airbox eigen oracle gauge weights must be positive normalized mean-zero weights",
            "poisson_airbox_eigen_requires_mean_zero_gauge");
    }
    if (!string_equals(problem.gauge_policy, "mean_zero_augmented")) {
        return fail(
            problem,
            result,
            FrequencyDomainStatus::validation_error,
            "PA-E1 dense Poisson-airbox eigen oracle requires gauge_policy=mean_zero_augmented",
            "poisson_airbox_eigen_requires_mean_zero_gauge");
    }
    if (!string_equals(problem.phasor_convention, "exp_plus_i_omega_t") ||
        !string_equals(problem.eigenvalue_convention, "lambda_imag_positive_frequency")) {
        return fail(
            problem,
            result,
            FrequencyDomainStatus::validation_error,
            "PA-E1 dense Poisson-airbox eigen oracle requires exp_plus_i_omega_t and lambda_imag_positive_frequency",
            "poisson_airbox_eigen_convention_mismatch");
    }
    if (!string_equals(problem.demag_kind, "synthetic_poisson_airbox_k0") &&
        !string_equals(problem.demag_kind, "synthetic_demag_factor")) {
        return fail(
            problem,
            result,
            FrequencyDomainStatus::validation_error,
            "PA-E1 dense Poisson-airbox eigen oracle only accepts synthetic demag_kind values",
            "poisson_airbox_eigen_pa_e1_synthetic_only");
    }
    if (!problem.require_alpha_zero || !problem.require_k0 || !problem.synthetic_no_mesh) {
        return fail(
            problem,
            result,
            FrequencyDomainStatus::validation_error,
            "PA-E1 dense Poisson-airbox eigen oracle is limited to alpha=0, k=0, synthetic no-mesh cases",
            "poisson_airbox_eigen_pa_e1_synthetic_only");
    }
    if (problem.test_q.count != 0 &&
        (problem.test_q.count != problem.q_dof_count || problem.test_q.real == nullptr)) {
        return fail(
            problem,
            result,
            FrequencyDomainStatus::validation_error,
            "PA-E1 dense Poisson-airbox eigen oracle test_q shape mismatch",
            "poisson_airbox_eigen_test_vector_shape_mismatch");
    }
    if (!(problem.relative_tolerance > 0.0) ||
        !(problem.absolute_tolerance > 0.0) ||
        !std::isfinite(problem.relative_tolerance) ||
        !std::isfinite(problem.absolute_tolerance) ||
        !(problem.expected_frequency_relative_tolerance > 0.0) ||
        !std::isfinite(problem.expected_frequency_relative_tolerance)) {
        return fail(
            problem,
            result,
            FrequencyDomainStatus::validation_error,
            "PA-E1 dense Poisson-airbox eigen oracle tolerances must be finite positive values",
            "poisson_airbox_eigen_invalid_tolerance");
    }
    return FrequencyDomainStatus::ok;
}

ComplexDenseMatrix make_complex_from_real(DenseRealMatrixView view)
{
    ComplexDenseMatrix matrix{view.row_count, view.column_count, {}};
    matrix.values.assign(
        static_cast<std::size_t>(view.row_count * view.column_count),
        Complex{});
    for (std::uint64_t index = 0; index < view.row_count * view.column_count; ++index) {
        matrix.values[static_cast<std::size_t>(index)] =
            Complex(view.values_row_major[index], 0.0);
    }
    return matrix;
}

std::vector<Complex> matvec(
    const ComplexDenseMatrix &matrix,
    const std::vector<Complex> &x)
{
    if (matrix.cols != x.size()) {
        return {};
    }
    std::vector<Complex> y(static_cast<std::size_t>(matrix.rows), Complex{});
    for (std::uint64_t row = 0; row < matrix.rows; ++row) {
        Complex value{};
        for (std::uint64_t col = 0; col < matrix.cols; ++col) {
            value += matrix(row, col) * x[static_cast<std::size_t>(col)];
        }
        y[static_cast<std::size_t>(row)] = value;
    }
    return y;
}

double complex_l2_norm(const std::vector<Complex> &x) noexcept
{
    long double sum = 0.0L;
    for (const Complex &value : x) {
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
    std::vector<Complex> difference(actual.size(), Complex{});
    for (std::size_t index = 0; index < actual.size(); ++index) {
        difference[index] = actual[index] - expected[index];
    }
    return complex_l2_norm(difference) /
        std::max(1.0e-300, complex_l2_norm(expected));
}

bool solve_dense_complex_linear_system(
    ComplexDenseMatrix matrix,
    std::vector<Complex> rhs,
    std::vector<Complex> &x,
    double singular_tolerance,
    char error_message[256]) noexcept
{
    const std::uint64_t n = matrix.rows;
    if (matrix.rows != matrix.cols || rhs.size() != n) {
        copy_message(error_message, 256, "dense solve shape mismatch");
        return false;
    }

    for (std::uint64_t pivot_col = 0; pivot_col < n; ++pivot_col) {
        std::uint64_t pivot_row = pivot_col;
        double pivot_abs = std::abs(matrix(pivot_col, pivot_col));
        for (std::uint64_t row = pivot_col + 1; row < n; ++row) {
            const double candidate = std::abs(matrix(row, pivot_col));
            if (candidate > pivot_abs) {
                pivot_abs = candidate;
                pivot_row = row;
            }
        }
        if (!(pivot_abs > singular_tolerance) || !std::isfinite(pivot_abs)) {
            copy_message(error_message, 256, "dense solve singular matrix");
            return false;
        }
        if (pivot_row != pivot_col) {
            for (std::uint64_t col = 0; col < n; ++col) {
                std::swap(matrix(pivot_col, col), matrix(pivot_row, col));
            }
            std::swap(
                rhs[static_cast<std::size_t>(pivot_col)],
                rhs[static_cast<std::size_t>(pivot_row)]);
        }

        const Complex diagonal = matrix(pivot_col, pivot_col);
        for (std::uint64_t col = pivot_col; col < n; ++col) {
            matrix(pivot_col, col) /= diagonal;
        }
        rhs[static_cast<std::size_t>(pivot_col)] /= diagonal;

        for (std::uint64_t row = 0; row < n; ++row) {
            if (row == pivot_col) {
                continue;
            }
            const Complex factor = matrix(row, pivot_col);
            if (std::abs(factor) == 0.0) {
                continue;
            }
            for (std::uint64_t col = pivot_col; col < n; ++col) {
                matrix(row, col) -= factor * matrix(pivot_col, col);
            }
            rhs[static_cast<std::size_t>(row)] -=
                factor * rhs[static_cast<std::size_t>(pivot_col)];
        }
    }
    x = std::move(rhs);
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
        const Complex weight(weights[index], 0.0);
        augmented(index, n) = weight;
        augmented(n, index) = weight;
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
    const std::uint64_t phi_count = a_phiq.rows;
    const std::vector<Complex> phiq = matvec(a_phiq, q);
    if (phiq.size() != phi_count) {
        copy_message(error_message, 256, "A_phiq q shape mismatch");
        return false;
    }
    std::vector<Complex> rhs(static_cast<std::size_t>(phi_count + 1), Complex{});
    for (std::uint64_t index = 0; index < phi_count; ++index) {
        rhs[static_cast<std::size_t>(index)] = -phiq[static_cast<std::size_t>(index)];
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
    phi.assign(solution.begin(), solution.begin() + static_cast<std::ptrdiff_t>(phi_count));
    eta = solution[static_cast<std::size_t>(phi_count)];
    return true;
}

Complex weighted_mean(const std::vector<Complex> &phi, const double *weights)
{
    Complex value{};
    for (std::size_t index = 0; index < phi.size(); ++index) {
        value += weights[index] * phi[index];
    }
    return value;
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

ComplexDenseMatrix build_explicit_schur_by_columns(
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
        if (y.size() != n) {
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
            if (std::abs(a - l) < 1.0e-12 && std::abs(c) < 1.0e-12) {
                vec[index] = {Complex(1.0, 0.0), Complex(0.0, 0.0)};
                norm = 1.0;
            } else {
                return false;
            }
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
        copy_message(error_message, 256, "2x2 positive-frequency eigen solve failed");
        return out;
    }
    int best = -1;
    double best_imag = -std::numeric_limits<double>::infinity();
    for (int index = 0; index < 2; ++index) {
        const double imag = std::imag(lambda[index]);
        if (imag > 0.0 && imag > best_imag) {
            best = index;
            best_imag = imag;
        }
    }
    if (best < 0) {
        copy_message(error_message, 256, "positive-frequency eigen branch not found");
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

FullResidualBreakdown compute_full_descriptor_residual(
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
    FullResidualBreakdown out{};
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

    const double rq = complex_l2_norm(r_q);
    const double rp = complex_l2_norm(r_phi);
    const double rg = std::abs(gauge);
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
    out.relative_phi = std::sqrt(rp * rp + rg * rg) / phi_denom;
    out.gauge_abs = rg;
    out.relative_full = std::sqrt(rq * rq + rp * rp + rg * rg) / (q_denom + phi_denom);
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

std::vector<Complex> load_q_or_default(
    const DenseComplexVectorView &view,
    std::uint64_t q_dof_count)
{
    std::vector<Complex> q(static_cast<std::size_t>(q_dof_count), Complex{});
    if (view.count == q_dof_count && view.real != nullptr) {
        for (std::uint64_t index = 0; index < q_dof_count; ++index) {
            q[static_cast<std::size_t>(index)] = Complex(
                view.real[index],
                view.imag != nullptr ? view.imag[index] : 0.0);
        }
        return q;
    }
    q[0] = Complex(1.0, 0.0);
    return q;
}

} // namespace

FrequencyDomainStatus solve_dense_poisson_airbox_eigen_oracle(
    const DensePoissonAirboxEigenOracleProblem &problem,
    DensePoissonAirboxEigenOracleResult *out_result) noexcept
{
    FrequencyDomainStatus status = validate_problem(problem, out_result);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }

    ComplexDenseMatrix a_qq = make_complex_from_real(problem.A_qq);
    ComplexDenseMatrix a_qphi = make_complex_from_real(problem.A_qphi);
    ComplexDenseMatrix a_phiq = make_complex_from_real(problem.A_phiq);
    ComplexDenseMatrix a_phiphi = make_complex_from_real(problem.A_phiphi);
    ComplexDenseMatrix b_qq = make_complex_from_real(problem.B_qq);
    ComplexDenseMatrix augmented_poisson =
        build_mean_zero_augmented_poisson(a_phiphi, problem.phi_mean_weights);

    out_result->gauge_augmented = true;
    out_result->augmented_phi_dof_count = problem.phi_dof_count + 1;

    std::vector<Complex> q_test = load_q_or_default(problem.test_q, problem.q_dof_count);
    const std::vector<Complex> schur_apply =
        apply_schur(a_qq, a_qphi, augmented_poisson, a_phiq, q_test, out_result->error_message);
    if (schur_apply.size() != problem.q_dof_count) {
        return fail(
            problem,
            out_result,
            FrequencyDomainStatus::operator_error,
            out_result->error_message,
            "poisson_airbox_eigen_schur_apply_failed");
    }
    const ComplexDenseMatrix schur =
        build_explicit_schur_by_columns(a_qq, a_qphi, augmented_poisson, a_phiq, out_result->error_message);
    if (schur.rows != problem.q_dof_count || schur.cols != problem.q_dof_count) {
        return fail(
            problem,
            out_result,
            FrequencyDomainStatus::operator_error,
            out_result->error_message,
            "poisson_airbox_eigen_schur_build_failed");
    }
    const std::vector<Complex> schur_explicit = matvec(schur, q_test);
    out_result->schur_apply_relative_error = relative_error(schur_apply, schur_explicit);
    out_result->schur_certified =
        out_result->schur_apply_relative_error <= problem.relative_tolerance;

    EigenPair2x2 eigen =
        solve_tiny_positive_frequency_eigen(schur, b_qq, out_result->error_message);
    if (!eigen.ok) {
        return fail(
            problem,
            out_result,
            FrequencyDomainStatus::solve_error,
            out_result->error_message,
            "poisson_airbox_eigen_positive_branch_not_found");
    }
    out_result->positive_frequency_branch_found = true;
    out_result->eigenvalue_real = eigen.lambda.real();
    out_result->eigenvalue_imag = eigen.lambda.imag();
    out_result->omega_rad_s = eigen.lambda.imag();
    out_result->frequency_hz = eigen.lambda.imag() / kTwoPi;
    out_result->eigen_residual_relative =
        eigen_residual_relative(schur, b_qq, eigen.lambda, eigen.q);

    std::vector<Complex> phi;
    Complex eta{};
    if (!solve_phi_for_q(augmented_poisson, a_phiq, eigen.q, phi, eta, out_result->error_message)) {
        return fail(
            problem,
            out_result,
            FrequencyDomainStatus::operator_error,
            out_result->error_message,
            "poisson_airbox_eigen_phi_reconstruction_failed");
    }
    FullResidualBreakdown full = compute_full_descriptor_residual(
        a_qq,
        a_qphi,
        a_phiq,
        a_phiphi,
        b_qq,
        problem.phi_mean_weights,
        eigen.lambda,
        eigen.q,
        phi,
        eta);
    out_result->full_residual_reconstruction_relative_error = full.relative_full;
    out_result->poisson_constraint_relative_residual = full.relative_phi;
    out_result->gauge_mean_abs = full.gauge_abs;
    out_result->full_residual_certified =
        full.relative_full <= problem.relative_tolerance &&
        full.relative_phi <= problem.relative_tolerance &&
        full.gauge_abs <= problem.absolute_tolerance;

    if (problem.expected_positive_frequency_hz > 0.0) {
        out_result->relative_frequency_error =
            std::abs(out_result->frequency_hz - problem.expected_positive_frequency_hz) /
            std::max(std::abs(problem.expected_positive_frequency_hz), 1.0e-300);
        out_result->sign_flip_relative_error = out_result->relative_frequency_error;
    }

    const bool frequency_ok =
        problem.expected_positive_frequency_hz <= 0.0 ||
        out_result->relative_frequency_error <= problem.expected_frequency_relative_tolerance;
    const bool all_ok =
        out_result->schur_certified &&
        out_result->full_residual_certified &&
        out_result->eigen_residual_relative <= problem.relative_tolerance &&
        frequency_ok;

    out_result->status = all_ok ? FrequencyDomainStatus::ok : FrequencyDomainStatus::solve_error;
    if (!all_ok) {
        copy_message(
            out_result->error_message,
            sizeof(out_result->error_message),
            "PA-E1 dense Poisson-airbox eigen oracle certification failed");
    }
    write_diagnostics_json(
        problem,
        *out_result,
        all_ok ? "passed" : "failed",
        all_ok ? "" : "poisson_airbox_eigen_certification_failed",
        out_result);
    return out_result->status;
}

} // namespace fullmag::fem::frequency_domain
