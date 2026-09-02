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

#include "gpu/cuda/demag_poisson/hypre_stream_interop.hpp"

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

enum class GpuDemagRecoveryMode : uint32_t {
    SplitCsr = 0,
    SharedPatternFusedXyz = 1,
};

struct GpuDemagPoissonWorkspace {
    std::string operator_fingerprint;
    uint64_t operator_build_count = 0;
    uint64_t operator_upload_count = 0;
    DeviceCsrTriple rhs;
    DeviceCsrScalar recovery_x;
    DeviceCsrScalar recovery_y;
    DeviceCsrScalar recovery_z;
    // A fused XYZ recovery is legal only when all three component operators
    // have exactly the same row-offset and column-index pattern.  Values may
    // differ.  Keep the digest/mode as setup telemetry and retain split CSR as
    // the fail-closed fallback.
    uint64_t recovery_xyz_pattern_digest = 0;
    GpuDemagRecoveryMode recovery_mode = GpuDemagRecoveryMode::SplitCsr;
    DeviceCsrScalar visual_recovery_x;
    DeviceCsrScalar visual_recovery_y;
    DeviceCsrScalar visual_recovery_z;
    uint64_t visual_recovery_xyz_pattern_digest = 0;
    GpuDemagRecoveryMode visual_recovery_mode = GpuDemagRecoveryMode::SplitCsr;
    DeviceCsrScalar robin_boundary_mass;
    std::vector<uint32_t> ess_tdofs;
#if FULLMAG_HAS_CUDA_RUNTIME
    uint32_t *d_ess_tdofs = nullptr;
    HypreStreamInterop stream_interop{};
#endif
#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
    HYPRE_BigInt row_starts[2] = {0, 0};
    std::unique_ptr<mfem::HypreParMatrix> A_par;
    std::unique_ptr<mfem::HypreSolver> preconditioner;
    std::unique_ptr<mfem::HypreSolver> solver;
    std::unique_ptr<mfem::HypreParVector> b_par;
    std::unique_ptr<mfem::HypreParVector> x_par;
    std::unique_ptr<mfem::HypreParVector> residual;
#endif
    uint64_t device_bytes = 0;
    uint64_t solver_setup_count = 0;
    uint64_t fresh_zero_guess_count = 0;
    uint64_t warm_start_count = 0;
    bool solver_setup_complete = false;
    bool ready = false;
};

// Builds P1-state/resolved-order-potential operators for nonperiodic Poisson
// demag and retains the node-class-reduced P1/P1 operator for the periodic path.
bool build_mixed_demag_operators(
    Context &ctx,
    GpuDemagPoissonWorkspace &workspace,
    std::string &error);

bool build_fredkin_koehler_demag_operators(
    Context &ctx,
    GpuDemagPoissonWorkspace &workspace,
    std::string &error);

// Compatibility entrypoint used by existing GPU lifecycle callers.
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
