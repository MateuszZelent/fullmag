/* Executed CUDA contract for the deterministic pageable scalar-readback path. */

#include "gpu/cuda/reductions/reduction_workspace_memory.hpp"

#include <cuda_runtime.h>

#include <cstdio>
#include <cstdlib>
#include <string>

namespace {

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

void check_cuda(cudaError_t status, const char *message)
{
    if (status != cudaSuccess) {
        std::fprintf(stderr, "FAIL: %s: %s\n", message, cudaGetErrorString(status));
        std::exit(1);
    }
}

} // namespace

int main()
{
    check(
        setenv("FULLMAG_FEM_FORCE_PAGEABLE_SCALAR_READBACK", "1", 1) == 0,
        "pageable scalar readback test injection must be settable");

    fullmag::fem::FemGpuReductionWorkspaceDeviceState reductions{};
    uint64_t device_bytes = 0;
    uint64_t reduction_workspace_bytes = 0;
    std::string error;
    check(
        fullmag::fem::gpu_reduction_workspace_allocate(
            reductions,
            1,
            device_bytes,
            reduction_workspace_bytes,
            error),
        error.c_str());
    check(!reductions.scalar_result_pinned, "forced pageable path must not report pinned staging");
    check(
        reductions.host_scalar_result == reductions.pageable_scalar_result.data(),
        "forced pageable path must publish the fixed pageable staging array");

    const double expected = 3.25;
    check_cuda(
        cudaMemcpyAsync(
            reductions.scalar_result,
            &expected,
            sizeof(expected),
            cudaMemcpyHostToDevice,
            nullptr),
        "pageable scalar fixture H2D");
    check_cuda(
        cudaMemcpyAsync(
            reductions.host_scalar_result,
            reductions.scalar_result,
            sizeof(expected),
            cudaMemcpyDeviceToHost,
            nullptr),
        "pageable scalar fixture D2H");
    check_cuda(cudaStreamSynchronize(nullptr), "pageable scalar fixture synchronization");
    check(
        reductions.host_scalar_result[0] == expected,
        "pageable scalar staging must preserve the device result");

    fullmag::fem::gpu_reduction_workspace_free(reductions);
    check(
        reductions.host_scalar_result == nullptr && !reductions.scalar_result_pinned,
        "pageable scalar cleanup must not call cudaFreeHost on pageable memory");
    unsetenv("FULLMAG_FEM_FORCE_PAGEABLE_SCALAR_READBACK");
    return 0;
}
