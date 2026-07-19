/*
 * cuda_periodic_demag_contract.cpp - source contract for strict GPU
 * periodic Poisson demag enablement.
 */

#include "context.hpp"
#include "gpu/cuda/demag_poisson/hypre_device_solver.hpp"

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#endif

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

namespace {

void check(bool condition, const char *msg)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", msg);
        std::exit(1);
    }
}

std::string read_text_file(const std::filesystem::path &path)
{
    std::ifstream in(path);
    if (!in) {
        std::fprintf(stderr, "FAIL: unable to read %s\n", path.string().c_str());
        std::exit(1);
    }
    std::ostringstream buffer;
    buffer << in.rdbuf();
    return buffer.str();
}

std::filesystem::path fem_source_root()
{
    const std::filesystem::path this_file(__FILE__);
    if (this_file.is_absolute()) {
        return this_file.parent_path().parent_path();
    }
    return std::filesystem::current_path() / this_file.parent_path().parent_path();
}

#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI) && FULLMAG_HAS_CUDA_RUNTIME
void gpu_hypre_demag_rejects_one_iteration_candidate()
{
    fullmag::fem::Context ctx;
    ctx.demag.solver.solver = FULLMAG_FEM_LINEAR_SOLVER_CG;
    ctx.demag.solver.preconditioner = FULLMAG_FEM_PRECONDITIONER_NONE;
    ctx.demag.solver.relative_tolerance = 1.0e-14;
    ctx.demag.solver.has_absolute_tolerance = 0;
    ctx.demag.solver.absolute_tolerance = 0.0;
    ctx.demag.solver.max_iterations = 1;
    ctx.demag.solver.print_level = 0;

    mfem::SparseMatrix op(8, 8);
    for (int i = 0; i < 8; ++i) {
        op.Add(i, i, 3.0 + static_cast<double>(i));
        if (i + 1 < 8) {
            op.Add(i, i + 1, -1.0);
            op.Add(i + 1, i, -1.0);
        }
    }
    op.Finalize();
    ctx.poisson_demag.poisson_bc_op = &op;
    check(cudaMalloc(
              reinterpret_cast<void **>(&ctx.gpu_state.device.demag_poisson.poisson_rhs),
              8 * sizeof(double)) == cudaSuccess,
          "strict GPU Hypre fixture allocates RHS");
    check(cudaMalloc(
              reinterpret_cast<void **>(&ctx.gpu_state.device.demag_poisson.poisson_solution),
              8 * sizeof(double)) == cudaSuccess,
          "strict GPU Hypre fixture allocates solution");

    fullmag::fem::GpuDemagPoissonWorkspace workspace;
    std::string error;
    check(fullmag::fem::initialize_demag_poisson_hypre_device_solver(ctx, workspace, error),
          "strict GPU Hypre one-iteration fixture initializes");
    *workspace.b_par = 1.0;
    *workspace.x_par = 0.0;
    workspace.b_par->HypreRead();
    workspace.x_par->HypreRead();
    workspace.solver->Mult(*workspace.b_par, *workspace.x_par);
    check(cudaDeviceSynchronize() == cudaSuccess, "strict GPU Hypre fixture synchronizes");

    int iterations = -1;
    double residual = -1.0;
    error.clear();
    const bool ok = fullmag::fem::validate_demag_poisson_hypre_device_solve(
        ctx, workspace, iterations, residual, error);
    check(!ok, "strict GPU Hypre demag must reject a nonconverged one-iteration solve");
    check(error.find("solver_kind=gpu_poisson_hypre/cg") != std::string::npos,
          "strict GPU failure includes solver kind");
    check(error.find("iterations=1") != std::string::npos,
          "strict GPU failure includes iterations");
    check(error.find("residual=") != std::string::npos,
          "strict GPU failure includes residual");
    check(error.find("relative_tolerance=") != std::string::npos,
          "strict GPU failure includes tolerance");
    check(error.find("max_iterations=1") != std::string::npos,
          "strict GPU failure includes maximum iterations");
    workspace.solver.reset();
    workspace.preconditioner.reset();
    workspace.x_par.reset();
    workspace.b_par.reset();
    workspace.A_par.reset();
    check(cudaFree(ctx.gpu_state.device.demag_poisson.poisson_solution) == cudaSuccess,
          "strict GPU Hypre fixture frees solution");
    check(cudaFree(ctx.gpu_state.device.demag_poisson.poisson_rhs) == cudaSuccess,
          "strict GPU Hypre fixture frees RHS");
    ctx.gpu_state.device.demag_poisson.poisson_solution = nullptr;
    ctx.gpu_state.device.demag_poisson.poisson_rhs = nullptr;
    ctx.poisson_demag.poisson_bc_op = nullptr;
}
#endif

} // namespace

int main()
{
#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI) && FULLMAG_HAS_CUDA_RUNTIME
    gpu_hypre_demag_rejects_one_iteration_candidate();
#endif
    const std::filesystem::path root = fem_source_root();
    const std::string gpu_operators =
        read_text_file(root / "gpu" / "cuda" / "demag_poisson" / "operators.cpp");
    const std::string gpu_hypre =
        read_text_file(root / "gpu" / "cuda" / "demag_poisson" / "hypre_device_solver.cpp");
    const std::string gpu_stage =
        read_text_file(root / "gpu" / "cuda" / "demag_poisson" / "stage_compute.cpp");

    check(
        gpu_operators.find("strict FEM GPU demag does not support periodic Poisson demag yet") ==
            std::string::npos,
        "strict GPU Poisson demag must not reject periodic_node_pairs");
    check(
        gpu_operators.find("periodic_scalar_row_count(ctx)") != std::string::npos &&
            gpu_operators.find("periodic_scalar_column(ctx, col)") != std::string::npos,
        "strict GPU Poisson demag CSR builders must reduce scalar potential rows/columns by periodic classes");
    check(
        gpu_operators.find("reduce_sparse_matrix_by_periodic_classes") != std::string::npos,
        "strict GPU Poisson-Robin boundary energy must use a periodic reduced boundary mass");
    check(
        gpu_hypre.find("ctx.poisson_demag.periodic_matrix") != std::string::npos &&
            gpu_hypre.find("demag_periodic_poisson_reduction_requested(ctx)") !=
                std::string::npos,
        "strict GPU Hypre demag solver must use the periodic reduced Poisson matrix for PBC");
    const size_t validate_pos =
        gpu_stage.find("validate_demag_poisson_hypre_device_solve(");
    const size_t recover_pos = gpu_stage.find("fullmag_cuda_demag_recovery_csr(");
    check(
        validate_pos != std::string::npos &&
            recover_pos != std::string::npos &&
            validate_pos < recover_pos,
        "strict GPU demag must reject a failed Hypre candidate before field recovery");
    check(
        gpu_stage.find("cudaMemset rejected GPU Poisson demag candidate") !=
            std::string::npos,
        "strict GPU demag must invalidate the rejected scalar-potential candidate");

    return 0;
}
