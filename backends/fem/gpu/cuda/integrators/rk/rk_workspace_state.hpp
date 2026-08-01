#pragma once

/*
 * GPU CUDA RK workspace device-state module header.
 *
 * Owns stepper scratch magnetization, embedded-error, stage RHS, FSAL cache,
 * and persistent device-to-device rollback storage used by the
 * device-resident explicit Runge-Kutta integrator.
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

    // Persistent device-to-device snapshot storage for atomic RK rollback.
    FemGpuComponentField transaction_m;
    FemGpuComponentField transaction_k0;
    FemGpuComponentField transaction_h_ex;
    FemGpuComponentField transaction_h_demag;
    FemGpuComponentField transaction_h_drive;
    FemGpuComponentField transaction_h_ani;
    FemGpuComponentField transaction_h_cubic_ani;
    FemGpuComponentField transaction_h_dmi;
    FemGpuComponentField transaction_h_bulk_dmi;
    FemGpuComponentField transaction_h_oe;
    FemGpuComponentField transaction_h_therm;
    FemGpuComponentField transaction_h_mel;
    FemGpuComponentField transaction_h_eff;
    double *transaction_poisson_solution = nullptr;
    double *transaction_poisson_solution_full = nullptr;
};

} // namespace fullmag::fem
