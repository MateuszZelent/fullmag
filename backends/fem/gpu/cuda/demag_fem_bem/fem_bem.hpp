#pragma once

/*
 * Strict CUDA Fredkin-Koehler FEM/BEM runtime.
 *
 * The CPU hierarchy is built once during setup and flattened into device
 * near-field CSR plus admissible ACA row records. Two device Hypre systems
 * solve the FEM u1/u2 potentials; the RK hot loop never downloads a vector to
 * execute the BEM correction and never routes through the CPU FEM/BEM solver.
 */

#include "cpu/mfem/interactions/demag_fem_bem_operator.hpp"
#include "gpu/cuda/demag_poisson/operators.hpp"
#include "gpu/cuda/demag_poisson/hypre_stream_interop.hpp"
#include "gpu/cuda/state/component_field.hpp"

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

struct GpuFemBemLinearSystem {
#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
    HYPRE_BigInt row_starts[2] = {0, 0};
    const mfem::SparseMatrix *host_operator = nullptr;
    std::unique_ptr<mfem::HypreParMatrix> A_par;
    std::unique_ptr<mfem::HypreSolver> preconditioner;
    std::unique_ptr<mfem::HypreSolver> solver;
    std::unique_ptr<mfem::HypreParVector> b_par;
    std::unique_ptr<mfem::HypreParVector> x_par;
    std::unique_ptr<mfem::HypreParVector> residual;
#endif
    uint64_t rows = 0;
    uint64_t solver_setup_count = 0;
    uint64_t independent_residual_validation_count = 0;
    bool solver_setup_complete = false;
};

struct GpuDemagFemBemWorkspace {
    std::string operator_fingerprint;
    uint64_t operator_build_count = 0;
    uint64_t operator_upload_count = 0;
    uint64_t device_bytes = 0;
    uint64_t boundary_nodes_count = 0;
    uint64_t boundary_triangle_count = 0;
    uint64_t near_block_count = 0;
    uint64_t far_block_count = 0;
    uint32_t max_rank = 0;
    uint64_t near_entry_count = 0;
    uint64_t far_row_count = 0;
    double relative_error_estimate = 0.0;
    uint64_t boundary_operator_apply_count = 0;

    // Shared source RHS and recovery operators are assembled with the same
    // P1 quadrature contract as the CPU Poisson path.
    GpuDemagPoissonWorkspace source_operators;
    DeviceCsrScalar dirichlet_matrix;

    std::vector<uint32_t> boundary_nodes;
    std::vector<int32_t> boundary_global_to_row;
    std::vector<uint32_t> boundary_tdofs;
    std::vector<uint32_t> boundary_permutation;
    std::vector<uint32_t> near_row_offsets;
    std::vector<uint32_t> near_column_indices;
    std::vector<double> near_values;
    std::vector<AcaHMatrixDemagBemFarBlock> far_blocks;
    std::vector<double> far_u;
    std::vector<double> far_v;

#if FULLMAG_HAS_CUDA_RUNTIME
    uint32_t *d_boundary_nodes = nullptr;
    int32_t *d_boundary_global_to_row = nullptr;
    uint32_t *d_boundary_tdofs = nullptr;
    uint32_t *d_boundary_permutation = nullptr;
    double *d_bem_boundary_values = nullptr;
    uint32_t *d_near_row_offsets = nullptr;
    uint32_t *d_near_column_indices = nullptr;
    double *d_near_values = nullptr;
    AcaHMatrixDemagBemFarBlock *d_far_blocks = nullptr;
    double *d_far_u = nullptr;
    double *d_far_v = nullptr;
#endif

    GpuFemBemLinearSystem u1_system;
    GpuFemBemLinearSystem u2_system;
#if FULLMAG_HAS_CUDA_RUNTIME
    HypreStreamLease stream_lease;
#endif
    uint64_t u1_iterations = 0;
    uint64_t u2_iterations = 0;
    double u1_residual = 0.0;
    double u2_residual = 0.0;
    bool force_independent_residual_validation = false;
    bool ready = false;
};

bool gpu_demag_fem_bem_initialize(Context &ctx, std::string &error);
void gpu_demag_fem_bem_destroy(Context &ctx);
bool gpu_demag_fem_bem_ready(const Context &ctx);
uint64_t gpu_demag_fem_bem_device_bytes(const Context &ctx);
const char *gpu_demag_fem_bem_operator_mode(const Context &ctx);

bool compute_device_demag_fem_bem_for_device_stage(
    Context &ctx,
    const FemGpuComponentField &m,
    void *raw_stream,
    bool reset_initial_solution,
    bool field_and_recovered_energy,
    std::string &reason);

bool recover_device_demag_fem_bem_field_device(
    Context &ctx,
    void *raw_stream,
    std::string &reason);

} // namespace fullmag::fem
