/*
 * cuda_periodic_demag_contract.cpp - source contract for strict GPU
 * periodic Poisson demag enablement.
 */

#include "cuda_demag_residual_fixture.hpp"

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

void check_hypre_stream_interop(fullmag::fem::HypreStreamInterop &interop, std::string &error)
{
    const uint64_t waits_before_stream_contract = interop.event_wait_count;
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
            interop, fullmag_stream, error);
    dependency_bridge_ok = dependency_bridge_ok &&
        cudaMemcpyAsync(
            hypre_value,
            producer_value,
            sizeof(int),
            cudaMemcpyDeviceToDevice,
            interop.hypre_stream) == cudaSuccess;
    dependency_bridge_ok = dependency_bridge_ok &&
        fullmag::fem::fullmag_wait_for_hypre(
            interop, fullmag_stream, error);
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
            interop.hypre_stream) == cudaSuccess;
    dependency_bridge_ok = dependency_bridge_ok &&
        fullmag::fem::mfem_default_stream_wait_for_hypre_validation(
            interop, error);
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
    check(interop.event_wait_count == waits_before_stream_contract + 3u &&
              interop.global_sync_count == 0u,
          "strict GPU event bridge reports exact waits and zero global syncs");

    cudaFree(hypre_value);
    cudaFree(producer_value);
    cudaEventDestroy(independent_done);
    cudaStreamDestroy(independent_stream);
    cudaStreamDestroy(fullmag_stream);
}
#endif

} // namespace

int main()
{
#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI) && FULLMAG_HAS_CUDA_RUNTIME
    int selected_device = 0;
    check(cudaGetDevice(&selected_device) == cudaSuccess,
          "strict GPU periodic contract selects a CUDA device");
    mfem::Device cuda_device("cuda", selected_device);
    fullmag::fem::test::check_gpu_hypre_demag_residual(check, check_hypre_stream_interop);
#endif
    const std::filesystem::path root = fem_source_root();
    const std::string gpu_operators =
        read_text_file(root / "gpu" / "cuda" / "demag_poisson" / "operators.cpp");
    const std::string gpu_hypre =
        read_text_file(root / "gpu" / "cuda" / "demag_poisson" / "hypre_device_solver.cpp");
    const std::string gpu_cert =
        read_text_file(root / "gpu" / "cuda" / "demag_poisson" / "hypre_residual_certification.cpp");
    const std::string demag_kernels =
        read_text_file(root / "gpu" / "cuda" / "demag_poisson" / "demag_kernels.cu");
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
    const size_t cert_matvec_pos = gpu_cert.find("input.A_par->Mult(");
    const size_t cert_axpy_pos = gpu_cert.find("HYPRE_ParVectorAxpy(", cert_matvec_pos);
    const size_t cert_norm_pair_pos =
        gpu_cert.find("fullmag_cuda_demag_validation_norm_pair(", cert_axpy_pos);
    const size_t cert_rhs_finite_pos =
        gpu_cert.find("!std::isfinite(output.rhs_norm)", cert_norm_pair_pos);
    const size_t cert_res_finite_pos =
        gpu_cert.find("!std::isfinite(output.absolute_residual)", cert_rhs_finite_pos);
    const size_t hypre_cert_call_pos =
        gpu_hypre.find("certify_gpu_hypre_demag_residual(");
    const size_t hypre_cert_flag_pos =
        gpu_hypre.find("residual_independently_certified", hypre_cert_call_pos);
    const size_t pair_blocks_def_pos =
        demag_kernels.find("__global__ void demag_validation_norm_pair_blocks_kernel(");
    const size_t pair_finalize_def_pos =
        demag_kernels.find("__global__ void demag_validation_norm_pair_finalize_kernel(",
                           pair_blocks_def_pos);
    const size_t pair_wrapper_pos =
        demag_kernels.find("cudaError_t fullmag_cuda_demag_validation_norm_pair(");
    const size_t pair_blocks_launch_pos =
        demag_kernels.find("demag_validation_norm_pair_blocks_kernel<<<", pair_wrapper_pos);
    const size_t pair_finalize_launch_pos =
        demag_kernels.find("demag_validation_norm_pair_finalize_kernel<<<", pair_blocks_launch_pos);
    const size_t pair_copy_pos =
        demag_kernels.find("cudaMemcpyAsync(", pair_finalize_launch_pos);
    const size_t pair_fence_pos =
        demag_kernels.find("cudaStreamSynchronize(stream)", pair_copy_pos);
    check(
        cert_matvec_pos != std::string::npos &&
            cert_matvec_pos < cert_axpy_pos &&
            cert_axpy_pos < cert_norm_pair_pos &&
            cert_norm_pair_pos < cert_rhs_finite_pos &&
            cert_rhs_finite_pos < cert_res_finite_pos &&
            cert_res_finite_pos != std::string::npos &&
            gpu_cert.find("HYPRE_ClearAllErrors") == std::string::npos &&
            gpu_cert.find("HYPRE_ClearError") == std::string::npos &&
            gpu_cert.find("reject_queued_work") != std::string::npos &&
            hypre_cert_call_pos != std::string::npos &&
            hypre_cert_call_pos < hypre_cert_flag_pos &&
            hypre_cert_flag_pos != std::string::npos &&
            gpu_hypre.find("mfem_default_stream_wait_for_hypre_validation(") == std::string::npos,
        "strict GPU residual certification uses shared sticky-safe certifier and checks RHS finiteness before residual finiteness");
    check(
        pair_blocks_def_pos != std::string::npos &&
            pair_finalize_def_pos != std::string::npos &&
            pair_blocks_def_pos < pair_finalize_def_pos &&
            demag_kernels.substr(pair_blocks_def_pos, pair_finalize_def_pos - pair_blocks_def_pos)
                    .find("break;") == std::string::npos &&
            pair_wrapper_pos != std::string::npos &&
            pair_wrapper_pos < pair_blocks_launch_pos &&
            pair_blocks_launch_pos < pair_finalize_launch_pos &&
            pair_finalize_launch_pos < pair_copy_pos &&
            pair_copy_pos < pair_fence_pos &&
            pair_fence_pos != std::string::npos,
        "strict GPU pair-norm reduction uses two-pass multi-block CUB kernels without early break and one stream sync");
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
