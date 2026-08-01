/*
 * cuda_periodic_demag_contract.cpp - source contract for strict GPU
 * periodic Poisson demag enablement.
 */

#include "context.hpp"
#include "gpu/cuda/demag_poisson/hypre_device_solver.hpp"
#include "gpu/cuda/demag_poisson/hypre_stream_interop.hpp"

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#endif

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <thread>

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
struct BlockingHostCallbackState {
    std::atomic<bool> started{false};
    std::atomic<bool> release{false};
};

void CUDART_CB block_independent_stream_until_released(void *opaque)
{
    auto &state = *static_cast<BlockingHostCallbackState *>(opaque);
    state.started.store(true, std::memory_order_release);
    while (!state.release.load(std::memory_order_acquire)) {
        std::this_thread::yield();
    }
}

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
    check(fullmag::fem::initialize_hypre_stream_interop(workspace.stream_interop, error),
          "strict GPU fixture initializes exact HYPRE stream interop");
    workspace.solver->Mult(*workspace.b_par, *workspace.x_par);
    check(fullmag::fem::fullmag_wait_for_hypre(workspace.stream_interop, nullptr, error),
          "strict GPU fixture orders the solve before residual certification");

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

    const uint64_t waits_before_stream_contract = workspace.stream_interop.event_wait_count;
    cudaStream_t fullmag_stream = nullptr;
    cudaStream_t independent_stream = nullptr;
    cudaEvent_t independent_done = nullptr;
    int *producer_value = nullptr;
    int *hypre_value = nullptr;
    check(cudaStreamCreateWithFlags(&fullmag_stream, cudaStreamNonBlocking) == cudaSuccess,
          "strict GPU fixture creates Fullmag stream");
    check(cudaStreamCreateWithFlags(&independent_stream, cudaStreamNonBlocking) == cudaSuccess,
          "strict GPU fixture creates independent stream");
    check(cudaEventCreateWithFlags(&independent_done, cudaEventDisableTiming) == cudaSuccess,
          "strict GPU fixture creates independent completion event");
    check(cudaMalloc(reinterpret_cast<void **>(&producer_value), sizeof(int)) == cudaSuccess &&
              cudaMalloc(reinterpret_cast<void **>(&hypre_value), sizeof(int)) == cudaSuccess,
          "strict GPU fixture allocates stream-order sentinels");

    BlockingHostCallbackState independent_callback;
    check(cudaLaunchHostFunc(
              independent_stream,
              block_independent_stream_until_released,
              &independent_callback) == cudaSuccess &&
              cudaEventRecord(independent_done, independent_stream) == cudaSuccess,
          "strict GPU fixture queues deliberately incomplete independent work");
    const auto callback_deadline =
        std::chrono::steady_clock::now() + std::chrono::seconds(2);
    while (!independent_callback.started.load(std::memory_order_acquire) &&
           std::chrono::steady_clock::now() < callback_deadline) {
        std::this_thread::yield();
    }
    const bool independent_started =
        independent_callback.started.load(std::memory_order_acquire);

    const int producer_host = 37;
    int consumer_host = 0;
    bool dependency_bridge_ok = independent_started;
    dependency_bridge_ok = dependency_bridge_ok &&
        cudaMemcpyAsync(
            producer_value,
            &producer_host,
            sizeof(int),
            cudaMemcpyHostToDevice,
            fullmag_stream) == cudaSuccess;
    dependency_bridge_ok = dependency_bridge_ok &&
        fullmag::fem::hypre_wait_for_fullmag(
            workspace.stream_interop, fullmag_stream, error);
    dependency_bridge_ok = dependency_bridge_ok &&
        cudaMemcpyAsync(
            hypre_value,
            producer_value,
            sizeof(int),
            cudaMemcpyDeviceToDevice,
            workspace.stream_interop.hypre_stream) == cudaSuccess;
    dependency_bridge_ok = dependency_bridge_ok &&
        fullmag::fem::fullmag_wait_for_hypre(
            workspace.stream_interop, fullmag_stream, error);
    dependency_bridge_ok = dependency_bridge_ok &&
        cudaMemcpyAsync(
            &consumer_host,
            hypre_value,
            sizeof(int),
            cudaMemcpyDeviceToHost,
            fullmag_stream) == cudaSuccess &&
        cudaStreamSynchronize(fullmag_stream) == cudaSuccess;
    dependency_bridge_ok = dependency_bridge_ok &&
        cudaMemcpyAsync(
            hypre_value,
            producer_value,
            sizeof(int),
            cudaMemcpyDeviceToDevice,
            workspace.stream_interop.hypre_stream) == cudaSuccess;
    dependency_bridge_ok = dependency_bridge_ok &&
        fullmag::fem::mfem_default_stream_wait_for_hypre_validation(
            workspace.stream_interop, error);
    dependency_bridge_ok = dependency_bridge_ok &&
        cudaMemcpyAsync(
            &consumer_host,
            hypre_value,
            sizeof(int),
            cudaMemcpyDeviceToHost,
            nullptr) == cudaSuccess &&
        cudaStreamSynchronize(nullptr) == cudaSuccess;
    const cudaError_t independent_status = cudaEventQuery(independent_done);
    independent_callback.release.store(true, std::memory_order_release);
    const bool independent_cleanup_ok =
        cudaStreamSynchronize(independent_stream) == cudaSuccess;

    check(dependency_bridge_ok && consumer_host == producer_host,
          "strict GPU event bridge orders Fullmag producer, HYPRE work, and Fullmag consumer");
    check(independent_status == cudaErrorNotReady,
          "strict GPU event bridge must not globally complete an independent stream");
    check(independent_cleanup_ok,
          "strict GPU fixture releases and completes independent work");
    check(workspace.stream_interop.event_wait_count == waits_before_stream_contract + 3u &&
              workspace.stream_interop.global_sync_count == 0u,
          "strict GPU event bridge reports exact waits and zero global syncs");

    cudaFree(hypre_value);
    cudaFree(producer_value);
    cudaEventDestroy(independent_done);
    cudaStreamDestroy(independent_stream);
    cudaStreamDestroy(fullmag_stream);
    fullmag::fem::destroy_hypre_stream_interop(workspace.stream_interop);
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
    const std::string hypre_stream_interop =
        read_text_file(root / "gpu" / "cuda" / "demag_poisson" / "hypre_stream_interop.cpp");
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
    check(
        gpu_hypre.find("mfem_default_stream_wait_for_hypre_validation(") !=
                std::string::npos &&
            hypre_stream_interop.find("hypre_validation_done") != std::string::npos &&
            hypre_stream_interop.find(
                "cudaStreamWaitEvent(nullptr, interop.hypre_validation_done, 0)") !=
                std::string::npos,
        "strict GPU residual certification must order its Hypre matvec before MFEM Vector::Add");
    const size_t validate_pos =
        gpu_stage.find("validate_demag_poisson_hypre_device_solve(");
    const size_t recover_pos = gpu_stage.find("fullmag_cuda_demag_recovery_csr(");
    check(
        validate_pos != std::string::npos &&
            recover_pos != std::string::npos &&
            validate_pos < recover_pos,
        "strict GPU demag must reject a failed Hypre candidate before field recovery");
    check(
        gpu_stage.find("cudaMemsetAsync rejected GPU Poisson demag candidate") !=
            std::string::npos,
        "strict GPU demag must invalidate the rejected scalar-potential candidate");

    return 0;
}
