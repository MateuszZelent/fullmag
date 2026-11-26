#pragma once
#include "gpu/cuda/state/component_field.hpp"
#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>

namespace fullmag::fem {
struct GpuBbCsr {
    const int *rows;
    const int *columns;
    const double *values;
};
struct GpuBbPcgResult {
    double scaled_rhs_norm_squared[3];
    double scaled_residual_norm_squared[3];
    double sigma[3];
    double tau_tilde[3];
    double rho[3];
    double denominator[3];
    double alpha[3];
    double beta[3];
    int component_iterations[3];
    int component_status[3]; // 0 active, 1 converged, 2 iter limit, 3 invalid, 4 non-SPD, 5 certificate
    int iterations;
    int status; // 1 certified, 2 iteration limit, 3 invalid, 4 non-SPD, 5 certificate
};
struct GpuBbPcgDevice {
    GpuBbCsr mass;
    GpuBbCsr regularized_mass;
    GpuBbCsr stiffness;
    FemGpuComponentField rhs, residual, search, applied;
    double *inv_sqrt_diagonal;
    double *block_sums;
    GpuBbPcgResult *result;
};

// Returns the supported resident grid size; zero means no cooperative CUDA
// execution. There is deliberately no host Krylov fallback.
cudaError_t gpu_bb_pcg_grid_size(int n, int &blocks);
cudaError_t gpu_bb_pcg_launch(
    const GpuBbPcgDevice &workspace,
    const FemGpuComponentField &gradient,
    const FemGpuComponentField &solution,
    int n, int blocks, double weight,
    cudaStream_t stream);
} // namespace fullmag::fem
#endif
