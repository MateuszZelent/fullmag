#pragma once

#include <cuda_runtime_api.h>

#include <cstddef>
#include <functional>
#include <memory>

namespace fullmag::fem::frequency_domain::gpu {

class CudssDeviceGraph {
public:
    static std::unique_ptr<CudssDeviceGraph> prepare(
        cudaStream_t stream, double2 *rhs, const double2 *solution, std::size_t elements,
        const std::function<bool()> &enqueue_vendor_solve, const char **failure);
    ~CudssDeviceGraph();

    CudssDeviceGraph(const CudssDeviceGraph &) = delete;
    CudssDeviceGraph &operator=(const CudssDeviceGraph &) = delete;

    bool launch(cudaStream_t stream) const noexcept;
    std::size_t node_count() const noexcept;
    // The caller fences the stream before closing the graph and its inputs.
    bool close() noexcept;

private:
    struct State;
    CudssDeviceGraph();
    std::unique_ptr<State> state_;
};

} // namespace fullmag::fem::frequency_domain::gpu
