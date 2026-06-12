#include "cpu/frequency_domain/dense_driven_response.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace fullmag::fem::frequency_domain {

namespace {

constexpr std::uint64_t kMaxValidationTangentDofs = 16;
constexpr std::uint64_t kMaxValidationBlockDofs = kMaxValidationTangentDofs * 2;

void copy_error(char out[128], const char *message) noexcept
{
    if (out == nullptr) {
        return;
    }
    std::strncpy(out, message, 127);
    out[127] = '\0';
}

double matrix_value(
    const double *matrix_row_major,
    const double *diagonal,
    std::uint64_t row,
    std::uint64_t column,
    std::uint64_t size) noexcept
{
    if (matrix_row_major != nullptr) {
        return matrix_row_major[row * size + column];
    }
    if (diagonal != nullptr && row == column) {
        return diagonal[row];
    }
    return 0.0;
}

bool swap_rows(
    double matrix[kMaxValidationBlockDofs][kMaxValidationBlockDofs],
    double rhs[kMaxValidationBlockDofs],
    std::uint64_t a,
    std::uint64_t b,
    std::uint64_t size) noexcept
{
    if (a == b) {
        return false;
    }
    for (std::uint64_t column = 0; column < size; ++column) {
        std::swap(matrix[a][column], matrix[b][column]);
    }
    std::swap(rhs[a], rhs[b]);
    return true;
}

FrequencyDomainStatus solve_real_linear_system(
    double matrix[kMaxValidationBlockDofs][kMaxValidationBlockDofs],
    double rhs[kMaxValidationBlockDofs],
    std::uint64_t size,
    char error_message[128]) noexcept
{
    for (std::uint64_t pivot_column = 0; pivot_column < size; ++pivot_column) {
        std::uint64_t pivot_row = pivot_column;
        double pivot_abs = std::abs(matrix[pivot_column][pivot_column]);
        for (std::uint64_t row = pivot_column + 1; row < size; ++row) {
            const double candidate_abs = std::abs(matrix[row][pivot_column]);
            if (candidate_abs > pivot_abs) {
                pivot_abs = candidate_abs;
                pivot_row = row;
            }
        }
        if (!(pivot_abs > 1.0e-14) || !std::isfinite(pivot_abs)) {
            copy_error(error_message, "dense driven response validation matrix is singular");
            return FrequencyDomainStatus::solve_error;
        }
        swap_rows(matrix, rhs, pivot_column, pivot_row, size);

        const double pivot = matrix[pivot_column][pivot_column];
        for (std::uint64_t column = pivot_column; column < size; ++column) {
            matrix[pivot_column][column] /= pivot;
        }
        rhs[pivot_column] /= pivot;

        for (std::uint64_t row = 0; row < size; ++row) {
            if (row == pivot_column) {
                continue;
            }
            const double factor = matrix[row][pivot_column];
            if (factor == 0.0) {
                continue;
            }
            for (std::uint64_t column = pivot_column; column < size; ++column) {
                matrix[row][column] -= factor * matrix[pivot_column][column];
            }
            rhs[row] -= factor * rhs[pivot_column];
        }
    }
    return FrequencyDomainStatus::ok;
}

} // namespace

