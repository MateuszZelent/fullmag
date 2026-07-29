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
#include <cstdint>
#include <string>

namespace fullmag::fem {

struct Context;

struct GpuDirectEnergySnapshot {
    double total_energy_j = 0.0;
    std::array<double, kGpuFinalScalarSlots> terms_j{};
};

enum class GpuEnergyIncrementOwner : uint8_t {
    NotEnergy,
    Direct,
    EndpointResidual,
    Unsupported,
};

GpuEnergyIncrementOwner gpu_energy_increment_owner(
    const Context &ctx,
    GpuFinalScalarSlot slot);

struct GpuDirectEnergyReductionCounts {
    size_t local = 0;
    size_t exchange = 0;
    size_t interfacial_dmi = 0;
    size_t bulk_dmi = 0;
};

bool gpu_direct_energy_reduction_counts(
    const Context &ctx,
    size_t node_count,
    size_t element_count,
    size_t exchange_nnz,
    GpuDirectEnergyReductionCounts &counts);

bool gpu_compose_term_complete_energy_difference(
    const Context &ctx,
    const GpuDirectEnergySnapshot &base,
    const GpuDirectEnergySnapshot &trial,
    double direct_delta_j,
    double direct_absolute_term_sum_j,
    size_t scalar_term_count,
    relaxation::EnergyDifference &difference,
    double &endpoint_residual_delta_j,
    double &endpoint_residual_operand_absolute_sum_j,
    std::string &reason);

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
    double demag_delta_j = 0.0;
    double demag_absolute_term_sum_j = 0.0;
    double demag_roundoff_bound_j = 0.0;
    double exchange_delta_j = 0.0;
    double interfacial_dmi_delta_j = 0.0;
    double bulk_dmi_delta_j = 0.0;
    double endpoint_residual_delta_j = 0.0;
    double endpoint_residual_operand_absolute_sum_j = 0.0;
    double representable_chord_energy_linear_increment_j = 0.0;
    double armijo_rhs_j = 0.0;
    bool trial_active_state_unchanged = false;
    relaxation::ArmijoDifferenceDecision decision =
        relaxation::ArmijoDifferenceDecision::Reject;
    bool refinement_attempted = false;
    bool refinement_accepted = false;
    uint32_t refinement_rhs_evaluations = 0;
};

bool gpu_direct_armijo_demag_refinement_eligible(
    const Context &ctx,
    const GpuDirectArmijoResult &result,
    double armijo_rhs_j);

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

bool gpu_unpack_direct_energy_snapshot(
    const Context &ctx,
    const double *energy_terms,
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
    bool track_active_state_change,
    GpuDirectArmijoResult &result,
    std::string &reason);

bool gpu_direct_minimizer_precompute_representable_chord_increment(
    Context &ctx,
    cudaStream_t stream,
    int node_count,
    int block_count,
    const FemGpuComponentField &base_m,
    const FemGpuComponentField &trial_m,
    const FemGpuComponentField &accepted_h_eff,
    std::string &reason);

bool gpu_direct_minimizer_armijo_evaluate(
    Context &ctx,
    cudaStream_t stream,
    int node_count,
    int block_count,
    const FemGpuComponentField &base_m,
    const FemGpuComponentField &base_h_demag,
    const GpuDirectEnergySnapshot &base,
    double armijo_coefficient,
    bool track_active_state_change,
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
