#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#include <cstdint>

namespace fullmag::fem {

void fullmag_cuda_exchange_mass_validate_setup(
    const double *mass,
    const std::uint8_t *active_mask,
    std::uint32_t *failure_latch,
    int n,
    cudaStream_t stream);

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
    cudaStream_t stream);

void fullmag_cuda_exchange_mass_form_operator_and_dot(
    const double *mass,
    const std::uint8_t *active_mask,
    double exchange_weight,
    double *workspace,
    std::uint32_t *failure_latch,
    int n,
    cudaStream_t stream);

void fullmag_cuda_exchange_mass_compute_alpha(
    double *scalars,
    std::uint32_t *failure_latch,
    cudaStream_t stream);

void fullmag_cuda_exchange_mass_update_solution_and_residual(
    const std::uint8_t *active_mask,
    double *solution_x,
    double *solution_y,
    double *solution_z,
    double *workspace,
    const double *scalars,
    std::uint32_t *failure_latch,
    int n,
    cudaStream_t stream);

void fullmag_cuda_exchange_mass_compute_beta_and_advance(
    double *scalars,
    std::uint32_t *iteration_count,
    std::uint32_t *failure_latch,
    cudaStream_t stream);

void fullmag_cuda_exchange_mass_update_direction(
    const std::uint8_t *active_mask,
    double *workspace,
    const double *scalars,
    const std::uint32_t *failure_latch,
    int n,
    cudaStream_t stream);

void fullmag_cuda_exchange_mass_validate_output(
    const double *solution_x,
    const double *solution_y,
    const double *solution_z,
    const std::uint8_t *active_mask,
    std::uint32_t *failure_latch,
    int n,
    cudaStream_t stream);

void fullmag_cuda_exchange_mass_cleanup(
    double *solution_x,
    double *solution_y,
    double *solution_z,
    double *workspace,
    double *scalars,
    const std::uint8_t *active_mask,
    const std::uint32_t *failure_latch,
    int n,
    cudaStream_t stream);

} // namespace fullmag::fem
#endif
