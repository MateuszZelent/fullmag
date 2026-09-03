#include "gpu/cuda/relaxation/gpu_relaxation_preconditioner.hpp"
#include "gpu/cuda/relaxation/pgbb_kernels.hpp"

#include <cuda_runtime.h>
#include <cmath>

namespace fullmag::fem {

const char *gpu_relaxation_preconditioner_kind_id(
    GpuRelaxationPreconditionerKind kind) noexcept
{
    switch (kind) {
    case GpuRelaxationPreconditionerKind::None: return "none";
    case GpuRelaxationPreconditionerKind::Diagonal: return "diagonal";
    case GpuRelaxationPreconditionerKind::ExchangeMass: return "exchange_mass";
    }
    return "unsupported";
}

bool resolve_gpu_relaxation_preconditioner(
    const GpuRelaxationPreconditionerRequest &request,
    GpuRelaxationPreconditionerDecision &decision,
    std::string &error)
{
    decision = {};
    if (request.profile_stale) {
        error = "GPU relaxation preconditioner profile is stale";
        return false;
    }
    if (request.requested_kind.empty() || request.requested_kind == "none") {
        decision.kind = GpuRelaxationPreconditionerKind::None;
        decision.qualified = true;
        error.clear();
        return true;
    }
    if (request.requested_kind == "exchange_mass") {
        if (!request.profile_qualified) {
            error = "GPU exchange-mass relaxation preconditioner is not qualified";
            return false;
        }
        decision.kind = GpuRelaxationPreconditionerKind::ExchangeMass;
        decision.qualified = true;
        error.clear();
        return true;
    }
    if (request.requested_kind != "diagonal") {
        error = "unsupported GPU relaxation preconditioner: " +
            request.requested_kind;
        return false;
    }
    if (!request.profile_qualified) {
        error = "GPU diagonal relaxation preconditioner is not qualified";
        return false;
    }
    decision.kind = GpuRelaxationPreconditionerKind::Diagonal;
    decision.qualified = true;
    error.clear();
    return true;
}

bool build_gpu_relaxation_diagonal(
    const std::vector<double> &mass_diagonal,
    const std::vector<double> &exchange_diagonal,
    double exchange_weight,
    const std::vector<uint8_t> &free_node_mask,
    std::vector<double> &diagonal,
    std::string &error)
{
    diagonal.clear();
    if (mass_diagonal.empty() || mass_diagonal.size() != exchange_diagonal.size() ||
        (!free_node_mask.empty() && free_node_mask.size() != mass_diagonal.size()) ||
        !std::isfinite(exchange_weight) || exchange_weight < 0.0) {
        error = "GPU relaxation diagonal inputs have invalid dimensions or weight";
        return false;
    }
    diagonal.resize(mass_diagonal.size(), 0.0);
    for (size_t i = 0; i < mass_diagonal.size(); ++i) {
        const bool free = free_node_mask.empty() || free_node_mask[i] != 0u;
        if (!std::isfinite(mass_diagonal[i]) ||
            !std::isfinite(exchange_diagonal[i])) {
            error = "GPU relaxation diagonal inputs contain non-finite values";
            diagonal.clear();
            return false;
        }
        if (!free) {
            continue;
        }
        const double value = mass_diagonal[i] + exchange_weight * exchange_diagonal[i];
        if (!std::isfinite(value) || value <= 0.0) {
            error = "GPU relaxation diagonal is non-positive on a free node";
            diagonal.clear();
            return false;
        }
        diagonal[i] = value;
    }
    error.clear();
    return true;
}

GpuExchangeMassPreconditioner::~GpuExchangeMassPreconditioner()
{
    reset();
}

void GpuExchangeMassPreconditioner::reset()
{
    if (d_op_diag_inv_ != nullptr) {
        cudaFree(d_op_diag_inv_);
        d_op_diag_inv_ = nullptr;
    }
    d_capacity_ = 0;
    cached_weight_ = 0.0;
    cached_mass_.clear();
    cached_exchange_.clear();
    cached_op_diag_.clear();
}

bool GpuExchangeMassPreconditioner::setup(
    const std::vector<double> &mass_diagonal,
    const std::vector<double> &exchange_diagonal,
    double weight,
    void *stream,
    std::string &error)
{
    if (mass_diagonal.empty() || mass_diagonal.size() != exchange_diagonal.size() ||
        !std::isfinite(weight) || weight < 0.0) {
        error = "invalid dimensions or weight for exchange-mass preconditioner";
        return false;
    }

    const size_t n = mass_diagonal.size();

    // Reusable check: if already configured with matching inputs, reuse existing setup
    if (cached_weight_ == weight &&
        cached_mass_ == mass_diagonal &&
        cached_exchange_ == exchange_diagonal &&
        !cached_op_diag_.empty() &&
        d_op_diag_inv_ != nullptr &&
        d_capacity_ >= n) {
        return true;
    }

    cached_op_diag_.resize(n);
    std::vector<double> host_factors(n);
    for (size_t i = 0; i < n; ++i) {
        const double m = mass_diagonal[i];
        const double k = exchange_diagonal[i];
        if (!std::isfinite(m) || !std::isfinite(k) || m <= 0.0 || k < 0.0) {
            error = "non-positive or non-finite entries in preconditioner matrices";
            reset();
            return false;
        }
        const double denom = m + weight * k;
        cached_op_diag_[i] = denom;
        host_factors[i] = m / denom;
    }

    if (d_op_diag_inv_ != nullptr && d_capacity_ < n) {
        cudaFree(d_op_diag_inv_);
        d_op_diag_inv_ = nullptr;
        d_capacity_ = 0;
    }
    if (d_op_diag_inv_ == nullptr) {
        cudaError_t rc = cudaMalloc(&d_op_diag_inv_, n * sizeof(double));
        if (rc != cudaSuccess) {
            error = "cudaMalloc d_op_diag_inv_ failed: " + std::string(cudaGetErrorString(rc));
            reset();
            return false;
        }
        d_capacity_ = n;
    }

    cudaStream_t s = static_cast<cudaStream_t>(stream);
    cudaError_t rc = cudaMemcpyAsync(
        d_op_diag_inv_,
        host_factors.data(),
        n * sizeof(double),
        cudaMemcpyHostToDevice,
        s);
    if (rc != cudaSuccess) {
        error = "cudaMemcpyAsync d_op_diag_inv_ failed: " + std::string(cudaGetErrorString(rc));
        reset();
        return false;
    }

    cached_mass_ = mass_diagonal;
    cached_exchange_ = exchange_diagonal;
    cached_weight_ = weight;
    setup_count_ += 1;
    error.clear();
    return true;
}

bool GpuExchangeMassPreconditioner::apply_host(
    const std::vector<double> &rhs,
    std::vector<double> &solution,
    std::string &error)
{
    if (cached_op_diag_.empty() || rhs.size() != cached_op_diag_.size()) {
        error = "preconditioner not set up or dimension mismatch";
        return false;
    }
    const size_t n = rhs.size();
    solution.resize(n);
    for (size_t i = 0; i < n; ++i) {
        // (M + w K)^{-1} * M * rhs
        solution[i] = (cached_mass_[i] * rhs[i]) / cached_op_diag_[i];
    }
    apply_count_ += 1;
    error.clear();
    return true;
}

bool GpuExchangeMassPreconditioner::apply_device(
    const double *d_rhs,
    double *d_solution,
    size_t n,
    void *stream,
    std::string &error)
{
    if (d_op_diag_inv_ == nullptr || d_capacity_ < n || d_rhs == nullptr || d_solution == nullptr) {
        error = "GPU preconditioner device buffers not allocated or null arguments";
        return false;
    }
    cudaStream_t s = static_cast<cudaStream_t>(stream);
    fullmag_cuda_relax_preconditioner_apply(
        d_rhs, d_op_diag_inv_, d_solution, static_cast<int>(n), s);
    apply_count_ += 1;
    error.clear();
    return true;
}

bool GpuExchangeMassPreconditioner::apply_device_component(
    const double *d_rhs_x,
    const double *d_rhs_y,
    const double *d_rhs_z,
    double *d_sol_x,
    double *d_sol_y,
    double *d_sol_z,
    size_t n,
    void *stream,
    std::string &error)
{
    if (d_op_diag_inv_ == nullptr || d_capacity_ < n) {
        error = "GPU preconditioner device buffers not allocated";
        return false;
    }
    cudaStream_t s = static_cast<cudaStream_t>(stream);
    fullmag_cuda_relax_preconditioner_apply_component(
        d_rhs_x, d_rhs_y, d_rhs_z, d_op_diag_inv_, d_sol_x, d_sol_y, d_sol_z, static_cast<int>(n), s);
    apply_count_ += 1;
    error.clear();
    return true;
}

} // namespace fullmag::fem
