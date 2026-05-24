#pragma once

/*
 * GPU CUDA legacy sparse exchange device-state module header.
 *
 * Owns the device-side CSR, dimensions, readiness flag, and byte accounting
 * for the legacy sparse GPU exchange path. Shared integration metrics such as
 * lumped mass live in the GPU mesh metrics state.
 */

#include <cstdint>

namespace fullmag::fem {

struct LegacyGpuExchangeDeviceState {
    bool uploaded = false;
    uint64_t rows = 0;
    uint64_t cols = 0;
    uint64_t nnz = 0;
    uint64_t device_bytes = 0;
    uint32_t *csr_row_offsets = nullptr;
    uint32_t *csr_col_indices = nullptr;
    double *csr_values = nullptr;
};

} // namespace fullmag::fem