FrequencyDomainStatus solve_dense_driven_response_validation_problem(
    const DenseDrivenResponseValidationProblem &problem,
    DenseDrivenResponseValidationResult *out_result) noexcept
{
    if (out_result == nullptr) {
        return FrequencyDomainStatus::validation_error;
    }

    *out_result = DenseDrivenResponseValidationResult{};
    const std::uint64_t tangent_dof_count = problem.tangent_dof_count;
    if (tangent_dof_count == 0 || tangent_dof_count > kMaxValidationTangentDofs) {
        copy_error(out_result->error_message, "dense driven response validation problem has unsupported tangent DOF count");
        return FrequencyDomainStatus::validation_error;
    }
    if (problem.frequencies_hz == nullptr ||
        problem.frequency_count == 0 ||
        problem.drive_real == nullptr) {
        copy_error(out_result->error_message, "dense driven response validation problem requires frequencies and drive");
        return FrequencyDomainStatus::validation_error;
    }
    if ((problem.stiffness_matrix_row_major == nullptr && problem.stiffness_diagonal == nullptr) ||
        (problem.mass_matrix_row_major == nullptr && problem.mass_diagonal == nullptr)) {
        copy_error(out_result->error_message, "dense driven response validation problem requires stiffness and mass operators");
        return FrequencyDomainStatus::validation_error;
    }
    if ((problem.out_response_real != nullptr || problem.out_response_imag != nullptr) &&
        (problem.out_response_real == nullptr ||
            problem.out_response_imag == nullptr ||
            problem.response_capacity < tangent_dof_count * problem.frequency_count)) {
        copy_error(out_result->error_message, "dense driven response validation problem has invalid response output buffers");
        return FrequencyDomainStatus::validation_error;
    }
    if ((problem.out_residual_l2_norm != nullptr || problem.out_relative_residual_l2_norm != nullptr) &&
        (problem.out_residual_l2_norm == nullptr ||
            problem.out_relative_residual_l2_norm == nullptr ||
            problem.residual_capacity < problem.frequency_count)) {
        copy_error(out_result->error_message, "dense driven response validation problem has invalid residual output buffers");
        return FrequencyDomainStatus::validation_error;
    }
    if (problem.out_response_real != nullptr) {
        std::fill(problem.out_response_real, problem.out_response_real + problem.response_capacity, 0.0);
        std::fill(problem.out_response_imag, problem.out_response_imag + problem.response_capacity, 0.0);
        out_result->response_dof_count = tangent_dof_count;
    }
    if (problem.out_residual_l2_norm != nullptr) {
        std::fill(problem.out_residual_l2_norm, problem.out_residual_l2_norm + problem.residual_capacity, 0.0);
        std::fill(
            problem.out_relative_residual_l2_norm,
            problem.out_relative_residual_l2_norm + problem.residual_capacity,
            0.0);
    }

    constexpr double two_pi = 6.28318530717958647692;
    const std::uint64_t block_size = tangent_dof_count * 2;
    for (std::uint64_t frequency_index = 0; frequency_index < problem.frequency_count; ++frequency_index) {
        if (problem.cancel_requested != nullptr &&
            problem.cancel_requested(problem.cancel_user_data)) {
            copy_error(out_result->error_message, "dense driven response validation was interrupted");
            return FrequencyDomainStatus::interrupted;
        }
        const double frequency_hz = problem.frequencies_hz[frequency_index];
        const double omega = two_pi * frequency_hz;
        if (!(frequency_hz > 0.0) || !std::isfinite(frequency_hz)) {
            copy_error(out_result->error_message, "dense driven response validation problem has invalid frequency");
            return FrequencyDomainStatus::validation_error;
        }

        double block_matrix[kMaxValidationBlockDofs][kMaxValidationBlockDofs]{};
        double rhs[kMaxValidationBlockDofs]{};
        for (std::uint64_t row = 0; row < tangent_dof_count; ++row) {
            const double drive = problem.drive_real[row];
            if (!std::isfinite(drive)) {
                copy_error(out_result->error_message, "dense driven response validation problem has non-finite drive");
                return FrequencyDomainStatus::validation_error;
            }
            rhs[row] = drive;
            rhs[row + tangent_dof_count] = 0.0;
            for (std::uint64_t column = 0; column < tangent_dof_count; ++column) {
                const double stiffness = matrix_value(
                    problem.stiffness_matrix_row_major,
                    problem.stiffness_diagonal,
                    row,
                    column,
                    tangent_dof_count);
                const double mass = matrix_value(
                    problem.mass_matrix_row_major,
                    problem.mass_diagonal,
                    row,
                    column,
                    tangent_dof_count);
                if (!std::isfinite(stiffness) || !std::isfinite(mass)) {
                    copy_error(out_result->error_message, "dense driven response validation problem has non-finite operator values");
                    return FrequencyDomainStatus::validation_error;
                }
                block_matrix[row][column] = stiffness;
                block_matrix[row][column + tangent_dof_count] = omega * mass;
                block_matrix[row + tangent_dof_count][column] = -omega * mass;
                block_matrix[row + tangent_dof_count][column + tangent_dof_count] = stiffness;
            }
        }

        const FrequencyDomainStatus solve_status = solve_real_linear_system(
            block_matrix,
            rhs,
            block_size,
            out_result->error_message);
        if (solve_status != FrequencyDomainStatus::ok) {
            return solve_status;
        }

        for (std::uint64_t dof = 0; dof < tangent_dof_count; ++dof) {
            const double real_part = rhs[dof];
            const double imag_part = rhs[dof + tangent_dof_count];
            if (problem.out_response_real != nullptr) {
                const std::uint64_t response_index = frequency_index * tangent_dof_count + dof;
                problem.out_response_real[response_index] = real_part;
                problem.out_response_imag[response_index] = imag_part;
            }
            out_result->max_abs_response = std::max(
                out_result->max_abs_response,
                std::hypot(real_part, imag_part));
        }
        double residual_l2_squared = 0.0;
        double rhs_l2_squared = 0.0;
        for (std::uint64_t row = 0; row < tangent_dof_count; ++row) {
            double residual_real = -problem.drive_real[row];
            double residual_imag = 0.0;
            rhs_l2_squared += problem.drive_real[row] * problem.drive_real[row];
            for (std::uint64_t column = 0; column < tangent_dof_count; ++column) {
                const double stiffness = matrix_value(
                    problem.stiffness_matrix_row_major,
                    problem.stiffness_diagonal,
                    row,
                    column,
                    tangent_dof_count);
                const double mass = matrix_value(
                    problem.mass_matrix_row_major,
                    problem.mass_diagonal,
                    row,
                    column,
                    tangent_dof_count);
                const double solution_real = rhs[column];
                const double solution_imag = rhs[column + tangent_dof_count];
                residual_real += stiffness * solution_real + omega * mass * solution_imag;
                residual_imag += stiffness * solution_imag - omega * mass * solution_real;
            }
            residual_l2_squared += residual_real * residual_real + residual_imag * residual_imag;
        }
        const double residual_l2 = std::sqrt(residual_l2_squared);
        const double relative_residual_l2 = rhs_l2_squared > 0.0 ?
            residual_l2 / std::sqrt(rhs_l2_squared) :
            residual_l2;
        if (problem.out_residual_l2_norm != nullptr) {
            problem.out_residual_l2_norm[frequency_index] = residual_l2;
            problem.out_relative_residual_l2_norm[frequency_index] = relative_residual_l2;
        }
        out_result->residual_l2_norm = std::max(out_result->residual_l2_norm, residual_l2);
        out_result->relative_residual_l2_norm = std::max(
            out_result->relative_residual_l2_norm,
            relative_residual_l2);
        out_result->max_frequency_hz = std::max(out_result->max_frequency_hz, frequency_hz);
        ++out_result->completed_frequency_count;
        out_result->response_frequency_count = out_result->completed_frequency_count;
    }

    return FrequencyDomainStatus::ok;
}

} // namespace fullmag::fem::frequency_domain
