#pragma once

/*
 * GPU CUDA legacy sparse exchange device-state module header.
 *
 * Owns the device-side CSR, dimensions, readiness flag, and byte accounting
 * for the legacy sparse GPU exchange path. Shared integration metrics such as
 * lumped mass live in the GPU mesh metrics state.
 */

#include <cstdint>
#include "gpu/cuda/sparse/sparse_apply_plan.hpp"

namespace fullmag::fem {

struct LegacyGpuExchangeDeviceState {
    bool uploaded = false;
    bool row_scale_ready = false;
    SparseApplyPlan plan{};
    uint64_t rows = 0;
    uint64_t cols = 0;
    uint64_t nnz = 0;
    uint64_t device_bytes = 0;
    uint32_t *csr_row_offsets = nullptr;
    uint32_t *csr_col_indices = nullptr;
    double *csr_values = nullptr;
    double *row_scale = nullptr;
    // Optional class-level P^T K P representation for periodic exchange.
    bool periodic_reduced_ready = false;
    uint64_t periodic_reduced_rows = 0;
    uint64_t periodic_reduced_nnz = 0;
    uint64_t periodic_reduced_device_bytes = 0;
    uint32_t *periodic_reduced_row_offsets = nullptr;
    uint32_t *periodic_reduced_col_indices = nullptr;
    double *periodic_reduced_values = nullptr;
    double *periodic_reduced_mass = nullptr;
    double *periodic_reduced_hx = nullptr;
    double *periodic_reduced_hy = nullptr;
    double *periodic_reduced_hz = nullptr;
};

} // namespace fullmag::fem
