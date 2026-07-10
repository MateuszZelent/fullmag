#include "cpu/frequency_domain/contour_interval_solver.hpp"
#include "frequency_domain/mode_kinematics.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <complex>
#include <cstdio>
#include <limits>

namespace fullmag::fem::frequency_domain {

namespace {

constexpr double kPi = 3.14159265358979323846264338327950288;
constexpr double kTwoPi = 2.0 * kPi;

std::string format_double(double value)
{
    char buffer[64]{};
    const int written = std::snprintf(buffer, sizeof(buffer), "%.17g", value);
    if (written <= 0 || static_cast<std::size_t>(written) >= sizeof(buffer)) {
        return "0";
    }
    return buffer;
}

double relative_frequency_width(double frequency_min_hz, double frequency_max_hz) noexcept
{
    if (!std::isfinite(frequency_min_hz) ||
        !std::isfinite(frequency_max_hz) ||
        !(frequency_min_hz < frequency_max_hz)) {
        return 0.0;
    }
    const double width = frequency_max_hz - frequency_min_hz;
    const double denominator = frequency_min_hz > 0.0 ? frequency_min_hz : width;
    return denominator > 0.0 ? width / denominator : 0.0;
}

std::complex<double> determinant_zb_minus_a(
    std::complex<double> z,
    const double stiffness[4],
    const double gyrotropic_mass[4]) noexcept
{
    const std::complex<double> m00 = z * gyrotropic_mass[0] - stiffness[0];
    const std::complex<double> m01 = z * gyrotropic_mass[1] - stiffness[1];
    const std::complex<double> m10 = z * gyrotropic_mass[2] - stiffness[2];
    const std::complex<double> m11 = z * gyrotropic_mass[3] - stiffness[3];
    return m00 * m11 - m01 * m10;
}

int contour_winding_count(
    const ContourQuadrature &quadrature,
    const double stiffness[4],
    const double gyrotropic_mass[4]) noexcept
{
    if (quadrature.points.empty()) {
        return 0;
    }
    double total_angle = 0.0;
    double previous_angle = std::arg(determinant_zb_minus_a(
        quadrature.points.front().lambda,
        stiffness,
        gyrotropic_mass));
    for (std::size_t i = 1; i <= quadrature.points.size(); ++i) {
        const std::complex<double> det = determinant_zb_minus_a(
            quadrature.points[i % quadrature.points.size()].lambda,
            stiffness,
            gyrotropic_mass);
        double angle = std::arg(det);
        double delta = angle - previous_angle;
        while (delta > kPi) {
            delta -= kTwoPi;
        }
        while (delta < -kPi) {
            delta += kTwoPi;
        }
        total_angle += delta;
        previous_angle = angle;
    }
    return static_cast<int>(std::llround(std::abs(total_angle) / kTwoPi));
}

double complex_vector_norm2(const std::complex<double> v[2]) noexcept
{
    return std::sqrt(std::norm(v[0]) + std::norm(v[1]));
}

bool invert_shifted_pencil(
    std::complex<double> z,
    const double stiffness[4],
    const double gyrotropic_mass[4],
    std::complex<double> inverse[4]) noexcept
{
    const std::complex<double> matrix[4] = {
        z * gyrotropic_mass[0] - stiffness[0],
        z * gyrotropic_mass[1] - stiffness[1],
        z * gyrotropic_mass[2] - stiffness[2],
        z * gyrotropic_mass[3] - stiffness[3],
    };
    const std::complex<double> det =
        matrix[0] * matrix[3] - matrix[1] * matrix[2];
    if (!std::isfinite(det.real()) ||
        !std::isfinite(det.imag()) ||
        std::abs(det) <= 1.0e-24) {
        return false;
    }
    inverse[0] = matrix[3] / det;
    inverse[1] = -matrix[1] / det;
    inverse[2] = -matrix[2] / det;
    inverse[3] = matrix[0] / det;
    return true;
}

bool build_contour_projection_matrix(
    const ContourQuadrature &quadrature,
    const double stiffness[4],
    const double gyrotropic_mass[4],
    std::complex<double> projection[4]) noexcept
{
    projection[0] = {};
    projection[1] = {};
    projection[2] = {};
    projection[3] = {};
    for (const ContourPoint &point : quadrature.points) {
        std::complex<double> inverse[4]{};
        if (!invert_shifted_pencil(
                point.lambda,
                stiffness,
                gyrotropic_mass,
                inverse)) {
            return false;
        }
        const std::complex<double> inverse_times_mass[4] = {
            inverse[0] * gyrotropic_mass[0] + inverse[1] * gyrotropic_mass[2],
            inverse[0] * gyrotropic_mass[1] + inverse[1] * gyrotropic_mass[3],
            inverse[2] * gyrotropic_mass[0] + inverse[3] * gyrotropic_mass[2],
            inverse[2] * gyrotropic_mass[1] + inverse[3] * gyrotropic_mass[3],
        };
        for (int i = 0; i < 4; ++i) {
            projection[i] += point.weight * inverse_times_mass[i];
        }
    }
    return true;
}

int complex_matrix_rank2(const std::complex<double> matrix[4]) noexcept
{
    const double h00 = std::norm(matrix[0]) + std::norm(matrix[2]);
    const double h11 = std::norm(matrix[1]) + std::norm(matrix[3]);
    const std::complex<double> h01 =
        std::conj(matrix[0]) * matrix[1] +
        std::conj(matrix[2]) * matrix[3];
    const double trace = h00 + h11;
    const double det = h00 * h11 - std::norm(h01);
    const double discriminant =
        std::max(0.0, trace * trace - 4.0 * det);
    const double root = std::sqrt(discriminant);
    const double singular0 =
        std::sqrt(std::max(0.0, 0.5 * (trace + root)));
    const double singular1 =
        std::sqrt(std::max(0.0, 0.5 * (trace - root)));
    const double threshold = std::max(1.0e-10, singular0 * 1.0e-8);
    int rank = 0;
    if (singular0 > threshold) {
        ++rank;
    }
    if (singular1 > threshold) {
        ++rank;
    }
    return rank;
}

bool solve_projected_tiny_modes(
    const double stiffness[4],
    const double gyrotropic_mass[4],
    const std::complex<double> projection[4],
    int global_dof_count,
    int global_dof_offset,
    double frequency_min_hz,
    double frequency_max_hz,
    double residual_tolerance,
    std::vector<ContourIntervalMode> &modes)
{
    std::vector<std::array<std::complex<double>, 2>> basis;
    basis.reserve(2);
    for (int column = 0; column < 2; ++column) {
        std::complex<double> vector[2] = {
            projection[column],
            projection[2 + column],
        };
        for (const std::array<std::complex<double>, 2> &accepted : basis) {
            const std::complex<double> overlap =
                std::conj(accepted[0]) * vector[0] +
                std::conj(accepted[1]) * vector[1];
            vector[0] -= overlap * accepted[0];
            vector[1] -= overlap * accepted[1];
        }
        const double norm = complex_vector_norm2(vector);
        if (!(norm > 1.0e-10) || !std::isfinite(norm)) {
            continue;
        }
        basis.push_back({vector[0] / norm, vector[1] / norm});
    }

    for (const std::array<std::complex<double>, 2> &basis_vector : basis) {
        std::complex<double> eigenvector[2] = {
            basis_vector[0],
            basis_vector[1],
        };
        const std::complex<double> k_phi[2] = {
            stiffness[0] * eigenvector[0] + stiffness[1] * eigenvector[1],
            stiffness[2] * eigenvector[0] + stiffness[3] * eigenvector[1],
        };
        const std::complex<double> g_phi[2] = {
            gyrotropic_mass[0] * eigenvector[0] + gyrotropic_mass[1] * eigenvector[1],
            gyrotropic_mass[2] * eigenvector[0] + gyrotropic_mass[3] * eigenvector[1],
        };
        const std::complex<double> denominator =
            std::conj(g_phi[0]) * g_phi[0] +
            std::conj(g_phi[1]) * g_phi[1];
        if (!std::isfinite(denominator.real()) ||
            !std::isfinite(denominator.imag()) ||
            std::abs(denominator) <= 1.0e-24) {
            continue;
        }
        const std::complex<double> numerator =
            std::conj(g_phi[0]) * k_phi[0] +
            std::conj(g_phi[1]) * k_phi[1];
        const std::complex<double> lambda_candidate =
            numerator / denominator;
        const ModeKinematics kinematics = map_eigenvalue(
            {lambda_candidate.real(), lambda_candidate.imag()},
            FrequencyDomainPhaseConvention::exp_i_omega_t);
        if (!select_positive_frequency_mode(
                kinematics,
                ZeroFrequencyModePolicy::exclude)) {
            continue;
        }
        if (kinematics.frequency_hz < frequency_min_hz ||
            kinematics.frequency_hz > frequency_max_hz) {
            continue;
        }

        const std::complex<double> residual[2] = {
            k_phi[0] - lambda_candidate * g_phi[0],
            k_phi[1] - lambda_candidate * g_phi[1],
        };
        const double residual_norm = complex_vector_norm2(residual);
        const double denom =
            complex_vector_norm2(k_phi) +
            std::abs(lambda_candidate) * complex_vector_norm2(g_phi);
        const double relative_residual =
            denom > 0.0 ? residual_norm / denom : std::numeric_limits<double>::infinity();
        if (!(relative_residual <= residual_tolerance)) {
            continue;
        }

        ContourIntervalMode mode{};
        mode.frequency_hz = kinematics.frequency_hz;
        mode.omega_rad_s = kinematics.omega_rad_s;
        mode.eigenvalue = lambda_candidate;
        mode.mode[0] = eigenvector[0];
        mode.mode[1] = eigenvector[1];
        mode.mode_vector.assign(static_cast<std::size_t>(global_dof_count), {});
        mode.mode_vector[static_cast<std::size_t>(global_dof_offset)] = eigenvector[0];
        mode.mode_vector[static_cast<std::size_t>(global_dof_offset + 1)] = eigenvector[1];
        mode.relative_residual = relative_residual;
        modes.push_back(mode);
    }

    std::sort(
        modes.begin(),
        modes.end(),
        [](const ContourIntervalMode &lhs, const ContourIntervalMode &rhs) {
            return lhs.frequency_hz < rhs.frequency_hz;
        });
    return true;
}

bool load_block(
    const double *matrix,
    int size,
    int block_index,
    double block[4]) noexcept
{
    const int offset = 2 * block_index;
    block[0] = matrix[offset * size + offset];
    block[1] = matrix[offset * size + offset + 1];
    block[2] = matrix[(offset + 1) * size + offset];
    block[3] = matrix[(offset + 1) * size + offset + 1];
    for (int i = 0; i < 4; ++i) {
        if (!std::isfinite(block[i])) {
            return false;
        }
    }
    return true;
}

bool is_block_diagonal_two_by_two_payload(
    int size,
    const double *stiffness,
    const double *gyrotropic_mass) noexcept
{
    if (size <= 0 || size % 2 != 0) {
        return false;
    }
    constexpr double kTolerance = 1.0e-12;
    for (int row = 0; row < size; ++row) {
        for (int col = 0; col < size; ++col) {
            const bool same_block = (row / 2) == (col / 2);
            const double stiffness_value = stiffness[row * size + col];
            const double gyrotropic_value = gyrotropic_mass[row * size + col];
            if (!std::isfinite(stiffness_value) || !std::isfinite(gyrotropic_value)) {
                return false;
            }
            if (!same_block &&
                (std::abs(stiffness_value) > kTolerance ||
                 std::abs(gyrotropic_value) > kTolerance)) {
                return false;
            }
        }
    }
    return true;
}

int contour_winding_count_block_diagonal(
    const ContourQuadrature &quadrature,
    int size,
    const double *stiffness,
    const double *gyrotropic_mass) noexcept
{
    int count = 0;
    const int block_count = size / 2;
    for (int block_index = 0; block_index < block_count; ++block_index) {
        double stiffness_block[4]{};
        double gyrotropic_block[4]{};
        if (!load_block(stiffness, size, block_index, stiffness_block) ||
            !load_block(gyrotropic_mass, size, block_index, gyrotropic_block)) {
            return 0;
        }
        count += contour_winding_count(
            quadrature,
            stiffness_block,
            gyrotropic_block);
    }
    return count;
}

bool all_block_shifted_pencils_invertible(
    std::complex<double> lambda,
    int size,
    const double *stiffness,
    const double *gyrotropic_mass) noexcept
{
    const int block_count = size / 2;
    for (int block_index = 0; block_index < block_count; ++block_index) {
        double stiffness_block[4]{};
        double gyrotropic_block[4]{};
        std::complex<double> inverse[4]{};
        if (!load_block(stiffness, size, block_index, stiffness_block) ||
            !load_block(gyrotropic_mass, size, block_index, gyrotropic_block) ||
            !invert_shifted_pencil(
                lambda,
                stiffness_block,
                gyrotropic_block,
                inverse)) {
            return false;
        }
    }
    return true;
}

bool solve_block_diagonal_projected_modes(
    const ContourQuadrature &quadrature,
    int size,
    const double *stiffness,
    const double *gyrotropic_mass,
    double frequency_min_hz,
    double frequency_max_hz,
    double residual_tolerance,
    ContourIntervalSolveResult &result)
{
    result.projection_rank = 0;
    result.projection_matrix_row_major[0] = {};
    result.projection_matrix_row_major[1] = {};
    result.projection_matrix_row_major[2] = {};
    result.projection_matrix_row_major[3] = {};

    const int block_count = size / 2;
    for (int block_index = 0; block_index < block_count; ++block_index) {
        double stiffness_block[4]{};
        double gyrotropic_block[4]{};
        std::complex<double> projection[4]{};
        if (!load_block(stiffness, size, block_index, stiffness_block) ||
            !load_block(gyrotropic_mass, size, block_index, gyrotropic_block) ||
            !build_contour_projection_matrix(
                quadrature,
                stiffness_block,
                gyrotropic_block,
                projection)) {
            return false;
        }
        result.projection_rank += complex_matrix_rank2(projection);
        if (size == 2) {
            for (int i = 0; i < 4; ++i) {
                result.projection_matrix_row_major[i] = projection[i];
            }
        }
        if (!solve_projected_tiny_modes(
                stiffness_block,
                gyrotropic_block,
                projection,
                size,
                2 * block_index,
                frequency_min_hz,
                frequency_max_hz,
                residual_tolerance,
                result.modes)) {
            return false;
        }
    }
    return true;
}

bool solve_complex_linear_system(
    std::vector<std::complex<double>> matrix,
    std::vector<std::complex<double>> rhs,
    int size,
    std::vector<std::complex<double>> &solution) noexcept
{
    solution.assign(static_cast<std::size_t>(size), {});
    if (size <= 0 ||
        matrix.size() != static_cast<std::size_t>(size * size) ||
        rhs.size() != static_cast<std::size_t>(size)) {
        return false;
    }
    constexpr double kPivotTolerance = 1.0e-24;
    for (int column = 0; column < size; ++column) {
        int pivot = column;
        double pivot_abs = std::abs(matrix[static_cast<std::size_t>(column * size + column)]);
        for (int row = column + 1; row < size; ++row) {
            const double candidate =
                std::abs(matrix[static_cast<std::size_t>(row * size + column)]);
            if (candidate > pivot_abs) {
                pivot_abs = candidate;
                pivot = row;
            }
        }
        if (!std::isfinite(pivot_abs) || pivot_abs <= kPivotTolerance) {
            return false;
        }
        if (pivot != column) {
            for (int col = column; col < size; ++col) {
                std::swap(
                    matrix[static_cast<std::size_t>(column * size + col)],
                    matrix[static_cast<std::size_t>(pivot * size + col)]);
            }
            std::swap(
                rhs[static_cast<std::size_t>(column)],
                rhs[static_cast<std::size_t>(pivot)]);
        }
        const std::complex<double> diagonal =
            matrix[static_cast<std::size_t>(column * size + column)];
        for (int row = column + 1; row < size; ++row) {
            const std::complex<double> factor =
                matrix[static_cast<std::size_t>(row * size + column)] / diagonal;
            matrix[static_cast<std::size_t>(row * size + column)] = {};
            for (int col = column + 1; col < size; ++col) {
                matrix[static_cast<std::size_t>(row * size + col)] -=
                    factor * matrix[static_cast<std::size_t>(column * size + col)];
            }
            rhs[static_cast<std::size_t>(row)] -= factor * rhs[static_cast<std::size_t>(column)];
        }
    }
    for (int row = size - 1; row >= 0; --row) {
        std::complex<double> sum = rhs[static_cast<std::size_t>(row)];
        for (int col = row + 1; col < size; ++col) {
            sum -= matrix[static_cast<std::size_t>(row * size + col)] *
                solution[static_cast<std::size_t>(col)];
        }
        const std::complex<double> diagonal =
            matrix[static_cast<std::size_t>(row * size + row)];
        if (std::abs(diagonal) <= kPivotTolerance) {
            return false;
        }
        solution[static_cast<std::size_t>(row)] = sum / diagonal;
    }
    for (const std::complex<double> &value : solution) {
        if (!std::isfinite(value.real()) || !std::isfinite(value.imag())) {
            return false;
        }
    }
    return true;
}

bool invert_shifted_pencil_dense(
    std::complex<double> lambda,
    int size,
    const double *stiffness,
    const double *gyrotropic_mass,
    std::vector<std::complex<double>> &inverse) noexcept
{
    inverse.assign(static_cast<std::size_t>(size * size), {});
    std::vector<std::complex<double>> matrix(static_cast<std::size_t>(size * size));
    for (int row = 0; row < size; ++row) {
        for (int col = 0; col < size; ++col) {
            const double stiffness_value = stiffness[row * size + col];
            const double gyrotropic_value = gyrotropic_mass[row * size + col];
            if (!std::isfinite(stiffness_value) || !std::isfinite(gyrotropic_value)) {
                return false;
            }
            matrix[static_cast<std::size_t>(row * size + col)] =
                lambda * gyrotropic_value - stiffness_value;
        }
    }
    for (int column = 0; column < size; ++column) {
        std::vector<std::complex<double>> rhs(
            static_cast<std::size_t>(size),
            std::complex<double>{});
        rhs[static_cast<std::size_t>(column)] = 1.0;
        std::vector<std::complex<double>> solution;
        if (!solve_complex_linear_system(matrix, rhs, size, solution)) {
            return false;
        }
        for (int row = 0; row < size; ++row) {
            inverse[static_cast<std::size_t>(row * size + column)] =
                solution[static_cast<std::size_t>(row)];
        }
    }
    return true;
}

bool build_dense_contour_projection_matrix(
    const ContourQuadrature &quadrature,
    int size,
    const double *stiffness,
    const double *gyrotropic_mass,
    std::vector<std::complex<double>> &projection) noexcept
{
    projection.assign(static_cast<std::size_t>(size * size), {});
    std::vector<std::complex<double>> inverse;
    for (const ContourPoint &point : quadrature.points) {
        if (!invert_shifted_pencil_dense(
                point.lambda,
                size,
                stiffness,
                gyrotropic_mass,
                inverse)) {
            return false;
        }
        for (int row = 0; row < size; ++row) {
            for (int col = 0; col < size; ++col) {
                std::complex<double> value{};
                for (int inner = 0; inner < size; ++inner) {
                    value += inverse[static_cast<std::size_t>(row * size + inner)] *
                        gyrotropic_mass[inner * size + col];
                }
                projection[static_cast<std::size_t>(row * size + col)] +=
                    point.weight * value;
            }
        }
    }
    return true;
}

double complex_column_norm(
    const std::vector<std::complex<double>> &column) noexcept
{
    double norm_squared = 0.0;
    for (const std::complex<double> &value : column) {
        norm_squared += std::norm(value);
    }
    return std::sqrt(norm_squared);
}

std::complex<double> complex_dot(
    const std::vector<std::complex<double>> &lhs,
    const std::vector<std::complex<double>> &rhs) noexcept
{
    std::complex<double> value{};
    for (std::size_t index = 0; index < lhs.size(); ++index) {
        value += std::conj(lhs[index]) * rhs[index];
    }
    return value;
}

bool orthonormal_basis_from_projection(
    const std::vector<std::complex<double>> &projection,
    int size,
    std::vector<std::complex<double>> &basis,
    int &rank) noexcept
{
    basis.clear();
    rank = 0;
    double max_column_norm = 0.0;
    for (int column = 0; column < size; ++column) {
        std::vector<std::complex<double>> vector(static_cast<std::size_t>(size));
        for (int row = 0; row < size; ++row) {
            vector[static_cast<std::size_t>(row)] =
                projection[static_cast<std::size_t>(row * size + column)];
        }
        max_column_norm = std::max(max_column_norm, complex_column_norm(vector));
    }
    const double threshold = std::max(1.0e-10, max_column_norm * 1.0e-8);
    for (int column = 0; column < size; ++column) {
        std::vector<std::complex<double>> vector(static_cast<std::size_t>(size));
        for (int row = 0; row < size; ++row) {
            vector[static_cast<std::size_t>(row)] =
                projection[static_cast<std::size_t>(row * size + column)];
        }
        for (int accepted = 0; accepted < rank; ++accepted) {
            std::vector<std::complex<double>> accepted_vector(static_cast<std::size_t>(size));
            for (int row = 0; row < size; ++row) {
                accepted_vector[static_cast<std::size_t>(row)] =
                    basis[static_cast<std::size_t>(row * size + accepted)];
            }
            const std::complex<double> overlap = complex_dot(accepted_vector, vector);
            for (int row = 0; row < size; ++row) {
                vector[static_cast<std::size_t>(row)] -=
                    overlap * accepted_vector[static_cast<std::size_t>(row)];
            }
        }
        const double norm = complex_column_norm(vector);
        if (!(norm > threshold) || !std::isfinite(norm)) {
            continue;
        }
        const int new_rank = rank + 1;
        basis.resize(static_cast<std::size_t>(size * new_rank));
        for (int previous = new_rank - 2; previous >= 0; --previous) {
            for (int row = 0; row < size; ++row) {
                basis[static_cast<std::size_t>(row * new_rank + previous)] =
                    basis[static_cast<std::size_t>(row * rank + previous)];
            }
        }
        for (int row = 0; row < size; ++row) {
            basis[static_cast<std::size_t>(row * new_rank + rank)] =
                vector[static_cast<std::size_t>(row)] / norm;
        }
        rank = new_rank;
    }
    return rank > 0;
}

bool build_standard_operator_from_pencil(
    int size,
    const double *stiffness,
    const double *gyrotropic_mass,
    std::vector<std::complex<double>> &operator_matrix) noexcept
{
    operator_matrix.assign(static_cast<std::size_t>(size * size), {});
    std::vector<std::complex<double>> gyrotropic(static_cast<std::size_t>(size * size));
    for (int row = 0; row < size; ++row) {
        for (int col = 0; col < size; ++col) {
            gyrotropic[static_cast<std::size_t>(row * size + col)] =
                gyrotropic_mass[row * size + col];
        }
    }
    for (int column = 0; column < size; ++column) {
        std::vector<std::complex<double>> rhs(static_cast<std::size_t>(size));
        for (int row = 0; row < size; ++row) {
            rhs[static_cast<std::size_t>(row)] = stiffness[row * size + column];
        }
        std::vector<std::complex<double>> solution;
        if (!solve_complex_linear_system(gyrotropic, rhs, size, solution)) {
            return false;
        }
        for (int row = 0; row < size; ++row) {
            operator_matrix[static_cast<std::size_t>(row * size + column)] =
                solution[static_cast<std::size_t>(row)];
        }
    }
    return true;
}

std::vector<std::complex<double>> project_operator_to_basis(
    const std::vector<std::complex<double>> &operator_matrix,
    const std::vector<std::complex<double>> &basis,
    int size,
    int rank)
{
    std::vector<std::complex<double>> projected(
        static_cast<std::size_t>(rank * rank),
        std::complex<double>{});
    for (int row_basis = 0; row_basis < rank; ++row_basis) {
        for (int col_basis = 0; col_basis < rank; ++col_basis) {
            std::complex<double> value{};
            for (int row = 0; row < size; ++row) {
                std::complex<double> applied{};
                for (int col = 0; col < size; ++col) {
                    applied += operator_matrix[static_cast<std::size_t>(row * size + col)] *
                        basis[static_cast<std::size_t>(col * rank + col_basis)];
                }
                value += std::conj(basis[static_cast<std::size_t>(row * rank + row_basis)]) *
                    applied;
            }
            projected[static_cast<std::size_t>(row_basis * rank + col_basis)] = value;
        }
    }
    return projected;
}

void qr_decompose_complex(
    const std::vector<std::complex<double>> &matrix,
    int size,
    std::vector<std::complex<double>> &q,
    std::vector<std::complex<double>> &r)
{
    q.assign(static_cast<std::size_t>(size * size), {});
    r.assign(static_cast<std::size_t>(size * size), {});
    for (int column = 0; column < size; ++column) {
        std::vector<std::complex<double>> vector(static_cast<std::size_t>(size));
        for (int row = 0; row < size; ++row) {
            vector[static_cast<std::size_t>(row)] =
                matrix[static_cast<std::size_t>(row * size + column)];
        }
        for (int previous = 0; previous < column; ++previous) {
            std::vector<std::complex<double>> q_column(static_cast<std::size_t>(size));
            for (int row = 0; row < size; ++row) {
                q_column[static_cast<std::size_t>(row)] =
                    q[static_cast<std::size_t>(row * size + previous)];
            }
            const std::complex<double> coefficient = complex_dot(q_column, vector);
            r[static_cast<std::size_t>(previous * size + column)] = coefficient;
            for (int row = 0; row < size; ++row) {
                vector[static_cast<std::size_t>(row)] -=
                    coefficient * q_column[static_cast<std::size_t>(row)];
            }
        }
        const double norm = complex_column_norm(vector);
        r[static_cast<std::size_t>(column * size + column)] = norm;
        if (!(norm > 1.0e-24) || !std::isfinite(norm)) {
            q[static_cast<std::size_t>(column * size + column)] = 1.0;
            continue;
        }
        for (int row = 0; row < size; ++row) {
            q[static_cast<std::size_t>(row * size + column)] =
                vector[static_cast<std::size_t>(row)] / norm;
        }
    }
}

std::vector<std::complex<double>> multiply_complex_matrices(
    const std::vector<std::complex<double>> &lhs,
    const std::vector<std::complex<double>> &rhs,
    int size)
{
    std::vector<std::complex<double>> product(
        static_cast<std::size_t>(size * size),
        std::complex<double>{});
    for (int row = 0; row < size; ++row) {
        for (int col = 0; col < size; ++col) {
            std::complex<double> value{};
            for (int inner = 0; inner < size; ++inner) {
                value += lhs[static_cast<std::size_t>(row * size + inner)] *
                    rhs[static_cast<std::size_t>(inner * size + col)];
            }
            product[static_cast<std::size_t>(row * size + col)] = value;
        }
    }
    return product;
}

bool qr_eigenvalues_complex(
    const std::vector<std::complex<double>> &matrix,
    int size,
    std::vector<std::complex<double>> &eigenvalues) noexcept
{
    std::vector<std::complex<double>> current = matrix;
    for (int iteration = 0; iteration < 512; ++iteration) {
        const std::complex<double> shift =
            current[static_cast<std::size_t>((size - 1) * size + (size - 1))];
        std::vector<std::complex<double>> shifted = current;
        for (int index = 0; index < size; ++index) {
            shifted[static_cast<std::size_t>(index * size + index)] -= shift;
        }
        std::vector<std::complex<double>> q;
        std::vector<std::complex<double>> r;
        qr_decompose_complex(shifted, size, q, r);
        current = multiply_complex_matrices(r, q, size);
        for (int index = 0; index < size; ++index) {
            current[static_cast<std::size_t>(index * size + index)] += shift;
        }
    }
    eigenvalues.resize(static_cast<std::size_t>(size));
    for (int index = 0; index < size; ++index) {
        const std::complex<double> value =
            current[static_cast<std::size_t>(index * size + index)];
        if (!std::isfinite(value.real()) || !std::isfinite(value.imag())) {
            return false;
        }
        eigenvalues[static_cast<std::size_t>(index)] = value;
    }
    return true;
}

bool inverse_iteration_eigenvector(
    const std::vector<std::complex<double>> &matrix,
    int size,
    std::complex<double> eigenvalue,
    std::vector<std::complex<double>> &vector) noexcept
{
    vector.assign(static_cast<std::size_t>(size), {});
    for (int index = 0; index < size; ++index) {
        vector[static_cast<std::size_t>(index)] = 1.0 / static_cast<double>(index + 1);
    }
    const std::complex<double> shift = eigenvalue + std::complex<double>(1.0e-10, 1.0e-10);
    for (int iteration = 0; iteration < 12; ++iteration) {
        std::vector<std::complex<double>> shifted = matrix;
        for (int index = 0; index < size; ++index) {
            shifted[static_cast<std::size_t>(index * size + index)] -= shift;
        }
        std::vector<std::complex<double>> next;
        if (!solve_complex_linear_system(shifted, vector, size, next)) {
            break;
        }
        const double norm = complex_column_norm(next);
        if (!(norm > 0.0) || !std::isfinite(norm)) {
            return false;
        }
        for (std::complex<double> &value : next) {
            value /= norm;
        }
        vector = next;
    }
    return complex_column_norm(vector) > 0.0;
}

double dense_pencil_relative_residual(
    int size,
    const double *stiffness,
    const double *gyrotropic_mass,
    const std::complex<double> &lambda,
    const std::vector<std::complex<double>> &vector) noexcept
{
    double residual_norm_squared = 0.0;
    double k_norm_squared = 0.0;
    double g_norm_squared = 0.0;
    for (int row = 0; row < size; ++row) {
        std::complex<double> k_value{};
        std::complex<double> g_value{};
        for (int col = 0; col < size; ++col) {
            k_value += stiffness[row * size + col] * vector[static_cast<std::size_t>(col)];
            g_value += gyrotropic_mass[row * size + col] * vector[static_cast<std::size_t>(col)];
        }
        const std::complex<double> residual = k_value - lambda * g_value;
        residual_norm_squared += std::norm(residual);
        k_norm_squared += std::norm(k_value);
        g_norm_squared += std::norm(g_value);
    }
    const double denominator = std::sqrt(k_norm_squared) + std::abs(lambda) * std::sqrt(g_norm_squared);
    return denominator > 0.0 ?
        std::sqrt(residual_norm_squared) / denominator :
        std::numeric_limits<double>::infinity();
}

bool dense_pencil_rayleigh_quotient(
    int size,
    const double *stiffness,
    const double *gyrotropic_mass,
    const std::vector<std::complex<double>> &vector,
    std::complex<double> &lambda) noexcept
{
    std::complex<double> numerator{};
    std::complex<double> denominator{};
    for (int row = 0; row < size; ++row) {
        std::complex<double> k_value{};
        std::complex<double> g_value{};
        for (int col = 0; col < size; ++col) {
            k_value += stiffness[row * size + col] * vector[static_cast<std::size_t>(col)];
            g_value += gyrotropic_mass[row * size + col] * vector[static_cast<std::size_t>(col)];
        }
        numerator += std::conj(g_value) * k_value;
        denominator += std::conj(g_value) * g_value;
    }
    if (!std::isfinite(numerator.real()) ||
        !std::isfinite(numerator.imag()) ||
        !std::isfinite(denominator.real()) ||
        !std::isfinite(denominator.imag()) ||
        std::abs(denominator) <= 1.0e-24) {
        return false;
    }
    lambda = numerator / denominator;
    return std::isfinite(lambda.real()) && std::isfinite(lambda.imag());
}

bool solve_dense_projected_modes(
    const ContourQuadrature &quadrature,
    int size,
    const double *stiffness,
    const double *gyrotropic_mass,
    double frequency_min_hz,
    double frequency_max_hz,
    double residual_tolerance,
    ContourIntervalSolveResult &result)
{
    std::vector<std::complex<double>> projection;
    if (!build_dense_contour_projection_matrix(
            quadrature,
            size,
            stiffness,
            gyrotropic_mass,
            projection)) {
        return false;
    }
    std::vector<std::complex<double>> basis;
    int rank = 0;
    if (!orthonormal_basis_from_projection(projection, size, basis, rank)) {
        result.projection_rank = 0;
        return true;
    }
    result.projection_rank = rank;

    std::vector<std::complex<double>> standard_operator;
    if (!build_standard_operator_from_pencil(
            size,
            stiffness,
            gyrotropic_mass,
            standard_operator)) {
        return false;
    }
    const std::vector<std::complex<double>> reduced_operator =
        project_operator_to_basis(standard_operator, basis, size, rank);
    std::vector<std::complex<double>> eigenvalues;
    if (!qr_eigenvalues_complex(reduced_operator, rank, eigenvalues)) {
        return false;
    }
    for (const std::complex<double> &lambda : eigenvalues) {
        const ModeKinematics kinematics = map_eigenvalue(
            {lambda.real(), lambda.imag()},
            FrequencyDomainPhaseConvention::exp_i_omega_t);
        if (!select_positive_frequency_mode(
                kinematics,
                ZeroFrequencyModePolicy::exclude)) {
            continue;
        }
        if (kinematics.frequency_hz < frequency_min_hz ||
            kinematics.frequency_hz > frequency_max_hz) {
            continue;
        }
        std::vector<std::complex<double>> reduced_vector;
        if (!inverse_iteration_eigenvector(
                reduced_operator,
                rank,
                lambda,
                reduced_vector)) {
            continue;
        }
        std::vector<std::complex<double>> full_vector(
            static_cast<std::size_t>(size),
            std::complex<double>{});
        for (int row = 0; row < size; ++row) {
            for (int col = 0; col < rank; ++col) {
                full_vector[static_cast<std::size_t>(row)] +=
                    basis[static_cast<std::size_t>(row * rank + col)] *
                    reduced_vector[static_cast<std::size_t>(col)];
            }
        }
        const double norm = complex_column_norm(full_vector);
        if (!(norm > 0.0) || !std::isfinite(norm)) {
            continue;
        }
        for (std::complex<double> &value : full_vector) {
            value /= norm;
        }
        std::complex<double> refined_lambda{};
        if (!dense_pencil_rayleigh_quotient(
                size,
                stiffness,
                gyrotropic_mass,
                full_vector,
                refined_lambda)) {
            continue;
        }
        const ModeKinematics refined_kinematics = map_eigenvalue(
            {refined_lambda.real(), refined_lambda.imag()},
            FrequencyDomainPhaseConvention::exp_i_omega_t);
        if (!select_positive_frequency_mode(
                refined_kinematics,
                ZeroFrequencyModePolicy::exclude)) {
            continue;
        }
        if (refined_kinematics.frequency_hz < frequency_min_hz ||
            refined_kinematics.frequency_hz > frequency_max_hz) {
            continue;
        }
        const double residual =
            dense_pencil_relative_residual(
                size,
                stiffness,
                gyrotropic_mass,
                refined_lambda,
                full_vector);
        if (!(residual <= std::max(residual_tolerance, 1.0e-7))) {
            continue;
        }
        ContourIntervalMode mode{};
        mode.frequency_hz = refined_kinematics.frequency_hz;
        mode.omega_rad_s = refined_kinematics.omega_rad_s;
        mode.eigenvalue = refined_lambda;
        mode.mode_vector = full_vector;
        mode.relative_residual = residual;
        result.modes.push_back(mode);
    }
    std::sort(
        result.modes.begin(),
        result.modes.end(),
        [](const ContourIntervalMode &lhs, const ContourIntervalMode &rhs) {
            return lhs.frequency_hz < rhs.frequency_hz;
        });
    return true;
}

} // namespace

ModalSolverSelection select_modal_solver_for_frequency_window(
    double frequency_min_hz,
    double frequency_max_hz,
    int eigensolver_family) noexcept
{
    if (eigensolver_family == kModalEigensolverFamilyShiftInvert) {
        return {"shift_invert", "requested_shift_invert"};
    }
    if (eigensolver_family == kModalEigensolverFamilyContourInterval) {
        return {"contour_interval", "requested_contour_interval"};
    }
    if (relative_frequency_width(frequency_min_hz, frequency_max_hz) >= 0.5) {
        return {"contour_interval", "frequency_window_relative_width_ge_0.5"};
    }
    return {"shift_invert", "frequency_window_relative_width_lt_0.5"};
}

ContourIntervalSolveResult solve_tiny_contour_interval(
    const ContourIntervalSolverRequest &request)
{
    ContourIntervalSolveResult result{};
    if (request.tangent_dof_count <= 0 ||
        request.tangent_dof_count % 2 != 0 ||
        request.stiffness_matrix_row_major == nullptr ||
        request.gyrotropic_mass_matrix_row_major == nullptr ||
        !std::isfinite(request.frequency_min_hz) ||
        !std::isfinite(request.frequency_max_hz) ||
        !(request.frequency_min_hz < request.frequency_max_hz) ||
        request.frequency_min_hz < 0.0) {
        result.stop_reason = "invalid_contour_interval_request";
        return result;
    }

    const int size = static_cast<int>(request.tangent_dof_count);
    const bool block_diagonal_payload =
        is_block_diagonal_two_by_two_payload(
            size,
            request.stiffness_matrix_row_major,
            request.gyrotropic_mass_matrix_row_major);

    ContourQuadratureRequest quadrature_request{};
    quadrature_request.frequency_min_hz = request.frequency_min_hz;
    quadrature_request.frequency_max_hz = request.frequency_max_hz;
    quadrature_request.contour_point_count = request.contour_point_count;
    const ContourQuadrature quadrature =
        build_lambda_ellipse_quadrature(quadrature_request);
    result.contour_point_count = static_cast<int>(quadrature.points.size());
    result.quadrature_rule = quadrature.quadrature_rule;
    result.contour_center_hz = quadrature.contour_center_hz;
    result.contour_radius_hz = quadrature.contour_radius_hz;
    result.contour_points.reserve(quadrature.points.size());

    if (request.max_outer_iterations <= 0) {
        result.stop_reason = "max_iterations";
        return result;
    }
    if (request.max_linear_iterations <= 0) {
        result.stop_reason = "linear_solver_unavailable";
        result.linear_solve_failed = true;
        return result;
    }

    for (const ContourPoint &point : quadrature.points) {
        std::vector<std::complex<double>> dense_inverse;
        const bool converged = block_diagonal_payload ?
            all_block_shifted_pencils_invertible(
                point.lambda,
                size,
                request.stiffness_matrix_row_major,
                request.gyrotropic_mass_matrix_row_major) :
            invert_shifted_pencil_dense(
                point.lambda,
                size,
                request.stiffness_matrix_row_major,
                request.gyrotropic_mass_matrix_row_major,
                dense_inverse);
        ContourPointSolveDiagnostic point_diagnostic{};
        point_diagnostic.index = point.index;
        point_diagnostic.lambda = point.lambda;
        point_diagnostic.linear_iterations = converged ? 1 : request.max_linear_iterations;
        point_diagnostic.converged = converged;
        result.contour_points.push_back(point_diagnostic);
        if (!converged) {
            result.linear_solve_failed = true;
        }
    }
    if (result.linear_solve_failed) {
        result.stop_reason = "contour_linear_solve_failed";
        return result;
    }

    const int initial_count = block_diagonal_payload ?
        contour_winding_count_block_diagonal(
            quadrature,
            size,
            request.stiffness_matrix_row_major,
            request.gyrotropic_mass_matrix_row_major) :
        0;
    ContourQuadratureRequest refined_request = quadrature_request;
    refined_request.contour_point_count =
        std::max(2 * result.contour_point_count, result.contour_point_count + 1);
    const ContourQuadrature refined_quadrature =
        build_lambda_ellipse_quadrature(refined_request);
    const int refined_count = block_diagonal_payload ?
        contour_winding_count_block_diagonal(
            refined_quadrature,
            size,
            request.stiffness_matrix_row_major,
            request.gyrotropic_mass_matrix_row_major) :
        0;

    result.quadrature_refinements = 1;
    result.estimated_mode_count = refined_count;
    const bool projected_modes_ok = block_diagonal_payload ?
        solve_block_diagonal_projected_modes(
                refined_quadrature,
                size,
                request.stiffness_matrix_row_major,
                request.gyrotropic_mass_matrix_row_major,
                request.frequency_min_hz,
                request.frequency_max_hz,
                request.residual_tolerance,
                result) :
        solve_dense_projected_modes(
                refined_quadrature,
                size,
                request.stiffness_matrix_row_major,
                request.gyrotropic_mass_matrix_row_major,
                request.frequency_min_hz,
                request.frequency_max_hz,
                request.residual_tolerance,
                result);
    if (!projected_modes_ok) {
        result.stop_reason = "contour_projection_failed";
        result.linear_solve_failed = true;
        return result;
    }
    if (!block_diagonal_payload) {
        result.estimated_mode_count = result.projection_rank;
    }
    result.rank_deficiency_detected = result.projection_rank < result.estimated_mode_count;
    std::sort(
        result.modes.begin(),
        result.modes.end(),
        [](const ContourIntervalMode &lhs, const ContourIntervalMode &rhs) {
            return lhs.frequency_hz < rhs.frequency_hz;
        });
    const int accepted_mode_count_before_cap =
        static_cast<int>(result.modes.size());
    const bool stable_contour_count =
        block_diagonal_payload ? initial_count == refined_count : result.projection_rank > 0;
    const bool all_estimated_modes_accepted =
        accepted_mode_count_before_cap >= result.estimated_mode_count;
    const bool truncated_by_requested_count =
        request.requested_mode_count > 0 &&
        accepted_mode_count_before_cap > request.requested_mode_count;
    if (request.requested_mode_count > 0 &&
        static_cast<int>(result.modes.size()) > request.requested_mode_count) {
        result.modes.resize(static_cast<std::size_t>(request.requested_mode_count));
    }
    result.accepted_mode_count = static_cast<int>(result.modes.size());
    result.count_certificate =
        stable_contour_count &&
        result.projection_rank >= result.estimated_mode_count &&
        all_estimated_modes_accepted &&
        !result.rank_deficiency_detected &&
        !result.linear_solve_failed;
    result.ok = result.count_certificate || result.accepted_mode_count > 0;
    if (truncated_by_requested_count) {
        result.stop_reason = "requested_count_reached";
    } else if (result.count_certificate && result.estimated_mode_count == 0) {
        result.stop_reason = "window_exhausted";
    } else if (result.count_certificate) {
        result.stop_reason = "converged";
    } else if (!all_estimated_modes_accepted) {
        result.stop_reason = "residual_not_met";
    } else {
        result.stop_reason = "partial_convergence";
    }
    return result;
}

std::string contour_interval_diagnostics_json(
    const ContourIntervalSolveResult &result)
{
    std::string json =
        "\"contour_plane\":\"lambda\","
        "\"frequency_mapping\":\"map_eigenvalue(lambda, exp_i_omega_t)\","
        "\"positive_frequency_filter\":\"select_positive_frequency_mode(map_eigenvalue(lambda, exp_i_omega_t), exclude_zero_frequency)\","
        "\"zero_frequency_mode_policy\":\"exclude_zero_frequency\","
        "\"contour_point_count\":" +
        std::to_string(result.contour_point_count) +
        ",\"quadrature_rule\":\"" +
        std::string(result.quadrature_rule != nullptr ? result.quadrature_rule : "") +
        "\",\"contour_center_hz\":" +
        format_double(result.contour_center_hz) +
        ",\"contour_radius_hz\":" +
        format_double(result.contour_radius_hz) +
        ",\"projection_rank\":" +
        std::to_string(result.projection_rank) +
        ",\"estimated_mode_count\":" +
        std::to_string(result.estimated_mode_count) +
        ",\"accepted_mode_count\":" +
        std::to_string(result.accepted_mode_count) +
        ",\"certified_count\":" +
        std::string(result.count_certificate ? "true" : "false") +
        ",\"count_certificate\":{\"certified_count\":" +
        std::string(result.count_certificate ? "true" : "false") +
        ",\"estimated_modes_in_window\":" +
        std::to_string(result.estimated_mode_count) +
        ",\"accepted_modes_in_window\":" +
        std::to_string(result.accepted_mode_count) +
        "},\"quadrature_refinements\":" +
        std::to_string(result.quadrature_refinements) +
        ",\"rank_deficiency_detected\":" +
        std::string(result.rank_deficiency_detected ? "true" : "false") +
        ",\"linear_iterations_per_point\":[";
    for (std::size_t i = 0; i < result.contour_points.size(); ++i) {
        if (i > 0) {
            json += ",";
        }
        json += std::to_string(result.contour_points[i].linear_iterations);
    }
    json += "],\"contour_points\":[";
    for (std::size_t i = 0; i < result.contour_points.size(); ++i) {
        const ContourPointSolveDiagnostic &point = result.contour_points[i];
        if (i > 0) {
            json += ",";
        }
        json +=
            "{\"index\":" +
            std::to_string(point.index) +
            ",\"lambda_real\":" +
            format_double(point.lambda.real()) +
            ",\"lambda_imag\":" +
            format_double(point.lambda.imag()) +
            ",\"linear_iterations\":" +
            std::to_string(point.linear_iterations) +
            ",\"linear_solve_converged\":" +
            std::string(point.converged ? "true" : "false") +
            "}";
    }
    json += "],\"modes\":[";
    for (std::size_t i = 0; i < result.modes.size(); ++i) {
        const ContourIntervalMode &mode = result.modes[i];
        const ModeKinematics kinematics = map_eigenvalue(
            {mode.eigenvalue.real(), mode.eigenvalue.imag()},
            FrequencyDomainPhaseConvention::exp_i_omega_t);
        if (i > 0) {
            json += ",";
        }
        json +=
            "{\"lambda_real_per_s\":" +
            format_double(kinematics.lambda.real_per_s) +
            ",\"lambda_imag_rad_per_s\":" +
            format_double(kinematics.lambda.imag_rad_per_s) +
            ",\"omega_rad_s\":" +
            format_double(kinematics.omega_rad_s) +
            ",\"frequency_hz\":" +
            format_double(kinematics.frequency_hz) +
            ",\"decay_rate_per_s\":" +
            format_double(kinematics.decay_rate_per_s) +
            ",\"branch_sign\":" +
            std::to_string(kinematics.branch_sign) +
            ",\"stable\":" +
            std::string(kinematics.stable ? "true" : "false") +
            "}";
    }
    json += "]";
    return json;
}

} // namespace fullmag::fem::frequency_domain
