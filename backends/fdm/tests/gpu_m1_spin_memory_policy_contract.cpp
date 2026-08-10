#include "gpu/cuda/transport/spin/memory_policy.hpp"

#include <cstdint>
#include <cstdio>
#include <limits>

namespace memory = fullmag::fdm::gpu::transport::spin::memory;

namespace {

constexpr uint64_t MiB = UINT64_C(1024) * 1024;
constexpr uint64_t GiB = UINT64_C(1024) * 1024 * 1024;

bool expect(bool condition, const char *message) {
    if (!condition) std::fprintf(stderr, "FAIL: %s\n", message);
    return condition;
}

memory::Input base_input() {
    memory::Input input{};
    input.total_device_bytes = 16 * GiB;
    input.free_device_bytes = 12 * GiB;
    input.static_baseline_bytes = 4 * GiB;
    input.tracked_resident_bytes = 128 * MiB;
    input.required_new_bytes = 256 * MiB;
    input.phase_peak_bytes = 640 * MiB;
    input.workspace_bytes = 384 * MiB;
    input.context_bytes = 32 * MiB;
    input.old_accepted_bytes = 192 * MiB;
    input.first_solve = true;
    input.first_required_is_conservative_upper_bound = true;
    return input;
}

}  // namespace

int main() {
    bool ok = true;

    {
        const memory::Plan plan = memory::plan(base_input());
        ok &= expect(plan.preflight == memory::Preflight::ready,
                     "auto plan must pass with sufficient device memory");
        ok &= expect(plan.policy == memory::Policy::automatic,
                     "allocator limit zero must resolve automatic policy");
        ok &= expect(plan.reserve_bytes == 16 * GiB / 20,
                     "reserve must be max(256 MiB, total/20)");
        ok &= expect(plan.usable_bytes == 12 * GiB - 16 * GiB / 20,
                     "automatic usable memory must subtract reserve from free memory");
        ok &= expect(plan.effective_limit_bytes ==
                         plan.tracked_resident_bytes + plan.usable_bytes,
                     "automatic effective limit must include tracked residency");
        ok &= expect(plan.first_required_bytes == 800 * MiB,
                     "first high-water must include tracked, phase high-water and context");
        ok &= expect(plan.warm_required_bytes == 992 * MiB,
                     "warm high-water must additionally include old accepted state");
        ok &= expect(plan.applicable_required_bytes == plan.first_required_bytes,
                     "first solve must select first required bytes");
        ok &= expect(plan.first_required_is_conservative_upper_bound,
                     "cold conservative-bound provenance must be preserved");
    }

    {
        memory::Input input = base_input();
        input.total_device_bytes = 4 * GiB;
        input.free_device_bytes = 256 * MiB;
        const memory::Plan plan = memory::plan(input);
        ok &= expect(plan.reserve_bytes == 256 * MiB,
                     "minimum reserve must be 256 MiB");
        ok &= expect(plan.usable_bytes == 0,
                     "free memory at reserve must produce zero usable bytes");
        ok &= expect(plan.preflight == memory::Preflight::insufficient_device_memory,
                     "new allocation must fail when free memory does not exceed reserve");
    }

    {
        memory::Input input = base_input();
        input.allocator_limit_bytes = 799 * MiB;
        const memory::Plan below = memory::plan(input);
        ok &= expect(below.policy == memory::Policy::fixed,
                     "nonzero allocator limit must resolve fixed policy");
        ok &= expect(below.preflight == memory::Preflight::insufficient_allocator_limit,
                     "fixed limit below high-water must fail closed");

        input.allocator_limit_bytes = 800 * MiB;
        const memory::Plan exact = memory::plan(input);
        ok &= expect(exact.preflight == memory::Preflight::ready,
                     "fixed limit equal to high-water must pass");
        ok &= expect(exact.effective_limit_bytes == 800 * MiB,
                     "fixed effective limit must preserve qualification limit");
    }

    {
        memory::Input input = base_input();
        input.allocator_limit_bytes = 2 * GiB;
        input.free_device_bytes = 800 * MiB;
        const memory::Plan plan = memory::plan(input);
        ok &= expect(plan.preflight == memory::Preflight::insufficient_device_memory,
                     "fixed policy must still respect actual free device memory");
    }

    {
        memory::Input cold_input = base_input();
        const memory::Plan cold = memory::plan(cold_input);
        cold_input.first_solve = false;
        const memory::Plan warm = memory::plan(cold_input);
        ok &= expect(cold.applicable_required_bytes == cold.first_required_bytes,
                     "cold solve must use first requirement");
        ok &= expect(warm.applicable_required_bytes == warm.warm_required_bytes,
                     "warm solve must use warm requirement");
        ok &= expect(warm.applicable_required_bytes - cold.applicable_required_bytes ==
                         cold_input.old_accepted_bytes,
                     "warm requirement must account for old accepted state exactly once");
        ok &= expect(warm.new_allocation_required_bytes ==
                         cold.new_allocation_required_bytes,
                     "old accepted state must not be counted as a new allocation");
    }

    {
        memory::Input input = base_input();
        input.required_new_bytes = std::numeric_limits<uint64_t>::max();
        const memory::Plan plan = memory::plan(input);
        ok &= expect(plan.preflight == memory::Preflight::arithmetic_overflow,
                     "required-byte overflow must fail closed");
    }

    {
        memory::Input input{};
        input.total_device_bytes = std::numeric_limits<uint64_t>::max();
        input.free_device_bytes = std::numeric_limits<uint64_t>::max();
        input.tracked_resident_bytes = std::numeric_limits<uint64_t>::max();
        const memory::Plan plan = memory::plan(input);
        ok &= expect(plan.preflight == memory::Preflight::arithmetic_overflow,
                     "automatic tracked-plus-usable limit overflow must fail closed");
    }

    {
        memory::Input input = base_input();
        input.workspace_limit_bytes = input.workspace_bytes - 1;
        const memory::Plan below = memory::plan(input);
        ok &= expect(below.preflight == memory::Preflight::insufficient_workspace_limit,
                     "workspace limit below requirement must fail closed");
        input.workspace_limit_bytes = input.workspace_bytes;
        const memory::Plan exact = memory::plan(input);
        ok &= expect(exact.preflight == memory::Preflight::ready,
                     "workspace limit equal to requirement must pass");
    }

    {
        const uint64_t grid[3]{64, 1, 1};
        const memory::UpperBound estimate =
            memory::estimate_upper_bound(grid, 2, 0, 0, 0, false);
        ok &= expect(estimate.valid, "cold upper-bound estimate must succeed");
        ok &= expect(estimate.persistent_storage_bytes == 9464,
                     "persistent storage must match device allocation formulas");
        ok &= expect(estimate.candidate_bytes == 19288,
                     "candidate storage must match device materialization formulas");
        ok &= expect(estimate.hierarchy_bytes == 2120,
                     "single-axis hierarchy bytes must be exact for a 64x1x1 grid");
        ok &= expect(estimate.coarse_cell_sum == 32,
                     "single-axis hierarchy coarse-cell sum must stop at 32 cells");
        ok &= expect(estimate.krylov_basis_bytes == 78336,
                     "GMRES basis must contain (restart+1)*3N doubles");
        ok &= expect(estimate.work_vector_bytes == 4608,
                     "workspace must contain three 3N work vectors");
        ok &= expect(estimate.coarse_vector_bytes == 3840,
                     "AMG workspace must contain 15 values per coarse cell");
        ok &= expect(estimate.reduction_scalar_bytes == 31744,
                     "reduction/scalar estimate must use conservative 1024-block bounds");
        ok &= expect(estimate.workspace_bytes == 118528,
                     "workspace components must sum exactly");
        ok &= expect(estimate.solve_phase_peak_bytes == 130112,
                     "solve peak must include persistent, hierarchy and workspace");
        ok &= expect(estimate.materialization_phase_peak_bytes == 30872,
                     "materialization peak must include persistent, hierarchy and candidate");
        ok &= expect(estimate.phase_peak_bytes == estimate.solve_phase_peak_bytes,
                     "phase peak must select the largest live phase");
    }

    {
        const uint64_t grid[3]{33, 33, 1};
        const memory::UpperBound estimate =
            memory::estimate_upper_bound(grid, 0, 0, 0, 0, false);
        ok &= expect(estimate.valid,
                     "multi-dimensional cold hierarchy enumeration must succeed");
        ok &= expect(estimate.coarse_cell_sum >= 17 * 33 + 9 * 33,
                     "upper bound must cover a legal repeated single-axis halving path");
    }

    {
        const uint64_t grid[3]{64, 1, 1};
        const memory::UpperBound warm =
            memory::estimate_upper_bound(grid, 2, 7000, 9000, 17, true);
        ok &= expect(warm.valid, "warm exact estimate must succeed");
        ok &= expect(warm.persistent_storage_bytes == 7000,
                     "warm estimate must use retained persistent storage exactly");
        ok &= expect(warm.hierarchy_bytes == 9000,
                     "warm estimate must use retained hierarchy exactly");
        ok &= expect(warm.coarse_cell_sum == 17,
                     "warm workspace must use retained coarse-cell sum exactly");
        ok &= expect(warm.coarse_vector_bytes == 15 * 17 * sizeof(double),
                     "warm coarse workspace must derive from retained hierarchy");
    }

    {
        const uint64_t huge[3]{std::numeric_limits<uint64_t>::max(), 2, 2};
        const memory::UpperBound estimate =
            memory::estimate_upper_bound(huge, 0, 0, 0, 0, false);
        ok &= expect(!estimate.valid,
                     "upper-bound grid arithmetic overflow must fail closed");
    }

    if (!ok) return 1;
    std::puts("PASS: FDM GPU M1 spin host memory policy contract");
    return 0;
}
