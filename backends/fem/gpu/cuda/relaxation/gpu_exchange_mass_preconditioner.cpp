#include "gpu/cuda/relaxation/gpu_exchange_mass_preconditioner.hpp"

#include "gpu/cuda/reductions/reduction_kernels.hpp"
#include "gpu/cuda/relaxation/gpu_exchange_mass_preconditioner_kernels.hpp"

#include <cuda_runtime.h>

#include <cmath>
#include <limits>

namespace fullmag::fem {

namespace {

constexpr std::size_t kWorkspaceValuesPerNode = 15u;
constexpr std::size_t kScalarCount = 15u;
constexpr std::size_t kComponents = 3u;

bool cuda_ok(cudaError_t status, const char *operation, std::string &error)
{
    if (status == cudaSuccess) {
        return true;
    }
    error = std::string(operation) + " failed: " + cudaGetErrorString(status);
    return false;
}

bool launch_ok(const char *operation, std::string &error)
{
    return cuda_ok(cudaPeekAtLastError(), operation, error);
}

bool reduce_components(
    double *terms,
    double *results,
    int n,
    void *storage,
    std::size_t storage_bytes,
    cudaStream_t stream,
    std::string &error)
{
    for (std::size_t component = 0; component < kComponents; ++component) {
        std::size_t bytes = storage_bytes;
        fullmag_cuda_device_sum(
            terms + component * static_cast<std::size_t>(n),
            n,
            results + component,
            storage,
            bytes,
            stream);
        if (bytes > storage_bytes) {
            error = "persistent exchange-mass reduction workspace is too small";
            return false;
        }
    }
    return launch_ok("enqueue exchange-mass component reductions", error);
}

} // namespace

GpuExchangeMassPreconditioner::GpuExchangeMassPreconditioner(
    GpuExchangeMassCgVariant variant) noexcept
    : variant_(variant)
{
}

GpuExchangeMassPreconditioner::~GpuExchangeMassPreconditioner()
{
    reset();
}

std::uint32_t GpuExchangeMassPreconditioner::fixed_iterations() const noexcept
{
    return variant_ == GpuExchangeMassCgVariant::Cg4 ? 4u : 8u;
}

const char *GpuExchangeMassPreconditioner::selected_sparse_variant() const noexcept
{
    return sparse_plan_ == nullptr
        ? "unconfigured"
        : sparse_plan_->selected_variant_name();
}

void GpuExchangeMassPreconditioner::reset() noexcept
{
    cudaFree(d_workspace_);
    cudaFree(d_scalars_);
    cudaFree(d_iterations_);
    cudaFree(d_failure_latch_);
    cudaFree(d_reduction_storage_);
    d_workspace_ = nullptr;
    d_scalars_ = nullptr;
    d_iterations_ = nullptr;
    d_failure_latch_ = nullptr;
    d_reduction_storage_ = nullptr;
    reduction_storage_bytes_ = 0;
    capacity_ = 0;
    configured_size_ = 0;
    sparse_plan_ = nullptr;
    d_mass_ms_ = nullptr;
    d_active_mask_ = nullptr;
    stream_ = nullptr;
    identity_ = {};
}

bool GpuExchangeMassPreconditioner::allocate_workspace(
    std::size_t n,
    void *stream,
    std::string &error)
{
    if (capacity_ >= n && d_workspace_ != nullptr && d_scalars_ != nullptr &&
        d_iterations_ != nullptr && d_failure_latch_ != nullptr &&
        d_reduction_storage_ != nullptr) {
        return true;
    }

    reset();
    if (n > std::numeric_limits<std::size_t>::max() / kWorkspaceValuesPerNode) {
        error = "exchange-mass workspace dimensions overflow";
        return false;
    }
    if (!cuda_ok(
            cudaMalloc(
                reinterpret_cast<void **>(&d_workspace_),
                n * kWorkspaceValuesPerNode * sizeof(double)),
            "cudaMalloc exchange-mass Krylov workspace",
            error) ||
        !cuda_ok(
            cudaMalloc(
                reinterpret_cast<void **>(&d_scalars_),
                kScalarCount * sizeof(double)),
            "cudaMalloc exchange-mass device scalars",
            error) ||
        !cuda_ok(
            cudaMalloc(
                reinterpret_cast<void **>(&d_iterations_),
                sizeof(std::uint32_t)),
            "cudaMalloc exchange-mass iteration count",
            error) ||
        !cuda_ok(
            cudaMalloc(
                reinterpret_cast<void **>(&d_failure_latch_),
                sizeof(std::uint32_t)),
            "cudaMalloc exchange-mass failure latch",
            error)) {
        reset();
        return false;
    }

    cudaStream_t cuda_stream = static_cast<cudaStream_t>(stream);
    std::size_t required_bytes = 0;
    fullmag_cuda_device_sum(
        d_workspace_,
        static_cast<int>(n),
        d_scalars_,
        nullptr,
        required_bytes,
        cuda_stream);
    if (!launch_ok("query exchange-mass reduction workspace", error) ||
        required_bytes == 0u ||
        !cuda_ok(
            cudaMalloc(&d_reduction_storage_, required_bytes),
            "cudaMalloc exchange-mass reduction workspace",
            error)) {
        reset();
        return false;
    }
    reduction_storage_bytes_ = required_bytes;
    capacity_ = n;
    return true;
}

bool GpuExchangeMassPreconditioner::setup(
    SparseApplyPlan &sparse_plan,
    const double *d_mass_ms,
    const std::uint8_t *d_active_mask,
    std::size_t n,
    GpuExchangeMassSetupIdentity identity,
    void *stream,
    std::string &error)
{
    if (d_mass_ms == nullptr || d_active_mask == nullptr || n == 0u ||
        n > static_cast<std::size_t>(std::numeric_limits<int>::max())) {
        error = "exchange-mass setup has invalid device buffers or dimensions";
        sparse_plan_ = nullptr;
        return false;
    }
    if (!sparse_plan.is_configured()) {
        error = "exchange-mass setup requires a configured sparse plan";
        sparse_plan_ = nullptr;
        return false;
    }
    if (sparse_plan.configured_rows() != n || sparse_plan.configured_cols() != n) {
        error = "exchange-mass setup dimension does not match the sparse plan";
        sparse_plan_ = nullptr;
        return false;
    }
    if (sparse_plan_ == &sparse_plan && d_mass_ms_ == d_mass_ms &&
        d_active_mask_ == d_active_mask && configured_size_ == n &&
        identity_ == identity && stream_ == stream) {
        setup_reuse_count_ += 1u;
        error.clear();
        return true;
    }
    if (!allocate_workspace(n, stream, error)) {
        return false;
    }

    sparse_plan_ = nullptr;
    cudaStream_t cuda_stream = static_cast<cudaStream_t>(stream);
    if (!cuda_ok(
            cudaMemsetAsync(d_failure_latch_, 0, sizeof(std::uint32_t), cuda_stream),
            "clear exchange-mass setup failure latch",
            error) ||
        !cuda_ok(
            cudaMemsetAsync(
                d_workspace_, 0, n * kWorkspaceValuesPerNode * sizeof(double), cuda_stream),
            "clear exchange-mass setup Krylov workspace",
            error) ||
        !cuda_ok(
            cudaMemsetAsync(d_scalars_, 0, kScalarCount * sizeof(double), cuda_stream),
            "clear exchange-mass setup scalars",
            error) ||
        !cuda_ok(
            cudaMemsetAsync(d_iterations_, 0, sizeof(std::uint32_t), cuda_stream),
            "clear exchange-mass setup iteration count",
            error)) {
        return false;
    }
    fullmag_cuda_exchange_mass_validate_setup(
        d_mass_ms, d_active_mask, d_failure_latch_, static_cast<int>(n), cuda_stream);
    if (!launch_ok("validate exchange-mass device mass", error)) {
        return false;
    }
    std::uint32_t failure = 0u;
    if (!cuda_ok(
            cudaMemcpyAsync(
                &failure,
                d_failure_latch_,
                sizeof(failure),
                cudaMemcpyDeviceToHost,
                cuda_stream),
            "read exchange-mass setup validation",
            error) ||
        !cuda_ok(
            cudaStreamSynchronize(cuda_stream),
            "synchronize exchange-mass setup validation",
            error)) {
        return false;
    }
    if (failure != 0u) {
        error = "exchange-mass setup found non-positive or non-finite active mass";
        return false;
    }

    sparse_plan_ = &sparse_plan;
    d_mass_ms_ = d_mass_ms;
    d_active_mask_ = d_active_mask;
    configured_size_ = n;
    identity_ = identity;
    stream_ = stream;
    setup_count_ += 1u;
    error.clear();
    return true;
}

bool GpuExchangeMassPreconditioner::apply_device_xyz(
    const double *d_gradient_x,
    const double *d_gradient_y,
    const double *d_gradient_z,
    double *d_solution_x,
    double *d_solution_y,
    double *d_solution_z,
    std::size_t n,
    double exchange_weight,
    void *stream,
    std::string &error)
{
    if (!is_active() || d_gradient_x == nullptr || d_gradient_y == nullptr ||
        d_gradient_z == nullptr || d_solution_x == nullptr ||
        d_solution_y == nullptr || d_solution_z == nullptr ||
        configured_size_ != n || n == 0u) {
        error = "exchange-mass apply has invalid device buffers or dimensions";
        return false;
    }
    if (!std::isfinite(exchange_weight) || exchange_weight < 0.0) {
        error = "exchange-mass apply has invalid exchange weight";
        return false;
    }
    if (stream != stream_) {
        error = "exchange-mass apply must use the setup stream";
        return false;
    }
    if (!sparse_plan_->is_configured() ||
        sparse_plan_->configured_rows() != n ||
        sparse_plan_->configured_cols() != n) {
        error = "exchange-mass sparse plan is no longer valid for apply";
        return false;
    }

    cudaStream_t cuda_stream = static_cast<cudaStream_t>(stream);
    if (!cuda_ok(
            cudaMemsetAsync(d_scalars_, 0, kScalarCount * sizeof(double), cuda_stream),
            "clear exchange-mass apply scalars",
            error) ||
        !cuda_ok(
            cudaMemsetAsync(d_iterations_, 0, sizeof(std::uint32_t), cuda_stream),
            "clear exchange-mass apply iteration count",
            error)) {
        return false;
    }
    fullmag_cuda_exchange_mass_initialize(
        d_gradient_x, d_gradient_y, d_gradient_z,
        d_mass_ms_, d_active_mask_,
        d_solution_x, d_solution_y, d_solution_z,
        d_workspace_, d_failure_latch_, static_cast<int>(n), cuda_stream);
    if (!launch_ok("enqueue exchange-mass initialization", error) ||
        !reduce_components(
            d_workspace_ + 12u * n,
            d_scalars_,
            static_cast<int>(n),
            d_reduction_storage_,
            reduction_storage_bytes_,
            cuda_stream,
            error)) {
        return false;
    }

    double *const residual = d_workspace_;
    double *const direction = d_workspace_ + 3u * n;
    double *const applied = d_workspace_ + 6u * n;
    double *const exchange_applied = d_workspace_ + 9u * n;
    double *const terms = d_workspace_ + 12u * n;
    for (std::uint32_t iteration = 0; iteration < fixed_iterations(); ++iteration) {
        if (!sparse_plan_->apply_xyz(
                {direction,
                 direction + n,
                 direction + 2u * n,
                 exchange_applied,
                 exchange_applied + n,
                 exchange_applied + 2u * n,
                 d_active_mask_},
                cuda_stream,
                error)) {
            return false;
        }
        fullmag_cuda_exchange_mass_form_operator_and_dot(
            d_mass_ms_, d_active_mask_, exchange_weight,
            d_workspace_, d_failure_latch_, static_cast<int>(n), cuda_stream);
        if (!launch_ok("enqueue exchange-mass operator composition", error) ||
            !reduce_components(
                terms,
                d_scalars_ + 6u,
                static_cast<int>(n),
                d_reduction_storage_,
                reduction_storage_bytes_,
                cuda_stream,
                error)) {
            return false;
        }
        fullmag_cuda_exchange_mass_compute_alpha(
            d_scalars_, d_failure_latch_, cuda_stream);
        fullmag_cuda_exchange_mass_update_solution_and_residual(
            d_active_mask_, d_solution_x, d_solution_y, d_solution_z,
            d_workspace_, d_scalars_, d_failure_latch_,
            static_cast<int>(n), cuda_stream);
        if (!launch_ok("enqueue exchange-mass solution update", error) ||
            !reduce_components(
                terms,
                d_scalars_ + 3u,
                static_cast<int>(n),
                d_reduction_storage_,
                reduction_storage_bytes_,
                cuda_stream,
                error)) {
            return false;
        }
        fullmag_cuda_exchange_mass_compute_beta_and_advance(
            d_scalars_, d_iterations_, d_failure_latch_, cuda_stream);
        fullmag_cuda_exchange_mass_update_direction(
            d_active_mask_, d_workspace_, d_scalars_, d_failure_latch_,
            static_cast<int>(n), cuda_stream);
        if (!launch_ok("enqueue exchange-mass direction update", error)) {
            return false;
        }
    }
    (void)residual;
    (void)applied;

    fullmag_cuda_exchange_mass_validate_output(
        d_solution_x, d_solution_y, d_solution_z, d_active_mask_,
        d_failure_latch_, static_cast<int>(n), cuda_stream);
    fullmag_cuda_exchange_mass_cleanup(
        d_solution_x, d_solution_y, d_solution_z,
        d_workspace_, d_scalars_, d_active_mask_, d_failure_latch_,
        static_cast<int>(n), cuda_stream);
    if (!launch_ok("enqueue exchange-mass final validation", error)) {
        return false;
    }

    apply_count_ += 1u;
    error.clear();
    return true;
}

} // namespace fullmag::fem
