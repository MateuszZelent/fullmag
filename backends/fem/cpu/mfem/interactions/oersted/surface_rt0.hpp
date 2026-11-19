#pragma once

#include "cpu/mfem/transport/affine_rt0_element.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace fullmag::fem::oersted {

inline constexpr char surface_rt0_operator_version[] =
    "fem_oersted_rt0_surface.mpfr128_160_rndn_etoff.inspection.v1";

enum class AntennaProgressPhase : std::uint32_t {
    preparing_source, solving_potential, reconstructing_current, evaluating_field,
    validating_result, publishing_result
};
struct SurfaceRt0ProgressObserver {
    void *user_data;
    void (*callback)(void *, AntennaProgressPhase, std::uint64_t, std::uint64_t, std::uint64_t) noexcept;
    void emit(AntennaProgressPhase phase, std::uint64_t completed,
        std::uint64_t total, std::uint64_t source_cells) const noexcept
    { callback(user_data, phase, completed, total, source_cells); }
};

// Private FEM CPU kernel; the accepted-source adapter owns ABI, dispatch and policy.
enum class SurfaceRt0WorkKind : std::size_t {
    source_target_pairs,
    face_precision_passes,
    whole_face_formulas,
    signed_fan_panels,
    exact_fraction_operations,
    exact_integer_operations,
    exact_comparisons,
    real_divisions,
    copied_input_bytes,
    reserved_output_bytes,
    sqrt_calls,
    log_calls,
    log1p_calls,
    atan2_calls,
    count
};

inline constexpr std::size_t surface_rt0_work_kind_count =
    static_cast<std::size_t>(SurfaceRt0WorkKind::count);
using SurfaceRt0WorkCounts = std::array<std::uint64_t, surface_rt0_work_kind_count>;

// Every limit is mandatory and strictly positive. Counters describe the named
// operations only, not exhaustive Boost/libmp arithmetic or allocator activity.
struct SurfaceRt0WorkLimits {
    SurfaceRt0WorkCounts total;
    SurfaceRt0WorkCounts per_target;
    std::uint64_t maximum_raw_integer_bits;
    std::uint64_t maximum_reduced_fraction_bits;
    std::uint64_t maximum_lifetime_peak_rss_bytes;
    std::uint64_t guard_interval_events;
    double maximum_total_seconds;
    double maximum_target_seconds;
};

// Caller-owned reviewed numerical policy, with no implicit numeric defaults.
// Agreements/roundoff indicators are empirical checks, not error certificates.
struct SurfaceRt0Tolerances {
    double absolute_field_apm;
    double relative_field;
    double cancellation_floor_apm;
    double scalar_relative_80;
    double scalar_relative_120;
    double angle_relative_80;
    double angle_relative_120;
    double binary_scalar_epsilon_factor;
    double binary_roundoff_epsilon_factor;
    double binary_cancellation_limit;
    double highprecision_cancellation_limit;
};

struct SurfaceRt0WorkReport {
    SurfaceRt0WorkCounts total{};
    SurfaceRt0WorkCounts current_target{};
    // Precision-specific work only; shared exact preparation remains in total.
    // Precision order: binary64, MPFR128, MPFR160 (logical 80/120 passes).
    std::array<SurfaceRt0WorkCounts, 3> by_precision{};
    std::size_t current_target_index = 0;
    std::uint64_t maximum_raw_integer_bits = 0;
    std::uint64_t maximum_reduced_fraction_bits = 0;
    std::uint64_t last_sampled_lifetime_peak_rss_bytes = 0;
    double elapsed_seconds = 0.0;
};

// Private optional diagnostics; stable indices are separate from numerical work.
enum class SurfaceRt0Phase : std::size_t {
    source_prepare,
    exact_geometry,
    binary64,
    precision80,
    precision120,
    consistency,
    reduction,
    serialization,
    unattributed,
    count
};
inline constexpr std::size_t surface_rt0_phase_count =
    static_cast<std::size_t>(SurfaceRt0Phase::count);

struct SurfaceRt0PhaseReport {
    std::array<std::uint64_t, surface_rt0_phase_count> wall_time_ns{};
    std::uint64_t total_wall_time_ns = 0;
    bool started = false;
    // Any clock reversal, overflow or inconsistent accounting is explicit.
    bool accounting_issue = false;
};

struct SurfaceRt0PrecisionResult {
    bool evaluated = false;
    std::string refusal_reason;
    std::array<std::string, 3> h_xyz_apm;
    std::array<std::string, 3> whole_h_xyz_apm;
    std::string sum_local_norm_apm;
    std::string cancellation;
    std::string maximum_face_cancellation;
};

struct SurfaceRt0TargetResult {
    std::array<double, 3> h_xyz_apm;
    std::array<SurfaceRt0PrecisionResult, 3> precisions;
    SurfaceRt0WorkCounts work;
    bool binary64_requires_highprecision;
    std::string precision_budget_apm;
    std::string local_precision_delta_apm;
    std::string local_formula_delta_apm;
    std::string local_formula_delta_80_apm;
    std::string binary64_roundoff_indicator_apm;
};

struct SurfaceRt0Result {
    std::vector<SurfaceRt0TargetResult> targets;
    // Opaque caller binding, echoed without recomputing or authenticating a hash.
    std::array<std::uint8_t, 32> caller_source_digest;
};

// The callback must return a real, positive lifetime process peak RSS in bytes.
// Missing/throwing/zero-valued callbacks fail closed. Sampling is not a hard
// allocator cap: overshoot between guards remains possible. The core does not
// duplicate platform RSS logic or claim exhaustive heap accounting.
using SurfaceRt0PeakRss = std::function<std::uint64_t()>;

// Straight Tet4 generic RT0 signed coefficients (A), never physical face fluxes.
// Preserves coefficient/vertex order and both determinant orientations. Returns
// H in A/m, with no mu0, current solve, projection, QR or nodal averaging.
// report remains readable on failure; counts reset once on entry, never between
// targets, cells, formulas or precision passes within this invocation.
SurfaceRt0Result evaluate_surface_rt0(
    const std::vector<transport::AffineRt0Element::FrozenInput> &source,
    const std::array<std::uint8_t, 32> &caller_source_digest,
    const std::vector<std::array<double, 3>> &ordered_targets_m,
    const SurfaceRt0WorkLimits &limits,
    const SurfaceRt0Tolerances &tolerances,
    const SurfaceRt0PeakRss &peak_rss,
    SurfaceRt0WorkReport &report,
    SurfaceRt0PhaseReport *phase_report = nullptr,
    const SurfaceRt0ProgressObserver *observer = nullptr);

} // namespace fullmag::fem::oersted
