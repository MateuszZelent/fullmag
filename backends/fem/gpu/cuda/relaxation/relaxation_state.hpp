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

#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <utility>

namespace fullmag::fem {
struct GpuBbExchangeMassWorkspace;

static constexpr std::size_t kFemGpuAcceptedEnergyTermSlots = 18;

// Exact, allocation-free provenance for a single PGBB field reuse. Values
// are stored separately (not hashed), so different policies cannot collide.
struct FemGpuPgbbFieldKey {
    std::array<uint64_t, 64> values{};
    bool operator==(const FemGpuPgbbFieldKey &other) const noexcept
    {
        return values == other.values;
    }
};

struct FemGpuPgbbFieldToken {
    bool valid = false;
    FemGpuPgbbFieldKey key{};
};

inline bool gpu_relax_consume_pgbb_field(
    FemGpuPgbbFieldToken &token,
    const FemGpuPgbbFieldKey &key,
    bool eligible) noexcept
{
    const bool reuse = eligible && token.valid && token.key == key;
    token.valid = false; // No rollback or second caller may replay the token.
    return reuse;
}

// Private, single-use guess provenance. Fixed storage avoids hot-loop allocation.
// Oversized fingerprints are ineligible; this is never an approximate digest.
struct FemGpuPgbbPotentialKey {
    FemGpuPgbbFieldKey endpoint;
    std::array<char, 64> operator_fingerprint{};
    uintptr_t workspace = 0, solution = 0, stream = 0, hypre_stream = 0;
    uint64_t rows = 0, fingerprint_size = 0, operator_build = 0, operator_upload = 0, solver_setup = 0;
    int device = -1;
    bool operator==(const FemGpuPgbbPotentialKey &b) const noexcept
    {
        return endpoint == b.endpoint && fingerprint_size == b.fingerprint_size &&
            operator_fingerprint == b.operator_fingerprint &&
            workspace == b.workspace && solution == b.solution && stream == b.stream &&
            hypre_stream == b.hypre_stream && rows == b.rows && device == b.device &&
            operator_build == b.operator_build && operator_upload == b.operator_upload &&
            solver_setup == b.solver_setup;
    }
};
// The Context retains a copyable owner token; only consume() can issue a
// move-only execution permit. Moving transfers authority and spends the source.
struct FemGpuPgbbPotentialToken {
    bool valid = false;
    FemGpuPgbbPotentialKey key{};
};
struct FemGpuPgbbPotentialPermit {
    bool valid = false;
    FemGpuPgbbPotentialKey key{};
    FemGpuPgbbPotentialPermit() = default;
    FemGpuPgbbPotentialPermit(const FemGpuPgbbPotentialPermit &) = delete;
    FemGpuPgbbPotentialPermit &operator=(const FemGpuPgbbPotentialPermit &) = delete;
    FemGpuPgbbPotentialPermit(FemGpuPgbbPotentialPermit &&other) noexcept
        : valid(std::exchange(other.valid, false)), key(other.key) {}
    FemGpuPgbbPotentialPermit &operator=(FemGpuPgbbPotentialPermit &&other) noexcept
    {
        if (this != &other) {
            valid = std::exchange(other.valid, false);
            key = other.key;
        }
        return *this;
    }
};

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

// Private native-fixture seams, following the existing nonlinear-CG failure seam.
enum class GpuRelaxPgbbFailurePoint : uint32_t {
    None = 0, AfterTrialField = 1, DuringAcceptedStatistics = 2, RejectFirstTrial = 3,
};

struct FemGpuRelaxationDeviceState {
    uint32_t bb_preconditioner_policy = 0; // auto, none, exchange_mass
    std::shared_ptr<GpuBbExchangeMassWorkspace> bb_exchange_mass;
    FemGpuComponentField bb_preconditioned_gradient;
    uint64_t bb_preconditioner_wall_time_ns = 0;
    uint32_t bb_preconditioner_cache_hits = 0;
    uint32_t bb_preconditioner_cache_misses = 0;
    FemGpuComponentField projected_gradient_accepted_h_eff;
    FemGpuComponentField nonlinear_cg_direction;
    FemGpuComponentField nonlinear_cg_direction_backup;
    uint64_t node_count = 0;
    uint64_t state_generation = 0;
    bool nonlinear_cg_direction_valid = false;
    FemGpuAcceptedEvaluationToken accepted_evaluation;
    FemGpuPgbbFieldToken pgbb_accepted_field;
    FemGpuPgbbPotentialToken pgbb_accepted_potential;
    GpuRelaxPgbbFailurePoint next_pgbb_failure = GpuRelaxPgbbFailurePoint::None;
    uint32_t accepted_evaluation_cache_hits_current_step = 0;
    uint32_t accepted_evaluation_cache_misses_current_step = 0;
    uint32_t accepted_evaluation_invalidations_current_step = 0;
    GpuRelaxNcgFailurePoint next_nonlinear_cg_failure =
        GpuRelaxNcgFailurePoint::None;
    uint64_t nonlinear_cg_failures_injected = 0;
    uint32_t direct_energy_refinements_current_step = 0;
    uint64_t direct_energy_refinements = 0;
};

inline void gpu_relax_invalidate_accepted_evaluation(
    FemGpuRelaxationDeviceState &state) noexcept
{
    if (state.accepted_evaluation.valid) {
        state.accepted_evaluation.invalidations += 1;
        state.accepted_evaluation_invalidations_current_step += 1;
    }
    state.accepted_evaluation.valid = false;
    state.pgbb_accepted_field.valid = false;
    state.pgbb_accepted_potential.valid = false;
}

inline void gpu_relax_reset_step_diagnostics(
    FemGpuRelaxationDeviceState &state) noexcept
{
    state.bb_preconditioner_wall_time_ns = 0;
    state.bb_preconditioner_cache_hits = 0;
    state.bb_preconditioner_cache_misses = 0;
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
