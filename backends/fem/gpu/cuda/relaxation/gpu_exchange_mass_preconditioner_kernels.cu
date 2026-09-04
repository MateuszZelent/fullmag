#include "gpu/cuda/relaxation/gpu_exchange_mass_preconditioner_kernels.hpp"

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>

#include <algorithm>
#include <cmath>

namespace fullmag::fem {

namespace {

constexpr int kBlockSize = 256;
constexpr int kVectorBlocks = 5;
constexpr int kComponents = 3;
constexpr int kScalarCount = 15;

__device__ void latch_failure(std::uint32_t *failure_latch)
{
    atomicOr(reinterpret_cast<unsigned int *>(failure_latch), 1u);
}

__global__ void validate_setup_kernel(
    const double *mass,
    const std::uint8_t *active_mask,
    std::uint32_t *failure_latch,
    int n)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n && active_mask[i] != 0u &&
        (!isfinite(mass[i]) || mass[i] <= 0.0)) {
        latch_failure(failure_latch);
    }
}

__global__ void initialize_kernel(
    const double *gradient_x,
    const double *gradient_y,
    const double *gradient_z,
    const double *mass,
    const std::uint8_t *active_mask,
    double *solution_x,
    double *solution_y,
    double *solution_z,
    double *workspace,
    std::uint32_t *failure_latch,
    int n)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) {
        return;
    }
    solution_x[i] = 0.0;
    solution_y[i] = 0.0;
    solution_z[i] = 0.0;
    for (int block = 0; block < kVectorBlocks * kComponents; ++block) {
        workspace[block * n + i] = 0.0;
    }
    if (active_mask[i] == 0u || *failure_latch != 0u) {
        return;
    }

    const double gradients[kComponents] = {
        gradient_x[i], gradient_y[i], gradient_z[i]};
    for (int component = 0; component < kComponents; ++component) {
        const double value = mass[i] * gradients[component];
        if (!isfinite(gradients[component]) || !isfinite(value)) {
            latch_failure(failure_latch);
            continue;
        }
        workspace[component * n + i] = value;
        workspace[(kComponents + component) * n + i] = value;
        workspace[(4 * kComponents + component) * n + i] = value * value;
        if (!isfinite(value * value)) {
            latch_failure(failure_latch);
        }
    }
}

__global__ void form_operator_and_dot_kernel(
    const double *mass,
    const std::uint8_t *active_mask,
    double exchange_weight,
    double *workspace,
    std::uint32_t *failure_latch,
    int n)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) {
        return;
    }
    const bool failed = *failure_latch != 0u;
    for (int component = 0; component < kComponents; ++component) {
        double &q = workspace[(2 * kComponents + component) * n + i];
        double &kp = workspace[(3 * kComponents + component) * n + i];
        double &term = workspace[(4 * kComponents + component) * n + i];
        if (failed || active_mask[i] == 0u) {
            q = 0.0;
            kp = 0.0;
            term = 0.0;
            continue;
        }
        const double p = workspace[(kComponents + component) * n + i];
        q = mass[i] * p + exchange_weight * kp;
        term = p * q;
        if (!isfinite(p) || !isfinite(kp) || !isfinite(q) || !isfinite(term)) {
            q = 0.0;
            term = 0.0;
            latch_failure(failure_latch);
        }
    }
}

__global__ void compute_alpha_kernel(
    double *scalars,
    std::uint32_t *failure_latch)
{
    const int component = threadIdx.x;
    if (component >= kComponents) {
        return;
    }
    const double rho = scalars[component];
    const double denominator = scalars[2 * kComponents + component];
    double alpha = 0.0;
    if (*failure_latch == 0u && rho != 0.0) {
        if (!isfinite(rho) || rho < 0.0 ||
            !isfinite(denominator) || denominator <= 0.0) {
            latch_failure(failure_latch);
        } else {
            alpha = rho / denominator;
            if (!isfinite(alpha)) {
                alpha = 0.0;
                latch_failure(failure_latch);
            }
        }
    }
    scalars[3 * kComponents + component] = alpha;
}

