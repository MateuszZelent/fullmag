#include "gpu/frequency_domain/modal_augmented_window.hpp"

#include "gpu/frequency_domain/modal_augmented_ritz.hpp"
#include "gpu/frequency_domain/modal_augmented_window_count.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <limits>

namespace fullmag::fem::frequency_domain::gpu {
namespace {

constexpr int projection_capacity = 96;
constexpr double two_pi = 6.283185307179586476925286766559;

struct SearchInterval {
    double lower;
    double upper;
    int negative_lower;
    int negative_upper;
    int depth;

    int mode_count() const noexcept { return negative_upper - negative_lower; }
};

double interior_guard(double edge, double residual_tol)
{
    return std::max(residual_tol, 64.0 * std::numeric_limits<double>::epsilon()) * edge;
}

std::vector<PoissonAirboxModalEigenResult::AcceptedMode> accept_block(
    AugmentedRitzBlock &block, const SearchInterval &interval, double angular_scale,
    double residual_tol, std::size_t dimension)
{
    using Mode = PoissonAirboxModalEigenResult::AcceptedMode;
    std::vector<Mode> modes;
    if (dimension == 0 || block.vectors.size() % dimension != 0 ||
        block.vectors.size() / dimension != block.candidates.size()) {
        return modes;
    }
    const double lower_guard = interior_guard(interval.lower, residual_tol);
    const double upper_guard = interior_guard(interval.upper, residual_tol);
    for (std::size_t index = 0; index < block.candidates.size(); ++index) {
        const auto &candidate = block.candidates[index];
        if (!std::isfinite(candidate.inverse_scaled_eigenvalue) || candidate.inverse_scaled_eigenvalue <= 0.0 ||
            !std::isfinite(candidate.magnetic_relative_residual) || candidate.magnetic_relative_residual < 0.0 ||
            !std::isfinite(candidate.poisson_relative_residual) || candidate.poisson_relative_residual < 0.0 ||
            !std::isfinite(candidate.magnetic_residual_l2) || !std::isfinite(candidate.poisson_residual_l2)) {
            continue;
        }
        const double omega = angular_scale / candidate.inverse_scaled_eigenvalue;
        const double frequency = omega / two_pi;
        const double residual = std::max(candidate.magnetic_relative_residual, candidate.poisson_relative_residual);
        if (!std::isfinite(frequency) || frequency <= interval.lower + lower_guard ||
            frequency >= interval.upper - upper_guard || residual > residual_tol) {
            continue;
        }
        const auto begin = block.vectors.begin() + static_cast<std::ptrdiff_t>(index * dimension);
        if (!std::all_of(begin, begin + dimension, [](const auto &entry) {
                return std::isfinite(entry.real()) && std::isfinite(entry.imag());
            })) {
            continue;
        }
        Mode mode;
        mode.eigenvalue_imag = mode.omega_rad_s = omega;
        mode.frequency_hz = frequency;
        mode.relative_residual = residual;
        mode.full_residual_reconstruction_relative_error = residual;
        mode.magnetic_block_backward_error = candidate.magnetic_relative_residual;
        mode.poisson_block_backward_error = candidate.poisson_relative_residual;
        mode.magnetic_residual_l2 = candidate.magnetic_residual_l2;
        mode.poisson_residual_l2 = candidate.poisson_residual_l2;
        mode.full_vector.assign(begin, begin + dimension);
        modes.push_back(std::move(mode));
    }
    std::stable_sort(modes.begin(), modes.end(), [](const Mode &lhs, const Mode &rhs) {
        return lhs.frequency_hz < rhs.frequency_hz;
    });
    return modes;
}

struct AugmentedWindowSolves {
    double operator_scale;
    double mass_scale;
    double angular_frequency_scale;
    double mu0;
    const FloquetAirboxAugmentedPencilView *floquet = nullptr;
    AugmentedWindowInertiaCache inertia_cache{};

