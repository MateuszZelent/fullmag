/*
 * Strict GPU Fredkin-Koehler FEM/BEM runtime.
 *
 * Setup owns one immutable ACA H-matrix BEM upload and two persistent device
 * Hypre scalar systems. Stage compute owns only device kernels and device
 * vectors; it never downloads magnetization or potential values to execute
 * the CPU FEM/BEM implementation.
 */

#include "gpu/cuda/demag_fem_bem/fem_bem.hpp"

#include "context.hpp"
#include "core/demag_linear_solve_validation.hpp"
#include "cpu/mfem/interactions/demag_fem_bem_workspace.hpp"
#include "cpu/mfem/runtime/mpi_init.hpp"
#include "fem_common.hpp"
#include "gpu/cuda/demag_fem_bem/fem_bem_kernels.hpp"
#include "gpu/cuda/demag_poisson/demag_kernels.hpp"
#include "gpu/cuda/demag_poisson/hypre_validation_policy.hpp"
#include "gpu/cuda/fields/vector_field_kernels.hpp"
#include "gpu/cuda/reductions/reduction_kernels.hpp"
#include "gpu/cuda/runtime/execution_receipt.hpp"
#include "gpu/cuda/runtime/hypre_device_policy.hpp"
#include "gpu/cuda/state/gpu_state.hpp"
#include "gpu/cuda/transfer/transfer_audit.hpp"
#include "frequency_domain/canonical_digest.hpp"

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
#include <HYPRE_utilities.h>
#endif

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <memory>
#include <new>
#include <string>
#include <utility>
#include <vector>

