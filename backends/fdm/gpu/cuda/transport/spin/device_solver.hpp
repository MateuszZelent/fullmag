#pragma once

#include "fullmag/fdm/transport/gpu_abi_v1.h"
#include "sparse_solver.hpp"

#include <cuda_runtime_api.h>

#include <cstdint>

namespace fullmag::fdm::gpu::transport::spin {

// The v1 public contract freezes restarted GMRES at 50.  Keeping the value in
// the device-solver owner prevents a caller from silently selecting a
// different Krylov realization while retaining the same provenance IDs.
inline constexpr uint64_t kGmresRestartV1 = 50;

struct Buffers {
    double *mu_x = nullptr;
    double *mu_y = nullptr;
    double *mu_z = nullptr;
    double *qx = nullptr;
    double *qy = nullptr;
    double *qz = nullptr;
    double *reaction_sf = nullptr;
    double *reaction_j = nullptr;
    double *reaction_phi = nullptr;
    double *torque_volume = nullptr;
    double *torque_surface = nullptr;
    double *torque_total = nullptr;
    uint32_t *cell_region_ids = nullptr;
    fullmag_fdm_gpu_transport_spin_observation_record_v1 *interface_observations = nullptr;
    uint64_t cells = 0;
    uint64_t qx_values = 0;
    uint64_t qy_values = 0;
    uint64_t qz_values = 0;
    uint64_t observation_count = 0;
    uint64_t interface_observation_count = 0;
    uint64_t owned_bytes = 0;
};

struct SparseOperatorStorage {
    uint8_t *active = nullptr;
    double *spin_conductivity = nullptr;
    double *local_block_soa = nullptr;
    double *rhs_soa = nullptr;
    double *solution_soa = nullptr;
    uint64_t *interface_row_offsets = nullptr;
    uint32_t *interface_columns = nullptr;
    uint32_t *interface_record_indices = nullptr;
    uint8_t *interface_roles = nullptr;
    double *interface_blocks_soa = nullptr;
    unsigned long long *digest_accumulator = nullptr;
    uint64_t cells = 0;
    uint64_t interface_count = 0;
    uint64_t interface_nonzeros = 0;
    uint64_t owned_bytes = 0;
};

struct SparseState {
    SparseOperatorStorage storage{};
    sparse::HierarchyCache hierarchy{};
    sparse::Workspace workspace{};
    uint64_t hierarchy_build_count = 0;
    uint64_t hierarchy_cache_hit_count = 0;
    uint64_t amg_apply_count = 0;
    uint64_t fine_unknown_count = 0;
    uint64_t coarse_unknown_count = 0;
    uint32_t hierarchy_levels = 0;
    uint8_t hierarchy_digest[32]{};
};

struct SolveInput {
    uint64_t grid[3]{};
    double cell_size[3]{};
    void *payloads[6]{};
    fullmag_fdm_gpu_transport_buffer_view_v1 views[6]{};
    const double *accepted_potential = nullptr;
    const double *accepted_jx = nullptr;
    const double *accepted_jy = nullptr;
    const double *accepted_jz = nullptr;
    uint64_t accepted_jx_count = 0;
    uint64_t accepted_jy_count = 0;
    uint64_t accepted_jz_count = 0;
    const double *accepted_interface_from_trace_v = nullptr;
    const double *accepted_interface_to_trace_v = nullptr;
    const double *accepted_interface_delta_trace_v = nullptr;
    const double *accepted_interface_charge_current_density = nullptr;
    uint64_t accepted_interface_count = 0;
    uint8_t accepted_snapshot_digest[32]{};
    const double *m_stage = nullptr;
    double *torque_destination = nullptr;
    cudaStream_t stream = nullptr;
    uint64_t allocator_limit = 0;
    uint64_t workspace_limit = 0;
    double relative_tolerance = 0.0;
    uint64_t max_iterations = 0;
    SparseState *sparse_state = nullptr;
    uint64_t operator_revision = 0;
    uint64_t resident_external_bytes = 0;
    const uint64_t *interface_negative_cells_host = nullptr;
    const uint64_t *interface_positive_cells_host = nullptr;
};

struct SolveOutput {
    Buffers buffers{};
    uint64_t iterations = 0;
    uint32_t reason = FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_UNSET;
    double algebraic_residual = 0.0;
    double local_balance = 0.0;
    double global_balance = 0.0;
    double interface_balance = 0.0;
    double torque_balance = 0.0;
    uint64_t transfer_count = 0;
    uint64_t transfer_bytes = 0;
    uint64_t peak_bytes = 0;
    uint64_t amg_apply_count = 0;
    uint64_t fine_unknowns = 0;
    uint64_t coarse_unknowns = 0;
    uint32_t hierarchy_levels = 0;
    uint8_t hierarchy_digest[32]{};
    uint8_t deterministic_compute_digest[32]{};
    uint64_t hierarchy_build_count = 0;
    uint64_t cache_hit_count = 0;
};

void release(Buffers &buffers) noexcept;
void release(SparseState &state) noexcept;
uint32_t materialize_observation_range(
    const Buffers &buffers, uint64_t range_begin, uint64_t range_count,
    fullmag_fdm_gpu_transport_spin_observation_record_v1 *destination_device,
    cudaStream_t stream) noexcept;
uint32_t solve_device(const SolveInput &input, SolveOutput *output) noexcept;
uint32_t test_direct_she_signs_device(double output[18]) noexcept;

} // namespace fullmag::fdm::gpu::transport::spin
