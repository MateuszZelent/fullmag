#pragma once

/*
 * GPU CUDA Poisson demag stage compute header.
 *
 * Declares strict device-resident FEM GPU Poisson demag stage compute. Lifecycle
 * and readiness remain in poisson.hpp; operator workspace records live in
 * operators.hpp.
 */

#include "gpu/cuda/state/gpu_state.hpp"

#include <string>

namespace fullmag::fem {

struct Context;

bool compute_device_demag_for_device_stage(
    Context &ctx,
    const FemGpuComponentField &m,
    void *stream,
    std::string &reason);

bool reduce_device_demag_robin_boundary_energy(
    Context &ctx,
    double *result,
    void *stream,
    std::string &reason);

} // namespace fullmag::fem
