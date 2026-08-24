/*
 * streams.cu - Native FDM CUDA stream lifecycle and legacy-default handoff.
 *
 * Context owns the stream pointers; this runtime owner creates, destroys, and
 * bridges work between the legacy default stream and the nonblocking compute
 * stream used by demag, reductions, and staged multilayer kernels.
 */

#include "context.hpp"

#include <cuda_runtime.h>

namespace fullmag {
namespace fdm {

extern void set_cuda_error(Context &ctx, const char *operation, cudaError_t err);

bool context_create_compute_stream(Context &ctx) {
    if (ctx.compute_stream) {
        return true;
    }

    cudaStream_t compute_stream{};
    cudaError_t err = cudaStreamCreateWithFlags(&compute_stream, cudaStreamNonBlocking);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaStreamCreate(compute_stream)", err);
        return false;
    }
    ctx.compute_stream = reinterpret_cast<void *>(compute_stream);

    cudaEvent_t ready_event{};
    err = cudaEventCreateWithFlags(&ready_event, cudaEventDisableTiming);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaEventCreate(compute_ready_event)", err);
        cudaStreamDestroy(compute_stream);
        ctx.compute_stream = nullptr;
        return false;
    }
    ctx.compute_ready_event = reinterpret_cast<void *>(ready_event);

    cudaEvent_t done_event{};
    err = cudaEventCreateWithFlags(&done_event, cudaEventDisableTiming);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "cudaEventCreate(compute_done_event)", err);
        cudaEventDestroy(ready_event);
        ctx.compute_ready_event = nullptr;
        cudaStreamDestroy(compute_stream);
        ctx.compute_stream = nullptr;
        return false;
    }
    ctx.compute_done_event = reinterpret_cast<void *>(done_event);

    return true;
}

void context_destroy_compute_stream(Context &ctx) {
    if (ctx.compute_stream) {
        cudaStreamSynchronize(reinterpret_cast<cudaStream_t>(ctx.compute_stream));
        cudaStreamSynchronize(nullptr);
    }
    if (ctx.compute_done_event) {
        cudaEventDestroy(reinterpret_cast<cudaEvent_t>(ctx.compute_done_event));
        ctx.compute_done_event = nullptr;
    }
    if (ctx.compute_ready_event) {
        cudaEventDestroy(reinterpret_cast<cudaEvent_t>(ctx.compute_ready_event));
        ctx.compute_ready_event = nullptr;
    }
    if (ctx.compute_stream) {
        cudaStreamDestroy(reinterpret_cast<cudaStream_t>(ctx.compute_stream));
        ctx.compute_stream = nullptr;
    }
}

cudaStream_t context_compute_stream(Context &ctx) {
    return reinterpret_cast<cudaStream_t>(ctx.compute_stream);
}

bool context_begin_compute_stream_work(Context &ctx, const char *operation) {
    auto stream = context_compute_stream(ctx);
    auto ready_event = reinterpret_cast<cudaEvent_t>(ctx.compute_ready_event);
    if (!stream || !ready_event) {
        ctx.last_error = std::string(operation) + ": compute stream not initialized";
        return false;
    }

    cudaError_t err = cudaEventRecord(ready_event, nullptr);
    if (err != cudaSuccess) {
        std::string label = std::string(operation) + ": cudaEventRecord(compute_ready_event)";
        set_cuda_error(ctx, label.c_str(), err);
        return false;
    }
    err = cudaStreamWaitEvent(stream, ready_event, 0);
    if (err != cudaSuccess) {
        std::string label = std::string(operation) + ": cudaStreamWaitEvent(compute_ready_event)";
        set_cuda_error(ctx, label.c_str(), err);
        return false;
    }
    return true;
}

bool context_end_compute_stream_work(Context &ctx, const char *operation) {
    auto stream = context_compute_stream(ctx);
    auto done_event = reinterpret_cast<cudaEvent_t>(ctx.compute_done_event);
    if (!stream || !done_event) {
        ctx.last_error = std::string(operation) + ": compute stream not initialized";
        return false;
    }

    cudaError_t err = cudaEventRecord(done_event, stream);
    if (err != cudaSuccess) {
        std::string label = std::string(operation) + ": cudaEventRecord(compute_done_event)";
        set_cuda_error(ctx, label.c_str(), err);
        return false;
    }
    err = cudaStreamWaitEvent(nullptr, done_event, 0);
    if (err != cudaSuccess) {
        std::string label = std::string(operation) + ": cudaStreamWaitEvent(compute_done_event)";
        set_cuda_error(ctx, label.c_str(), err);
        return false;
    }
    return true;
}

bool context_complete_solver_receipt_attempt(Context &ctx, const char *operation) {
    const cudaError_t err = cudaStreamSynchronize(nullptr);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, operation, err);
        return false;
    }
    return true;
}

bool context_test_copy_f64_on_compute_stream(
    Context &ctx, double *destination, const double *source, uint64_t values) {
    if (destination == nullptr || source == nullptr || values == 0 ||
        values > SIZE_MAX / sizeof(double)) {
        return false;
    }
    const auto stream = context_compute_stream(ctx);
    return stream != nullptr &&
        cudaMemcpyAsync(destination, source,
                        static_cast<size_t>(values) * sizeof(double),
                        cudaMemcpyDeviceToDevice, stream) == cudaSuccess &&
        cudaStreamSynchronize(stream) == cudaSuccess;
}

} // namespace fdm
} // namespace fullmag
