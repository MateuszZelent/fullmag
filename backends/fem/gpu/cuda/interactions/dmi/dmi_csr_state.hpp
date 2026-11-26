#pragma once

/*
 * GPU CUDA sparse CSR DMI device-state module header.
 *
 * Owns device-side off-diagonal skew-symmetric nodal edge vector CSR buffers
 * (d_ij = -d_ji, R_i = sum_j d_ij x m_j) for interfacial (+ rotated) and bulk
 * DMI channels, plus optional periodic class-reduced P^T D P buffers.
 */

#include <cstdint>

namespace fullmag::fem {

struct GpuDmiCsrChannelDeviceState {
    bool uploaded = false;
    uint64_t rows = 0;
    uint64_t nnz = 0;
    uint64_t device_bytes = 0;
    uint32_t *csr_row_offsets = nullptr;
    uint32_t *csr_col_indices = nullptr;
    double *csr_dx = nullptr;
    double *csr_dy = nullptr;
    double *csr_dz = nullptr;

    // Optional periodic class-level P^T D P representation (docs/physics/0810).
    bool periodic_reduced_ready = false;
    uint64_t periodic_reduced_rows = 0;
    uint64_t periodic_reduced_nnz = 0;
    uint64_t periodic_reduced_device_bytes = 0;
    uint32_t *periodic_reduced_row_offsets = nullptr;
    uint32_t *periodic_reduced_col_indices = nullptr;
    double *periodic_reduced_dx = nullptr;
    double *periodic_reduced_dy = nullptr;
    double *periodic_reduced_dz = nullptr;
    double *periodic_reduced_mass = nullptr;
    double *periodic_reduced_rx = nullptr;
    double *periodic_reduced_ry = nullptr;
    double *periodic_reduced_rz = nullptr;
};

struct FemGpuDmiCsrDeviceState {
    GpuDmiCsrChannelDeviceState interfacial{};
    GpuDmiCsrChannelDeviceState bulk{};
};

} // namespace fullmag::fem
