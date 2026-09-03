/*
 * GPU CUDA RK conditional graph implementation.
 */

#include "gpu/cuda/integrators/rk/rk_graph.hpp"
#include "context.hpp"
#include "gpu/cuda/integrators/rk/rk_component_copy.hpp"
#include "gpu/cuda/integrators/rk/rk_output_control.hpp"

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
      instance_(other.instance_),
      d_probe_(other.d_probe_)
{
    other.is_captured_ = false;
    other.mode_ = RkGraphMode::Disabled;
    other.graph_ = nullptr;
    other.instance_ = nullptr;
    other.d_probe_ = nullptr;
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
        d_probe_ = other.d_probe_;

        other.is_captured_ = false;
        other.mode_ = RkGraphMode::Disabled;
        other.graph_ = nullptr;
        other.instance_ = nullptr;
        other.d_probe_ = nullptr;
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
    if (d_probe_ != nullptr) {
        cudaFree(d_probe_);
        d_probe_ = nullptr;
    }
    is_captured_ = false;
    mode_ = RkGraphMode::Disabled;
}

bool RkGraphPlan::capture(Context &ctx, cudaStream_t stream, std::string &error) {
    invalidate();

    cudaStream_t capture_stream = stream;
    bool created_stream = false;
    if (capture_stream == nullptr) {
        cudaError_t s_rc = cudaStreamCreateWithFlags(&capture_stream, cudaStreamNonBlocking);
        if (s_rc != cudaSuccess) {
            mode_ = RkGraphMode::Fallback;
            error = std::string("cudaStreamCreateWithFlags failed: ") + cudaGetErrorString(s_rc);
            return false;
        }
        created_stream = true;
    }

    if (d_probe_ == nullptr) {
        cudaError_t m_rc = cudaMalloc(&d_probe_, sizeof(double));
        if (m_rc != cudaSuccess) {
            if (created_stream) cudaStreamDestroy(capture_stream);
            mode_ = RkGraphMode::Fallback;
            error = std::string("cudaMalloc d_probe_ failed: ") + cudaGetErrorString(m_rc);
            return false;
        }
    }

    cudaError_t rc = cudaStreamBeginCapture(capture_stream, cudaStreamCaptureModeGlobal);
    if (rc != cudaSuccess) {
        if (created_stream) cudaStreamDestroy(capture_stream);
        mode_ = RkGraphMode::Fallback;
        error = std::string("cudaStreamBeginCapture failed: ") + cudaGetErrorString(rc);
        return false;
    }

    auto &gpu = ctx.gpu_state.device;
    if (gpu.lifecycle.allocated && gpu.magnetization.m.x != nullptr && gpu.rk.m_stage.x != nullptr) {
        std::string copy_err;
        gpu_rk_copy_component_device(
            gpu.magnetization.m,
            gpu.rk.m_stage,
            static_cast<int>(gpu.lifecycle.node_count),
            capture_stream,
            "graph capture RK stage copy",
            copy_err);
    }
    if (d_probe_ != nullptr) {
        cudaMemsetAsync(d_probe_, 0, sizeof(double), capture_stream);
    }

    rc = cudaStreamEndCapture(capture_stream, &graph_);
    if (created_stream) {
        cudaStreamDestroy(capture_stream);
    }
    if (rc != cudaSuccess) {
        mode_ = RkGraphMode::Fallback;
        error = std::string("cudaStreamEndCapture failed: ") + cudaGetErrorString(rc);
        return false;
    }

    size_t num_nodes = 0;
    rc = cudaGraphGetNodes(graph_, nullptr, &num_nodes);
    if (rc != cudaSuccess || num_nodes == 0) {
        invalidate();
        mode_ = RkGraphMode::Fallback;
        error = "captured graph contains zero nodes, falling back to standard execution";
        return false;
    }

    rc = cudaGraphInstantiate(&instance_, graph_, nullptr, nullptr, 0);
    if (rc != cudaSuccess) {
        invalidate();
        mode_ = RkGraphMode::Fallback;
        error = std::string("cudaGraphInstantiate failed: ") + cudaGetErrorString(rc);
        return false;
    }

    is_captured_ = true;
    mode_ = RkGraphMode::Captured;
    capture_count_ += 1;
    host_callback_count_ = 0;
    error.clear();
    return true;
}

bool RkGraphPlan::launch(Context &ctx, cudaStream_t stream, std::string &error) {
    if (mode_ == RkGraphMode::Fallback || !is_captured_) {
        // Fallback: execute standard device RK attempt/copy without CUDA graph
        launch_count_ += 1;
        auto &gpu = ctx.gpu_state.device;
        if (gpu.lifecycle.allocated && gpu.magnetization.m.x != nullptr && gpu.rk.candidate.m_candidate.x != nullptr) {
            std::string cap_err;
            rk_candidate_capture_device(
                gpu.rk.candidate,
                gpu.magnetization.m,
                gpu.lifecycle.node_count,
                stream,
                cap_err);
        }
        error.clear();
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
    error.clear();
    return true;
}

bool RkGraphPlan::simulate_forced_reject(Context &ctx, cudaStream_t stream, std::string &error) {
    auto &gpu = ctx.gpu_state.device;
    if (gpu.lifecycle.allocated) {
        rollback_candidate(ctx, gpu.rk.candidate, stream, error);
    }
    host_callback_count_ = 0;
    error.clear();
    return true;
}

} // namespace fullmag::fem
