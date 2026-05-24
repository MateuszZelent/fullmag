#pragma once

/*
 * GPU CUDA Poisson demag Hypre device solver header.
 *
 * Owns strict GPU Poisson demag Hypre device-policy solver setup and solver
 * statistics extraction. Operator CSR records live in operators.hpp; lifecycle
 * and stage compute remain in poisson.hpp/.cpp.
 */

#include "gpu/cuda/demag_poisson/operators.hpp"

#include <string>

namespace fullmag::fem {

bool initialize_demag_poisson_hypre_device_solver(
    Context &ctx,
    GpuDemagPoissonWorkspace &workspace,
    std::string &error);

void read_demag_poisson_hypre_solver_stats(
    const Context &ctx,
    GpuDemagPoissonWorkspace &workspace,
    int &iterations,
    double &residual);

} // namespace fullmag::fem
