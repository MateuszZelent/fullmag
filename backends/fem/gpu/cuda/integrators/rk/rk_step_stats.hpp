/*
 * GPU CUDA RK final step stats module header.
 *
 * Declares scalar result slots and final step-stat publication helpers used by
 * the device-resident RK stepper. Step scheduling remains in rk_step.cu.
 */
#pragma once

#include "fullmag_fem.h"
#include "gpu/cuda/state/gpu_state.hpp"

#include <cstddef>
#include <string>

namespace fullmag::fem {

struct Context;

enum class GpuFinalScalarSlot : int {
    MaxRhs = 0,
    ExchangeEnergy,
    DemagEnergy,
    DemagRobinBoundaryEnergy,
    ExternalEnergy,
    DmiEnergy,
    BulkDmiEnergy,
    AnisotropyEnergy,
    CubicAnisotropyEnergy,
    MagnetoelasticEnergy,
    MaxHEff,
    MaxHDemag,
    MaxTorque,
    MxSum,
    MySum,
    MzSum,
    MagneticCount,
    Count,
};

static constexpr size_t kGpuFinalScalarSlots =
    static_cast<size_t>(GpuFinalScalarSlot::Count);
static_assert(
    kGpuFinalScalarSlots <= FEM_GPU_SCALAR_RESULT_SLOTS,
    "FemGpuState scalar result allocation must cover GPU RK final stats slots");

double *gpu_rk_final_scalar_result(FemGpuState &gpu, GpuFinalScalarSlot slot);

bool gpu_rk_finalize_step_stats(
    Context &ctx,
    fullmag_fem_step_stats &stats,
    std::string &reason);

bool gpu_rk_finalize_step_stats_control_readback(
    Context &ctx,
    fullmag_fem_step_stats &stats,
    std::string &reason);

} // namespace fullmag::fem
