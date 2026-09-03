/*
 * GPU CUDA legacy sparse exchange upload source contract.
 *
 * Keeps legacy sparse exchange CSR upload/reset ownership in the CUDA exchange
 * module instead of FemGpuState lifecycle code.
 */

#include "gpu/cuda/exchange/exchange_upload.hpp"

#include "gpu/cuda/exchange/exchange_operator.hpp"
#include "gpu/cuda/state/device_memory.hpp"

#include <algorithm>
#include <limits>
#include <vector>

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#endif

namespace fullmag::fem {

namespace {

#if FULLMAG_HAS_CUDA_RUNTIME
bool cuda_ok(cudaError_t rc, const char *operation, std::string &error)
{
    if (rc == cudaSuccess) {
        return true;
    }
    error = std::string(operation) + " failed: " + cudaGetErrorString(rc);
    return false;
}
#endif

} // namespace

void gpu_exchange_reset_legacy_sparse(
    FemGpuLifecycleDeviceState &lifecycle,
    LegacyGpuExchangeDeviceState &legacy_exchange,
    FemGpuMeshMetricsDeviceState &mesh_metrics)
{
    const uint64_t previous_device_bytes =
        legacy_exchange.device_bytes + mesh_metrics.device_bytes;
    gpu_device_free_u32(legacy_exchange.csr_row_offsets);
    gpu_device_free_u32(legacy_exchange.csr_col_indices);
    gpu_device_free_double(legacy_exchange.csr_values);
    gpu_device_free_double(legacy_exchange.row_scale);
    gpu_device_free_u32(legacy_exchange.periodic_reduced_row_offsets);
    gpu_device_free_u32(legacy_exchange.periodic_reduced_col_indices);
    gpu_device_free_double(legacy_exchange.periodic_reduced_values);
    gpu_device_free_double(legacy_exchange.periodic_reduced_mass);
    gpu_device_free_double(legacy_exchange.periodic_reduced_hx);
    gpu_device_free_double(legacy_exchange.periodic_reduced_hy);
    gpu_device_free_double(legacy_exchange.periodic_reduced_hz);
    gpu_device_free_double(mesh_metrics.lumped_mass);
    gpu_device_free_double(mesh_metrics.inv_lumped_mass);
    if (previous_device_bytes <= lifecycle.device_bytes) {
        lifecycle.device_bytes -= previous_device_bytes;
    } else {
        lifecycle.device_bytes = 0;
    }
    legacy_exchange.uploaded = false;
    legacy_exchange.row_scale_ready = false;
    legacy_exchange.rows = 0;
    legacy_exchange.cols = 0;
    legacy_exchange.nnz = 0;
    legacy_exchange.device_bytes = 0;
    legacy_exchange.plan.reset();
    legacy_exchange.row_scale = nullptr;
    legacy_exchange.periodic_reduced_ready = false;
    legacy_exchange.periodic_reduced_rows = 0;
    legacy_exchange.periodic_reduced_nnz = 0;
    legacy_exchange.periodic_reduced_device_bytes = 0;
    legacy_exchange.periodic_reduced_row_offsets = nullptr;
    legacy_exchange.periodic_reduced_col_indices = nullptr;
    legacy_exchange.periodic_reduced_values = nullptr;
    legacy_exchange.periodic_reduced_mass = nullptr;
    legacy_exchange.periodic_reduced_hx = nullptr;
    legacy_exchange.periodic_reduced_hy = nullptr;
    legacy_exchange.periodic_reduced_hz = nullptr;
    mesh_metrics.uploaded = false;
    mesh_metrics.device_bytes = 0;
}

bool gpu_exchange_upload_legacy_sparse(
    FemGpuLifecycleDeviceState &lifecycle,
    LegacyGpuExchangeDeviceState &legacy_exchange,
    FemGpuMeshMetricsDeviceState &mesh_metrics,
    uint64_t rows,
    uint64_t cols,
    const uint32_t *csr_row_offsets,
    uint64_t csr_row_offsets_len,
    const uint32_t *csr_col_indices,
    uint64_t csr_col_indices_len,
    const double *csr_values,
    uint64_t csr_values_len,
    const double *lumped_mass,
    uint64_t lumped_mass_len,
    const double *inv_lumped_mass,
    uint64_t inv_lumped_mass_len,
    TransferAudit &audit,
    std::string &error,
    const uint32_t *periodic_reduced_node,
    uint64_t periodic_reduced_node_len,
    const uint32_t *periodic_representative_nodes,
    uint64_t periodic_representative_nodes_len,
    uint64_t periodic_reduced_node_count)
{
    if (!lifecycle.allocated) {
        return true;
    }
    if (rows == 0 || cols == 0) {
        error = "FemGpuState exchange CSR upload requires non-empty dimensions";
        return false;
    }
    if (rows > std::numeric_limits<uint32_t>::max() ||
        cols > std::numeric_limits<uint32_t>::max()) {
        error = "FemGpuState exchange CSR dimensions exceed u32 device indexing";
        return false;
    }
    const uint64_t nnz = csr_values_len;
    if (csr_row_offsets == nullptr || csr_col_indices == nullptr || csr_values == nullptr ||
        lumped_mass == nullptr || inv_lumped_mass == nullptr) {
        error = "FemGpuState exchange CSR upload received a null pointer";
        return false;
    }
    if (csr_row_offsets_len != rows + 1ull ||
        csr_col_indices_len != nnz ||
        lumped_mass_len != rows ||
        inv_lumped_mass_len != rows) {
        error = "FemGpuState exchange CSR upload length mismatch";
        return false;
    }

#if FULLMAG_HAS_CUDA_RUNTIME
    GpuExchangePeriodicReducedCsr periodic_reduced{};
    const bool periodic_reduced_requested =
        periodic_reduced_node_count > 0u && periodic_reduced_node_count <= rows;
    if (periodic_reduced_requested) {
        if (periodic_reduced_node == nullptr ||
            periodic_reduced_node_len != rows ||
            periodic_representative_nodes == nullptr ||
            periodic_representative_nodes_len != periodic_reduced_node_count) {
            error = "GPU periodic reduced exchange maps are incomplete";
            return false;
        }
        const std::vector<uint32_t> reduced_node(
            periodic_reduced_node,
            periodic_reduced_node + rows);
        const std::vector<uint32_t> representative_nodes(
            periodic_representative_nodes,
            periodic_representative_nodes + periodic_reduced_node_count);
        const std::vector<uint32_t> host_row_offsets(
            csr_row_offsets,
            csr_row_offsets + csr_row_offsets_len);
        const std::vector<uint32_t> host_col_indices(
            csr_col_indices,
            csr_col_indices + csr_col_indices_len);
        const std::vector<double> host_values(
            csr_values,
            csr_values + csr_values_len);
        const std::vector<double> host_lumped_mass(
            lumped_mass,
            lumped_mass + lumped_mass_len);
        if (!build_gpu_exchange_periodic_reduced_csr(
                static_cast<uint32_t>(rows),
                host_row_offsets,
                host_col_indices,
                host_values,
                host_lumped_mass,
                reduced_node,
                representative_nodes,
                static_cast<uint32_t>(periodic_reduced_node_count),
                periodic_reduced,
                error)) {
            return false;
        }
    }
    gpu_exchange_reset_legacy_sparse(lifecycle, legacy_exchange, mesh_metrics);

    uint64_t exchange_device_bytes = 0;
    uint64_t mesh_metric_device_bytes = 0;
    if (!gpu_device_allocate_u32(legacy_exchange.csr_row_offsets, csr_row_offsets_len, exchange_device_bytes, error) ||
        !gpu_device_allocate_u32(legacy_exchange.csr_col_indices, csr_col_indices_len, exchange_device_bytes, error) ||
        !gpu_device_allocate_double(legacy_exchange.csr_values, nnz, exchange_device_bytes, error) ||
        !gpu_device_allocate_double(legacy_exchange.row_scale, rows, exchange_device_bytes, error) ||
        !gpu_device_allocate_double(mesh_metrics.lumped_mass, rows, mesh_metric_device_bytes, error) ||
        !gpu_device_allocate_double(mesh_metrics.inv_lumped_mass, rows, mesh_metric_device_bytes, error)) {
        gpu_exchange_reset_legacy_sparse(lifecycle, legacy_exchange, mesh_metrics);
        return false;
    }
    const uint64_t base_exchange_device_bytes = exchange_device_bytes;

    if (periodic_reduced_requested) {
        if (!gpu_device_allocate_u32(
                legacy_exchange.periodic_reduced_row_offsets,
                periodic_reduced.row_offsets.size(),
                exchange_device_bytes,
                error) ||
            !gpu_device_allocate_u32(
                legacy_exchange.periodic_reduced_col_indices,
                periodic_reduced.col_indices.size(),
                exchange_device_bytes,
                error) ||
            !gpu_device_allocate_double(
                legacy_exchange.periodic_reduced_values,
                periodic_reduced.values.size(),
                exchange_device_bytes,
                error) ||
            !gpu_device_allocate_double(
                legacy_exchange.periodic_reduced_mass,
                periodic_reduced.reduced_mass.size(),
                exchange_device_bytes,
                error) ||
            !gpu_device_allocate_double(
                legacy_exchange.periodic_reduced_hx,
                periodic_reduced.reduced_mass.size(),
                exchange_device_bytes,
                error) ||
            !gpu_device_allocate_double(
                legacy_exchange.periodic_reduced_hy,
                periodic_reduced.reduced_mass.size(),
                exchange_device_bytes,
                error) ||
            !gpu_device_allocate_double(
                legacy_exchange.periodic_reduced_hz,
                periodic_reduced.reduced_mass.size(),
                exchange_device_bytes,
                error)) {
            gpu_exchange_reset_legacy_sparse(lifecycle, legacy_exchange, mesh_metrics);
            return false;
        }
    }

    const size_t row_offsets_bytes = static_cast<size_t>(csr_row_offsets_len) * sizeof(uint32_t);
    const size_t col_indices_bytes = static_cast<size_t>(csr_col_indices_len) * sizeof(uint32_t);
    const size_t values_bytes = static_cast<size_t>(nnz) * sizeof(double);
    const size_t mass_bytes = static_cast<size_t>(rows) * sizeof(double);
    if (!cuda_ok(cudaMemcpy(
                legacy_exchange.csr_row_offsets,
                csr_row_offsets,
                row_offsets_bytes,
                cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState exchange CSR row_offsets host->device",
            error) ||
        !cuda_ok(cudaMemcpy(
                legacy_exchange.csr_col_indices,
                csr_col_indices,
                col_indices_bytes,
                cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState exchange CSR col_indices host->device",
            error) ||
        !cuda_ok(cudaMemcpy(
                legacy_exchange.csr_values,
                csr_values,
                values_bytes,
                cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState exchange CSR values host->device",
            error) ||
        !cuda_ok(cudaMemcpy(
                mesh_metrics.lumped_mass,
                lumped_mass,
                mass_bytes,
                cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState exchange lumped_mass host->device",
            error) ||
        !cuda_ok(cudaMemcpy(
                 mesh_metrics.inv_lumped_mass,
                inv_lumped_mass,
                mass_bytes,
                cudaMemcpyHostToDevice),
            "cudaMemcpy FemGpuState exchange inv_lumped_mass host->device",
             error) ||
        (periodic_reduced_requested &&
         (!cuda_ok(cudaMemcpy(
                  legacy_exchange.periodic_reduced_row_offsets,
                  periodic_reduced.row_offsets.data(),
                  periodic_reduced.row_offsets.size() * sizeof(uint32_t),
                  cudaMemcpyHostToDevice),
              "cudaMemcpy FemGpuState periodic reduced row offsets host->device",
              error) ||
          !cuda_ok(cudaMemcpy(
                  legacy_exchange.periodic_reduced_col_indices,
                  periodic_reduced.col_indices.data(),
                  periodic_reduced.col_indices.size() * sizeof(uint32_t),
                  cudaMemcpyHostToDevice),
              "cudaMemcpy FemGpuState periodic reduced column indices host->device",
              error) ||
          !cuda_ok(cudaMemcpy(
                  legacy_exchange.periodic_reduced_values,
                  periodic_reduced.values.data(),
                  periodic_reduced.values.size() * sizeof(double),
                  cudaMemcpyHostToDevice),
              "cudaMemcpy FemGpuState periodic reduced values host->device",
              error) ||
          !cuda_ok(cudaMemcpy(
                  legacy_exchange.periodic_reduced_mass,
                  periodic_reduced.reduced_mass.data(),
                  periodic_reduced.reduced_mass.size() * sizeof(double),
                  cudaMemcpyHostToDevice),
              "cudaMemcpy FemGpuState periodic reduced mass host->device",
              error)))) {
        gpu_exchange_reset_legacy_sparse(lifecycle, legacy_exchange, mesh_metrics);
        return false;
    }

    lifecycle.device_bytes += exchange_device_bytes + mesh_metric_device_bytes;
    legacy_exchange.uploaded = true;
    legacy_exchange.rows = rows;
    legacy_exchange.cols = cols;
    legacy_exchange.nnz = nnz;
    legacy_exchange.device_bytes = exchange_device_bytes;
    SparseApplyCsrDeviceView ex_csr{
        legacy_exchange.csr_row_offsets,
        legacy_exchange.csr_col_indices,
        legacy_exchange.csr_values,
        static_cast<uint32_t>(rows),
        static_cast<uint32_t>(cols),
    };
    std::string plan_err;
    if (!legacy_exchange.plan.setup(ex_csr, nullptr, plan_err, /*allow_cusparse=*/false)) {
        error = "failed to setup exchange sparse apply plan: " + plan_err;
        return false;
    }
    legacy_exchange.periodic_reduced_ready = periodic_reduced_requested;
    legacy_exchange.periodic_reduced_rows = periodic_reduced_requested
        ? periodic_reduced_node_count : 0u;
    legacy_exchange.periodic_reduced_nnz = periodic_reduced_requested
        ? periodic_reduced.values.size() : 0u;
    legacy_exchange.periodic_reduced_device_bytes = periodic_reduced_requested
        ? exchange_device_bytes - base_exchange_device_bytes : 0u;
    mesh_metrics.uploaded = true;
    mesh_metrics.node_count = rows;
    mesh_metrics.device_bytes = mesh_metric_device_bytes;
    record_host_to_device(
        audit,
        static_cast<uint64_t>(row_offsets_bytes + col_indices_bytes + values_bytes) +
            static_cast<uint64_t>(mass_bytes) * 2ull +
            (periodic_reduced_requested
                ? static_cast<uint64_t>(periodic_reduced.row_offsets.size() * sizeof(uint32_t) +
                    periodic_reduced.col_indices.size() * sizeof(uint32_t) +
                    periodic_reduced.values.size() * sizeof(double) +
                    periodic_reduced.reduced_mass.size() * sizeof(double))
                : 0ull));
    return true;
#else
    (void)audit;
    error = "FemGpuState was marked allocated but fullmag_fem was built without CUDA runtime support";
    return false;
#endif
}

} // namespace fullmag::fem
