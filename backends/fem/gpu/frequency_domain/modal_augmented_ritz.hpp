#pragma once

#include "gpu/cuda/runtime/cuda_activity_trace.hpp"

#include <complex>
#include <cstdint>
#include <optional>
#include <vector>

namespace fullmag::fem::frequency_domain {

struct PoissonAirboxEigenBlockProblem;

namespace gpu {

struct FloquetAirboxAugmentedPencilView;

struct AugmentedRitzCandidate {
    double inverse_scaled_eigenvalue;
    double magnetic_relative_residual;
    double poisson_relative_residual;
    double magnetic_residual_l2;
    double poisson_residual_l2;
};

struct AugmentedRitzDeviceMeasurements {
    std::uint64_t setup_host_upload_count = 0;
    std::uint64_t setup_host_upload_bytes = 0;
    std::uint64_t vector_export_count = 0;
    std::uint64_t vector_export_bytes = 0;
    std::uint64_t memory_at_setup_bytes = 0;
    std::uint64_t memory_before_iteration_bytes = 0;
    std::uint64_t memory_after_release_bytes = 0;
    std::uint64_t first_export_ns = 0;
    std::uint64_t last_export_ns = 0;
    std::uint64_t qualified_graph_nodes = 0;
    bool checked_release = false;
    bool memory_sampled = false;
};

struct AugmentedRitzBlock {
    std::vector<AugmentedRitzCandidate> candidates;
    // Column major, q followed by phi in original coefficient units.
    std::vector<std::complex<double>> vectors;
    std::optional<int> negative_shift_inertia;
    cuda_trace::ModalEpsSolveTraceV1 native_trace{};
    AugmentedRitzDeviceMeasurements measurements{};
};

// One block at one real shift. The result is an unfiltered candidate pool.
// The caller owns frequency ordering, window cardinality and acceptance.
std::optional<AugmentedRitzBlock> solve_open_airbox_augmented_ritz(
    const PoissonAirboxEigenBlockProblem &problem, double operator_scale,
    double mass_scale, double shift, double mu0, int columns, const char **failure);

// The complex Floquet overload accepts the five original phase-reduced CSR
// blocks through a non-owning view. `shift` uses the same scaled angular
// frequency convention as the open-airbox entry above.
std::optional<AugmentedRitzBlock> solve_floquet_airbox_augmented_ritz(
    const PoissonAirboxEigenBlockProblem &controls,
    const FloquetAirboxAugmentedPencilView &blocks,
    double operator_scale,
    double mass_scale,
    double shift,
    double mu0,
    int columns,
    const char **failure);

} // namespace gpu
} // namespace fullmag::fem::frequency_domain
