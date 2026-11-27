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

#include "gpu/cuda/demag_poisson/cudss_direct_solver.hpp"
#include "gpu/cuda/demag_poisson/demag_kernels.hpp"
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
struct GpuDemagCudssDirectSolver;

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
    GpuValidationNormScratch validation_scratch{};
#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
    HYPRE_BigInt row_starts[2] = {0, 0};
    std::unique_ptr<mfem::HypreParMatrix> A_par;
    std::unique_ptr<mfem::HypreSolver> preconditioner;
    std::unique_ptr<mfem::HypreSolver> solver;
    std::unique_ptr<mfem::HypreParVector> b_par;
    std::unique_ptr<mfem::HypreParVector> x_par;
    std::unique_ptr<mfem::HypreParVector> residual;
#endif
    // Guarded cuDSS direct factor (docs/physics/0997); null on Krylov paths.
    // shared_ptr keeps the deleter, so the type may stay incomplete here.
    std::shared_ptr<GpuDemagCudssDirectSolver> direct_solver;
    GpuDemagCudssDirectStats direct_solver_stats{};
    uint64_t device_bytes = 0;
    uint64_t solver_setup_count = 0;
    uint64_t fresh_zero_guess_count = 0;
    uint64_t warm_start_count = 0;
    bool solver_setup_complete = false;
    bool ready = false;
    // Set once the host CSR copies were freed after a completed GPU setup;
    // such a workspace cannot be uploaded again and must be rebuilt.
    bool host_arrays_released = false;
};

// Debug A/B switch for the element-loop assembly of the mixed operators.
// Unset, empty, or "csr" selects the default two-pass CSR assembly; "maps"
// selects the legacy std::map row assembly; any other value fails closed.
// Both produce byte-identical arrays. Periodic node-class reduction always
// uses the row-map assembly.
inline constexpr const char *kDemagOperatorBuildEnv = "FULLMAG_FEM_DEMAG_OPERATOR_BUILD";

enum class GpuDemagOperatorBuildPath : uint32_t {
    Csr = 0,
    RowMaps = 1,
};

bool resolve_gpu_demag_operator_build_path(
    const char *env_value,
    GpuDemagOperatorBuildPath &path,
    std::string &error);

// Builds P1-state/resolved-order-potential operators for nonperiodic Poisson
// demag and retains the node-class-reduced P1/P1 operator for the periodic path.
// Reads FULLMAG_FEM_DEMAG_OPERATOR_BUILD on every call.
bool build_mixed_demag_operators(
    Context &ctx,
    GpuDemagPoissonWorkspace &workspace,
    std::string &error);

// Same build with an explicit assembly path, for A/B checks and tests.
bool build_mixed_demag_operators_with_path(
    Context &ctx,
    GpuDemagPoissonWorkspace &workspace,
    GpuDemagOperatorBuildPath requested_path,
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

// Frees the host copies of the uploaded CSR operators (RHS, recovery, visual
// recovery, Robin boundary mass) and returns the freed capacity in bytes.
// Keeps rows, nnz, device pointers, essential DOFs, and the fingerprint, which
// are all the GPU lane reads after setup. Call only after a completed GPU
// Poisson setup.
uint64_t release_demag_poisson_operator_host_arrays(GpuDemagPoissonWorkspace &workspace);

void destroy_demag_poisson_operators(GpuDemagPoissonWorkspace &workspace);

GpuDemagPoissonWorkspace *workspace_ptr(const Context &ctx);

} // namespace fullmag::fem
