#pragma once

/*
 * GPU CUDA Poisson demag device-state module header.
 *
 * Owns device-side Poisson buffers plus transitional hybrid CPU-Poisson
 * compatibility buffers used by the native FEM CUDA demag realization.
 */

#include "gpu/cuda/state/component_field.hpp"

#include <cstdint>
#include <vector>

namespace fullmag::fem {

struct FemGpuDemagPoissonDeviceState {
    uint64_t scalar_dof_count = 0;
    uint64_t full_scalar_dof_count = 0;
    double *poisson_rhs = nullptr;
    double *poisson_solution = nullptr;
    double *poisson_solution_full = nullptr;
    FemGpuComponentField poisson_gradient;
    std::vector<double> hybrid_stage_m_xyz;
    std::vector<double> hybrid_demag_xyz;
    double hybrid_demag_energy_joules = 0.0;
};

} // namespace fullmag::fem
