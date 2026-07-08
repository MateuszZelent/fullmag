#include "cpu/frequency_domain/modal_response.hpp"

#include "cpu/frequency_domain/engines/sparse_direct/cpu_sparse_direct_engine.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <vector>

namespace fullmag::fem::frequency_domain {

namespace {

constexpr double kTwoPi = 6.283185307179586476925286766559;
constexpr std::uint64_t kMaxValidationTangentDofs = 16;
constexpr std::uint64_t kMaxValidationModes = 16;

void copy_error(ModalResponseValidationResult *result, const char *message) noexcept
{
    if (result == nullptr) {
        return;
    }
    std::strncpy(result->error_message, message, sizeof(result->error_message) - 1);
    result->error_message[sizeof(result->error_message) - 1] = '\0';
}

bool finite_values(const double *values, std::uint64_t count) noexcept
{
    if (values == nullptr) {
        return false;
    }
    for (std::uint64_t index = 0; index < count; ++index) {
        if (!std::isfinite(values[index])) {
            return false;
        }
    }
    return true;
}

FrequencyDomainStatus validate_problem(
    const ModalResponseDiagonalValidationProblem &problem,
    ModalResponseValidationResult *result) noexcept
{
    if (problem.tangent_dof_count == 0 ||
        problem.mode_count == 0 ||
        problem.frequency_count == 0 ||
        problem.tangent_dof_count > kMaxValidationTangentDofs ||
        problem.mode_count > kMaxValidationModes ||
        problem.mode_count > problem.tangent_dof_count ||
        problem.tangent_dof_count >
            std::numeric_limits<std::uint64_t>::max() / problem.frequency_count ||
        problem.tangent_dof_count >
            std::numeric_limits<std::uint64_t>::max() / problem.mode_count) {
        copy_error(result, "modal response validation problem has unsupported dimensions");
        return FrequencyDomainStatus::validation_error;
    }
    const std::uint64_t shape_count = problem.tangent_dof_count * problem.mode_count;
    const std::uint64_t response_count =
        problem.tangent_dof_count * problem.frequency_count;
    if (problem.mode_shape_value_count != shape_count ||
        problem.modal_stiffness_value_count != problem.mode_count ||
        problem.modal_mass_value_count != problem.mode_count ||
        problem.response_capacity < response_count ||
        !finite_values(problem.frequencies_hz, problem.frequency_count) ||
        !finite_values(problem.mode_shapes_row_major, shape_count) ||
        !finite_values(problem.modal_stiffness_diagonal, problem.mode_count) ||
        !finite_values(problem.modal_mass_diagonal, problem.mode_count) ||
        !finite_values(problem.drive_real, problem.tangent_dof_count) ||
        problem.out_response_real == nullptr ||
        problem.out_response_imag == nullptr) {
        copy_error(result, "modal response validation problem has invalid buffers");
        return FrequencyDomainStatus::validation_error;
    }
    if (problem.drive_imag != nullptr &&
        !finite_values(problem.drive_imag, problem.tangent_dof_count)) {
        copy_error(result, "modal response validation problem has non-finite imaginary drive");
        return FrequencyDomainStatus::validation_error;
    }
    if (problem.sparse_direct_sample_frequency_count > 0 &&
        !finite_values(
            problem.sparse_direct_sample_frequencies_hz,
            problem.sparse_direct_sample_frequency_count)) {
        copy_error(result, "modal response validation problem has invalid sparse/direct samples");
        return FrequencyDomainStatus::validation_error;
    }
    return FrequencyDomainStatus::ok;
}

bool frequencies_match(double left, double right) noexcept
{
    const double scale = std::max({1.0, std::abs(left), std::abs(right)});
    return std::abs(left - right) <= 1.0e-12 * scale;
}

} // namespace

FrequencyDomainStatus solve_modal_response_diagonal_validation_problem(
    const ModalResponseDiagonalValidationProblem &problem,
    ModalResponseValidationResult *out_result) noexcept
{
    if (out_result == nullptr) {
        return FrequencyDomainStatus::validation_error;
    }
    *out_result = ModalResponseValidationResult{};
    const FrequencyDomainStatus validation_status = validate_problem(problem, out_result);
    if (validation_status != FrequencyDomainStatus::ok) {
        return validation_status;
    }

    const std::uint64_t n = problem.tangent_dof_count;
    const std::uint64_t mode_count = problem.mode_count;
    std::fill(
        problem.out_response_real,
        problem.out_response_real + problem.response_capacity,
        0.0);
    std::fill(
        problem.out_response_imag,
        problem.out_response_imag + problem.response_capacity,
        0.0);

    std::vector<double> modal_drive_real(static_cast<std::size_t>(mode_count), 0.0);
    std::vector<double> modal_drive_imag(static_cast<std::size_t>(mode_count), 0.0);
    std::vector<double> response_modal_real(static_cast<std::size_t>(mode_count), 0.0);
    std::vector<double> response_modal_imag(static_cast<std::size_t>(mode_count), 0.0);
    std::vector<double> stiffness_matrix(static_cast<std::size_t>(n * n), 0.0);
    std::vector<double> mass_matrix(static_cast<std::size_t>(n * n), 0.0);
    std::vector<double> sparse_response_real(static_cast<std::size_t>(n), 0.0);
    std::vector<double> sparse_response_imag(static_cast<std::size_t>(n), 0.0);
    const double zero_drive_imag[kMaxValidationTangentDofs]{};
    for (std::uint64_t mode = 0; mode < mode_count; ++mode) {
        for (std::uint64_t dof = 0; dof < n; ++dof) {
            const double shape =
                problem.mode_shapes_row_major[dof * mode_count + mode];
            modal_drive_real[static_cast<std::size_t>(mode)] +=
                shape * problem.drive_real[dof];
            modal_drive_imag[static_cast<std::size_t>(mode)] +=
                shape * (problem.drive_imag != nullptr ? problem.drive_imag[dof] : 0.0);
        }
    }
    for (std::uint64_t row = 0; row < n; ++row) {
        for (std::uint64_t column = 0; column < n; ++column) {
            for (std::uint64_t mode = 0; mode < mode_count; ++mode) {
                const double row_shape =
                    problem.mode_shapes_row_major[row * mode_count + mode];
                const double column_shape =
                    problem.mode_shapes_row_major[column * mode_count + mode];
                stiffness_matrix[static_cast<std::size_t>(row * n + column)] +=
                    row_shape * problem.modal_stiffness_diagonal[mode] * column_shape;
                mass_matrix[static_cast<std::size_t>(row * n + column)] +=
                    row_shape * problem.modal_mass_diagonal[mode] * column_shape;
            }
        }
    }

    for (std::uint64_t frequency_index = 0;
         frequency_index < problem.frequency_count;
         ++frequency_index) {
        const double frequency_hz = problem.frequencies_hz[frequency_index];
        if (!(frequency_hz > 0.0) || !std::isfinite(frequency_hz)) {
            copy_error(out_result, "modal response validation problem has invalid frequency");
            return FrequencyDomainStatus::validation_error;
        }
        const double omega = kTwoPi * frequency_hz;
        for (std::uint64_t mode = 0; mode < mode_count; ++mode) {
            const double stiffness = problem.modal_stiffness_diagonal[mode];
            const double omega_mass = omega * problem.modal_mass_diagonal[mode];
            const double denominator =
                stiffness * stiffness + omega_mass * omega_mass;
            if (!(denominator > 0.0) || !std::isfinite(denominator)) {
                copy_error(out_result, "modal response validation problem has singular modal denominator");
                return FrequencyDomainStatus::solve_error;
            }
            const double coefficient_real =
                (stiffness * modal_drive_real[static_cast<std::size_t>(mode)] -
                    omega_mass * modal_drive_imag[static_cast<std::size_t>(mode)]) /
                denominator;
            const double coefficient_imag =
                (omega_mass * modal_drive_real[static_cast<std::size_t>(mode)] +
                    stiffness * modal_drive_imag[static_cast<std::size_t>(mode)]) /
                denominator;
            for (std::uint64_t dof = 0; dof < n; ++dof) {
                const double shape =
                    problem.mode_shapes_row_major[dof * mode_count + mode];
                const std::uint64_t response_index = frequency_index * n + dof;
                problem.out_response_real[response_index] += shape * coefficient_real;
                problem.out_response_imag[response_index] += shape * coefficient_imag;
            }
        }

        double residual_l2_squared = 0.0;
        double rhs_l2_squared = 0.0;
        std::fill(response_modal_real.begin(), response_modal_real.end(), 0.0);
        std::fill(response_modal_imag.begin(), response_modal_imag.end(), 0.0);
        for (std::uint64_t mode = 0; mode < mode_count; ++mode) {
            for (std::uint64_t dof = 0; dof < n; ++dof) {
                const double shape =
                    problem.mode_shapes_row_major[dof * mode_count + mode];
                const std::uint64_t response_index = frequency_index * n + dof;
                response_modal_real[static_cast<std::size_t>(mode)] +=
                    shape * problem.out_response_real[response_index];
                response_modal_imag[static_cast<std::size_t>(mode)] +=
                    shape * problem.out_response_imag[response_index];
            }
        }
        for (std::uint64_t dof = 0; dof < n; ++dof) {
            const std::uint64_t response_index = frequency_index * n + dof;
            const double response_real = problem.out_response_real[response_index];
            const double response_imag = problem.out_response_imag[response_index];
            const double drive_real = problem.drive_real[dof];
            const double drive_imag =
                problem.drive_imag != nullptr ? problem.drive_imag[dof] : 0.0;
            double residual_real = -drive_real;
            double residual_imag = -drive_imag;
            rhs_l2_squared += drive_real * drive_real + drive_imag * drive_imag;
            for (std::uint64_t mode = 0; mode < mode_count; ++mode) {
                const double shape =
                    problem.mode_shapes_row_major[dof * mode_count + mode];
                residual_real +=
                    shape * problem.modal_stiffness_diagonal[mode] *
                        response_modal_real[static_cast<std::size_t>(mode)] +
                    shape * omega * problem.modal_mass_diagonal[mode] *
                        response_modal_imag[static_cast<std::size_t>(mode)];
                residual_imag +=
                    shape * problem.modal_stiffness_diagonal[mode] *
                        response_modal_imag[static_cast<std::size_t>(mode)] -
                    shape * omega * problem.modal_mass_diagonal[mode] *
                        response_modal_real[static_cast<std::size_t>(mode)];
            }
            residual_l2_squared +=
                residual_real * residual_real + residual_imag * residual_imag;
            out_result->max_abs_response = std::max(
                out_result->max_abs_response,
                std::hypot(response_real, response_imag));
        }
        const double residual_l2 = std::sqrt(residual_l2_squared);
        out_result->max_sample_error_l2_norm =
            std::max(out_result->max_sample_error_l2_norm, residual_l2);
        out_result->max_relative_sample_error_l2_norm = std::max(
            out_result->max_relative_sample_error_l2_norm,
            rhs_l2_squared > 0.0 ? residual_l2 / std::sqrt(rhs_l2_squared) : residual_l2);
        bool validate_sparse_direct_sample = false;
        for (std::uint64_t sample_index = 0;
             sample_index < problem.sparse_direct_sample_frequency_count;
             ++sample_index) {
            validate_sparse_direct_sample =
                validate_sparse_direct_sample ||
                frequencies_match(
                    problem.sparse_direct_sample_frequencies_hz[sample_index],
                    frequency_hz);
        }
        if (validate_sparse_direct_sample) {
            CpuSparseDirectSolveResult sparse_result{};
            const FrequencyDomainStatus sparse_status =
                solve_cpu_sparse_direct_real_split(
                    CpuSparseDirectRealSplitProblem{
                        n,
                        frequency_hz,
                        stiffness_matrix.data(),
                        n * n,
                        mass_matrix.data(),
                        n * n,
                        problem.drive_real,
                        n,
                        problem.drive_imag != nullptr ?
                            problem.drive_imag :
                            zero_drive_imag,
                        n,
                        sparse_response_real.data(),
                        sparse_response_imag.data(),
                        n,
                    },
                    &sparse_result);
            if (sparse_status != FrequencyDomainStatus::ok) {
                copy_error(out_result, sparse_result.error_message);
                return sparse_status;
            }
            double sparse_error_l2_squared = 0.0;
            double sparse_l2_squared = 0.0;
            for (std::uint64_t dof = 0; dof < n; ++dof) {
                const std::uint64_t response_index = frequency_index * n + dof;
                const double real_error =
                    problem.out_response_real[response_index] -
                    sparse_response_real[static_cast<std::size_t>(dof)];
                const double imag_error =
                    problem.out_response_imag[response_index] -
                    sparse_response_imag[static_cast<std::size_t>(dof)];
                sparse_error_l2_squared +=
                    real_error * real_error + imag_error * imag_error;
                sparse_l2_squared +=
                    sparse_response_real[static_cast<std::size_t>(dof)] *
                        sparse_response_real[static_cast<std::size_t>(dof)] +
                    sparse_response_imag[static_cast<std::size_t>(dof)] *
                        sparse_response_imag[static_cast<std::size_t>(dof)];
            }
            const double sparse_error_l2 = std::sqrt(sparse_error_l2_squared);
            out_result->max_sparse_direct_sample_error_l2_norm = std::max(
                out_result->max_sparse_direct_sample_error_l2_norm,
                sparse_error_l2);
            out_result->max_sparse_direct_relative_sample_error_l2_norm = std::max(
                out_result->max_sparse_direct_relative_sample_error_l2_norm,
                sparse_l2_squared > 0.0 ?
                    sparse_error_l2 / std::sqrt(sparse_l2_squared) :
                    sparse_error_l2);
            ++out_result->sparse_direct_sample_count;
        }
        ++out_result->completed_frequency_count;
    }
    if (out_result->sparse_direct_sample_count !=
        problem.sparse_direct_sample_frequency_count) {
        copy_error(out_result, "modal response sparse/direct sample was not in frequency sweep");
        return FrequencyDomainStatus::validation_error;
    }
    out_result->mode_count = mode_count;
    return FrequencyDomainStatus::ok;
}

} // namespace fullmag::fem::frequency_domain
