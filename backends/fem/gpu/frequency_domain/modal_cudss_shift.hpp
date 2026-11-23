#pragma once

#include <cuda_runtime_api.h>

#include <memory>
#include <optional>

namespace fullmag::fem::frequency_domain::gpu {

struct OpenAirboxAugmentedPencil;

// Owns a numeric CUDA factor and the column-major block input/output buffers.
// The caller owns the non-default stream and must keep it alive through destruction.
class CudssModalShift {
public:
    static std::unique_ptr<CudssModalShift> create(
        const OpenAirboxAugmentedPencil &pencil, int block_columns, cudaStream_t stream,
        const char **failure);
    ~CudssModalShift();

    CudssModalShift(const CudssModalShift &) = delete;
    CudssModalShift &operator=(const CudssModalShift &) = delete;

    double2 *rhs() noexcept;
    const double2 *solution() const noexcept;
    // Unavailable when factorization perturbed a pivot or was numerically singular.
    std::optional<int> negative_inertia() const noexcept;
    bool enqueue() noexcept;

    // Setup-only capture and qualification. This resets the RHS block.
    bool prepare_device_replay(const char **failure);
    bool enqueue_device_replay() noexcept;
    std::size_t device_replay_nodes() const noexcept;
    bool close() noexcept;

private:
    struct Impl;
    CudssModalShift();
    std::unique_ptr<Impl> state_;
};

} // namespace fullmag::fem::frequency_domain::gpu
