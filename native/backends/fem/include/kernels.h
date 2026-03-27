// ── S11: CUDA kernel declarations for fused LLG + field ops ───────────
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#include <cstddef>

namespace fullmag::fem {

/// Fused LLG RHS: dm/dt = -γ̄ (m×H + α m×(m×H)), per-block max reduction.
void fullmag_cuda_llg_rhs_fused(
    const double *mx, const double *my, const double *mz,
    const double *hx, const double *hy, const double *hz,
    double *dmx, double *dmy, double *dmz,
    double *block_max_rhs,
    double gamma, double alpha,
    int N, cudaStream_t stream = nullptr);

/// Normalize each (mx,my,mz) to unit length.
void fullmag_cuda_normalize_vectors(
    double *mx, double *my, double *mz,
    int N, cudaStream_t stream = nullptr);

/// h_eff = h_ex + h_demag [+ h_ext] (element-wise, SOA component).
void fullmag_cuda_accumulate_heff(
    const double *h_ex, const double *h_demag, const double *h_ext,
    double *h_eff,
    int N, bool has_ext, cudaStream_t stream = nullptr);

/// Query/execute CUB device-wide max reduction.
/// Call once with temp_storage=nullptr to get temp_storage_bytes,
/// then again with allocated buffer.
void fullmag_cuda_device_max(
    const double *data, int N, double *result,
    void *temp_storage, size_t &temp_storage_bytes,
    cudaStream_t stream = nullptr);

} // namespace fullmag::fem

#endif // FULLMAG_HAS_CUDA_RUNTIME
