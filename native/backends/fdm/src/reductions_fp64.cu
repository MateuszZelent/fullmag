/*
 * reductions_fp64.cu — Scalar reduction kernels for fp64.
 *
 * Provides max-norm reduction for |H_eff| and |dm/dt| diagnostics.
 * Uses simple host-side reduction for Phase 2 correctness-first approach.
 */

#include "context.hpp"

#include <cuda_runtime.h>
#include <cmath>
#include <vector>
#include <algorithm>

namespace fullmag {
namespace fdm {

/// Compute max |v| over a SoA vector field.
/// Returns the maximum Euclidean norm across all cells.
double reduce_max_norm_fp64(
    const void *vx, const void *vy, const void *vz,
    uint64_t cell_count)
{
    std::vector<double> hx(cell_count), hy(cell_count), hz(cell_count);
    cudaMemcpy(hx.data(), vx, cell_count * sizeof(double), cudaMemcpyDeviceToHost);
    cudaMemcpy(hy.data(), vy, cell_count * sizeof(double), cudaMemcpyDeviceToHost);
    cudaMemcpy(hz.data(), vz, cell_count * sizeof(double), cudaMemcpyDeviceToHost);

    double max_norm = 0.0;
    for (uint64_t i = 0; i < cell_count; i++) {
        double norm = std::sqrt(
            hx[i] * hx[i] + hy[i] * hy[i] + hz[i] * hz[i]);
        if (norm > max_norm) max_norm = norm;
    }
    return max_norm;
}

/// Compute max |v| over a SoA fp32 vector field, returning fp64 result.
double reduce_max_norm_fp32(
    const void *vx, const void *vy, const void *vz,
    uint64_t cell_count)
{
    std::vector<float> hx(cell_count), hy(cell_count), hz(cell_count);
    cudaMemcpy(hx.data(), vx, cell_count * sizeof(float), cudaMemcpyDeviceToHost);
    cudaMemcpy(hy.data(), vy, cell_count * sizeof(float), cudaMemcpyDeviceToHost);
    cudaMemcpy(hz.data(), vz, cell_count * sizeof(float), cudaMemcpyDeviceToHost);

    double max_norm = 0.0;
    for (uint64_t i = 0; i < cell_count; i++) {
        double norm = std::sqrt(
            (double)hx[i] * hx[i] + (double)hy[i] * hy[i] + (double)hz[i] * hz[i]);
        if (norm > max_norm) max_norm = norm;
    }
    return max_norm;
}

} // namespace fdm
} // namespace fullmag
