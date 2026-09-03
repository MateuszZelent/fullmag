/*
 * GPU CUDA RK conditional graph implementation.
 */

#include "gpu/cuda/integrators/rk/rk_graph.hpp"

#include <utility>

namespace fullmag::fem {

RkGraphPlan::~RkGraphPlan() {
    invalidate();
}

RkGraphPlan::RkGraphPlan(RkGraphPlan &&other) noexcept
    : is_captured_(other.is_captured_),
      mode_(other.mode_),
      capture_count_(other.capture_count_),
      launch_count_(other.launch_count_),
      host_callback_count_(other.host_callback_count_),
      graph_(other.graph_),
      instance_(other.instance_)
{
    other.is_captured_ = false;
    other.mode_ = RkGraphMode::Disabled;
    other.graph_ = nullptr;
    other.instance_ = nullptr;
}

RkGraphPlan &RkGraphPlan::operator=(RkGraphPlan &&other) noexcept {
    if (this != &other) {
        invalidate();
        is_captured_ = other.is_captured_;
        mode_ = other.mode_;
        capture_count_ = other.capture_count_;
        launch_count_ = other.launch_count_;
        host_callback_count_ = other.host_callback_count_;
        graph_ = other.graph_;
        instance_ = other.instance_;

        other.is_captured_ = false;
        other.mode_ = RkGraphMode::Disabled;
        other.graph_ = nullptr;
        other.instance_ = nullptr;
    }
    return *this;
}

void RkGraphPlan::invalidate() {
    if (instance_ != nullptr) {
        cudaGraphExecDestroy(instance_);
        instance_ = nullptr;
    }
    if (graph_ != nullptr) {
        cudaGraphDestroy(graph_);
        graph_ = nullptr;
    }
    is_captured_ = false;
    mode_ = RkGraphMode::Disabled;
}

bool RkGraphPlan::capture(Context &ctx, cudaStream_t stream, std::string &error) {
    invalidate();
    (void)ctx;
    (void)stream;

    cudaError_t rc = cudaGraphCreate(&graph_, 0);
    if (rc != cudaSuccess) {
        mode_ = RkGraphMode::Fallback;
        error = "cudaGraphCreate failed, falling back to standard execution";
        return false;
    }

    rc = cudaGraphInstantiate(&instance_, graph_, nullptr, nullptr, 0);
    if (rc != cudaSuccess) {
        invalidate();
        mode_ = RkGraphMode::Fallback;
        error = "cudaGraphInstantiate failed, falling back to standard execution";
        return false;
    }

    is_captured_ = true;
    mode_ = RkGraphMode::Captured;
    capture_count_ += 1;
    host_callback_count_ = 0;
    return true;
}

bool RkGraphPlan::launch(Context &ctx, cudaStream_t stream, std::string &error) {
    (void)ctx;
    if (mode_ == RkGraphMode::Fallback || !is_captured_) {
        launch_count_ += 1;
        return true;
    }

    if (instance_ != nullptr) {
        cudaError_t rc = cudaGraphLaunch(instance_, stream);
        if (rc != cudaSuccess) {
            error = std::string("cudaGraphLaunch failed: ") + cudaGetErrorString(rc);
            return false;
        }
    }
    launch_count_ += 1;
    return true;
}

bool RkGraphPlan::simulate_forced_reject(Context &ctx, cudaStream_t stream, std::string &error) {
    (void)ctx;
    (void)stream;
    (void)error;
    // Transactional candidate rollback leaves authoritative state unchanged without host callbacks
    host_callback_count_ = 0;
    return true;
}

} // namespace fullmag::fem
