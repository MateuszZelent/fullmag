#pragma once

#include "fullmag/fdm/transport/gpu_abi_v1.h"

#include <cuda_runtime_api.h>

#include <array>
#include <cstdint>

namespace fullmag::fdm::gpu::transport::charge {

struct CudaFailurePolicy {
    uint32_t requested_boundary = 0;
    uint32_t failed_boundary = 0;
};

struct Buffers {
    uint8_t *active = nullptr;
    double *conductivity = nullptr;
    double *potential = nullptr;
    double *jx = nullptr;
    double *jy = nullptr;
    double *jz = nullptr;
    double *interface_from_trace_v = nullptr;
    double *interface_to_trace_v = nullptr;
    double *interface_delta_trace_v = nullptr;
    double *interface_charge_current_density = nullptr;
    uint64_t cells = 0;
    uint64_t jx_count = 0;
    uint64_t jy_count = 0;
    uint64_t jz_count = 0;
    uint64_t interface_count = 0;
};

struct HierarchyCache {
    uint8_t *active = nullptr;
    double *conductivity = nullptr;
    double *diag = nullptr;
    double *rhs = nullptr;
    double *gx = nullptr;
    double *gy = nullptr;
    double *gz = nullptr;
    double *coarse_diag = nullptr;
    uint64_t *aggregate = nullptr;
    uint64_t *coarse_edge_a = nullptr;
    uint64_t *coarse_edge_b = nullptr;
    double *coarse_edge_weight = nullptr;
    void *hierarchy_info = nullptr;
    uint64_t cells = 0;
    uint64_t coarse_cells = 0;
    bool valid = false;
};

struct SolveInput {
    std::array<uint64_t, 3> grid{};
    std::array<double, 3> cell_size{};
    std::array<void *, 6> payloads{};
    std::array<fullmag_fdm_gpu_transport_buffer_view_v1, 6> views{};
    cudaStream_t stream = nullptr;
    uint64_t allocator_limit = 0;
    uint64_t static_owned_bytes = 0;
    uint64_t workspace_limit = 0;
    double relative_tolerance = 0.0;
    uint64_t max_iterations = 0;
    HierarchyCache *hierarchy_cache = nullptr;
    CudaFailurePolicy *failure_policy = nullptr;
};

struct SolveOutput {
    Buffers buffers{};
    uint64_t iterations = 0;
    uint64_t amg_apply_count = 0;
    uint64_t hierarchy_build_count = 0;
    uint64_t cache_hit_count = 0;
    uint64_t fine_unknown_count = 0;
    uint64_t coarse_unknown_count = 0;
    uint8_t hierarchy_digest[32]{};
    uint32_t reason = FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_UNSET;
    uint32_t hierarchy_levels = 0;
    double algebraic_residual = 0.0;
    double physical_residual = 0.0;
    double component_balance = 0.0;
    double electrode_balance = 0.0;
    uint64_t transfer_count = 0;
    uint64_t transfer_bytes = 0;
    uint64_t peak_bytes = 0;
};

struct ContentDigestIdentity {
    std::array<uint8_t, 16> device_uuid{};
    std::array<uint8_t, 32> build_digest{};
    std::array<uint8_t, 32> static_digest{};
    std::array<uint8_t, 16> lineage{};
    std::array<uint64_t, 3> grid{};
    std::array<double, 3> cell_size{};
    uint32_t compute_major = 0;
    uint32_t compute_minor = 0;
    uint32_t cuda_driver = 0;
    uint32_t cuda_runtime = 0;
    uint64_t descriptor_revision = 0;
    uint64_t source_revision = 0;
    uint64_t accepted_sequence = 0;
    uint64_t iterations = 0;
    double component_balance = 0.0;
    double physical_residual = 0.0;
};

void release(Buffers &buffers) noexcept;
void release(HierarchyCache &cache) noexcept;
uint32_t solve_device(const SolveInput &input, SolveOutput *output) noexcept;
uint32_t materialize_static_state(
    const SolveInput &input, Buffers *buffers, uint32_t boundary = 0) noexcept;
uint32_t validate_static_payload_device(
    const SolveInput &input, uint32_t copy_boundary = 0,
    uint32_t sync_boundary = 0) noexcept;
uint32_t content_digest_device(
    const Buffers &buffers, const void *charge_faces, uint64_t charge_face_count,
    uint64_t charge_face_stride, const void *interfaces, uint64_t interface_stride,
    const ContentDigestIdentity &identity, cudaStream_t stream,
    uint8_t digest[32], CudaFailurePolicy *failure_policy = nullptr,
    uint32_t copy_boundary = 0, uint32_t sync_boundary = 0) noexcept;

} // namespace fullmag::fdm::gpu::transport::charge
