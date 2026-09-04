#pragma once

/*
 * GPU CUDA relaxation device-state module header.
 *
 * Owns persistent device buffers whose lifetime spans native FEM relaxation
 * steps. Step-local scratch stays in the RK workspace; algorithm memory such as
 * the nonlinear-CG search direction lives here so GPU minimizers do not depend
 * on host-side std::vector state.
 */

#include "gpu/cuda/state/component_field.hpp"
#include "gpu/cuda/relaxation/gpu_relaxation_preconditioner.hpp"

#include <array>
#include <cstddef>
#include <cstdint>

namespace fullmag::fem {

static constexpr std::size_t kFemGpuAcceptedEnergyTermSlots = 18;

struct FemGpuAcceptedEvaluationToken {
    bool valid = false;
    uint64_t accepted_step = 0;
    uint64_t state_generation = 0;
    uint64_t configuration_signature = 0;
    uint64_t solver_signature = 0;
    bool evaluation_refined = false;
    double total_energy_j = 0.0;
    std::array<double, kFemGpuAcceptedEnergyTermSlots> energy_terms_j{};
    uint64_t hits = 0;
    uint64_t misses = 0;
    uint64_t invalidations = 0;
};

enum class GpuRelaxNcgFailurePoint : uint32_t {
    None = 0,
    AfterTrialMagnetization = 1,
    DuringAcceptedStatistics = 2,
};

struct FemGpuRelaxationDeviceState {
    FemGpuComponentField projected_gradient_accepted_h_eff;
    FemGpuComponentField nonlinear_cg_direction;
    FemGpuComponentField nonlinear_cg_direction_backup;
    uint64_t node_count = 0;
    uint64_t state_generation = 0;
    bool nonlinear_cg_direction_valid = false;
    FemGpuAcceptedEvaluationToken accepted_evaluation;
    uint32_t accepted_evaluation_cache_hits_current_step = 0;
    uint32_t accepted_evaluation_cache_misses_current_step = 0;
    uint32_t accepted_evaluation_invalidations_current_step = 0;
    GpuRelaxNcgFailurePoint next_nonlinear_cg_failure =
        GpuRelaxNcgFailurePoint::None;
    uint64_t nonlinear_cg_failures_injected = 0;
    uint32_t direct_energy_refinements_current_step = 0;
    uint64_t direct_energy_refinements = 0;
    GpuDiagonalRelaxationPreconditioner preconditioner{};
};

inline void gpu_relax_invalidate_accepted_evaluation(
    FemGpuRelaxationDeviceState &state) noexcept
{
    if (state.accepted_evaluation.valid) {
        state.accepted_evaluation.invalidations += 1;
        state.accepted_evaluation_invalidations_current_step += 1;
    }
    state.accepted_evaluation.valid = false;
}

inline void gpu_relax_reset_step_diagnostics(
    FemGpuRelaxationDeviceState &state) noexcept
{
    state.accepted_evaluation_cache_hits_current_step = 0;
    state.accepted_evaluation_cache_misses_current_step = 0;
    state.accepted_evaluation_invalidations_current_step = 0;
    state.direct_energy_refinements_current_step = 0;
}

inline void gpu_relax_note_external_state_change(
    FemGpuRelaxationDeviceState &state) noexcept
{
    state.state_generation += 1;
    gpu_relax_invalidate_accepted_evaluation(state);
}

} // namespace fullmag::fem
