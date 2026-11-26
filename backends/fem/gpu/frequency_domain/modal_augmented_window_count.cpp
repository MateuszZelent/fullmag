#include "gpu/frequency_domain/modal_augmented_window_count.hpp"

#include "gpu/frequency_domain/modal_augmented_pencil.hpp"
#include "gpu/frequency_domain/modal_cudss_shift.hpp"

#include <cmath>
#include <limits>

namespace fullmag::fem::frequency_domain::gpu {

namespace {

template <typename Assemble>
std::optional<AugmentedWindowCount> count_airbox_augmented_window(
    const PoissonAirboxEigenBlockProblem &problem, double mass_scale,
    double angular_frequency_scale, double lower_hz, double upper_hz,
    Assemble assemble, AugmentedWindowInertiaCache &inertia_cache, const char **failure)
{
    if (!failure) {
        return std::nullopt;
    }
    *failure = nullptr;
    if (!std::isfinite(lower_hz) || lower_hz < 0.0 || !std::isfinite(upper_hz) || upper_hz <= lower_hz ||
        !std::isfinite(angular_frequency_scale) || angular_frequency_scale <= 0.0 ||
        !std::isfinite(mass_scale) || mass_scale <= 0.0 ||
        !std::isfinite(problem.residual_tolerance) || problem.residual_tolerance <= 0.0 ||
        problem.phi_dof_count > std::numeric_limits<int>::max()) {
        *failure = "cudss_window_invalid_configuration";
        return std::nullopt;
    }
    constexpr double tau = 6.283185307179586476925286766559;
    const auto cancelled = [&] {
        return problem.cancel_requested && problem.cancel_requested(problem.cancel_user_data) != 0;
    };
    struct Stream {
        cudaStream_t value = nullptr;
        ~Stream() { if (value) cudaStreamDestroy(value); }
    } stream;
    const auto negative = [&](double frequency_hz) -> std::optional<int> {
        if (cancelled()) {
            *failure = "cudss_window_cancelled";
            return std::nullopt;
        }
        const double coefficient = (frequency_hz / angular_frequency_scale) * tau * mass_scale;
        if (!std::isfinite(coefficient)) {
            *failure = "cudss_window_invalid_pencil";
            return std::nullopt;
        }
        const auto cached = inertia_cache.negative_by_scaled_shift.find(coefficient);
        if (cached != inertia_cache.negative_by_scaled_shift.end()) {
            ++inertia_cache.reused_probes;
            return cached->second;
        }
        if (!stream.value && cudaStreamCreateWithFlags(&stream.value, cudaStreamNonBlocking) != cudaSuccess) {
            *failure = "cudss_window_inertia_stream_failed";
            return std::nullopt;
        }
        auto pencil = assemble(coefficient);
        if (!pencil) {
            *failure = "cudss_window_invalid_pencil";
            return std::nullopt;
        }
        auto factor = CudssModalShift::create(*pencil, 1, stream.value, failure);
        if (!factor) {
            return std::nullopt;
        }
        const auto result = factor->negative_inertia();
        if (!factor->close()) {
            *failure = "cudss_window_factor_release_failed";
            return std::nullopt;
        }
        if (!result) {
            *failure = "cudss_window_inertia_unavailable_or_perturbed";
            return std::nullopt;
        }
        inertia_cache.negative_by_scaled_shift.emplace(coefficient, *result);
        return result;
    };

    const auto origin = negative(0.0);
    if (!origin) {
        return std::nullopt;
    }
    // Congruence with an SPD Schur block and the negative-definite
    // potential block has exactly phi negative directions at zero shift.
    if (*origin != static_cast<int>(problem.phi_dof_count)) {
        *failure = "cudss_window_equilibrium_not_positive_definite";
        return std::nullopt;
    }
    const auto guarded = [&](double edge_hz) -> std::optional<int> {
        if (edge_hz == 0.0) {
            return origin;
        }
        const double relative_guard = std::max(problem.residual_tolerance,
                                                64.0 * std::numeric_limits<double>::epsilon());
        const double guard_hz = relative_guard * edge_hz;
        const auto below = negative(std::max(0.0, edge_hz - guard_hz));
        if (!below) {
            return std::nullopt;
        }
        const auto above = negative(edge_hz + guard_hz);
        if (!above) {
            return std::nullopt;
        }
        if (*below != *above) {
            *failure = "cudss_window_endpoint_indeterminate";
            return std::nullopt;
        }
        return below;
    };

    const auto lower = guarded(lower_hz);
    if (!lower) {
        return std::nullopt;
    }
    const auto upper = guarded(upper_hz);
    if (!upper) {
        return std::nullopt;
    }
    if (*lower < *origin || *upper < *lower ||
        static_cast<std::uint64_t>(*upper - *origin) > problem.q_dof_count) {
        *failure = "cudss_window_inertia_not_monotonic";
        return std::nullopt;
    }
    return AugmentedWindowCount{*origin, *lower, *upper};
}

} // namespace

std::optional<AugmentedWindowCount> count_open_airbox_augmented_window(
    const PoissonAirboxEigenBlockProblem &problem, double operator_scale, double mass_scale,
    double angular_frequency_scale, double mu0, double lower_hz, double upper_hz,
    AugmentedWindowInertiaCache &inertia_cache, const char **failure)
{
    return count_airbox_augmented_window(
        problem, mass_scale, angular_frequency_scale, lower_hz, upper_hz,
        [&](double coefficient) {
            return assemble_open_airbox_augmented_pencil(problem, operator_scale, coefficient, mu0);
        }, inertia_cache, failure);
}

std::optional<AugmentedWindowCount> count_floquet_airbox_augmented_window(
    const PoissonAirboxEigenBlockProblem &problem, const FloquetAirboxAugmentedPencilView &blocks,
    double operator_scale, double mass_scale, double angular_frequency_scale, double mu0,
    double lower_hz, double upper_hz, AugmentedWindowInertiaCache &inertia_cache, const char **failure)
{
    return count_airbox_augmented_window(
        problem, mass_scale, angular_frequency_scale, lower_hz, upper_hz,
        [&](double coefficient) {
            return assemble_floquet_airbox_augmented_pencil(blocks, operator_scale, coefficient, mu0);
        }, inertia_cache, failure);
}

} // namespace fullmag::fem::frequency_domain::gpu
