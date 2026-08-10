#pragma once

#include <cstdint>

namespace fullmag::fdm::gpu::transport::spin::memory {

enum class Policy : uint8_t {
    automatic = 0,
    fixed = 1,
};

enum class Preflight : uint8_t {
    ready = 0,
    arithmetic_overflow = 1,
    insufficient_allocator_limit = 2,
    insufficient_workspace_limit = 3,
    insufficient_device_memory = 4,
};

// tracked_resident_bytes excludes old_accepted_bytes. required_new_bytes is
// the maximum phase allocation high-water; workspace_bytes is reported and
// limited separately, not added to that high-water a second time.
struct Input {
    uint64_t total_device_bytes = 0;
    uint64_t free_device_bytes = 0;
    uint64_t static_baseline_bytes = 0;
    uint64_t tracked_resident_bytes = 0;
    uint64_t required_new_bytes = 0;
    uint64_t phase_peak_bytes = 0;
    uint64_t workspace_bytes = 0;
    uint64_t context_bytes = 0;
    uint64_t old_accepted_bytes = 0;
    uint64_t allocator_limit_bytes = 0;
    uint64_t workspace_limit_bytes = 0;
    bool first_solve = true;
    bool first_required_is_conservative_upper_bound = false;
};

struct Plan {
    Policy policy = Policy::automatic;
    Preflight preflight = Preflight::arithmetic_overflow;
    uint64_t total_device_bytes = 0;
    uint64_t free_device_bytes = 0;
    uint64_t static_baseline_bytes = 0;
    uint64_t reserve_bytes = 0;
    uint64_t usable_bytes = 0;
    uint64_t tracked_resident_bytes = 0;
    uint64_t required_new_bytes = 0;
    uint64_t phase_peak_bytes = 0;
    uint64_t workspace_bytes = 0;
    uint64_t context_bytes = 0;
    uint64_t old_accepted_bytes = 0;
    uint64_t allocator_limit_bytes = 0;
    uint64_t workspace_limit_bytes = 0;
    uint64_t real_free_limit_bytes = 0;
    uint64_t effective_limit_bytes = 0;
    uint64_t new_allocation_required_bytes = 0;
    uint64_t first_required_bytes = 0;
    uint64_t warm_required_bytes = 0;
    uint64_t applicable_required_bytes = 0;
    bool first_solve = true;
    bool first_required_is_conservative_upper_bound = false;
};

Plan plan(const Input &input) noexcept;

struct UpperBound {
    bool valid = false;
    uint64_t persistent_storage_bytes = 0;
    uint64_t candidate_bytes = 0;
    uint64_t hierarchy_bytes = 0;
    uint64_t coarse_cell_sum = 0;
    uint64_t krylov_basis_bytes = 0;
    uint64_t work_vector_bytes = 0;
    uint64_t coarse_vector_bytes = 0;
    uint64_t reduction_scalar_bytes = 0;
    uint64_t workspace_bytes = 0;
    uint64_t hierarchy_build_phase_peak_bytes = 0;
    uint64_t solve_phase_peak_bytes = 0;
    uint64_t materialization_phase_peak_bytes = 0;
    uint64_t phase_peak_bytes = 0;
};

UpperBound estimate_upper_bound(const uint64_t grid[3], uint64_t interface_count,
                                uint64_t retained_storage_bytes,
                                uint64_t retained_hierarchy_bytes,
                                uint64_t retained_coarse_cell_sum,
                                bool is_warm) noexcept;

}  // namespace fullmag::fdm::gpu::transport::spin::memory
