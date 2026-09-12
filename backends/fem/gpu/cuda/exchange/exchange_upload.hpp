#pragma once

/*
 * GPU CUDA legacy sparse exchange upload module header.
 *
 * Owns validation, reset, allocation, host-to-device transfer, and byte
 * accounting for the legacy sparse GPU exchange CSR path.
 */

#include "gpu/cuda/exchange/exchange_state.hpp"
#include "gpu/cuda/mesh/mesh_metrics_state.hpp"
#include "gpu/cuda/state/lifecycle_state.hpp"
#include "gpu/cuda/transfer/transfer_audit.hpp"

#include <cstdint>
#include <string>

namespace fullmag::fem {

void gpu_exchange_reset_legacy_sparse(
    FemGpuLifecycleDeviceState &lifecycle,
    LegacyGpuExchangeDeviceState &legacy_exchange,
    FemGpuMeshMetricsDeviceState &mesh_metrics);

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
    const uint32_t *periodic_reduced_node = nullptr,
    uint64_t periodic_reduced_node_len = 0,
    const uint32_t *periodic_representative_nodes = nullptr,
    uint64_t periodic_representative_nodes_len = 0,
    uint64_t periodic_reduced_node_count = 0);

} // namespace fullmag::fem