__global__ void update_solution_and_residual_kernel(
    const std::uint8_t *active_mask,
    double *solution_x,
    double *solution_y,
    double *solution_z,
    double *workspace,
    const double *scalars,
    std::uint32_t *failure_latch,
    int n)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) {
        return;
    }
    double *solutions[kComponents] = {solution_x, solution_y, solution_z};
    if (*failure_latch != 0u || active_mask[i] == 0u) {
        for (int component = 0; component < kComponents; ++component) {
            solutions[component][i] = 0.0;
            workspace[component * n + i] = 0.0;
            workspace[(4 * kComponents + component) * n + i] = 0.0;
        }
        return;
    }
    for (int component = 0; component < kComponents; ++component) {
        const double alpha = scalars[3 * kComponents + component];
        const double p = workspace[(kComponents + component) * n + i];
        const double q = workspace[(2 * kComponents + component) * n + i];
        const double next_solution = solutions[component][i] + alpha * p;
        const double next_residual = workspace[component * n + i] - alpha * q;
        const double residual_squared = next_residual * next_residual;
        if (!isfinite(next_solution) || !isfinite(next_residual) ||
            !isfinite(residual_squared)) {
            solutions[component][i] = 0.0;
            workspace[component * n + i] = 0.0;
            workspace[(4 * kComponents + component) * n + i] = 0.0;
            latch_failure(failure_latch);
            continue;
        }
        solutions[component][i] = next_solution;
        workspace[component * n + i] = next_residual;
        workspace[(4 * kComponents + component) * n + i] = residual_squared;
    }
}

__global__ void compute_beta_and_advance_kernel(
    double *scalars,
    std::uint32_t *iteration_count,
    std::uint32_t *failure_latch)
{
    const int component = threadIdx.x;
    if (component < kComponents) {
        const double rho = scalars[component];
        const double next_rho = scalars[kComponents + component];
        double beta = 0.0;
        if (*failure_latch == 0u) {
            if (!isfinite(rho) || rho < 0.0 ||
                !isfinite(next_rho) || next_rho < 0.0) {
                latch_failure(failure_latch);
            } else if (rho != 0.0) {
                beta = next_rho / rho;
                if (!isfinite(beta)) {
                    beta = 0.0;
                    latch_failure(failure_latch);
                }
            }
        }
        scalars[component] = next_rho;
        scalars[4 * kComponents + component] = beta;
    }
    __syncthreads();
    if (component == 0) {
        *iteration_count += 1u;
    }
}

__global__ void update_direction_kernel(
    const std::uint8_t *active_mask,
    double *workspace,
    const double *scalars,
    const std::uint32_t *failure_latch,
    int n)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) {
        return;
    }
    for (int component = 0; component < kComponents; ++component) {
        double &p = workspace[(kComponents + component) * n + i];
        if (*failure_latch != 0u || active_mask[i] == 0u) {
            p = 0.0;
        } else {
            p = workspace[component * n + i] +
                scalars[4 * kComponents + component] * p;
        }
    }
}

__global__ void validate_output_kernel(
    const double *solution_x,
    const double *solution_y,
    const double *solution_z,
    const std::uint8_t *active_mask,
    std::uint32_t *failure_latch,
    int n)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n && active_mask[i] != 0u &&
        (!isfinite(solution_x[i]) || !isfinite(solution_y[i]) ||
         !isfinite(solution_z[i]))) {
        latch_failure(failure_latch);
    }
}

__global__ void cleanup_kernel(
    double *solution_x,
    double *solution_y,
    double *solution_z,
    double *workspace,
    double *scalars,
    const std::uint8_t *active_mask,
    const std::uint32_t *failure_latch,
    int n)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    const bool failed = *failure_latch != 0u;
    if (i < n && (failed || active_mask[i] == 0u)) {
        solution_x[i] = 0.0;
        solution_y[i] = 0.0;
        solution_z[i] = 0.0;
        for (int block = 0; block < kVectorBlocks * kComponents; ++block) {
            workspace[block * n + i] = 0.0;
        }
    }
    if (failed && i < kScalarCount) {
        scalars[i] = 0.0;
    }
}

