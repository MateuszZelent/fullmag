#pragma once

/*
 * GPU CUDA Poisson demag module header.
 *
 * Declares strict device-resident FEM GPU Poisson demag lifecycle and status.
 */

#include <cstdint>
#include <string>

namespace fullmag::fem {

struct Context;

// Linear-solver realization of the initialized device Poisson workspace
// (docs/physics/0997). Values match fullmag_fem_gpu_demag_linear_solver_v1.
enum class GpuDemagPoissonLinearSolver : uint32_t {
    Unavailable = 0,
    HypreKrylov = 1,
    CudssDirect = 2,
};

bool gpu_demag_poisson_initialize(Context &ctx, std::string &error);

void gpu_demag_poisson_destroy(Context &ctx);

bool gpu_demag_poisson_ready(const Context &ctx);

uint64_t gpu_demag_poisson_device_bytes(const Context &ctx);

const char *gpu_demag_poisson_operator_mode(const Context &ctx);

const char *gpu_demag_poisson_hypre_policy(const Context &ctx);

// Unavailable unless the device_hypre_poisson workspace is ready; the planner
// derives the required linear-solve operator bit from this value.
GpuDemagPoissonLinearSolver gpu_demag_poisson_linear_solver(const Context &ctx);

} // namespace fullmag::fem
