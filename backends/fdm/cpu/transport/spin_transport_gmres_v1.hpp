#pragma once

#include <fullmag/fdm/cpu/spin_transport_v1.hpp>

#include <cstddef>
#include <functional>
#include <vector>

namespace fullmag::fdm::cpu::transport::spin::v1::detail {

using MatrixFreeApply =
    std::function<SolveResult(const std::vector<double> &, std::vector<double> &)>;

double l2_norm(const std::vector<double> &values);

SolveResult block_gmres(const std::vector<double> &rhs,
                        const SolverOptions &options,
                        double tolerance,
                        const MatrixFreeApply &apply,
                        std::vector<double> &solution,
                        std::size_t &iterations,
                        double &recursive_residual);

} // namespace fullmag::fdm::cpu::transport::spin::v1::detail
