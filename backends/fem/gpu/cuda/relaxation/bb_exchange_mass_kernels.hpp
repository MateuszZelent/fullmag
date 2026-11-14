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
    double rhs_norm_squared[3];
    double residual_norm_squared[3];
    double rho;
    double denominator;
    double alpha;
    double beta;
    int iterations;
    int status; // 1 certified, 2 iteration limit, 3 invalid, 4 non-SPD, 5 certificate
    unsigned int nonzero_rhs_mask;
};
struct GpuBbPcgDevice {
    GpuBbCsr mass;
    GpuBbCsr regularized_mass;
    GpuBbCsr stiffness;
    FemGpuComponentField rhs, residual, search, applied;
    double *inverse_diagonal;
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
