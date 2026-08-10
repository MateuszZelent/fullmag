#pragma once

#include <cuda_runtime_api.h>

#include <cstdint>

namespace fullmag::fdm::gpu::transport::spin::sparse {

inline constexpr uint32_t kRestart = 50;
inline constexpr uint32_t kMaximumLevels = 20;
enum class ConvergenceReason : uint32_t {
    unset = 0,
    converged = 1,
    maximum_iterations = 2,
    non_finite = 3,
    launch_failure = 4,
};

enum class PreconditionerPolicy : uint32_t {
    identity_diagnostic = 0,
    block_jacobi_diagnostic = 1,
    component_amg_block_jacobi_v1 = 2,
};

template <typename T>
struct Triple {
    T values[3]{};
    __host__ __device__ T &operator[](uint32_t index) { return values[index]; }
    __host__ __device__ const T &operator[](uint32_t index) const {
        return values[index];
    }
};

// All arrays are device-resident. Vector fields use component-major SoA.
// local_block_soa stores nine N-entry lanes in row-major block order.
struct Operator {
    Triple<uint64_t> grid{};
    Triple<double> cell_size{};
    const uint8_t *active = nullptr;
    const double *spin_conductivity = nullptr;
    const double *local_block_soa = nullptr;
    const uint64_t *interface_row_offsets = nullptr;
    const uint32_t *interface_columns = nullptr;
    const double *interface_blocks_soa = nullptr;
    uint64_t interface_nonzeros = 0;
    const double *rhs_soa = nullptr;
    double *solution_soa = nullptr;
    uint64_t operator_revision = 0;
    uint8_t operator_digest[32]{};
    PreconditionerPolicy preconditioner =
        PreconditionerPolicy::component_amg_block_jacobi_v1;
    // Bytes already resident in the owning transport context. They are part of
    // the frozen whole-context high-water gate, even though sparse does not own
    // or release them.
    uint64_t resident_external_bytes = 0;
    uint64_t resolved_device_budget_bytes = 0;
};

struct Level {
    Triple<uint64_t> grid{};
    uint32_t coarsen_from_parent[3]{1, 1, 1};
    uint32_t strong_direction_mask = 0;
    uint8_t *active = nullptr;
    double *gx = nullptr;
    double *gy = nullptr;
    double *gz = nullptr;
    double *diagonal = nullptr;
    uint8_t *strong_edges = nullptr;
    uint64_t cells = 0;
    uint64_t bytes = 0;
};

struct HierarchyCache {
    Level levels[kMaximumLevels]{};
    uint32_t level_count = 0;
    uint64_t operator_revision = 0;
    uint8_t operator_digest[32]{};
    Triple<uint64_t> fine_grid{};
    uint64_t owned_bytes = 0;
    uint64_t cache_hits = 0;
    bool valid = false;
};

struct Workspace {
    double *basis = nullptr;
    double *vector_a = nullptr;
    double *vector_b = nullptr;
    double *vector_c = nullptr;
    double *coarse_vectors = nullptr;
    double *reduction_partials = nullptr;
    double *small = nullptr;
    uint32_t *device_status = nullptr;
    uint64_t vector_unknowns = 0;
    uint64_t coarse_vector_values = 0;
    uint64_t reduction_blocks = 0;
    uint64_t owned_bytes = 0;
};

struct ByteLedger {
    uint64_t external_context = 0;
    uint64_t hierarchy = 0;
    uint64_t krylov_basis = 0;
    uint64_t work_vectors = 0;
    uint64_t coarse_vectors = 0;
    uint64_t reductions_and_scalars = 0;
    uint64_t total_high_water = 0;
};

struct BuildMetrics {
    uint64_t fine_unknowns = 0;
    uint64_t coarse_unknowns = 0;
    uint32_t level_count = 0;
    uint64_t peak_device_bytes = 0;
    double setup_milliseconds = 0.0;
    ByteLedger bytes{};
};

struct SolveMetrics {
    uint64_t iterations = 0;
    uint64_t amg_applications = 0;
    ConvergenceReason reason = ConvergenceReason::unset;
    double relative_residual = 0.0;
    uint64_t forbidden_transfer_bytes = 0;
    uint64_t peak_device_bytes = 0;
    double apply_milliseconds = 0.0;
    double solve_milliseconds = 0.0;
    double reduction_milliseconds = 0.0;
    uint32_t restart_count = 0;
    double restart_residuals[32]{};
    ByteLedger bytes{};
};

struct PreconditionerAuditMetrics {
    double additive_relative_error = 0.0;
    double homogeneity_relative_error = 0.0;
    double repeat_relative_error = 0.0;
    double energy = 0.0;
    uint32_t level_count = 0;
    double residual_ratios[kMaximumLevels]{};
    double energy_cosines[kMaximumLevels]{};
    double down_phase_residuals[kMaximumLevels]{};
    double up_phase_residuals[kMaximumLevels]{};
};

uint32_t prepare(const Operator &input, cudaStream_t stream,
                 HierarchyCache *hierarchy, Workspace *workspace,
                 BuildMetrics *metrics) noexcept;

uint32_t solve(const Operator &input, cudaStream_t stream,
               const HierarchyCache &hierarchy, Workspace &workspace,
               double relative_tolerance, uint64_t max_iterations,
               SolveMetrics *metrics) noexcept;

uint32_t audit_preconditioner(const Operator &input, cudaStream_t stream,
                              const HierarchyCache &hierarchy,
                              Workspace &workspace,
                              PreconditionerAuditMetrics *metrics) noexcept;

void release(Workspace *workspace) noexcept;
void release(HierarchyCache *hierarchy) noexcept;

} // namespace fullmag::fdm::gpu::transport::spin::sparse
