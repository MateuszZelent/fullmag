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
#include "gpu/cuda/relaxation/gpu_exchange_mass_preconditioner.hpp"
#include "gpu/cuda/relaxation/gpu_relaxation_preconditioner.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

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

/*
 * Identity of the immutable state used to configure a direct-minimizer
 * preconditioner.  The fields deliberately remain runtime-local: the
 * optimization is not part of Python/ProblemIR.  A changed field makes the
 * previous setup stale and forces a new setup before the next apply.
 */
struct GpuRelaxationPreconditionerSetupIdentity {
    uint64_t mesh_topology_revision = 0;
    uint64_t geometry_revision = 0;
    uint64_t operator_revision = 0;
    uint64_t material_revision = 0;
    uint64_t mass_revision = 0;
    uint64_t mask_revision = 0;
    uint64_t precision_revision = 0;
    uint64_t runtime_revision = 0;
    uint64_t gpu_revision = 0;

    bool operator==(const GpuRelaxationPreconditionerSetupIdentity &other) const noexcept
    {
        return mesh_topology_revision == other.mesh_topology_revision &&
            geometry_revision == other.geometry_revision &&
            operator_revision == other.operator_revision &&
            material_revision == other.material_revision &&
            mass_revision == other.mass_revision &&
            mask_revision == other.mask_revision &&
            precision_revision == other.precision_revision &&
            runtime_revision == other.runtime_revision &&
            gpu_revision == other.gpu_revision;
    }

    bool operator!=(const GpuRelaxationPreconditionerSetupIdentity &other) const noexcept
    {
        return !(*this == other);
    }
};

/* Inputs consumed only by setup.  All pointers are borrowed and must remain
 * valid for the configured lifetime.  The apply hot path receives no setup
 * inputs, performs no host reads, and performs no allocation. */
struct GpuRelaxationPreconditionerSetupRequest {
    GpuRelaxationPreconditionerRequest profile{};
    GpuRelaxationPreconditionerSetupIdentity identity{};
    const std::vector<double> *mass_diagonal = nullptr;
    const std::vector<double> *exchange_diagonal = nullptr;
    const std::vector<double> *mass_ms = nullptr;
    SparseApplyPlan *sparse_plan = nullptr;
    const double *d_mass_ms = nullptr;
    const uint8_t *d_active_mask = nullptr;
    uint64_t node_count = 0;
    double exchange_weight = 0.0;
    void *stream = nullptr;
};

struct FemGpuRelaxationDeviceState {
    FemGpuComponentField projected_gradient_accepted_h_eff;
    /* Raw tangent gradient g lives in RK k[0]; z always has its own storage. */
    FemGpuComponentField preconditioned_gradient;
    FemGpuComponentField previous_preconditioned_gradient;
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
    GpuRelaxationPreconditionerRequest preconditioner_request{};
    GpuRelaxationPreconditionerDecision resolved_preconditioner{};
    GpuRelaxationPreconditionerSetupIdentity preconditioner_setup_identity{};
    std::string preconditioner_setup_profile;
    double preconditioner_setup_weight = 0.0;
    bool preconditioner_setup_complete = false;
    uint64_t preconditioner_setup_hits = 0;
    uint64_t preconditioner_setup_misses = 0;
    uint64_t preconditioner_setup_invalidations = 0;
    uint64_t preconditioner_apply_failures = 0;
    std::vector<double> preconditioner_mass_diagonal;
    std::vector<double> preconditioner_exchange_diagonal;
    std::vector<double> preconditioner_mass_ms;
    double *preconditioner_mass_ms_device = nullptr;
    GpuDiagonalRelaxationPreconditioner preconditioner{};
    GpuExchangeMassPreconditioner exchange_mass_cg4{
        GpuExchangeMassCgVariant::Cg4};
    GpuExchangeMassPreconditioner exchange_mass_cg8{
        GpuExchangeMassCgVariant::Cg8};
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

inline void gpu_relax_mark_preconditioner_invalid(
    FemGpuRelaxationDeviceState &state) noexcept
{
    state.preconditioner.reset();
    state.exchange_mass_cg4.reset();
    state.exchange_mass_cg8.reset();
    state.preconditioner_setup_complete = false;
    state.preconditioner_setup_identity = {};
    state.preconditioner_setup_profile.clear();
    state.preconditioner_setup_weight = 0.0;
    state.resolved_preconditioner = {};
    state.preconditioner_setup_invalidations += 1u;
}

} // namespace fullmag::fem
