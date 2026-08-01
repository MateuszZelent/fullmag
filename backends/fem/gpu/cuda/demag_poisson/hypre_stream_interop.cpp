/*
 * Exact HYPRE 3.1.0 CUDA stream adapter for strict FEM GPU demag.
 */

#include "gpu/cuda/demag_poisson/hypre_stream_interop.hpp"
#include "gpu/cuda/runtime/nvtx_ranges.hpp"

#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_HAS_MFEM_STACK
#include <mfem/config/_config.hpp>
#endif

#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
#include <HYPRE_config.h>
#include <_hypre_utilities.h>

#if MFEM_VERSION != 40900
#error "FEM GPU HYPRE stream interop requires MFEM 4.9.0"
#endif

static_assert(
    HYPRE_RELEASE_NUMBER == 30100,
    "FEM GPU HYPRE stream interop requires HYPRE 3.1.0");

// HYPRE publishes the handle macro in _hypre_utilities.h, but its CUDA stream
// accessor declaration is emitted only by the NVCC-oriented C++ private
// header. The symbol is exported by the pinned HYPRE 3.1.0 library.
cudaStream_t hypre_DeviceDataComputeStream(hypre_DeviceData *data);
#endif

namespace fullmag::fem {

#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_ENABLE_NVTX
extern "C" uint64_t fullmag_fem_nvtx_range_start(const char *name) noexcept
{
    return nvtx::start(name);
}

extern "C" void fullmag_fem_nvtx_range_end(uint64_t id) noexcept
{
    nvtx::end(id);
}
#endif

#if FULLMAG_HAS_CUDA_RUNTIME
namespace {

bool cuda_ok(cudaError_t rc, const char *operation, std::string &error)
{
    if (rc == cudaSuccess) {
        return true;
    }
    error = std::string(operation) + " failed: " + cudaGetErrorString(rc);
    return false;
}

} // namespace

void destroy_hypre_stream_interop(HypreStreamInterop &interop) noexcept
{
    if (interop.fullmag_ready != nullptr) {
        cudaEventDestroy(interop.fullmag_ready);
    }
    if (interop.hypre_done != nullptr) {
        cudaEventDestroy(interop.hypre_done);
    }
    if (interop.hypre_validation_done != nullptr) {
        cudaEventDestroy(interop.hypre_validation_done);
    }
    interop = HypreStreamInterop{};
}

bool initialize_hypre_stream_interop(
    HypreStreamInterop &interop,
    std::string &error)
{
#if FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)
    destroy_hypre_stream_interop(interop);
    interop.hypre_stream = hypre_HandleComputeStream(hypre_handle());
    if (interop.hypre_stream == nullptr) {
        error = "strict FEM GPU demag could not borrow the HYPRE 3.1.0 compute stream";
        return false;
    }
    if (!cuda_ok(
            cudaEventCreateWithFlags(&interop.fullmag_ready, cudaEventDisableTiming),
            "cudaEventCreate strict FEM GPU demag Fullmag-ready",
            error) ||
        !cuda_ok(
            cudaEventCreateWithFlags(&interop.hypre_done, cudaEventDisableTiming),
            "cudaEventCreate strict FEM GPU demag HYPRE-done",
            error) ||
        !cuda_ok(
            cudaEventCreateWithFlags(&interop.hypre_validation_done, cudaEventDisableTiming),
            "cudaEventCreate strict FEM GPU demag HYPRE-validation-done",
            error)) {
        destroy_hypre_stream_interop(interop);
        return false;
    }
    interop.ready = true;
    return true;
#else
    (void)interop;
    error = "strict FEM GPU demag HYPRE stream interop requires MFEM MPI";
    return false;
#endif
}

bool hypre_wait_for_fullmag(
    HypreStreamInterop &interop,
    cudaStream_t fullmag_stream,
    std::string &error)
{
    if (!interop.ready || interop.hypre_stream == nullptr ||
        interop.fullmag_ready == nullptr) {
        error = "strict FEM GPU demag HYPRE stream interop is not initialized";
        return false;
    }
    if (!cuda_ok(
            cudaEventRecord(interop.fullmag_ready, fullmag_stream),
            "cudaEventRecord strict FEM GPU demag Fullmag-ready",
            error) ||
        !cuda_ok(
            cudaStreamWaitEvent(interop.hypre_stream, interop.fullmag_ready, 0),
            "cudaStreamWaitEvent strict FEM GPU demag HYPRE waits for Fullmag",
            error)) {
        return false;
    }
    interop.event_wait_count += 1u;
    return true;
}

bool fullmag_wait_for_hypre(
    HypreStreamInterop &interop,
    cudaStream_t fullmag_stream,
    std::string &error)
{
    if (!interop.ready || interop.hypre_stream == nullptr ||
        interop.hypre_done == nullptr) {
        error = "strict FEM GPU demag HYPRE stream interop is not initialized";
        return false;
    }
    if (!cuda_ok(
            cudaEventRecord(interop.hypre_done, interop.hypre_stream),
            "cudaEventRecord strict FEM GPU demag HYPRE-done",
            error) ||
        !cuda_ok(
            cudaStreamWaitEvent(fullmag_stream, interop.hypre_done, 0),
            "cudaStreamWaitEvent strict FEM GPU demag Fullmag waits for HYPRE",
            error)) {
        return false;
    }
    interop.event_wait_count += 1u;
    return true;
}

bool mfem_default_stream_wait_for_hypre_validation(
    HypreStreamInterop &interop,
    std::string &error)
{
    if (!interop.ready || interop.hypre_stream == nullptr ||
        interop.hypre_validation_done == nullptr) {
        error = "strict FEM GPU demag HYPRE stream interop is not initialized";
        return false;
    }
    if (!cuda_ok(
            cudaEventRecord(interop.hypre_validation_done, interop.hypre_stream),
            "cudaEventRecord strict FEM GPU demag HYPRE-validation-done",
            error) ||
        !cuda_ok(
            cudaStreamWaitEvent(nullptr, interop.hypre_validation_done, 0),
            "cudaStreamWaitEvent strict FEM GPU demag MFEM waits for HYPRE validation",
            error)) {
        return false;
    }
    interop.event_wait_count += 1u;
    return true;
}
#endif

} // namespace fullmag::fem
