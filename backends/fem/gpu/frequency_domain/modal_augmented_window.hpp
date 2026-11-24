#pragma once

#include "cpu/frequency_domain/poisson_airbox_modal_eigen.hpp"
#include "gpu/frequency_domain/modal_augmented_ritz.hpp"

#include <array>
#include <optional>
#include <vector>

namespace fullmag::fem::frequency_domain {
inline constexpr char kAugmentedRobinGpuAdapter[] = "k0_poisson_airbox_gpu_augmented_cudss";
inline constexpr char kAugmentedFloquetGpuAdapter[] = "floquet_airbox_gpu_augmented_cudss";

namespace gpu {
struct FloquetAirboxAugmentedPencilView;
} // namespace gpu

FrequencyDomainStatus solve_poisson_airbox_modal_eigen_gpu_augmented_robin(
    const PoissonAirboxEigenBlockProblem &problem, double mu0,
    PoissonAirboxModalEigenResult *result) noexcept;
FrequencyDomainStatus solve_floquet_airbox_modal_eigen_gpu_augmented(
    const PoissonAirboxEigenBlockProblem &problem,
    const gpu::FloquetAirboxAugmentedPencilView &blocks,
    const std::array<double, 3> &k_rad_per_m, double mu0,
    PoissonAirboxModalEigenResult *result) noexcept;
} // namespace fullmag::fem::frequency_domain

namespace fullmag::fem::frequency_domain::gpu {

struct AugmentedWindowSubsolve {
    double lower_hz;
    double upper_hz;
    double shift_hz;
    int inertia_count;
    int accepted_count;
    int block_columns;
    cuda_trace::ModalEpsSolveTraceV1 native_trace{};
    AugmentedRitzDeviceMeasurements measurements{};
};

struct AugmentedWindowLeaf {
    double lower_hz;
    double upper_hz;
    int inertia_below;
    int inertia_above;
    int accepted_count;
};

struct CertifiedOpenAirboxWindow {
    std::vector<PoissonAirboxModalEigenResult::AcceptedMode> modes;
    std::vector<AugmentedWindowSubsolve> subsolves;
    std::vector<AugmentedWindowLeaf> certified_intervals;
    int negative_at_origin = 0;
    int negative_at_lower = 0;
    int negative_at_upper = 0;
    std::uint64_t certified_mode_count = 0;
    std::size_t certified_inertia_factorizations = 0;
    std::size_t reused_inertia_probes = 0;
    bool truncated_by_requested_count = false;
};

// The returned prefix is in ascending positive frequency order. A result is
// produced only after disjoint intervals account for the independently
// certified number of modes in the complete requested window.
std::optional<CertifiedOpenAirboxWindow> solve_open_airbox_augmented_window(
    const PoissonAirboxEigenBlockProblem &problem, double operator_scale,
    double mass_scale, double angular_frequency_scale, double mu0, const char **failure);

// Use an inertia-certified enclosing bracket to publish the closest modes
// to the requested target, including when the window starts at zero.
std::optional<CertifiedOpenAirboxWindow> solve_open_airbox_augmented_nearest(
    const PoissonAirboxEigenBlockProblem &problem, double operator_scale,
    double mass_scale, double angular_frequency_scale, double mu0, const char **failure);

std::optional<CertifiedOpenAirboxWindow> solve_floquet_airbox_augmented_nearest(
    const PoissonAirboxEigenBlockProblem &problem, const FloquetAirboxAugmentedPencilView &blocks,
    double operator_scale, double mass_scale, double angular_frequency_scale, double mu0,
    const char **failure);

} // namespace fullmag::fem::frequency_domain::gpu
