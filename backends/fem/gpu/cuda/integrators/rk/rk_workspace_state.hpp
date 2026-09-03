#pragma once

/*
 * GPU CUDA RK workspace device-state module header.
 *
 * Owns stepper scratch magnetization, embedded-error, stage RHS, FSAL cache,
 * and the minimal device-to-device journal used by the device-resident
 * explicit Runge-Kutta integrator.
 */

#include "gpu/cuda/state/component_field.hpp"
#include "gpu/cuda/integrators/rk/rk_attempt_control_state.hpp"
#include "gpu/cuda/integrators/rk/rk_output_control.hpp"

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
    // Exact normalized endpoint captured by DP54 stage-6. The buffer uses the
    // existing error scratch until the accepted attempt is promoted.
    bool endpoint_valid = false;
    uint32_t endpoint_integrator = 0;
    uint64_t endpoint_generation = 0;
    double endpoint_time_seconds = 0.0;
    uint64_t endpoint_operator_signature = 0;
    bool endpoint_consumed = false;
    GpuRkAttemptControlDeviceState attempt_control{};

    // Only authoritative magnetization and FSAL endpoint state are journaled.
    // Derived fields and Poisson iterates are invalidated after rollback.
    FemGpuComponentField transaction_m;
    FemGpuComponentField transaction_k0;
    RkCandidateState candidate{};
};

} // namespace fullmag::fem