namespace fullmag::fem {

namespace {

#if FULLMAG_HAS_CUDA_RUNTIME
bool cuda_ok(cudaError_t status, const char *operation, std::string &error)
{
    if (status == cudaSuccess) {
        return true;
    }
    error = std::string(operation) + " failed: " + cudaGetErrorString(status);
    return false;
}

template <typename T>
bool upload_array(
    T *&destination,
    const std::vector<T> &source,
    uint64_t &device_bytes,
    const char *operation,
    std::string &error)
{
    destination = nullptr;
    if (source.empty()) {
        return true;
    }
    if (source.size() > std::numeric_limits<size_t>::max() / sizeof(T)) {
        error = std::string(operation) + " is too large for a device allocation";
        return false;
    }
    const size_t bytes = source.size() * sizeof(T);
    if (!cuda_ok(
            cudaMalloc(reinterpret_cast<void **>(&destination), bytes),
            operation,
            error) ||
        !cuda_ok(
            cudaMemcpy(
                destination,
                source.data(),
                bytes,
                cudaMemcpyHostToDevice),
            operation,
            error)) {
        if (destination != nullptr) {
            cudaFree(destination);
            destination = nullptr;
        }
        return false;
    }
    device_bytes += static_cast<uint64_t>(bytes);
    return true;
}

template <typename T>
void free_array(T *&value)
{
    if (value != nullptr) {
        cudaFree(value);
        value = nullptr;
    }
}

bool upload_scalar_operator(
    DeviceCsrScalar &operator_data,
    uint64_t &device_bytes,
    const char *label,
    std::string &error)
{
    return upload_array(
               operator_data.d_row_offsets,
               operator_data.row_offsets,
               device_bytes,
               label,
               error) &&
        upload_array(
               operator_data.d_col_indices,
               operator_data.col_indices,
               device_bytes,
               label,
               error) &&
        upload_array(
               operator_data.d_values,
               operator_data.values,
               device_bytes,
               label,
               error);
}

void destroy_scalar_operator(DeviceCsrScalar &operator_data)
{
    free_array(operator_data.d_row_offsets);
    free_array(operator_data.d_col_indices);
    free_array(operator_data.d_values);
}
#endif

#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
bool hypre_vector_norm_l2(
    mfem::HypreParVector &vector,
    double &norm,
    const char *operation,
    std::string &error)
{
    HYPRE_Real norm_squared = 0.0;
    HYPRE_ClearAllErrors();
    const HYPRE_Int status = HYPRE_ParVectorInnerProd(
        vector, vector, &norm_squared);
    if (status != 0) {
        error = std::string(operation) + " failed with HYPRE status " +
            std::to_string(status);
        return false;
    }
    if (!std::isfinite(norm_squared) || norm_squared < 0.0) {
        error = std::string(operation) + " returned an invalid squared norm";
        return false;
    }
    norm = std::sqrt(norm_squared);
    return true;
}

bool hypre_vector_axpy(
    double alpha,
    mfem::HypreParVector &x,
    mfem::HypreParVector &y,
    const char *operation,
    std::string &error)
{
    HYPRE_ClearAllErrors();
    const HYPRE_Int status = HYPRE_ParVectorAxpy(alpha, x, y);
    if (status == 0) {
        return true;
    }
    error = std::string(operation) + " failed with HYPRE status " +
        std::to_string(status);
    return false;
}
#endif

#if FULLMAG_HAS_MFEM_STACK
bool copy_sparse_matrix_to_device_scalar(
    const mfem::SparseMatrix &source,
    DeviceCsrScalar &destination,
    std::string &error)
{
    const int rows = source.Height();
    const int columns = source.Width();
    const int *row_offsets = source.GetI();
    const int *column_indices = source.GetJ();
    const double *values = source.GetData();
    if (rows <= 0 || columns != rows || row_offsets == nullptr ||
        row_offsets[rows] < 0 ||
        (row_offsets[rows] > 0 &&
         (column_indices == nullptr || values == nullptr))) {
        error = "strict FEM GPU Fredkin-Koehler requires a finite square CSR Dirichlet operator";
        return false;
    }
    destination = {};
    destination.rows = static_cast<uint64_t>(rows);
    destination.nnz = static_cast<uint64_t>(row_offsets[rows]);
    destination.row_offsets.resize(static_cast<size_t>(rows) + 1u);
    destination.col_indices.resize(static_cast<size_t>(destination.nnz));
    destination.values.resize(static_cast<size_t>(destination.nnz));
    for (int row = 0; row <= rows; ++row) {
        if (row_offsets[row] < 0 ||
            row_offsets[row] > row_offsets[rows]) {
            error = "strict FEM GPU Fredkin-Koehler received invalid Dirichlet CSR row offsets";
            destination = {};
            return false;
        }
        destination.row_offsets[static_cast<size_t>(row)] =
            static_cast<uint32_t>(row_offsets[row]);
    }
    if (destination.nnz > std::numeric_limits<uint32_t>::max()) {
        error = "strict FEM GPU Fredkin-Koehler Dirichlet CSR exceeds uint32 index capacity";
        destination = {};
        return false;
    }
    for (uint64_t entry = 0; entry < destination.nnz; ++entry) {
        if (column_indices[entry] < 0 || column_indices[entry] >= columns ||
            !std::isfinite(values[entry])) {
            error = "strict FEM GPU Fredkin-Koehler received invalid Dirichlet CSR data";
            destination = {};
            return false;
        }
        destination.col_indices[static_cast<size_t>(entry)] =
            static_cast<uint32_t>(column_indices[entry]);
        destination.values[static_cast<size_t>(entry)] = values[entry];
    }
    return true;
}

void destroy_linear_system(GpuFemBemLinearSystem &system)
{
#if defined(MFEM_USE_MPI)
    system.solver.reset();
    system.preconditioner.reset();
    system.residual.reset();
    system.x_par.reset();
    system.b_par.reset();
    system.A_par.reset();
#endif
    system = {};
}
#endif

#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
void configure_amg(mfem::HypreBoomerAMG &amg, const Context &ctx)
{
    const auto &policy = ctx.demag.amg_policy;
    amg.SetPrintLevel(static_cast<int>(ctx.demag.solver.print_level));
    amg.SetRelaxType(policy.relax_type);
    amg.SetCoarsening(policy.coarsening);
    amg.SetInterpolation(policy.interpolation);
    amg.SetAggressiveCoarsening(policy.aggressive_coarsening);
    if (policy.strength_threshold_is_set) {
        amg.SetStrengthThresh(policy.strength_threshold);
    }
    if (policy.max_levels_is_set) {
        amg.SetMaxLevels(policy.max_levels);
    }
}

bool initialize_linear_system(
    const Context &ctx,
    const mfem::SparseMatrix &operator_matrix,
    double *rhs_device,
    double *solution_device,
    GpuFemBemLinearSystem &system,
    std::string &error)
{
    const int rows = operator_matrix.Height();
    if (rows <= 0 || operator_matrix.Width() != rows ||
        rhs_device == nullptr || solution_device == nullptr) {
        error = "strict FEM GPU Fredkin-Koehler scalar system has invalid dimensions or buffers";
        return false;
    }
    ensure_mpi_initialized();
    const HYPRE_BigInt global_rows = static_cast<HYPRE_BigInt>(rows);
    system.row_starts[0] = 0;
    system.row_starts[1] = global_rows;
    system.rows = static_cast<uint64_t>(rows);
    system.host_operator = &operator_matrix;
    system.A_par = std::make_unique<mfem::HypreParMatrix>(
        fullmag_serial_comm(),
        global_rows,
        system.row_starts,
        const_cast<mfem::SparseMatrix *>(&operator_matrix));
    system.A_par->HypreRead();
    system.b_par = std::make_unique<mfem::HypreParVector>(
        fullmag_serial_comm(),
        global_rows,
        rhs_device,
        system.row_starts,
        true);
    system.x_par = std::make_unique<mfem::HypreParVector>(
        fullmag_serial_comm(),
        global_rows,
        solution_device,
        system.row_starts,
        true);
    system.residual = std::make_unique<mfem::HypreParVector>(
        fullmag_serial_comm(),
        global_rows,
        system.row_starts);

    switch (ctx.demag.solver.preconditioner) {
    case FULLMAG_FEM_PRECONDITIONER_AMG: {
        auto amg = std::make_unique<mfem::HypreBoomerAMG>(*system.A_par);
        configure_amg(*amg, ctx);
        system.preconditioner = std::move(amg);
        break;
    }
    case FULLMAG_FEM_PRECONDITIONER_JACOBI:
        system.preconditioner =
            std::make_unique<mfem::HypreDiagScale>(*system.A_par);
        break;
    case FULLMAG_FEM_PRECONDITIONER_NONE:
        system.preconditioner = std::make_unique<mfem::HypreIdentity>();
        break;
    default:
        error = "strict FEM GPU Fredkin-Koehler requested an unsupported preconditioner";
        return false;
    }

    if (ctx.demag.solver.solver == FULLMAG_FEM_LINEAR_SOLVER_GMRES) {
        auto gmres = std::make_unique<mfem::HypreGMRES>(fullmag_serial_comm());
        gmres->iterative_mode = true;
        gmres->SetTol(ctx.demag.solver.relative_tolerance);
        if (ctx.demag.solver.has_absolute_tolerance &&
            ctx.demag.solver.absolute_tolerance > 0.0) {
            gmres->SetAbsTol(ctx.demag.solver.absolute_tolerance);
        }
        gmres->SetMaxIter(static_cast<int>(ctx.demag.solver.max_iterations));
        gmres->SetKDim(50);
        gmres->SetPrintLevel(static_cast<int>(ctx.demag.solver.print_level));
        gmres->SetOperator(*system.A_par);
        gmres->SetPreconditioner(*system.preconditioner);
        system.solver = std::move(gmres);
    } else if (ctx.demag.solver.solver == FULLMAG_FEM_LINEAR_SOLVER_CG) {
        auto pcg = std::make_unique<mfem::HyprePCG>(fullmag_serial_comm());
        pcg->iterative_mode = true;
        pcg->SetTol(ctx.demag.solver.relative_tolerance);
        if (ctx.demag.solver.has_absolute_tolerance &&
            ctx.demag.solver.absolute_tolerance > 0.0) {
            pcg->SetAbsTol(ctx.demag.solver.absolute_tolerance);
        }
        pcg->SetMaxIter(static_cast<int>(ctx.demag.solver.max_iterations));
        pcg->SetPrintLevel(static_cast<int>(ctx.demag.solver.print_level));
        const HYPRE_Int two_norm_status = HYPRE_PCGSetTwoNorm(
            static_cast<HYPRE_Solver>(*pcg), 1);
        if (two_norm_status != 0) {
            error = "strict FEM GPU Fredkin-Koehler failed to select L2 residual norm for PCG (status " +
                std::to_string(two_norm_status) + ")";
            return false;
        }
        pcg->SetOperator(*system.A_par);
        pcg->SetPreconditioner(*system.preconditioner);
        system.solver = std::move(pcg);
    } else {
        error = "strict FEM GPU Fredkin-Koehler requested an unsupported linear solver";
        return false;
    }
    system.solver->Setup(*system.b_par, *system.x_par);
    system.solver_setup_count = 1u;
    system.solver_setup_complete = true;
    return true;
}

bool set_zero_initial_iterate(
    const Context &ctx,
    GpuFemBemLinearSystem &system,
    std::string &error)
{
    if (system.solver == nullptr) {
        error = "strict FEM GPU Fredkin-Koehler scalar solver is not initialized";
        return false;
    }
    if (ctx.demag.solver.solver == FULLMAG_FEM_LINEAR_SOLVER_GMRES) {
        static_cast<mfem::HypreGMRES *>(system.solver.get())->SetZeroInitialIterate();
        return true;
    }
    if (ctx.demag.solver.solver == FULLMAG_FEM_LINEAR_SOLVER_CG) {
        static_cast<mfem::HyprePCG *>(system.solver.get())->SetZeroInitialIterate();
        return true;
    }
    error = "strict FEM GPU Fredkin-Koehler cannot select a zero initial iterate for the solver";
    return false;
}

void read_solver_statistics(
    const Context &ctx,
    GpuFemBemLinearSystem &system,
    int &iterations,
    double &relative_residual,
    bool &reported_converged)
{
    iterations = 0;
    relative_residual = 0.0;
    reported_converged = false;
    if (ctx.demag.solver.solver == FULLMAG_FEM_LINEAR_SOLVER_GMRES) {
        auto *gmres = static_cast<mfem::HypreGMRES *>(system.solver.get());
        gmres->GetNumIterations(iterations);
        mfem::real_t residual = 0.0;
        gmres->GetFinalResidualNorm(residual);
        relative_residual = static_cast<double>(residual);
        HYPRE_Int converged = 0;
        HYPRE_GMRESGetConverged(static_cast<HYPRE_Solver>(*gmres), &converged);
        reported_converged = converged != 0;
    } else {
        auto *pcg = static_cast<mfem::HyprePCG *>(system.solver.get());
        pcg->GetNumIterations(iterations);
        mfem::real_t residual = 0.0;
        pcg->GetFinalResidualNorm(residual);
        relative_residual = static_cast<double>(residual);
        HYPRE_Int converged = 0;
        HYPRE_PCGGetConverged(static_cast<HYPRE_Solver>(*pcg), &converged);
        reported_converged = converged != 0;
    }
}

bool solve_linear_system(
    Context &ctx,
    GpuFemBemLinearSystem &system,
    HypreStreamLease &stream_lease,
    cudaStream_t stream,
    bool force_independent_validation,
    uint64_t &iterations_out,
    double &relative_residual_out,
    std::string &error)
{
    if (!system.solver_setup_complete || system.solver == nullptr ||
        system.A_par == nullptr || system.b_par == nullptr ||
        system.x_par == nullptr || system.residual == nullptr) {
        error = "strict FEM GPU Fredkin-Koehler solve requires a completed Hypre setup";
        return false;
    }
    if (!hypre_wait_for_fullmag(stream_lease, stream, error)) {
        return false;
    }
    bool hypre_dependency_open = false;
    const auto close_hypre_dependency = [&](bool operation_succeeded) {
        if (!hypre_dependency_open) {
            return operation_succeeded;
        }
        std::string dependency_error;
        const bool dependency_closed =
            fullmag_wait_for_hypre(stream_lease, stream, dependency_error);
        hypre_dependency_open = false;
        if (!dependency_closed) {
            if (!operation_succeeded && !error.empty()) {
                error += "; ";
            }
            error += dependency_error;
        }
        return operation_succeeded && dependency_closed;
    };
    if (!set_zero_initial_iterate(ctx, system, error)) {
        return false;
    }
    system.b_par->HypreWrite();
    system.x_par->HypreWrite();
    hypre_dependency_open = true;
    system.solver->Mult(*system.b_par, *system.x_par);
    int iterations = 0;
    double relative_residual = 0.0;
    bool reported_converged = false;
    read_solver_statistics(
        ctx, system, iterations, relative_residual, reported_converged);
    const bool validate_independent_residual =
        should_validate_independent_residual(
            reported_converged, force_independent_validation);
    const bool rhs_norm_required =
        validate_independent_residual ||
        ctx.demag.solver.has_absolute_tolerance != 0;
    double rhs_norm = 0.0;
    if (rhs_norm_required &&
        !hypre_vector_norm_l2(
            *system.b_par,
            rhs_norm,
            "strict FEM GPU Fredkin-Koehler RHS norm",
            error)) {
        return close_hypre_dependency(false);
    }
    const bool zero_rhs = (rhs_norm_required && rhs_norm == 0.0);
    double absolute_residual =
        rhs_norm_required ? relative_residual * rhs_norm : 0.0;
    bool residual_independently_certified = false;
    if (validate_independent_residual || zero_rhs) {
        system.A_par->Mult(*system.x_par, *system.residual);
        if (!hypre_vector_axpy(
                -1.0,
                *system.b_par,
                *system.residual,
                "strict FEM GPU Fredkin-Koehler residual AXPY",
                error) ||
            !hypre_vector_norm_l2(
                *system.residual,
                absolute_residual,
                "strict FEM GPU Fredkin-Koehler residual norm",
                error)) {
            return close_hypre_dependency(false);
        }
        if (rhs_norm > 0.0) {
            relative_residual = absolute_residual / rhs_norm;
        } else {
            relative_residual = (absolute_residual == 0.0)
                ? 0.0
                : std::numeric_limits<double>::infinity();
        }
        residual_independently_certified = std::isfinite(absolute_residual);
        system.independent_residual_validation_count += 1u;
    }
    DemagLinearSolveResult result;
    result.solver_kind = ctx.demag.solver.solver == FULLMAG_FEM_LINEAR_SOLVER_GMRES
        ? "gpu_fem_bem/gmres"
        : "gpu_fem_bem/cg";
    result.norm_kind = DemagResidualNormKind::L2;
    result.certification_kind = residual_independently_certified
        ? DemagResidualCertificationKind::TrueResidual
        : (reported_converged
               ? DemagResidualCertificationKind::ReportedRecursive
               : DemagResidualCertificationKind::Unavailable);
    result.solver_reported_converged = reported_converged;
    result.residual_independently_certified = residual_independently_certified;
    result.iterations = iterations;
    result.relative_residual = relative_residual;
    result.has_absolute_residual =
        ctx.demag.solver.has_absolute_tolerance != 0;
    result.absolute_residual = absolute_residual;
    result.relative_tolerance = ctx.demag.solver.relative_tolerance;
    result.has_absolute_tolerance = ctx.demag.solver.has_absolute_tolerance != 0;
    result.absolute_tolerance = ctx.demag.solver.absolute_tolerance;
    result.max_iterations = ctx.demag.solver.max_iterations;
    if (!validate_demag_linear_solve_result(result, error)) {
        return close_hypre_dependency(false);
    }
    if (!close_hypre_dependency(true)) {
        return false;
    }
    iterations_out = static_cast<uint64_t>(std::max(0, iterations));
    relative_residual_out = relative_residual;
    if (gpu_execution_receipt_attempt_active(ctx.gpu_state.execution_receipt)) {
        gpu_execution_receipt_note_device(
            ctx.gpu_state.execution_receipt,
            FEM_GPU_OPERATOR_DEMAG_SOLVE |
                FEM_GPU_OPERATOR_PRECONDITIONER);
    }
    return true;
}
#endif

#if FULLMAG_HAS_MFEM_STACK
bool build_source_operators(
    Context &ctx,
    DemagFemBemWorkspace &cpu_workspace,
    GpuDemagFemBemWorkspace &gpu_workspace,
    std::string &error)
{
    // The existing P1 RHS/recovery builder is shared with the CPU Poisson
    // semantics. Temporarily point its read-only context inputs at the
    // body-only FK P1 space and Neumann matrix, then restore every field.
    auto &poisson = ctx.poisson_demag;
    struct PoissonAliasGuard {
        PoissonDemagRuntimeState &poisson;
        mfem::FiniteElementSpace *potential_fes;
        mfem::SparseMatrix *poisson_bc_op;
        int potential_order;
        bool periodic_reduced_ready;
        std::vector<int> ess_tdof_list;

        explicit PoissonAliasGuard(Context &context, DemagFemBemWorkspace &workspace)
            : poisson(context.poisson_demag),
              potential_fes(poisson.potential_fes),
              poisson_bc_op(poisson.poisson_bc_op),
              potential_order(poisson.potential_order),
              periodic_reduced_ready(poisson.periodic_reduced_ready),
              ess_tdof_list(poisson.ess_tdof_list)
        {
            poisson.potential_fes = workspace.potential_fes.get();
            poisson.poisson_bc_op = workspace.neumann_op.get();
            poisson.potential_order = 1;
            poisson.periodic_reduced_ready = false;
            poisson.ess_tdof_list = workspace.neumann_gauge_tdofs;
        }

        ~PoissonAliasGuard()
        {
            poisson.potential_fes = potential_fes;
            poisson.poisson_bc_op = poisson_bc_op;
            poisson.potential_order = potential_order;
            poisson.periodic_reduced_ready = periodic_reduced_ready;
            poisson.ess_tdof_list = std::move(ess_tdof_list);
        }
    } guard(ctx, cpu_workspace);
    return build_fredkin_koehler_demag_operators(
        ctx, gpu_workspace.source_operators, error);
}
#endif

inline std::vector<uint32_t> build_aca_batch_offsets(
    const std::vector<AcaHMatrixDemagBemFarBlock> &blocks)
{
    std::vector<uint32_t> offsets;
    if (blocks.empty()) {
        return offsets;
    }
    offsets.push_back(0);
    uint32_t current_batch_size = 0;
    uint32_t current_batch_cost = 0;
    constexpr uint32_t kMaxBatchCost = 256;
    constexpr uint32_t kMaxBatchSize = 16;

    for (size_t i = 0; i < blocks.size(); ++i) {
        const auto &block = blocks[i];
        const uint32_t target_len = block.target_end - block.target_begin;
        const uint32_t source_len = block.source_end - block.source_begin;
        const uint32_t block_cost = block.rank * (target_len + source_len);

        if (current_batch_size > 0 &&
            (current_batch_size >= kMaxBatchSize ||
             current_batch_cost + block_cost > kMaxBatchCost)) {
            offsets.push_back(static_cast<uint32_t>(i));
            current_batch_size = 0;
            current_batch_cost = 0;
        }
        current_batch_size += 1;
        current_batch_cost += block_cost;
    }
    offsets.push_back(static_cast<uint32_t>(blocks.size()));
    return offsets;
}

void destroy_gpu_workspace(GpuDemagFemBemWorkspace &workspace)
{
#if FULLMAG_HAS_CUDA_RUNTIME
    destroy_hypre_stream_interop(workspace.stream_lease);
    free_array(workspace.d_boundary_nodes);
    free_array(workspace.d_boundary_global_to_row);
    free_array(workspace.d_boundary_tdofs);
    free_array(workspace.d_boundary_permutation);
    free_array(workspace.d_bem_boundary_values);
    free_array(workspace.d_near_row_offsets);
    free_array(workspace.d_near_column_indices);
    free_array(workspace.d_near_values);
    free_array(workspace.d_far_blocks);
    free_array(workspace.d_far_u);
    free_array(workspace.d_far_v);
    free_array(workspace.d_batch_offsets);
    destroy_scalar_operator(workspace.dirichlet_matrix);
#endif
#if FULLMAG_HAS_MFEM_STACK
    destroy_linear_system(workspace.u1_system);
    destroy_linear_system(workspace.u2_system);
#endif
    destroy_demag_poisson_operators(workspace.source_operators);
    workspace = {};
}

void destroy_owned_gpu_workspace(Context &ctx, void *opaque_workspace)
{
    auto *workspace = static_cast<GpuDemagFemBemWorkspace *>(opaque_workspace);
    if (workspace == nullptr) {
        return;
    }
    const uint64_t device_bytes = workspace->device_bytes;
    destroy_gpu_workspace(*workspace);
#if FULLMAG_HAS_CUDA_RUNTIME
    if (device_bytes <= ctx.gpu_state.device.lifecycle.device_bytes) {
        ctx.gpu_state.device.lifecycle.device_bytes -= device_bytes;
    }
#else
    (void)ctx;
#endif
    delete workspace;
}

} // namespace

bool gpu_demag_fem_bem_initialize(Context &ctx, std::string &error)
{
    gpu_demag_fem_bem_destroy(ctx);
    if (!ctx.demag.enabled ||
        ctx.poisson_demag.gpu_demag_mode !=
            FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_FEM_BEM) {
        return true;
    }
#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
    bool force_independent_residual_validation = false;
    if (!read_force_independent_residual_validation(
            force_independent_residual_validation, error)) {
        return false;
    }
    auto *cpu_workspace = demag_fem_bem_workspace(ctx);
    auto &gpu = ctx.gpu_state.device;
    if (cpu_workspace == nullptr || !ctx.demag_fem_bem.ready ||
        !gpu.lifecycle.allocated || gpu.fields.h_demag.x == nullptr ||
        gpu.fields.h_demag.y == nullptr || gpu.fields.h_demag.z == nullptr) {
        error = "strict FEM GPU Fredkin-Koehler requires ready CPU geometry and allocated GPU state";
        return false;
    }
    if (cpu_workspace->potential_fes == nullptr ||
        cpu_workspace->neumann_op == nullptr ||
        cpu_workspace->dirichlet_op == nullptr ||
        cpu_workspace->boundary_tdofs_by_row.size() !=
            cpu_workspace->surface.boundary_nodes.size()) {
        error = "strict FEM GPU Fredkin-Koehler requires body-only P1 FEM operators and boundary DOF map";
        return false;
    }
    const int scalar_rows = cpu_workspace->potential_fes->GetTrueVSize();
    if (scalar_rows <= 0 || scalar_rows != static_cast<int>(ctx.mesh.n_nodes) ||
        cpu_workspace->potential_fes->GetVSize() != scalar_rows) {
        error = "strict FEM GPU Fredkin-Koehler requires unconstrained P1 true DOFs equal to mesh nodes";
        return false;
    }
    if (!ctx.mesh.periodic_node_pairs.empty()) {
        error = "strict FEM GPU Fredkin-Koehler does not support periodic body meshes";
        return false;
    }
    mfem::Hypre::Init();
    mfem::Hypre::InitDevice();
    const HypreDevicePolicySnapshot hypre_policy =
        configure_hypre_cuda_device_policy();
    if (!hypre_cuda_device_policy_is_available(hypre_policy)) {
        error = hypre_policy.failure_reason.empty()
            ? kHypreCudaDevicePolicyUnavailable
            : hypre_policy.failure_reason;
        return false;
    }

    std::unique_ptr<GpuDemagFemBemWorkspace> workspace;
    try {
        workspace = std::make_unique<GpuDemagFemBemWorkspace>();
        workspace->force_independent_residual_validation =
            force_independent_residual_validation;
        workspace->boundary_nodes = cpu_workspace->surface.boundary_nodes;
        workspace->boundary_nodes_count = workspace->boundary_nodes.size();
        workspace->boundary_triangle_count = cpu_workspace->surface.triangles.size();
        workspace->boundary_tdofs.reserve(workspace->boundary_nodes.size());
        workspace->boundary_global_to_row.assign(ctx.mesh.n_nodes, -1);
        for (size_t row = 0; row < workspace->boundary_nodes.size(); ++row) {
            const int tdof = cpu_workspace->boundary_tdofs_by_row[row];
            if (tdof < 0 || tdof >= scalar_rows ||
                workspace->boundary_global_to_row[static_cast<size_t>(tdof)] >= 0) {
                error = "strict FEM GPU Fredkin-Koehler boundary true DOF map is invalid";
                return false;
            }
            workspace->boundary_tdofs.push_back(static_cast<uint32_t>(tdof));
            workspace->boundary_global_to_row[static_cast<size_t>(tdof)] =
                static_cast<int32_t>(row);
        }
        AcaHMatrixDemagBemOperator device_boundary_operator;
        const AcaHMatrixDemagBemOptions device_boundary_options{};
        if (!device_boundary_operator.build(
                ctx,
                cpu_workspace->surface,
                device_boundary_options,
                error)) {
            return false;
        }
        AcaHMatrixDemagBemDeviceData device_data;
        if (!device_boundary_operator.export_device_data(device_data, error)) {
            return false;
        }
        workspace->boundary_permutation = std::move(device_data.boundary_permutation);
        workspace->near_row_offsets = std::move(device_data.near_row_offsets);
        workspace->near_column_indices = std::move(device_data.near_column_indices);
        workspace->near_values = std::move(device_data.near_values);
        workspace->far_blocks = std::move(device_data.far_blocks);
        workspace->far_u = std::move(device_data.far_u);
        workspace->far_v = std::move(device_data.far_v);
        workspace->near_entry_count = workspace->near_values.size();
        workspace->far_row_count = device_boundary_operator.far_row_count();
        workspace->near_block_count = device_boundary_operator.near_block_count();
        workspace->far_block_count = device_boundary_operator.far_block_count();
        workspace->max_rank = device_boundary_operator.max_rank_observed();
        workspace->relative_error_estimate =
            device_boundary_operator.relative_error_estimate();

        if (!build_source_operators(ctx, *cpu_workspace, *workspace, error) ||
            !copy_sparse_matrix_to_device_scalar(
                cpu_workspace->stiffness_form->SpMat(),
                workspace->dirichlet_matrix,
                error) ||
            !gpu_state_resize_demag_poisson_scalars(
                ctx.gpu_state.device,
                static_cast<uint64_t>(scalar_rows),
                static_cast<uint64_t>(scalar_rows),
                error)) {
            return false;
        }
        uint64_t device_bytes = 0;
        if (!upload_demag_poisson_operators(
                workspace->source_operators,
                device_bytes,
                error) ||
            !upload_scalar_operator(
                workspace->dirichlet_matrix,
                device_bytes,
                "cudaMalloc/upload Fredkin-Koehler Dirichlet CSR",
                error) ||
            !upload_array(
                workspace->d_boundary_nodes,
                workspace->boundary_nodes,
                device_bytes,
                "cudaMalloc/upload Fredkin-Koehler boundary nodes",
                error) ||
            !upload_array(
                workspace->d_boundary_global_to_row,
                workspace->boundary_global_to_row,
                device_bytes,
                "cudaMalloc/upload Fredkin-Koehler boundary DOF map",
                error) ||
            !upload_array(
                workspace->d_boundary_tdofs,
                workspace->boundary_tdofs,
                device_bytes,
                "cudaMalloc/upload Fredkin-Koehler boundary true DOFs",
                error) ||
            !upload_array(
                workspace->d_boundary_permutation,
                workspace->boundary_permutation,
                device_bytes,
                "cudaMalloc/upload Fredkin-Koehler boundary permutation",
                error) ||
            !upload_array(
                workspace->d_near_row_offsets,
                workspace->near_row_offsets,
                device_bytes,
                "cudaMalloc/upload Fredkin-Koehler near row offsets",
                error) ||
            !upload_array(
                workspace->d_near_column_indices,
                workspace->near_column_indices,
                device_bytes,
                "cudaMalloc/upload Fredkin-Koehler near columns",
                error) ||
            !upload_array(
                workspace->d_near_values,
                workspace->near_values,
                device_bytes,
                "cudaMalloc/upload Fredkin-Koehler near values",
                error) ||
            !upload_array(
                workspace->d_far_blocks,
                workspace->far_blocks,
                device_bytes,
                "cudaMalloc/upload Fredkin-Koehler far block records",
                error) ||
            !upload_array(
                workspace->d_far_u,
                workspace->far_u,
                device_bytes,
                "cudaMalloc/upload Fredkin-Koehler far U factors",
                error) ||
            !upload_array(
                workspace->d_far_v,
                workspace->far_v,
                device_bytes,
                "cudaMalloc/upload Fredkin-Koehler far V factors",
                error) ||
            !upload_array(
                workspace->d_bem_boundary_values,
                std::vector<double>(workspace->boundary_nodes.size(), 0.0),
                device_bytes,
                "cudaMalloc Fredkin-Koehler boundary correction",
                error)) {
            destroy_gpu_workspace(*workspace);
            return false;
        }
        workspace->batch_offsets = build_aca_batch_offsets(workspace->far_blocks);
        workspace->batch_count = workspace->batch_offsets.empty() ? 0 : static_cast<int>(workspace->batch_offsets.size()) - 1;
        if (!workspace->batch_offsets.empty()) {
            if (!upload_array(
                    workspace->d_batch_offsets,
                    workspace->batch_offsets,
                    device_bytes,
                    "cudaMalloc/upload Fredkin-Koehler ACA batch offsets",
                    error)) {
                destroy_gpu_workspace(*workspace);
                return false;
            }
        }
        if (!initialize_linear_system(
                ctx,
                *cpu_workspace->neumann_op,
                gpu.demag_poisson.poisson_rhs,
                gpu.demag_poisson.poisson_solution,
                workspace->u1_system,
                error) ||
            !initialize_linear_system(
                ctx,
                *cpu_workspace->dirichlet_op,
                gpu.demag_poisson.poisson_rhs,
                gpu.demag_poisson.poisson_solution,
                workspace->u2_system,
                error)) {
            destroy_gpu_workspace(*workspace);
            return false;
        }
        if (!initialize_hypre_stream_interop(workspace->stream_lease, error)) {
            destroy_gpu_workspace(*workspace);
            return false;
        }
        frequency_domain::CanonicalDigestBuilder digest(
            "fullmag.fem.bem.gpu_operator.v1");
        digest.add_string(
            "boundary_operator_fingerprint",
            device_boundary_operator.fingerprint());
        digest.add_string(
            "source_operator_fingerprint",
            workspace->source_operators.operator_fingerprint);
        workspace->operator_fingerprint = "sha256:" + digest.sha256_hex();
        workspace->operator_build_count = 1u;
        workspace->operator_upload_count = 1u;
        workspace->device_bytes = device_bytes;
        workspace->ready = true;
        ctx.gpu_state.device.lifecycle.device_bytes += device_bytes;
        cpu_workspace->gpu_workspace_device_bytes = device_bytes;
        cpu_workspace->gpu_workspace = workspace.release();
        cpu_workspace->gpu_workspace_destroy = &destroy_owned_gpu_workspace;
        cpu_workspace->gpu_workspace_ready = true;
        return true;
    } catch (const std::exception &exception) {
        if (workspace != nullptr) {
            destroy_gpu_workspace(*workspace);
        }
        error = std::string("strict FEM GPU Fredkin-Koehler initialization failed: ") +
            exception.what();
        return false;
    } catch (...) {
        if (workspace != nullptr) {
            destroy_gpu_workspace(*workspace);
        }
        error = "strict FEM GPU Fredkin-Koehler initialization failed with an unknown error";
        return false;
    }
#else
    (void)ctx;
    error = "strict FEM GPU Fredkin-Koehler requires CUDA, MFEM MPI, and hypre device support";
    return false;
#endif
}

void gpu_demag_fem_bem_destroy(Context &ctx)
{
    destroy_attached_demag_fem_bem_gpu_workspace(ctx);
}

bool gpu_demag_fem_bem_ready(const Context &ctx)
{
    const auto *cpu_workspace = demag_fem_bem_workspace(const_cast<Context &>(ctx));
    if (cpu_workspace == nullptr || !cpu_workspace->gpu_workspace_ready) {
        return false;
    }
    const auto *workspace = static_cast<const GpuDemagFemBemWorkspace *>(
        cpu_workspace->gpu_workspace);
    return workspace != nullptr && workspace->ready;
}

uint64_t gpu_demag_fem_bem_device_bytes(const Context &ctx)
{
    const auto *cpu_workspace = demag_fem_bem_workspace(const_cast<Context &>(ctx));
    if (cpu_workspace == nullptr || cpu_workspace->gpu_workspace == nullptr) {
        return 0;
    }
    return static_cast<const GpuDemagFemBemWorkspace *>(
        cpu_workspace->gpu_workspace)->device_bytes;
}

const char *gpu_demag_fem_bem_operator_mode(const Context &ctx)
{
    return gpu_demag_fem_bem_ready(ctx)
        ? "device_hypre_fem_bem_aca_hmatrix"
        : "unsupported";
}

bool compute_device_demag_fem_bem_for_device_stage(
    Context &ctx,
    const FemGpuComponentField &m,
    void *raw_stream,
    bool reset_initial_solution,
    bool field_and_recovered_energy,
    std::string &reason)
{
#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
    auto *cpu_workspace = demag_fem_bem_workspace(ctx);
    if (cpu_workspace == nullptr || cpu_workspace->gpu_workspace == nullptr ||
        !cpu_workspace->gpu_workspace_ready) {
        reason = "strict FEM GPU Fredkin-Koehler requires a ready device workspace";
        return false;
    }
    auto *workspace = static_cast<GpuDemagFemBemWorkspace *>(
        cpu_workspace->gpu_workspace);
    auto &gpu = ctx.gpu_state.device;
    if (!workspace->ready || gpu.demag_poisson.poisson_rhs == nullptr ||
        gpu.demag_poisson.poisson_solution == nullptr ||
        gpu.demag_poisson.poisson_solution_full == nullptr ||
        gpu.fields.h_demag.x == nullptr || gpu.fields.h_demag.y == nullptr ||
        gpu.fields.h_demag.z == nullptr) {
        reason = "strict FEM GPU Fredkin-Koehler requires device scalar and field buffers";
        return false;
    }
    if (m.x == nullptr || m.y == nullptr || m.z == nullptr) {
        reason = "strict FEM GPU Fredkin-Koehler received null device magnetization";
        return false;
    }
    const int scalar_rows = static_cast<int>(workspace->u1_system.rows);
    if (workspace->boundary_nodes_count >
            static_cast<uint64_t>(std::numeric_limits<int>::max()) ||
        workspace->far_blocks.size() >
            static_cast<size_t>(std::numeric_limits<int>::max()) ||
        workspace->max_rank >
            static_cast<uint32_t>(std::numeric_limits<int>::max())) {
        reason = "strict FEM GPU Fredkin-Koehler exceeds CUDA launch index capacity";
        return false;
    }
    const int boundary_rows = static_cast<int>(workspace->boundary_nodes_count);
    cudaStream_t stream = reinterpret_cast<cudaStream_t>(raw_stream);
    fullmag_cuda_demag_rhs_csr(
        workspace->source_operators.rhs.d_row_offsets,
        workspace->source_operators.rhs.d_col_indices,
        workspace->source_operators.rhs.d_values_x,
        workspace->source_operators.rhs.d_values_y,
        workspace->source_operators.rhs.d_values_z,
        m.x,
        m.y,
        m.z,
        gpu.demag_poisson.poisson_rhs,
        scalar_rows,
        stream);
    if (!cuda_ok(cudaGetLastError(), "launch Fredkin-Koehler device RHS", reason)) {
        return false;
    }
    fullmag_cuda_zero_indexed_values(
        gpu.demag_poisson.poisson_rhs,
        workspace->source_operators.d_ess_tdofs,
        static_cast<int>(workspace->source_operators.ess_tdofs.size()),
        stream);
    if (!cuda_ok(cudaGetLastError(), "launch Fredkin-Koehler gauge zero", reason)) {
        return false;
    }
    if (reset_initial_solution &&
        !cuda_ok(
            cudaMemsetAsync(
                gpu.demag_poisson.poisson_solution,
                0,
                static_cast<size_t>(scalar_rows) * sizeof(double),
                stream),
            "clear Fredkin-Koehler u1 solution",
            reason)) {
        return false;
    }
    if (!solve_linear_system(
            ctx,
            workspace->u1_system,
            workspace->stream_lease,
            stream,
            workspace->force_independent_residual_validation,
            workspace->u1_iterations,
            workspace->u1_residual,
            reason)) {
        return false;
    }
    if (!cuda_ok(
            cudaMemcpyAsync(
                gpu.demag_poisson.poisson_solution_full,
                gpu.demag_poisson.poisson_solution,
                static_cast<size_t>(scalar_rows) * sizeof(double),
                cudaMemcpyDeviceToDevice,
                stream),
            "preserve Fredkin-Koehler u1 solution",
            reason)) {
        return false;
    }
    fullmag_cuda_fem_bem_apply(
        workspace->d_near_row_offsets,
        workspace->d_near_column_indices,
        workspace->d_near_values,
        workspace->d_far_blocks,
        workspace->d_far_u,
        workspace->d_far_v,
        workspace->d_boundary_permutation,
        workspace->d_boundary_tdofs,
        gpu.demag_poisson.poisson_solution,
        workspace->d_bem_boundary_values,
        boundary_rows,
        static_cast<int>(workspace->far_blocks.size()),
        static_cast<int>(workspace->max_rank),
        stream,
        workspace->d_batch_offsets,
        workspace->batch_count);
    if (!cuda_ok(cudaGetLastError(), "launch Fredkin-Koehler device BEM", reason)) {
        return false;
    }
    workspace->boundary_operator_apply_count += 1u;
    fullmag_cuda_fem_bem_build_dirichlet_rhs(
        workspace->dirichlet_matrix.d_row_offsets,
        workspace->dirichlet_matrix.d_col_indices,
        workspace->dirichlet_matrix.d_values,
        workspace->d_boundary_global_to_row,
        workspace->d_bem_boundary_values,
        gpu.demag_poisson.poisson_rhs,
        scalar_rows,
        stream);
    if (!cuda_ok(cudaGetLastError(), "launch Fredkin-Koehler Dirichlet RHS", reason)) {
        return false;
    }
    if (!cuda_ok(
            cudaMemsetAsync(
                gpu.demag_poisson.poisson_solution,
                0,
                static_cast<size_t>(scalar_rows) * sizeof(double),
                stream),
            "clear Fredkin-Koehler u2 solution",
            reason)) {
        return false;
    }
    if (!solve_linear_system(
            ctx,
            workspace->u2_system,
            workspace->stream_lease,
            stream,
            workspace->force_independent_residual_validation,
            workspace->u2_iterations,
            workspace->u2_residual,
            reason)) {
        return false;
    }
    fullmag_cuda_fem_bem_combine_potentials(
        gpu.demag_poisson.poisson_solution_full,
        gpu.demag_poisson.poisson_solution,
        gpu.demag_poisson.poisson_solution_full,
        scalar_rows,
        stream);
    if (!cuda_ok(cudaGetLastError(), "launch Fredkin-Koehler potential combine", reason)) {
        return false;
    }
    fullmag_cuda_demag_recovery_xyz_csr(
        workspace->source_operators.recovery_x.d_row_offsets,
        workspace->source_operators.recovery_x.d_col_indices,
        workspace->source_operators.recovery_x.d_values,
        workspace->source_operators.recovery_y.d_values,
        workspace->source_operators.recovery_z.d_values,
        gpu.demag_poisson.poisson_solution_full,
        gpu.mesh_regions.magnetic_node_mask,
        gpu.fields.h_demag.x,
        gpu.fields.h_demag.y,
        gpu.fields.h_demag.z,
        scalar_rows,
        stream);
    if (!cuda_ok(cudaGetLastError(), "launch Fredkin-Koehler field recovery", reason)) {
        return false;
    }
    if (field_and_recovered_energy) {
        if (gpu.reductions.scalar_result == nullptr ||
            gpu.reductions.scalar_workspace == nullptr ||
            gpu.reductions.temp_storage == nullptr ||
            gpu.materials.ms == nullptr ||
            gpu.mesh_metrics.node_volumes == nullptr) {
            reason = "strict FEM GPU Fredkin-Koehler energy requires device reduction and material buffers";
            return false;
        }
        const int blocks = (scalar_rows + 255) / 256;
        fullmag_cuda_demag_energy_blocks(
            m.x,
            m.y,
            m.z,
            gpu.fields.h_demag.x,
            gpu.fields.h_demag.y,
            gpu.fields.h_demag.z,
            gpu.materials.ms,
            gpu.mesh_metrics.node_volumes,
            gpu.mesh_regions.magnetic_node_mask,
            gpu.reductions.scalar_workspace,
            scalar_rows,
            stream);
        if (!cuda_ok(cudaGetLastError(), "launch Fredkin-Koehler energy blocks", reason)) {
            return false;
        }
        size_t reduction_bytes = static_cast<size_t>(gpu.reductions.temp_storage_bytes);
        fullmag_cuda_device_sum(
            gpu.reductions.scalar_workspace,
            std::max(1, blocks),
            gpu.reductions.scalar_result,
            gpu.reductions.temp_storage,
            reduction_bytes,
            stream);
        if (!cuda_ok(cudaGetLastError(), "launch Fredkin-Koehler energy reduction", reason)) {
            return false;
        }
    } else if (gpu.reductions.scalar_result != nullptr &&
               !cuda_ok(
                   cudaMemsetAsync(
                       gpu.reductions.scalar_result,
                       0,
                       sizeof(double),
                       stream),
                   "clear Fredkin-Koehler FieldOnly energy",
                   reason)) {
        return false;
    }
    ctx.poisson_demag.last_iterations = static_cast<int>(workspace->u2_iterations);
    ctx.poisson_demag.last_residual = workspace->u2_residual;
    ctx.poisson_demag.solves_current_step += 2u;
    gpu.demag_poisson.last_evaluation_mode =
        field_and_recovered_energy ? 1u : 0u;
    gpu.demag_poisson.last_evaluation_purpose = 0u;
    if (field_and_recovered_energy) {
        gpu.demag_poisson.field_and_energy_evaluation_count += 1u;
    } else {
        gpu.demag_poisson.field_only_evaluation_count += 1u;
    }
    if (gpu_execution_receipt_attempt_active(ctx.gpu_state.execution_receipt)) {
        gpu_execution_receipt_note_device(
            ctx.gpu_state.execution_receipt,
            FEM_GPU_OPERATOR_DEMAG_RHS |
                FEM_GPU_OPERATOR_DEMAG_SOLVE |
                FEM_GPU_OPERATOR_DEMAG_RECOVERY |
                FEM_GPU_OPERATOR_PRECONDITIONER);
    }
    return true;
#else
    (void)ctx;
    (void)m;
    (void)raw_stream;
    (void)reset_initial_solution;
    (void)field_and_recovered_energy;
    reason = "strict FEM GPU Fredkin-Koehler requires CUDA, MFEM MPI, and hypre device support";
    return false;
#endif
}

bool recover_device_demag_fem_bem_field_device(
    Context &ctx,
    void *raw_stream,
    std::string &reason)
{
#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
    auto *cpu_workspace = demag_fem_bem_workspace(ctx);
    if (cpu_workspace == nullptr || cpu_workspace->gpu_workspace == nullptr) {
        reason = "strict FEM GPU Fredkin-Koehler observable recovery requires a ready workspace";
        return false;
    }
    auto *workspace = static_cast<GpuDemagFemBemWorkspace *>(
        cpu_workspace->gpu_workspace);
    auto &gpu = ctx.gpu_state.device;
    if (!workspace->ready || gpu.demag_poisson.poisson_solution_full == nullptr ||
        gpu.demag_poisson.poisson_gradient.x == nullptr ||
        gpu.demag_poisson.poisson_gradient.y == nullptr ||
        gpu.demag_poisson.poisson_gradient.z == nullptr) {
        reason = "strict FEM GPU Fredkin-Koehler observable recovery requires a total potential and visual buffers";
        return false;
    }
    const int rows = static_cast<int>(workspace->u1_system.rows);
    fullmag_cuda_demag_recovery_xyz_csr(
        workspace->source_operators.recovery_x.d_row_offsets,
        workspace->source_operators.recovery_x.d_col_indices,
        workspace->source_operators.recovery_x.d_values,
        workspace->source_operators.recovery_y.d_values,
        workspace->source_operators.recovery_z.d_values,
        gpu.demag_poisson.poisson_solution_full,
        nullptr,
        gpu.demag_poisson.poisson_gradient.x,
        gpu.demag_poisson.poisson_gradient.y,
        gpu.demag_poisson.poisson_gradient.z,
        rows,
        reinterpret_cast<cudaStream_t>(raw_stream));
    if (!cuda_ok(cudaGetLastError(), "launch Fredkin-Koehler observable recovery", reason)) {
        return false;
    }
    return true;
#else
    (void)ctx;
    (void)raw_stream;
    reason = "strict FEM GPU Fredkin-Koehler observable recovery requires CUDA, MFEM MPI, and hypre";
    return false;
#endif
}

} // namespace fullmag::fem
