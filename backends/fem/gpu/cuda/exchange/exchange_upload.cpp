/*
 * GPU CUDA legacy sparse exchange upload source contract.
 *
 * Keeps legacy sparse exchange CSR upload/reset ownership in the CUDA exchange
 * module instead of FemGpuState lifecycle code.
 */

#include "gpu/cuda/exchange/exchange_upload.hpp"

#include "gpu/cuda/state/device_memory.hpp"

#include <limits>

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
    gpu_device_free_double(mesh_metrics.lumped_mass);
    gpu_device_free_double(mesh_metrics.inv_lumped_mass);
    if (previous_device_bytes <= lifecycle.device_bytes) {
        lifecycle.device_bytes -= previous_device_bytes;
    } else {
        lifecycle.device_bytes = 0;
    }
    legacy_exchange.uploaded = false;
    legacy_exchange.rows = 0;
    legacy_exchange.cols = 0;
    legacy_exchange.nnz = 0;
    legacy_exchange.device_bytes = 0;
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
    std::string &error)
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
    gpu_exchange_reset_legacy_sparse(lifecycle, legacy_exchange, mesh_metrics);

    uint64_t exchange_device_bytes = 0;
    uint64_t mesh_metric_device_bytes = 0;
    if (!gpu_device_allocate_u32(legacy_exchange.csr_row_offsets, csr_row_offsets_len, exchange_device_bytes, error) ||
        !gpu_device_allocate_u32(legacy_exchange.csr_col_indices, csr_col_indices_len, exchange_device_bytes, error) ||
        !gpu_device_allocate_double(legacy_exchange.csr_values, nnz, exchange_device_bytes, error) ||
        !gpu_device_allocate_double(mesh_metrics.lumped_mass, rows, mesh_metric_device_bytes, error) ||
        !gpu_device_allocate_double(mesh_metrics.inv_lumped_mass, rows, mesh_metric_device_bytes, error)) {
        gpu_exchange_reset_legacy_sparse(lifecycle, legacy_exchange, mesh_metrics);
        return false;
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
            error)) {
        gpu_exchange_reset_legacy_sparse(lifecycle, legacy_exchange, mesh_metrics);
        return false;
    }

    lifecycle.device_bytes += exchange_device_bytes + mesh_metric_device_bytes;
    legacy_exchange.uploaded = true;
    legacy_exchange.rows = rows;
    legacy_exchange.cols = cols;
    legacy_exchange.nnz = nnz;
    legacy_exchange.device_bytes = exchange_device_bytes;
    mesh_metrics.uploaded = true;
    mesh_metrics.node_count = rows;
    mesh_metrics.device_bytes = mesh_metric_device_bytes;
    record_host_to_device(
        audit,
        static_cast<uint64_t>(row_offsets_bytes + col_indices_bytes + values_bytes) +
            static_cast<uint64_t>(mass_bytes) * 2ull);
    return true;
#else
    (void)audit;
    error = "FemGpuState was marked allocated but fullmag_fem was built without CUDA runtime support";
    return false;
#endif
}

} // namespace fullmag::fem
