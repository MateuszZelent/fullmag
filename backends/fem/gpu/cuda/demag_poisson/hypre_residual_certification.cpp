/*
 * Shared GPU HYPRE demag residual certification source.
 *
 * Computes optional independent residual r = A*x - b on the caller's borrowed
 * HYPRE stream while preserving sticky HYPRE error semantics and failure-path
 * stream synchronization, then evaluates ||b||_2 and optional ||r||_2 in one
 * multi-block fused pair-norm readback.
 */

#include "gpu/cuda/demag_poisson/hypre_residual_certification.hpp"

#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
#include <HYPRE_parcsr_mv.h>
#include <HYPRE_utilities.h>

#include <cmath>
#include <string>
#include <utility>
#endif

namespace fullmag::fem {

#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)

bool certify_gpu_hypre_demag_residual(
    const GpuDemagResidualCertInput &input,
    GpuDemagResidualCertOutput &output,
    std::string &error)
{
    output = GpuDemagResidualCertOutput{};
    const char *label = (input.label != nullptr && input.label[0] != '\0')
        ? input.label
        : "GPU Poisson demag";

    if (input.stream == nullptr ||
        input.b_par == nullptr ||
        input.scratch == nullptr ||
        input.scratch->d_partials == nullptr ||
        input.scratch->d_out_norms == nullptr ||
        input.scratch->h_norms == nullptr ||
        input.rows <= 0 ||
        input.b_par->Size() != input.rows ||
        (input.compute_independent_residual &&
         (input.A_par == nullptr ||
          input.x_par == nullptr ||
          input.residual == nullptr ||
          input.x_par->Size() != input.rows ||
          input.residual->Size() != input.rows))) {
        error = std::string(label) +
            " residual validation requires initialized device vectors, scratch, and HYPRE stream";
        return false;
    }

    const cudaStream_t stream = input.stream;
    const auto reject_queued_work = [&](std::string message) {
        // The stage may clear the candidate on the Fullmag stream after
        // failure. A rejected matvec can still have queued HYPRE work.
        const cudaError_t status = cudaStreamSynchronize(stream);
        error = std::move(message);
        if (status != cudaSuccess) {
            error += std::string("; synchronize HYPRE validation stream failed: ") +
                cudaGetErrorString(status);
        }
        return false;
    };

    if (input.compute_independent_residual) {
        // Preserve sticky HYPRE status semantics verbatim without clearing
        // unrelated prior errors or masking new errors during Mult/AXPY.
        const HYPRE_Int prior_status = HYPRE_GetError();
        if ((prior_status & ~HYPRE_ERROR_CONV) != 0) {
            error = std::string(label) + " residual validation found HYPRE status " +
                std::to_string(prior_status);
            return false;
        }
        input.A_par->HypreRead();
        input.x_par->HypreRead();
        input.b_par->HypreRead();
        input.residual->HypreWrite();
        const HYPRE_Int matvec_status =
            input.A_par->Mult(*input.x_par, *input.residual);
        if (matvec_status != 0) {
            return reject_queued_work(
                std::string(label) + " residual matvec failed: HYPRE status " +
                std::to_string(matvec_status));
        }
        const HYPRE_Int axpy_status =
            HYPRE_ParVectorAxpy(-1.0, *input.b_par, *input.residual);
        // AXPY returns the sticky HYPRE status, including an earlier
        // nonconvergence bit. Certification must still detect new errors.
        if ((axpy_status & ~(prior_status & HYPRE_ERROR_CONV)) != 0) {
            return reject_queued_work(
                std::string(label) + " residual AXPY failed: HYPRE status " +
                std::to_string(axpy_status));
        }
    }

    const auto memory_class = mfem::GetHypreMemoryClass();
    input.b_par->HypreRead();
    const double *rhs_data = input.b_par->GetMemory().Read(memory_class, input.rows);
    const double *residual_data = nullptr;
    if (input.compute_independent_residual) {
        input.residual->HypreRead();
        residual_data = input.residual->GetMemory().Read(memory_class, input.rows);
    }
    if (rhs_data == nullptr ||
        (input.compute_independent_residual && residual_data == nullptr)) {
        return reject_queued_work(
            std::string(label) +
            " residual validation could not resolve HYPRE device vector pointers");
    }

    double rhs_norm = 0.0;
    double residual_norm = 0.0;
    const cudaError_t norm_status = fullmag_cuda_demag_validation_norm_pair(
        rhs_data,
        residual_data,
        input.rows,
        *input.scratch,
        rhs_norm,
        residual_norm,
        stream);
    if (norm_status != cudaSuccess) {
        return reject_queued_work(
            std::string(label) + " validation norm pair failed: " +
            cudaGetErrorString(norm_status));
    }

    const uint64_t readback_bytes =
        (input.compute_independent_residual ? 2u : 1u) * sizeof(double);
    output.rhs_norm = rhs_norm;
    output.absolute_residual =
        input.compute_independent_residual ? residual_norm : 0.0;
    output.computed_independent_residual = input.compute_independent_residual;
    output.scalar_readback_count = 1u;
    output.control_fence_count = 1u;
    output.control_d2h_bytes = readback_bytes;

    // Check RHS finiteness strictly before residual finiteness: a NaN RHS
    // propagates into r = A*x - b, and callers expect the RHS diagnosis first.
    if (!std::isfinite(output.rhs_norm)) {
        return reject_queued_work(std::string(label) + " RHS norm is nonfinite");
    }
    if (input.compute_independent_residual && !std::isfinite(output.absolute_residual)) {
        return reject_queued_work(std::string(label) + " residual norm is nonfinite");
    }
    return true;
}

#endif

} // namespace fullmag::fem
