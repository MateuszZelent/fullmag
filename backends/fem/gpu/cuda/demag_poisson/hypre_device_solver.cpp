/*
 * GPU CUDA Poisson demag Hypre device solver source contract.
 *
 * This source owns strict GPU Poisson demag Hypre device-policy setup,
 * BoomerAMG/Jacobi/identity preconditioner selection, CG/GMRES construction,
 * and iteration/residual extraction. It does not own P1 CSR operator assembly,
 * lifecycle publication, RK-stage orchestration, local CUDA kernels, or C ABI
 * entrypoints.
 */

#include "gpu/cuda/demag_poisson/hypre_device_solver.hpp"

#include "context.hpp"
#include "cpu/mfem/runtime/mpi_init.hpp"

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
#include <HYPRE_utilities.h>
#endif

#include <climits>
#include <cstdlib>
#include <memory>
#include <string>

namespace fullmag::fem {

namespace {

#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
int demag_amg_int_env(const char *name, int default_value)
{
    const char *raw = std::getenv(name);
    if (raw == nullptr || raw[0] == '\0') {
        return default_value;
    }
    char *end = nullptr;
    const long parsed = std::strtol(raw, &end, 10);
    if (end == raw || *end != '\0' || parsed < 0 || parsed > INT_MAX) {
        return default_value;
    }
    return static_cast<int>(parsed);
}

bool demag_amg_optional_int_env(const char *name, int &value)
{
    const char *raw = std::getenv(name);
    if (raw == nullptr || raw[0] == '\0') {
        return false;
    }
    char *end = nullptr;
    const long parsed = std::strtol(raw, &end, 10);
    if (end == raw || *end != '\0' || parsed < 0 || parsed > INT_MAX) {
        return false;
    }
    value = static_cast<int>(parsed);
    return true;
}

bool demag_amg_real_env(const char *name, mfem::real_t &value)
{
    const char *raw = std::getenv(name);
    if (raw == nullptr || raw[0] == '\0') {
        return false;
    }
    char *end = nullptr;
    const double parsed = std::strtod(raw, &end);
    if (end == raw || *end != '\0' || parsed < 0.0) {
        return false;
    }
    value = static_cast<mfem::real_t>(parsed);
    return true;
}

void configure_demag_amg(mfem::HypreBoomerAMG &amg, const Context &ctx)
{
    amg.SetPrintLevel(static_cast<int>(ctx.demag.solver.print_level));
    amg.SetRelaxType(demag_amg_int_env("FULLMAG_FEM_DEMAG_AMG_RELAX_TYPE", 18));
    amg.SetCoarsening(demag_amg_int_env("FULLMAG_FEM_DEMAG_AMG_COARSENING", 8));
    amg.SetInterpolation(demag_amg_int_env("FULLMAG_FEM_DEMAG_AMG_INTERPOLATION", 6));
    amg.SetAggressiveCoarsening(
        demag_amg_int_env("FULLMAG_FEM_DEMAG_AMG_AGGRESSIVE_COARSENING", 1));
    mfem::real_t strength_threshold = 0.0;
    if (demag_amg_real_env("FULLMAG_FEM_DEMAG_AMG_STRENGTH_THRESHOLD", strength_threshold)) {
        amg.SetStrengthThresh(strength_threshold);
    }
    int max_levels = 0;
    if (demag_amg_optional_int_env("FULLMAG_FEM_DEMAG_AMG_MAX_LEVELS", max_levels)) {
        amg.SetMaxLevels(max_levels);
    }
}

void configure_hypre_device_vendor_kernels()
{
#if defined(HYPRE_USING_CUDA) || defined(HYPRE_USING_GPU) || defined(HYPRE_USING_HIP) || defined(HYPRE_USING_DEVICE_OPENMP)
    if (HYPRE_SetMemoryLocation(HYPRE_MEMORY_DEVICE) != 0) {
        HYPRE_ClearAllErrors();
    }
    if (HYPRE_SetExecutionPolicy(HYPRE_EXEC_DEVICE) != 0) {
        HYPRE_ClearAllErrors();
    }
    if (HYPRE_SetSpTransUseVendor(1) != 0) {
        HYPRE_ClearAllErrors();
    }
    if (HYPRE_SetSpMVUseVendor(1) != 0) {
        HYPRE_ClearAllErrors();
    }
    if (HYPRE_SetSpGemmUseVendor(1) != 0) {
        HYPRE_ClearAllErrors();
    }
#endif
}
#endif

} // namespace

bool initialize_demag_poisson_hypre_device_solver(
    Context &ctx,
    GpuDemagPoissonWorkspace &workspace,
    std::string &error)
{
#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
    mfem::Hypre::Init();
    mfem::Hypre::InitDevice();
    configure_hypre_device_vendor_kernels();

    auto *A_bc = static_cast<mfem::SparseMatrix *>(ctx.poisson_demag.poisson_bc_op);
    if (A_bc == nullptr) {
        error = "GPU Poisson demag requires an initialized Poisson boundary-conditioned operator";
        return false;
    }
    ensure_mpi_initialized();
    const HYPRE_BigInt glob_size = static_cast<HYPRE_BigInt>(A_bc->NumRows());
    workspace.row_starts[0] = 0;
    workspace.row_starts[1] = glob_size;
    workspace.A_par = std::make_unique<mfem::HypreParMatrix>(
        fullmag_serial_comm(),
        glob_size,
        workspace.row_starts,
        A_bc);
    workspace.A_par->HypreRead();

    switch (ctx.demag.solver.preconditioner) {
    case FULLMAG_FEM_PRECONDITIONER_AMG: {
        auto amg = std::make_unique<mfem::HypreBoomerAMG>(*workspace.A_par);
        configure_demag_amg(*amg, ctx);
        workspace.preconditioner = std::move(amg);
        break;
    }
    case FULLMAG_FEM_PRECONDITIONER_JACOBI:
        workspace.preconditioner = std::make_unique<mfem::HypreDiagScale>(*workspace.A_par);
        break;
    case FULLMAG_FEM_PRECONDITIONER_NONE: {
        auto identity = std::make_unique<mfem::HypreIdentity>();
        identity->SetOperator(*workspace.A_par);
        workspace.preconditioner = std::move(identity);
        break;
    }
    default:
        error = "Unsupported native FEM GPU demag preconditioner enum";
        return false;
    }

    switch (ctx.demag.solver.solver) {
    case FULLMAG_FEM_LINEAR_SOLVER_CG: {
        auto pcg = std::make_unique<mfem::HyprePCG>(fullmag_serial_comm());
        pcg->iterative_mode = true;
        pcg->SetTol(ctx.demag.solver.relative_tolerance);
        if (ctx.demag.solver.has_absolute_tolerance &&
            ctx.demag.solver.absolute_tolerance > 0.0) {
            pcg->SetAbsTol(ctx.demag.solver.absolute_tolerance);
        }
        pcg->SetMaxIter(static_cast<int>(ctx.demag.solver.max_iterations));
        pcg->SetPrintLevel(static_cast<int>(ctx.demag.solver.print_level));
        pcg->SetOperator(*workspace.A_par);
        pcg->SetPreconditioner(*workspace.preconditioner);
        workspace.solver = std::move(pcg);
        break;
    }
    case FULLMAG_FEM_LINEAR_SOLVER_GMRES: {
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
        gmres->SetOperator(*workspace.A_par);
        gmres->SetPreconditioner(*workspace.preconditioner);
        workspace.solver = std::move(gmres);
        break;
    }
    default:
        error = "Unsupported native FEM GPU demag linear solver enum";
        return false;
    }

    workspace.b_par = std::make_unique<mfem::HypreParVector>(
        fullmag_serial_comm(),
        glob_size,
        ctx.gpu_state.device.demag_poisson.poisson_rhs,
        workspace.row_starts,
        true);
    workspace.x_par = std::make_unique<mfem::HypreParVector>(
        fullmag_serial_comm(),
        glob_size,
        ctx.gpu_state.device.demag_poisson.poisson_solution,
        workspace.row_starts,
        true);
    return true;
#else
    (void)ctx;
    (void)workspace;
    error = "strict FEM GPU demag requires MFEM MPI and hypre device solver support";
    return false;
#endif
}

void read_demag_poisson_hypre_solver_stats(
    const Context &ctx,
    GpuDemagPoissonWorkspace &workspace,
    int &iterations,
    double &residual)
{
    iterations = 0;
    residual = 0.0;
#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
    mfem::real_t raw_residual = 0.0;
    switch (ctx.demag.solver.solver) {
    case FULLMAG_FEM_LINEAR_SOLVER_CG: {
        auto *pcg = static_cast<mfem::HyprePCG *>(workspace.solver.get());
        pcg->GetNumIterations(iterations);
        pcg->GetFinalResidualNorm(raw_residual);
        break;
    }
    case FULLMAG_FEM_LINEAR_SOLVER_GMRES: {
        auto *gmres = static_cast<mfem::HypreGMRES *>(workspace.solver.get());
        gmres->GetNumIterations(iterations);
        gmres->GetFinalResidualNorm(raw_residual);
        break;
    }
    default:
        break;
    }
    residual = static_cast<double>(raw_residual);
#else
    (void)ctx;
    (void)workspace;
#endif
}

} // namespace fullmag::fem
