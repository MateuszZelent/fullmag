#include "gpu/cuda/relaxation/gpu_relaxation_preconditioner.hpp"
#include "gpu/cuda/relaxation/pgbb_kernels.hpp"

#include <cuda_runtime.h>
#include <cmath>

namespace fullmag::fem {

namespace {

bool cuda_launch_ok(const char *operation, std::string &error)
{
    const cudaError_t rc = cudaPeekAtLastError();
    if (rc == cudaSuccess) {
        return true;
    }
    error = std::string(operation) + " failed: " + cudaGetErrorString(rc);
    return false;
}

} // namespace

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
        error = "GPU exchange-mass relaxation preconditioner request is ambiguous";
        return false;
    }
    if (request.requested_kind == "exchange_mass_cg4" ||
        request.requested_kind == "exchange_mass_cg8") {
        if (!request.profile_qualified) {
            error = "GPU exchange-mass relaxation preconditioner is not qualified";
            return false;
        }
        decision.kind = GpuRelaxationPreconditionerKind::ExchangeMass;
        decision.qualified = true;
        decision.fixed_iterations =
            request.requested_kind == "exchange_mass_cg4" ? 4u : 8u;
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
        if (mass_diagonal[i] <= 0.0 || exchange_diagonal[i] < 0.0) {
            error = "GPU relaxation diagonal has invalid entries on a free node";
            diagonal.clear();
            return false;
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

GpuDiagonalRelaxationPreconditioner::~GpuDiagonalRelaxationPreconditioner()
{
    reset();
}

void GpuDiagonalRelaxationPreconditioner::reset()
{
    if (d_op_diag_inv_ != nullptr) {
        cudaFree(d_op_diag_inv_);
        d_op_diag_inv_ = nullptr;
    }
    configured_size_ = 0;
    d_capacity_ = 0;
    cached_weight_ = 0.0;
    cached_mass_.clear();
    cached_exchange_.clear();
    cached_op_diag_.clear();
}

bool GpuDiagonalRelaxationPreconditioner::setup(
    const std::vector<double> &mass_diagonal,
    const std::vector<double> &exchange_diagonal,
    double weight,
    void *stream,
    std::string &error)
{
    if (mass_diagonal.empty() || mass_diagonal.size() != exchange_diagonal.size() ||
        !std::isfinite(weight) || weight < 0.0) {
        error = "invalid dimensions or weight for diagonal relaxation preconditioner";
        reset();
        return false;
    }

    const size_t n = mass_diagonal.size();

    // Reusable check: if already configured with matching inputs, reuse existing setup
    if (cached_weight_ == weight &&
        cached_mass_ == mass_diagonal &&
        cached_exchange_ == exchange_diagonal &&
        !cached_op_diag_.empty() &&
        d_op_diag_inv_ != nullptr &&
        configured_size_ == n &&
        d_capacity_ >= n) {
        error.clear();
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
        if (!std::isfinite(denom) || denom <= 0.0) {
            error = "non-positive or non-finite diagonal preconditioner entry";
            reset();
            return false;
        }
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
    configured_size_ = n;
    setup_count_ += 1;
    error.clear();
    return true;
}

bool GpuDiagonalRelaxationPreconditioner::apply_host(
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
        if (!std::isfinite(rhs[i])) {
            solution.clear();
            error = "diagonal relaxation preconditioner RHS contains non-finite values";
            return false;
        }
        solution[i] = (cached_mass_[i] * rhs[i]) / cached_op_diag_[i];
    }
    apply_count_ += 1;
    error.clear();
    return true;
}

bool GpuDiagonalRelaxationPreconditioner::apply_device(
    const double *d_rhs,
    double *d_solution,
    size_t n,
    void *stream,
    std::string &error)
{
    if (d_op_diag_inv_ == nullptr || configured_size_ != n || d_capacity_ < n || n == 0 ||
        d_rhs == nullptr || d_solution == nullptr) {
        error = "GPU diagonal preconditioner has invalid device buffers or dimensions";
        return false;
    }
    cudaStream_t s = static_cast<cudaStream_t>(stream);
    fullmag_cuda_relax_preconditioner_apply(
        d_rhs, d_op_diag_inv_, d_solution, static_cast<int>(n), s);
    if (!cuda_launch_ok("launch diagonal preconditioner apply", error)) {
        return false;
    }
    apply_count_ += 1;
    error.clear();
    return true;
}

bool GpuDiagonalRelaxationPreconditioner::apply_device_component(
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
    if (d_op_diag_inv_ == nullptr || configured_size_ != n || d_capacity_ < n || n == 0 ||
        d_rhs_x == nullptr || d_rhs_y == nullptr || d_rhs_z == nullptr ||
        d_sol_x == nullptr || d_sol_y == nullptr || d_sol_z == nullptr) {
        error = "GPU diagonal preconditioner has invalid component buffers or dimensions";
        return false;
    }
    cudaStream_t s = static_cast<cudaStream_t>(stream);
    fullmag_cuda_relax_preconditioner_apply_component(
        d_rhs_x, d_rhs_y, d_rhs_z, d_op_diag_inv_, d_sol_x, d_sol_y, d_sol_z, static_cast<int>(n), s);
    if (!cuda_launch_ok("launch diagonal preconditioner component apply", error)) {
        return false;
    }
    apply_count_ += 1;
    error.clear();
    return true;
}

} // namespace fullmag::fem
