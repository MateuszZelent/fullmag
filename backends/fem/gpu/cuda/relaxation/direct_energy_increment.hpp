/*
 * Shared direct energy-increment evaluation for native FEM CUDA minimizers.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include "gpu/cuda/integrators/rk/rk_step_stats.hpp"
#include "gpu/cuda/state/component_field.hpp"
#include "src/relaxation_numerics.hpp"

#include <cuda_runtime.h>

#include <array>
#include <string>

namespace fullmag::fem {

struct Context;

struct GpuDirectEnergySnapshot {
    double total_energy_j = 0.0;
    std::array<double, kGpuFinalScalarSlots> terms_j{};
};

static constexpr size_t kGpuPgbbCurrentGradientNormSlot =
    kGpuFinalScalarSlots;
static constexpr size_t kGpuPgbbCurrentProjectedGradientNormSlot =
    kGpuPgbbCurrentGradientNormSlot + 1u;
static constexpr size_t kGpuPgbbCurrentFiniteFlagsSlot =
    kGpuPgbbCurrentProjectedGradientNormSlot + 1u;
static constexpr size_t kGpuPgbbCurrentPackedScalarCount =
    kGpuPgbbCurrentFiniteFlagsSlot + 3u;
static_assert(
    kGpuPgbbCurrentPackedScalarCount <= FEM_GPU_SCALAR_RESULT_SLOTS,
    "GPU PG-BB packed current metrics must fit in the shared scalar result buffer");

struct GpuPgbbCurrentMetrics {
    GpuDirectEnergySnapshot energy_snapshot{};
    double gradient_norm_sq = 0.0;
    double projected_gradient_norm_sq = 0.0;
    bool energy_snapshot_finite = false;
    bool gradient_norm_finite = false;
    bool projected_gradient_norm_finite = false;
};

struct GpuDirectArmijoResult {
    relaxation::EnergyDifference difference{};
    GpuDirectEnergySnapshot trial_snapshot{};
    double local_delta_j = 0.0;
    double exchange_delta_j = 0.0;
    double interfacial_dmi_delta_j = 0.0;
    double bulk_dmi_delta_j = 0.0;
    double endpoint_replaced_delta_j = 0.0;
    relaxation::ArmijoDifferenceDecision decision =
        relaxation::ArmijoDifferenceDecision::Reject;
    bool refinement_attempted = false;
    bool refinement_accepted = false;
    uint32_t refinement_rhs_evaluations = 0;
};

bool gpu_relax_compute_effective_field_and_energy_terms(
    Context &ctx,
    cudaStream_t stream,
    int node_count,
    int block_count,
    std::string &reason);

bool gpu_direct_energy_snapshot(
    Context &ctx,
    cudaStream_t stream,
    GpuDirectEnergySnapshot &snapshot,
    std::string &reason);

bool gpu_unpack_pgbb_current_metrics(
    const Context &ctx,
    const std::array<double, FEM_GPU_SCALAR_RESULT_SLOTS> &packed_scalars,
    GpuPgbbCurrentMetrics &metrics,
    std::string &reason);

bool gpu_direct_armijo_evaluate(
    Context &ctx,
    cudaStream_t stream,
    int node_count,
    int block_count,
    const FemGpuComponentField &base_m,
    const FemGpuComponentField &base_h_demag,
    const GpuDirectEnergySnapshot &base,
    double armijo_rhs_j,
    GpuDirectArmijoResult &result,
    std::string &reason);

bool gpu_direct_armijo_refine(
    Context &ctx,
    cudaStream_t stream,
    int node_count,
    int block_count,
    const FemGpuComponentField &base_m,
    const FemGpuComponentField &trial_m,
    FemGpuComponentField &base_h_demag_scratch,
    double armijo_rhs_j,
    GpuDirectArmijoResult &result,
    std::string &reason);

} // namespace fullmag::fem
#endif