int block_count(int n)
{
    return (n + kBlockSize - 1) / kBlockSize;
}

} // namespace

void fullmag_cuda_exchange_mass_validate_setup(
    const double *mass,
    const std::uint8_t *active_mask,
    std::uint32_t *failure_latch,
    int n,
    cudaStream_t stream)
{
    validate_setup_kernel<<<block_count(n), kBlockSize, 0, stream>>>(
        mass, active_mask, failure_latch, n);
}

void fullmag_cuda_exchange_mass_initialize(
    const double *gradient_x,
    const double *gradient_y,
    const double *gradient_z,
    const double *mass,
    const std::uint8_t *active_mask,
    double *solution_x,
    double *solution_y,
    double *solution_z,
    double *workspace,
    std::uint32_t *failure_latch,
    int n,
    cudaStream_t stream)
{
    initialize_kernel<<<block_count(n), kBlockSize, 0, stream>>>(
        gradient_x, gradient_y, gradient_z, mass, active_mask,
        solution_x, solution_y, solution_z, workspace, failure_latch, n);
}

void fullmag_cuda_exchange_mass_form_operator_and_dot(
    const double *mass,
    const std::uint8_t *active_mask,
    double exchange_weight,
    double *workspace,
    std::uint32_t *failure_latch,
    int n,
    cudaStream_t stream)
{
    form_operator_and_dot_kernel<<<block_count(n), kBlockSize, 0, stream>>>(
        mass, active_mask, exchange_weight, workspace, failure_latch, n);
}

void fullmag_cuda_exchange_mass_compute_alpha(
    double *scalars,
    std::uint32_t *failure_latch,
    cudaStream_t stream)
{
    compute_alpha_kernel<<<1, kComponents, 0, stream>>>(scalars, failure_latch);
}

void fullmag_cuda_exchange_mass_update_solution_and_residual(
    const std::uint8_t *active_mask,
    double *solution_x,
    double *solution_y,
    double *solution_z,
    double *workspace,
    const double *scalars,
    std::uint32_t *failure_latch,
    int n,
    cudaStream_t stream)
{
    update_solution_and_residual_kernel<<<block_count(n), kBlockSize, 0, stream>>>(
        active_mask, solution_x, solution_y, solution_z, workspace, scalars,
        failure_latch, n);
}

void fullmag_cuda_exchange_mass_compute_beta_and_advance(
    double *scalars,
    std::uint32_t *iteration_count,
    std::uint32_t *failure_latch,
    cudaStream_t stream)
{
    compute_beta_and_advance_kernel<<<1, kComponents, 0, stream>>>(
        scalars, iteration_count, failure_latch);
}

void fullmag_cuda_exchange_mass_update_direction(
    const std::uint8_t *active_mask,
    double *workspace,
    const double *scalars,
    const std::uint32_t *failure_latch,
    int n,
    cudaStream_t stream)
{
    update_direction_kernel<<<block_count(n), kBlockSize, 0, stream>>>(
        active_mask, workspace, scalars, failure_latch, n);
}

void fullmag_cuda_exchange_mass_validate_output(
    const double *solution_x,
    const double *solution_y,
    const double *solution_z,
    const std::uint8_t *active_mask,
    std::uint32_t *failure_latch,
    int n,
    cudaStream_t stream)
{
    validate_output_kernel<<<block_count(n), kBlockSize, 0, stream>>>(
        solution_x, solution_y, solution_z, active_mask, failure_latch, n);
}

void fullmag_cuda_exchange_mass_cleanup(
    double *solution_x,
    double *solution_y,
    double *solution_z,
    double *workspace,
    double *scalars,
    const std::uint8_t *active_mask,
    const std::uint32_t *failure_latch,
    int n,
    cudaStream_t stream)
{
    const int count = std::max(n, kScalarCount);
    cleanup_kernel<<<block_count(count), kBlockSize, 0, stream>>>(
        solution_x, solution_y, solution_z, workspace, scalars,
        active_mask, failure_latch, n);
}

} // namespace fullmag::fem
#endif
