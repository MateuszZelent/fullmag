#pragma once

/*
 * GPU CUDA Poisson demag module header.
 *
 * Declares strict device-resident FEM GPU Poisson demag lifecycle and status.
 */

#include "gpu/cuda/demag_poisson/cudss_direct_solver.hpp"

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

// Unavailable unless a device_hypre_poisson or device_hypre_fem_bem workspace
// is ready; the planner derives the required linear-solve operator bit here.
GpuDemagPoissonLinearSolver gpu_demag_poisson_linear_solver(const Context &ctx);

// Reads the resolved strategy/fallback/VRAM provenance for an initialized
// device_hypre_poisson or device_hypre_fem_bem workspace.
bool gpu_demag_linear_solver_provenance(
    const Context &ctx,
    GpuDemagCudssResolution &out_resolution);

} // namespace fullmag::fem
