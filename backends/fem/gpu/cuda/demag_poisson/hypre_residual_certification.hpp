#pragma once

/*
 * Shared GPU HYPRE demag residual certification header.
 *
 * Declares the solver tolerance margin helper and unified multi-block residual
 * certification interface shared by strict GPU Poisson and GPU FEM/BEM solves.
 */

#include "gpu/cuda/demag_poisson/demag_kernels.hpp"

#include <cstdint>
#include <string>

#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
#include <cuda_runtime.h>
#include <mfem.hpp>
#endif

namespace fullmag::fem {

/// Tighter solver stopping tolerance below the independent residual threshold.
inline double certification_solver_tolerance(double requested_rtol) noexcept
{
    return requested_rtol > 0.0 ? requested_rtol * 0.1 : requested_rtol;
}

#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)

struct GpuDemagResidualCertInput {
    const char *label = "GPU Poisson demag";
    mfem::HypreParMatrix *A_par = nullptr;
    mfem::HypreParVector *b_par = nullptr;
    mfem::HypreParVector *x_par = nullptr;
    mfem::HypreParVector *residual = nullptr;
    GpuValidationNormScratch *scratch = nullptr;
    bool compute_independent_residual = true;
    int rows = 0;
    cudaStream_t stream = nullptr;
};

struct GpuDemagResidualCertOutput {
    double rhs_norm = 0.0;
    double absolute_residual = 0.0;
    bool computed_independent_residual = false;
    uint32_t scalar_readback_count = 0;
    uint32_t control_fence_count = 0;
    uint64_t control_d2h_bytes = 0;
};

/*
 * Computes optional r = A*x - b on the caller's stream (preserving sticky
 * HYPRE error status semantics and failure-path stream synchronization), then
 * evaluates ||b||_2 and (when requested) ||r||_2 via one fused multi-block
 * pair-norm readback.
 */
bool certify_gpu_hypre_demag_residual(
    const GpuDemagResidualCertInput &input,
    GpuDemagResidualCertOutput &output,
    std::string &error);

#endif

} // namespace fullmag::fem
