#pragma once

/*
 * GPU CUDA Poisson demag operator workspace header.
 *
 * Owns the internal device CSR operator records for strict GPU Poisson demag:
 * magnetic-source RHS, scalar-potential recovery, essential true DOFs, and
 * Hypre device workspace handles. Public lifecycle and stage-compute entrypoints
 * remain in poisson.hpp.
 */

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#endif

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
#include <HYPRE_utilities.h>
#endif

namespace fullmag::fem {

struct Context;

struct DeviceCsrTriple {
    uint64_t rows = 0;
    uint64_t nnz = 0;
    std::vector<uint32_t> row_offsets;
    std::vector<uint32_t> col_indices;
    std::vector<double> values_x;
    std::vector<double> values_y;
    std::vector<double> values_z;
#if FULLMAG_HAS_CUDA_RUNTIME
    uint32_t *d_row_offsets = nullptr;
    uint32_t *d_col_indices = nullptr;
    double *d_values_x = nullptr;
    double *d_values_y = nullptr;
    double *d_values_z = nullptr;
#endif
};

struct DeviceCsrScalar {
    uint64_t rows = 0;
    uint64_t nnz = 0;
    std::vector<uint32_t> row_offsets;
    std::vector<uint32_t> col_indices;
    std::vector<double> values;
#if FULLMAG_HAS_CUDA_RUNTIME
    uint32_t *d_row_offsets = nullptr;
    uint32_t *d_col_indices = nullptr;
    double *d_values = nullptr;
#endif
};

struct GpuDemagPoissonWorkspace {
    DeviceCsrTriple rhs;
    DeviceCsrScalar recovery_x;
    DeviceCsrScalar recovery_y;
    DeviceCsrScalar recovery_z;
    std::vector<uint32_t> ess_tdofs;
#if FULLMAG_HAS_CUDA_RUNTIME
    uint32_t *d_ess_tdofs = nullptr;
    cudaEvent_t compute_ready_event = nullptr;
    cudaEvent_t hypre_done_event = nullptr;
#endif
#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
    HYPRE_BigInt row_starts[2] = {0, 0};
    std::unique_ptr<mfem::HypreParMatrix> A_par;
    std::unique_ptr<mfem::HypreSolver> preconditioner;
    std::unique_ptr<mfem::HypreSolver> solver;
    std::unique_ptr<mfem::HypreParVector> b_par;
    std::unique_ptr<mfem::HypreParVector> x_par;
#endif
    uint64_t device_bytes = 0;
    bool ready = false;
};

bool build_p1_demag_operators(
    Context &ctx,
    GpuDemagPoissonWorkspace &workspace,
    std::string &error);

bool upload_demag_poisson_operators(
    GpuDemagPoissonWorkspace &workspace,
    uint64_t &device_bytes,
    std::string &error);

void destroy_demag_poisson_operators(GpuDemagPoissonWorkspace &workspace);

GpuDemagPoissonWorkspace *workspace_ptr(const Context &ctx);

} // namespace fullmag::fem
