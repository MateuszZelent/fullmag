#pragma once

#include <cuda_runtime.h>
#include <cstdint>
#include <string>

namespace fullmag::fem {

struct Context;

enum class RkGraphMode : uint32_t {
    Disabled = 0,
    Captured = 1,
    Fallback = 2
};

class RkGraphPlan {
public:
    RkGraphPlan() = default;
    ~RkGraphPlan();
    RkGraphPlan(const RkGraphPlan &) = delete;
    RkGraphPlan &operator=(const RkGraphPlan &) = delete;
    RkGraphPlan(RkGraphPlan &&other) noexcept;
    RkGraphPlan &operator=(RkGraphPlan &&other) noexcept;

    bool capture(Context &ctx, cudaStream_t stream, std::string &error);
    bool launch(Context &ctx, cudaStream_t stream, std::string &error);
    bool simulate_forced_reject(Context &ctx, cudaStream_t stream, std::string &error);
    void invalidate();

    bool is_captured() const noexcept { return is_captured_; }
    RkGraphMode mode() const noexcept { return mode_; }
    void set_mode(RkGraphMode mode) noexcept { mode_ = mode; }
    uint64_t capture_count() const noexcept { return capture_count_; }
    uint64_t launch_count() const noexcept { return launch_count_; }
    uint64_t host_callback_count() const noexcept { return host_callback_count_; }
    size_t node_count() const noexcept {
        if (graph_ == nullptr) return 0;
        size_t count = 0;
        cudaGraphGetNodes(graph_, nullptr, &count);
        return count;
    }

private:
    bool is_captured_ = false;
    RkGraphMode mode_ = RkGraphMode::Disabled;
    uint64_t capture_count_ = 0;
    uint64_t launch_count_ = 0;
    uint64_t host_callback_count_ = 0;
    cudaGraph_t graph_ = nullptr;
    cudaGraphExec_t instance_ = nullptr;
    void *d_probe_ = nullptr;
};

} // namespace fullmag::fem
