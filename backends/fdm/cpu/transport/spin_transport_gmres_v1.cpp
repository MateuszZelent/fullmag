#include "spin_transport_gmres_v1.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <utility>

namespace fullmag::fdm::cpu::transport::spin::v1::detail {
namespace {

double vector_dot(const std::vector<double> &left, const std::vector<double> &right) {
    double result = 0.0;
    for (std::size_t index = 0; index < left.size(); ++index) {
        result += left[index] * right[index];
    }
    return result;
}

void axpy(std::vector<double> &target, double factor, const std::vector<double> &source) {
    for (std::size_t index = 0; index < target.size(); ++index) {
        target[index] += factor * source[index];
    }
}

bool back_substitute(const std::vector<std::vector<double>> &matrix,
                     const std::vector<double> &rhs,
                     std::size_t count,
                     std::vector<double> &solution) {
    solution.assign(count, 0.0);
    for (std::size_t reverse = 0; reverse < count; ++reverse) {
        const std::size_t row = count - 1 - reverse;
        double value = rhs[row];
        for (std::size_t column = row + 1; column < count; ++column) {
            value -= matrix[row][column] * solution[column];
        }
        if (!std::isfinite(matrix[row][row]) || matrix[row][row] == 0.0) {
            return false;
        }
        solution[row] = value / matrix[row][row];
    }
    return true;
}

SolveResult failure(Status status, std::string message) {
    return {status, std::move(message), {}};
}

} // namespace

double l2_norm(const std::vector<double> &values) {
    double result = 0.0;
    for (double value : values) {
        result += value * value;
    }
    return std::sqrt(result);
}

SolveResult block_gmres(const std::vector<double> &rhs,
                        const SolverOptions &options,
                        double tolerance,
                        const MatrixFreeApply &apply,
                        std::vector<double> &solution,
                        std::size_t &iterations,
                        double &recursive_residual) {
    solution.assign(rhs.size(), 0.0);
    iterations = 0;
    while (true) {
        std::vector<double> applied;
        if (auto result = apply(solution, applied); !result.ok()) {
            return result;
        }
        std::vector<double> residual(rhs.size());
        for (std::size_t index = 0; index < rhs.size(); ++index) {
            residual[index] = rhs[index] - applied[index];
        }
        const double beta = l2_norm(residual);
        recursive_residual = beta;
        if (beta <= tolerance) {
            return {Status::ok, {}, {}};
        }
        if (iterations >= options.max_iterations) {
            return failure(Status::did_not_converge,
                           "spin block GMRES exhausted the iteration budget");
        }
        const std::size_t cycle =
            std::min(options.gmres_restart, options.max_iterations - iterations);
        std::vector<std::vector<double>> basis;
        basis.reserve(cycle + 1);
        basis.push_back(residual);
        for (double &value : basis.back()) {
            value /= beta;
        }
        std::vector<std::vector<double>> hessenberg(cycle + 1,
                                                     std::vector<double>(cycle, 0.0));
        std::vector<double> cosine(cycle, 0.0);
        std::vector<double> sine(cycle, 0.0);
        std::vector<double> projected_rhs(cycle + 1, 0.0);
        projected_rhs[0] = beta;
        std::size_t used = 0;
        for (std::size_t column = 0; column < cycle; ++column) {
            std::vector<double> vector;
            if (auto result = apply(basis[column], vector); !result.ok()) {
                return result;
            }
            const double column_norm = l2_norm(vector);
            for (std::size_t pass = 0; pass < 2; ++pass) {
                for (std::size_t row = 0; row <= column; ++row) {
                    const double coefficient = vector_dot(basis[row], vector);
                    hessenberg[row][column] += coefficient;
                    axpy(vector, -coefficient, basis[row]);
                }
            }
            hessenberg[column + 1][column] = l2_norm(vector);
            const double threshold =
                32.0 * std::numeric_limits<double>::epsilon() * column_norm;
            if (hessenberg[column + 1][column] > threshold) {
                const double inverse = 1.0 / hessenberg[column + 1][column];
                for (double &value : vector) {
                    value *= inverse;
                }
            } else {
                std::fill(vector.begin(), vector.end(), 0.0);
            }
            basis.push_back(std::move(vector));
            for (std::size_t row = 0; row < column; ++row) {
                const double upper = hessenberg[row][column];
                const double lower = hessenberg[row + 1][column];
                hessenberg[row][column] = cosine[row] * upper + sine[row] * lower;
                hessenberg[row + 1][column] = -sine[row] * upper + cosine[row] * lower;
            }
            const double diagonal = hessenberg[column][column];
            const double subdiagonal = hessenberg[column + 1][column];
            const double magnitude = std::hypot(diagonal, subdiagonal);
            if (!std::isfinite(magnitude) || magnitude == 0.0) {
                return failure(Status::singular_operator,
                               "spin block GMRES encountered a singular Krylov basis");
            }
            cosine[column] = diagonal / magnitude;
            sine[column] = subdiagonal / magnitude;
            hessenberg[column][column] = magnitude;
            hessenberg[column + 1][column] = 0.0;
            const double upper_rhs = projected_rhs[column];
            projected_rhs[column] = cosine[column] * upper_rhs;
            projected_rhs[column + 1] = -sine[column] * upper_rhs;
            used = column + 1;
            ++iterations;
            if (std::abs(projected_rhs[column + 1]) <= tolerance ||
                iterations >= options.max_iterations) {
                break;
            }
        }
        std::vector<double> coefficients;
        if (!back_substitute(hessenberg, projected_rhs, used, coefficients)) {
            return failure(Status::singular_operator,
                           "spin block GMRES triangular solve is singular");
        }
        for (std::size_t column = 0; column < used; ++column) {
            axpy(solution, coefficients[column], basis[column]);
        }
    }
}

} // namespace fullmag::fdm::cpu::transport::spin::v1::detail