    std::optional<AugmentedWindowCount> count(
        const PoissonAirboxEigenBlockProblem &problem, double low, double high,
        const char **failure)
    {
        if (floquet != nullptr) {
            return count_floquet_airbox_augmented_window(
                problem, *floquet, operator_scale, mass_scale, angular_frequency_scale,
                mu0, low, high, inertia_cache, failure);
        }
        return count_open_airbox_augmented_window(
            problem, operator_scale, mass_scale, angular_frequency_scale, mu0,
            low, high, inertia_cache, failure);
    }

    std::optional<AugmentedRitzBlock> ritz(
        const PoissonAirboxEigenBlockProblem &problem, double shift, int columns,
        const char **failure) const
    {
        if (floquet != nullptr) {
            return solve_floquet_airbox_augmented_ritz(
                problem, *floquet, operator_scale, mass_scale, shift, mu0, columns, failure);
        }
        return solve_open_airbox_augmented_ritz(
            problem, operator_scale, mass_scale, shift, mu0, columns, failure);
    }
};

bool is_factor_memory_admission_failure(const char *reason)
{
    return reason != nullptr &&
        (std::strcmp(reason, "cudss_peak_memory_estimate_unavailable") == 0 ||
         std::strcmp(reason, "cudss_device_memory_budget_unavailable") == 0 ||
         std::strcmp(reason, "cudss_peak_memory_budget_exceeded") == 0);
}

std::optional<CertifiedOpenAirboxWindow> solve_airbox_augmented_window(
    const PoissonAirboxEigenBlockProblem &problem, AugmentedWindowSolves &backend,
    const char **failure)
{
    if (!failure) {
        return std::nullopt;
    }
    *failure = nullptr;
    if (!problem.target_kind || std::strcmp(problem.target_kind, "frequency_window") != 0 ||
        problem.requested_mode_count == 0 || problem.max_outer_iterations == 0 ||
        problem.q_dof_count > std::numeric_limits<int>::max()) {
        *failure = "cudss_ritz_window_invalid_request";
        return std::nullopt;
    }

    const auto count = [&](double low, double high, const char **reason) {
        return backend.count(problem, low, high, reason);
    };
    const auto root = count(problem.frequency_min_hz, problem.frequency_max_hz, failure);
    if (!root) {
        return std::nullopt;
    }

    const auto capacity = std::min(static_cast<int>(problem.q_dof_count), projection_capacity);
    const auto dimension = static_cast<std::size_t>(problem.q_dof_count + problem.phi_dof_count);
    const auto started = std::chrono::steady_clock::now();
    std::vector<SearchInterval> pending{{problem.frequency_min_hz, problem.frequency_max_hz,
                                         root->negative_at_lower, root->negative_at_upper, 0}};
    CertifiedOpenAirboxWindow result;
    result.negative_at_origin = root->negative_at_origin;
    result.negative_at_lower = root->negative_at_lower;
    result.negative_at_upper = root->negative_at_upper;
    std::uint32_t solves = 0;
    // The same budget bounds how many intervals a failed search can refine.
    const auto budget = problem.max_outer_iterations;
    while (!pending.empty()) {
        if (poisson_airbox_modal_cancel_requested(problem)) {
            *failure = "cudss_ritz_window_cancelled";
            return std::nullopt;
        }
        const auto interval = pending.back();
        pending.pop_back();
        const int expected = interval.mode_count();
        if (expected == 0) {
            result.certified_intervals.push_back(
                {interval.lower, interval.upper, interval.negative_lower, interval.negative_upper, 0});
            continue;
        }
        if (solves == budget || interval.depth > std::numeric_limits<double>::digits) {
            *failure = "cudss_ritz_window_search_budget_exhausted";
            return std::nullopt;
        }

        const double width = interval.upper - interval.lower;
        const double midpoint = interval.lower + 0.5 * width;
        const char *local_failure = nullptr;
        if (expected <= capacity) {
            ++solves;
            // Include neighbouring modes, which can be closer to the shift
            // than some candidates inside this (possibly asymmetric) window.
            const int width_columns = std::clamp(2 * expected + 6, 16, projection_capacity);
            const int columns = std::min(capacity, width_columns);
            const double shift = (midpoint / backend.angular_frequency_scale) * two_pi;
            auto child = poisson_airbox_modal_progress_with_elapsed(
                problem, std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count());
            child.progress_current_subwindow = solves;
            poisson_airbox_modal_emit_progress(
                child, "frequency_window_base_subwindow", "production_gpu", 0, 0, 0, 0,
                std::numeric_limits<double>::quiet_NaN());
            auto block = backend.ritz(child, shift, columns, &local_failure);
            if (block) {
                auto modes = accept_block(*block, interval, backend.angular_frequency_scale,
                                          problem.residual_tolerance, dimension);
                result.subsolves.push_back({interval.lower, interval.upper, midpoint, expected,
                    static_cast<int>(modes.size()), columns, block->native_trace, block->measurements});
                if (modes.size() == static_cast<std::size_t>(expected)) {
                    result.certified_intervals.push_back(
                        {interval.lower, interval.upper, interval.negative_lower, interval.negative_upper, expected});
                    result.certified_mode_count += modes.size();
                    for (auto &mode : modes) {
                        if (result.modes.size() >= problem.requested_mode_count) {
                            break;
                        }
                        mode.eigenpair_index = static_cast<std::uint32_t>(result.modes.size());
                        result.modes.push_back(std::move(mode));
                    }
                    continue;
                }
            } else if (local_failure == nullptr ||
                       (std::strcmp(local_failure, "cudss_cuda_factorization_failed") != 0 &&
                        std::strcmp(local_failure, "cudss_factorization_info_failed") != 0)) {
                // A shifted factorization can fail near a pole. A failed CUDA
                // solve or resource-release check cannot be certified by a
                // successful solve on another interval.
                *failure = local_failure ? local_failure : "cudss_ritz_unknown_failure";
                return std::nullopt;
            }
        }

        bool split = false;
        for (const double fraction : {0.5, 0.375, 0.625}) {
            if (solves == budget) {
                break;
            }
            const double boundary = interval.lower + fraction * width;
            if (boundary <= interval.lower || boundary >= interval.upper) {
                continue;
            }
            ++solves;
            const char *split_failure = nullptr;
            const auto left = count(interval.lower, boundary, &split_failure);
            if (!left) {
                if (poisson_airbox_modal_cancel_requested(problem) ||
                    is_factor_memory_admission_failure(split_failure)) {
                    *failure = split_failure;
                    return std::nullopt;
                }
                continue;
            }
            if (left->negative_at_origin != root->negative_at_origin ||
                left->negative_at_lower != interval.negative_lower ||
                left->negative_at_upper > interval.negative_upper) {
                *failure = "cudss_ritz_window_inconsistent_interval_counts";
                return std::nullopt;
            }
            // Push right before left to maintain the ordering of the prefix.
            // Keep a single nonempty child if narrowing removed the halo.
            pending.push_back({boundary, interval.upper, left->negative_at_upper,
                               interval.negative_upper, interval.depth + 1});
            pending.push_back({interval.lower, boundary, interval.negative_lower,
                               left->negative_at_upper, interval.depth + 1});
            split = true;
            break;
        }
        if (!split) {
            *failure = local_failure ? local_failure : "cudss_ritz_window_no_certified_subdivision";
            return std::nullopt;
        }
    }
    const auto expected_total = static_cast<std::uint64_t>(root->negative_at_upper - root->negative_at_lower);
    if (result.certified_mode_count != expected_total) {
        *failure = "cudss_ritz_window_incomplete";
        return std::nullopt;
    }
    result.certified_inertia_factorizations = backend.inertia_cache.negative_by_scaled_shift.size();
    result.reused_inertia_probes = backend.inertia_cache.reused_probes;
    result.truncated_by_requested_count = result.modes.size() < result.certified_mode_count;
    return result;
}

std::optional<CertifiedOpenAirboxWindow> solve_airbox_augmented_nearest(
    const PoissonAirboxEigenBlockProblem &problem, AugmentedWindowSolves &backend,
    const char **failure)
{
    if (!failure) {
        return std::nullopt;
    }
    *failure = nullptr;
    const auto target = problem.target_frequency_hz;
    const auto angular_frequency_scale = backend.angular_frequency_scale;
    if (!problem.target_kind || std::strcmp(problem.target_kind, "nearest_frequency") != 0 ||
        !std::isfinite(target) || target < 0.0 || problem.requested_mode_count == 0 ||
        problem.requested_mode_count > problem.q_dof_count ||
        !std::isfinite(angular_frequency_scale) || angular_frequency_scale <= 0.0) {
        *failure = "cudss_ritz_nearest_invalid_request";
        return std::nullopt;
    }
    auto bracket = problem;
    bracket.target_kind = "frequency_window";
    double width = std::max(target / 16.0, angular_frequency_scale / (1024.0 * two_pi));
    for (std::uint32_t index = 0; index < problem.max_outer_iterations; ++index, width *= 2.0) {
        bracket.frequency_min_hz = std::max(0.0, target - width);
        bracket.frequency_max_hz = target + width;
        if (!std::isfinite(bracket.frequency_max_hz)) {
            break;
        }
        const auto count = backend.count(
            bracket, bracket.frequency_min_hz, bracket.frequency_max_hz, failure);
        if (!count) {
            if (*failure && std::strcmp(*failure, "cudss_window_endpoint_indeterminate") == 0) {
                continue;
            }
            return std::nullopt;
        }
        const auto inside = static_cast<std::uint32_t>(count->negative_at_upper - count->negative_at_lower);
        if (inside < problem.requested_mode_count) {
            continue;
        }
        // Every positive mode outside the bracket is farther from the target
        // than every mode inside it. Select only after accounting for all inside.
        bracket.requested_mode_count = inside;
        auto result = solve_airbox_augmented_window(bracket, backend, failure);
        if (!result) {
            return std::nullopt;
        }
        std::stable_sort(result->modes.begin(), result->modes.end(), [target](const auto &lhs, const auto &rhs) {
            return std::abs(lhs.frequency_hz - target) < std::abs(rhs.frequency_hz - target);
        });
        result->modes.resize(problem.requested_mode_count);
        for (std::size_t mode = 0; mode < result->modes.size(); ++mode) {
            result->modes[mode].eigenpair_index = static_cast<std::uint32_t>(mode);
        }
        result->truncated_by_requested_count = result->modes.size() < result->certified_mode_count;
        return result;
    }
    *failure = "cudss_ritz_nearest_bracket_exhausted";
    return std::nullopt;
}

} // namespace

std::optional<CertifiedOpenAirboxWindow> solve_open_airbox_augmented_window(
    const PoissonAirboxEigenBlockProblem &problem, double operator_scale,
    double mass_scale, double angular_frequency_scale, double mu0, const char **failure)
{
    AugmentedWindowSolves backend{operator_scale, mass_scale, angular_frequency_scale, mu0};
    return solve_airbox_augmented_window(problem, backend, failure);
}

std::optional<CertifiedOpenAirboxWindow> solve_open_airbox_augmented_nearest(
    const PoissonAirboxEigenBlockProblem &problem, double operator_scale,
    double mass_scale, double angular_frequency_scale, double mu0, const char **failure)
{
    AugmentedWindowSolves backend{operator_scale, mass_scale, angular_frequency_scale, mu0};
    return solve_airbox_augmented_nearest(problem, backend, failure);
}

std::optional<CertifiedOpenAirboxWindow> solve_floquet_airbox_augmented_nearest(
    const PoissonAirboxEigenBlockProblem &problem, const FloquetAirboxAugmentedPencilView &blocks,
    double operator_scale, double mass_scale, double angular_frequency_scale, double mu0,
    const char **failure)
{
    AugmentedWindowSolves backend{operator_scale, mass_scale, angular_frequency_scale, mu0, &blocks};
    return solve_airbox_augmented_nearest(problem, backend, failure);
}

} // namespace fullmag::fem::frequency_domain::gpu
