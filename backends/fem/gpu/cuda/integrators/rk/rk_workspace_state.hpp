#pragma once

/*
 * GPU CUDA RK workspace device-state module header.
 *
 * Owns stepper scratch magnetization, embedded-error, stage RHS, FSAL cache,
 * and the minimal device-to-device journal used by the device-resident
 * explicit Runge-Kutta integrator.
 */

#include "gpu/cuda/state/component_field.hpp"

#include <array>
#include <cstdint>

namespace fullmag::fem {

static constexpr uint32_t FEM_GPU_MAX_RK_STAGES = 7;

struct FemGpuRkWorkspaceDeviceState {
    FemGpuComponentField m_backup;
    FemGpuComponentField m_stage;
    FemGpuComponentField error;
    std::array<FemGpuComponentField, FEM_GPU_MAX_RK_STAGES> k{};
    bool fsal_valid = false;

    // Only authoritative magnetization and FSAL endpoint state are journaled.
    // Derived fields and Poisson iterates are invalidated after rollback.
    FemGpuComponentField transaction_m;
    FemGpuComponentField transaction_k0;
};

} // namespace fullmag::fem
