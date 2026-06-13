#pragma once

#include "frequency_domain/frequency_domain_contract.hpp"

#include <cstdint>

namespace fullmag::fem::frequency_domain {

using ProductionCpuFrequencyDomainApply =
    FrequencyDomainStatus (*)(void *user_data, const double *in, double *out, char error_message[128]);

struct ProductionCpuDrivenResponseProgress {
    std::uint64_t frequency_index = 0;
    std::uint64_t completed_frequency_count = 0;
    std::uint64_t total_frequency_count = 0;
    std::uint64_t iteration_count = 0;
    double frequency_hz = 0.0;
    double residual_l2_norm = 0.0;
    double relative_residual_l2_norm = 0.0;
    bool converged = false;
};

using ProductionCpuFrequencyDomainProgress =
    void (*)(void *user_data, const ProductionCpuDrivenResponseProgress &progress);

struct ProductionCpuDrivenResponseProblem {
    std::uint64_t tangent_dof_count = 0;
    const double *frequencies_hz = nullptr;
    std::uint64_t frequency_count = 0;
    const double *drive_real = nullptr;
    ProductionCpuFrequencyDomainApply apply_stiffness = nullptr;
    ProductionCpuFrequencyDomainApply apply_mass = nullptr;
    void *operator_user_data = nullptr;
    double relative_tolerance = 1.0e-10;
    std::uint64_t max_iterations = 200;
    std::uint64_t restart_iterations = 32;
    double *out_response_real = nullptr;
    double *out_response_imag = nullptr;
    std::uint64_t response_capacity = 0;
    double *out_residual_l2_norm = nullptr;
    double *out_relative_residual_l2_norm = nullptr;
    std::uint64_t residual_capacity = 0;
    bool (*cancel_requested)(void *user_data) = nullptr;
    void *cancel_user_data = nullptr;
    ProductionCpuFrequencyDomainProgress progress_callback = nullptr;
    void *progress_user_data = nullptr;
    const double *drive_imag = nullptr;
    double angular_frequency_sign = 1.0;
};

struct ProductionCpuDrivenResponseResult {
    std::uint64_t completed_frequency_count = 0;
    std::uint64_t response_dof_count = 0;
    std::uint64_t total_iteration_count = 0;
    std::uint64_t max_iterations_for_frequency = 0;
    double max_frequency_hz = 0.0;
    double max_abs_response = 0.0;
    double residual_l2_norm = 0.0;
    double relative_residual_l2_norm = 0.0;
    char error_message[128] = "";
};

FrequencyDomainStatus solve_production_cpu_driven_response(
    const ProductionCpuDrivenResponseProblem &problem,
    ProductionCpuDrivenResponseResult *out_result) noexcept;

} // namespace fullmag::fem::frequency_domain
