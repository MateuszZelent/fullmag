/*
 * GPU CUDA RK exchange dispatch source contract.
 *
 * This source owns validation and launch dispatch for the legacy sparse
 * exchange operator used by the GPU RK RHS runtime. It does not own exchange
 * assembly/upload, RHS orchestration, demag dispatch, local fields, LLG RHS,
 * RK stage scheduling, final statistics, or C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk_exchange_dispatch.hpp"

#include "gpu/cuda/exchange/exchange_kernels.hpp"
#include "gpu/cuda/runtime/execution_receipt.hpp"
#include "gpu/cuda/runtime/performance_counters.hpp"

#include <cuda_runtime.h>

#include <cstdint>
#include <limits>
#include <string>

namespace fullmag::fem {

namespace {

bool cuda_ok(cudaError_t rc, const char *operation, std::string &reason)
{
    if (rc == cudaSuccess) {
        return true;
    }
    reason = std::string(operation) + " failed: " + cudaGetErrorString(rc);
    return false;
}

bool cuda_launch_ok(const char *operation, std::string &reason)
{
    return cuda_ok(cudaPeekAtLastError(), operation, reason);
}

} // namespace

bool gpu_rk_compute_legacy_sparse_exchange(
    FemGpuState &gpu,
    const FemGpuComponentField &m,
    cudaStream_t stream,
    std::string &reason,
    FemGpuExecutionReceiptRuntimeState *execution_receipt,
    GpuPerformanceCounterState *performance_counters)
{
    if (!gpu.legacy_exchange.uploaded ||
        gpu.legacy_exchange.csr_row_offsets == nullptr ||
        gpu.legacy_exchange.csr_col_indices == nullptr ||
        gpu.legacy_exchange.csr_values == nullptr ||
        gpu.materials.ms == nullptr ||
        gpu.mesh_metrics.inv_lumped_mass == nullptr) {
        reason = "GPU legacy sparse exchange requires uploaded CSR/mass device buffers";
        return false;
    }
    if (gpu.legacy_exchange.rows != gpu.lifecycle.node_count ||
        gpu.legacy_exchange.cols != gpu.lifecycle.node_count ||
        gpu.lifecycle.node_count > static_cast<uint64_t>(std::numeric_limits<int>::max())) {
        reason = "GPU legacy sparse exchange dimensions do not match RK node_count";
        return false;
    }

    const int rows = static_cast<int>(gpu.lifecycle.node_count);
    bool periodic_reduced_path = false;
    if (gpu.mesh_regions.has_periodic_reduced_nodes) {
        if (gpu.mesh_metrics.lumped_mass == nullptr ||
            gpu.mesh_regions.periodic_reduced_node == nullptr ||
            gpu.mesh_regions.periodic_representative_nodes == nullptr ||
            gpu.mesh_regions.periodic_reduced_representative_nodes == nullptr) {
            reason = "GPU periodic sparse exchange requires lumped mass and periodic node maps";
            return false;
        }
        if (!gpu.legacy_exchange.periodic_reduced_ready ||
            gpu.legacy_exchange.periodic_reduced_row_offsets == nullptr ||
            gpu.legacy_exchange.periodic_reduced_col_indices == nullptr ||
            gpu.legacy_exchange.periodic_reduced_values == nullptr ||
            gpu.legacy_exchange.periodic_reduced_mass == nullptr ||
            gpu.legacy_exchange.periodic_reduced_hx == nullptr ||
            gpu.legacy_exchange.periodic_reduced_hy == nullptr ||
            gpu.legacy_exchange.periodic_reduced_hz == nullptr) {
            reason = "GPU periodic exchange requires a precomputed reduced CSR representation";
            return false;
        }
        if (gpu.legacy_exchange.periodic_reduced_rows == 0u ||
            gpu.legacy_exchange.periodic_reduced_rows > gpu.lifecycle.node_count ||
            gpu.legacy_exchange.periodic_reduced_rows >
                static_cast<uint64_t>(std::numeric_limits<int>::max()) ||
            gpu.mesh_regions.periodic_reduced_node_count !=
                gpu.legacy_exchange.periodic_reduced_rows) {
            reason = "GPU periodic exchange reduced row count is invalid";
            return false;
        }
        fullmag_cuda_periodic_reduced_exchange_xyz(
            gpu.legacy_exchange.periodic_reduced_row_offsets,
            gpu.legacy_exchange.periodic_reduced_col_indices,
            gpu.legacy_exchange.periodic_reduced_values,
            gpu.legacy_exchange.periodic_reduced_mass,
            m.x, m.y, m.z,
            gpu.materials.ms,
            gpu.mesh_regions.periodic_reduced_node,
            gpu.mesh_regions.periodic_reduced_representative_nodes,
            gpu.mesh_regions.magnetic_node_mask,
            gpu.legacy_exchange.periodic_reduced_hx,
            gpu.legacy_exchange.periodic_reduced_hy,
            gpu.legacy_exchange.periodic_reduced_hz,
            gpu.fields.h_ex.x,
            gpu.fields.h_ex.y,
            gpu.fields.h_ex.z,
            rows,
            static_cast<int>(gpu.legacy_exchange.periodic_reduced_rows),
            stream);
        periodic_reduced_path = true;
    } else {
        const auto ex_variant = gpu.legacy_exchange.plan.selected_variant();
        if (gpu.legacy_exchange.row_scale == nullptr) {
            // Keep the legacy three-launch realization as a compatibility
            // path for hand-built states that predate row-scale storage.
            fullmag_cuda_legacy_sparse_exchange(
                gpu.legacy_exchange.csr_row_offsets,
                gpu.legacy_exchange.csr_col_indices,
                gpu.legacy_exchange.csr_values,
                m.x,
                gpu.materials.ms,
                gpu.mesh_metrics.inv_lumped_mass,
                gpu.mesh_regions.magnetic_node_mask,
                gpu.fields.h_ex.x,
                rows,
                stream,
                ex_variant);
            fullmag_cuda_legacy_sparse_exchange(
                gpu.legacy_exchange.csr_row_offsets,
                gpu.legacy_exchange.csr_col_indices,
                gpu.legacy_exchange.csr_values,
                m.y,
                gpu.materials.ms,
                gpu.mesh_metrics.inv_lumped_mass,
                gpu.mesh_regions.magnetic_node_mask,
                gpu.fields.h_ex.y,
                rows,
                stream,
                ex_variant);
            fullmag_cuda_legacy_sparse_exchange(
                gpu.legacy_exchange.csr_row_offsets,
                gpu.legacy_exchange.csr_col_indices,
                gpu.legacy_exchange.csr_values,
                m.z,
                gpu.materials.ms,
                gpu.mesh_metrics.inv_lumped_mass,
                gpu.mesh_regions.magnetic_node_mask,
                gpu.fields.h_ex.z,
                rows,
                stream,
                ex_variant);
            if (execution_receipt != nullptr) {
                gpu_execution_receipt_note_performance_phase(
                    *execution_receipt,
                    FemGpuPerformancePhase::KernelLaunch,
                    0,
                    gpu.legacy_exchange.plan.selected_variant_id());
            }
        } else {
            if (!gpu.legacy_exchange.row_scale_ready) {
                fullmag_cuda_prepare_exchange_row_scale(
                    gpu.materials.ms,
                    gpu.legacy_exchange.row_scale,
                    rows,
                    stream);
                if (!cuda_launch_ok("launch GPU exchange row-scale preparation", reason)) {
                    return false;
                }
                gpu.legacy_exchange.row_scale_ready = true;
            }
            fullmag_cuda_legacy_sparse_exchange_xyz(
                gpu.legacy_exchange.csr_row_offsets,
                gpu.legacy_exchange.csr_col_indices,
                gpu.legacy_exchange.csr_values,
                m.x, m.y, m.z,
                gpu.legacy_exchange.row_scale,
                gpu.mesh_metrics.inv_lumped_mass,
                gpu.mesh_regions.magnetic_node_mask,
                gpu.fields.h_ex.x,
                gpu.fields.h_ex.y,
                gpu.fields.h_ex.z,
                rows,
                stream,
                ex_variant);
            if (execution_receipt != nullptr) {
                gpu_execution_receipt_note_performance_phase(
                    *execution_receipt,
                    FemGpuPerformancePhase::KernelLaunch,
                    0,
                    gpu.legacy_exchange.plan.selected_variant_id());
            }
        }
    }
    if (!cuda_launch_ok("launch GPU legacy sparse exchange", reason)) {
        return false;
    }
    // Count only the apply kernels; row-scale preparation is setup work and
    // is intentionally not charged to every RHS evaluation. Periodic and
    // compatibility split paths visit the same CSR once per component; the
    // fused path visits it once for all three components.
    const bool periodic = gpu.mesh_regions.has_periodic_reduced_nodes;
    const bool fused = !periodic && gpu.legacy_exchange.row_scale != nullptr;
    const uint64_t launch_count = periodic_reduced_path ? 2u : (fused ? 1u : 3u);
    const uint64_t nnz = gpu.legacy_exchange.nnz;
    GpuPerformanceCounterDelta performance_delta{};
    performance_delta.exchange_applies = 1u;
    performance_delta.exchange_launches = launch_count;
    if (periodic_reduced_path) {
        const uint64_t reduced_nnz = gpu.legacy_exchange.periodic_reduced_nnz;
        const uint64_t rows_u64 = gpu.lifecycle.node_count;
        performance_delta.exchange_nnz_visited =
            reduced_nnz > std::numeric_limits<uint64_t>::max() - rows_u64
                ? std::numeric_limits<uint64_t>::max()
                : reduced_nnz + rows_u64;
    } else {
        performance_delta.exchange_nnz_visited =
            nnz > std::numeric_limits<uint64_t>::max() / launch_count
                ? std::numeric_limits<uint64_t>::max()
                : nnz * launch_count;
    }
    if (performance_counters != nullptr) {
        gpu_performance_note(*performance_counters, performance_delta);
    }
    if (execution_receipt != nullptr &&
        gpu_execution_receipt_attempt_active(*execution_receipt)) {
        gpu_execution_receipt_note_device(
            *execution_receipt, FEM_GPU_OPERATOR_EXCHANGE);
    }
    return true;
}

} // namespace fullmag::fem
