#include "memory_policy.hpp"

#include <algorithm>
#include <limits>
#include <map>
#include <tuple>

namespace fullmag::fdm::gpu::transport::spin::memory {
namespace {

constexpr uint64_t minimum_reserve_bytes = UINT64_C(256) * 1024 * 1024;

bool checked_add(uint64_t left, uint64_t right, uint64_t *result) noexcept {
    if (left > std::numeric_limits<uint64_t>::max() - right) return false;
    *result = left + right;
    return true;
}

bool checked_mul(uint64_t left, uint64_t right, uint64_t *result) noexcept {
    if (left != 0 && right > std::numeric_limits<uint64_t>::max() / left)
        return false;
    *result = left * right;
    return true;
}

bool cells_of(const uint64_t grid[3], uint64_t *cells) noexcept {
    uint64_t xy = 0;
    return grid[0] != 0 && grid[1] != 0 && grid[2] != 0 &&
           checked_mul(grid[0], grid[1], &xy) &&
           checked_mul(xy, grid[2], cells);
}

bool face_count(const uint64_t grid[3], uint32_t axis, uint64_t *faces) noexcept {
    uint64_t extent = 0;
    uint64_t product = 0;
    if (!checked_add(grid[axis], 1, &extent)) return false;
    if (axis == 0)
        return checked_mul(extent, grid[1], &product) &&
               checked_mul(product, grid[2], faces);
    if (axis == 1)
        return checked_mul(grid[0], extent, &product) &&
               checked_mul(product, grid[2], faces);
    return checked_mul(grid[0], grid[1], &product) &&
           checked_mul(product, extent, faces);
}

bool level_bytes(const uint64_t grid[3], uint64_t *bytes) noexcept {
    uint64_t cells = 0;
    uint64_t fx = 0, fy = 0, fz = 0, faces = 0;
    uint64_t cell_bytes = 0, face_bytes = 0;
    return cells_of(grid, &cells) && face_count(grid, 0, &fx) &&
           face_count(grid, 1, &fy) && face_count(grid, 2, &fz) &&
           checked_add(fx, fy, &faces) && checked_add(faces, fz, &faces) &&
           checked_mul(cells, 26, &cell_bytes) &&
           checked_mul(faces, sizeof(double), &face_bytes) &&
           checked_add(cell_bytes, face_bytes, bytes);
}

struct HierarchyMaximum {
    bool valid = true;
    uint64_t bytes = 0;
    uint64_t coarse_cells = 0;
};

using HierarchyKey = std::tuple<uint64_t, uint64_t, uint64_t, uint32_t>;

HierarchyMaximum hierarchy_maximum(
    const uint64_t grid[3], uint32_t level_count,
    std::map<HierarchyKey, HierarchyMaximum> *memo) {
    uint64_t cells = 0;
    if (!cells_of(grid, &cells)) return {false, 0, 0};
    if (cells <= 32 || level_count >= 20) return {};
    const HierarchyKey key{grid[0], grid[1], grid[2], level_count};
    const auto found = memo->find(key);
    if (found != memo->end()) return found->second;

    HierarchyMaximum maximum{};
    bool has_child = false;
    for (uint32_t axis = 0; axis < 3; ++axis) {
        if (grid[axis] <= 1) continue;
        has_child = true;
        uint64_t coarse[3]{grid[0], grid[1], grid[2]};
        coarse[axis] = coarse[axis] / 2 + coarse[axis] % 2;
        uint64_t coarse_cells = 0, coarse_bytes = 0;
        if (!cells_of(coarse, &coarse_cells) ||
            !level_bytes(coarse, &coarse_bytes))
            return {false, 0, 0};
        const HierarchyMaximum tail =
            hierarchy_maximum(coarse, level_count + 1, memo);
        uint64_t path_bytes = 0, path_cells = 0;
        if (!tail.valid || !checked_add(coarse_bytes, tail.bytes, &path_bytes) ||
            !checked_add(coarse_cells, tail.coarse_cells, &path_cells))
            return {false, 0, 0};
        maximum.bytes = std::max(maximum.bytes, path_bytes);
        maximum.coarse_cells = std::max(maximum.coarse_cells, path_cells);
    }
    if (!has_child) maximum = {};
    memo->emplace(key, maximum);
    return maximum;
}

}  // namespace

Plan plan(const Input &input) noexcept {
    Plan output{};
    output.policy = input.allocator_limit_bytes == 0 ? Policy::automatic : Policy::fixed;
    output.total_device_bytes = input.total_device_bytes;
    output.free_device_bytes = input.free_device_bytes;
    output.static_baseline_bytes = input.static_baseline_bytes;
    output.reserve_bytes =
        std::max(minimum_reserve_bytes, input.total_device_bytes / UINT64_C(20));
    output.usable_bytes = input.free_device_bytes > output.reserve_bytes
        ? input.free_device_bytes - output.reserve_bytes
        : 0;
    output.tracked_resident_bytes = input.tracked_resident_bytes;
    output.required_new_bytes = input.required_new_bytes;
    output.phase_peak_bytes = input.phase_peak_bytes == 0
        ? input.required_new_bytes : input.phase_peak_bytes;
    output.workspace_bytes = input.workspace_bytes;
    output.context_bytes = input.context_bytes;
    output.old_accepted_bytes = input.old_accepted_bytes;
    output.allocator_limit_bytes = input.allocator_limit_bytes;
    output.workspace_limit_bytes = input.workspace_limit_bytes;
    output.real_free_limit_bytes = output.usable_bytes;
    if (output.policy == Policy::fixed) {
        output.effective_limit_bytes = input.allocator_limit_bytes;
    } else if (!checked_add(input.tracked_resident_bytes, output.usable_bytes,
                            &output.effective_limit_bytes)) {
        output.preflight = Preflight::arithmetic_overflow;
        return output;
    }
    output.first_solve = input.first_solve;
    output.first_required_is_conservative_upper_bound =
        input.first_required_is_conservative_upper_bound;

    if (!checked_add(input.required_new_bytes, input.context_bytes,
                     &output.new_allocation_required_bytes) ||
        !checked_add(input.tracked_resident_bytes, output.phase_peak_bytes,
                     &output.first_required_bytes) ||
        !checked_add(output.first_required_bytes, input.context_bytes,
                     &output.first_required_bytes) ||
        !checked_add(output.first_required_bytes, input.old_accepted_bytes,
                     &output.warm_required_bytes)) {
        output.preflight = Preflight::arithmetic_overflow;
        return output;
    }

    output.applicable_required_bytes = input.first_solve
        ? output.first_required_bytes
        : output.warm_required_bytes;

    if (input.workspace_limit_bytes != 0 &&
        input.workspace_bytes > input.workspace_limit_bytes) {
        output.preflight = Preflight::insufficient_workspace_limit;
        return output;
    }
    if (output.policy == Policy::fixed &&
        output.applicable_required_bytes > input.allocator_limit_bytes) {
        output.preflight = Preflight::insufficient_allocator_limit;
        return output;
    }
    if (output.new_allocation_required_bytes > output.usable_bytes) {
        output.preflight = Preflight::insufficient_device_memory;
        return output;
    }

    output.preflight = Preflight::ready;
    return output;
}

UpperBound estimate_upper_bound(const uint64_t grid[3], uint64_t interface_count,
                                uint64_t retained_storage_bytes,
                                uint64_t retained_hierarchy_bytes,
                                uint64_t retained_coarse_cell_sum,
                                bool is_warm) noexcept {
    UpperBound output{};
    if (grid == nullptr) return output;
    uint64_t cells = 0, unknowns = 0;
    uint64_t fx = 0, fy = 0, fz = 0, face_sum = 0;
    if (!cells_of(grid, &cells) || !checked_mul(cells, 3, &unknowns) ||
        !face_count(grid, 0, &fx) || !face_count(grid, 1, &fy) ||
        !face_count(grid, 2, &fz) || !checked_add(fx, fy, &face_sum) ||
        !checked_add(face_sum, fz, &face_sum))
        return output;

    if (is_warm) {
        output.persistent_storage_bytes = retained_storage_bytes;
        output.hierarchy_bytes = retained_hierarchy_bytes;
        output.coarse_cell_sum = retained_coarse_cell_sum;
    } else {
        uint64_t cell_storage = 0, interface_storage = 0;
        if (!checked_mul(cells, 137, &cell_storage) ||
            !checked_mul(interface_count, 324, &interface_storage) ||
            !checked_add(cell_storage, interface_storage,
                         &output.persistent_storage_bytes) ||
            !checked_add(output.persistent_storage_bytes, 48,
                         &output.persistent_storage_bytes))
            return output;
        try {
            std::map<HierarchyKey, HierarchyMaximum> memo;
            const HierarchyMaximum hierarchy = hierarchy_maximum(grid, 1, &memo);
            if (!hierarchy.valid) return output;
            output.hierarchy_bytes = hierarchy.bytes;
            output.coarse_cell_sum = hierarchy.coarse_cells;
        } catch (...) {
            return output;
        }
    }

    uint64_t q_values = 0, candidate_values = 0, candidate_double_bytes = 0;
    uint64_t region_bytes = 0, observation_bytes = 0;
    if (!checked_mul(face_sum, 3, &q_values) ||
        !checked_mul(cells, 21, &candidate_values) ||
        !checked_add(candidate_values, q_values, &candidate_values) ||
        !checked_mul(candidate_values, sizeof(double), &candidate_double_bytes) ||
        !checked_mul(cells, sizeof(uint32_t), &region_bytes) ||
        !checked_mul(interface_count, 288, &observation_bytes) ||
        !checked_add(candidate_double_bytes, region_bytes,
                     &output.candidate_bytes) ||
        !checked_add(output.candidate_bytes, observation_bytes,
                     &output.candidate_bytes))
        return output;

    uint64_t basis_values = 0, work_values = 0, coarse_values = 0;
    constexpr uint64_t reduction_and_scalar_values = UINT64_C(1024) + 2816;
    constexpr uint64_t conservative_device_status_bytes = 1024;
    if (!checked_mul(unknowns, 51, &basis_values) ||
        !checked_mul(basis_values, sizeof(double), &output.krylov_basis_bytes) ||
        !checked_mul(unknowns, 3, &work_values) ||
        !checked_mul(work_values, sizeof(double), &output.work_vector_bytes) ||
        !checked_mul(output.coarse_cell_sum, 15, &coarse_values) ||
        !checked_mul(coarse_values, sizeof(double), &output.coarse_vector_bytes) ||
        !checked_mul(reduction_and_scalar_values, sizeof(double),
                     &output.reduction_scalar_bytes) ||
        !checked_add(output.reduction_scalar_bytes,
                     conservative_device_status_bytes,
                     &output.reduction_scalar_bytes))
        return output;

    uint64_t workspace_partial = 0;
    if (!checked_add(output.krylov_basis_bytes, output.work_vector_bytes,
                     &workspace_partial) ||
        !checked_add(workspace_partial, output.coarse_vector_bytes,
                     &workspace_partial) ||
        !checked_add(workspace_partial, output.reduction_scalar_bytes,
                     &output.workspace_bytes))
        return output;

    uint64_t persistent_and_hierarchy = 0;
    if (!checked_add(output.persistent_storage_bytes, output.hierarchy_bytes,
                     &persistent_and_hierarchy) ||
        !checked_add(persistent_and_hierarchy, output.workspace_bytes,
                     &output.solve_phase_peak_bytes) ||
        !checked_add(persistent_and_hierarchy, output.candidate_bytes,
                     &output.materialization_phase_peak_bytes))
        return output;
    if (!is_warm) {
        if (!checked_add(persistent_and_hierarchy, 3 * sizeof(uint64_t),
                         &output.hierarchy_build_phase_peak_bytes))
            return output;
    }
    output.phase_peak_bytes = std::max(
        output.hierarchy_build_phase_peak_bytes,
        std::max(output.solve_phase_peak_bytes,
                 output.materialization_phase_peak_bytes));
    output.valid = true;
    return output;
}

}  // namespace fullmag::fdm::gpu::transport::spin::memory
