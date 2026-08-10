#pragma once

#include <fullmag/fdm/cpu/charge_transport_v1.hpp>

#include <array>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace fullmag::fdm::cpu::oersted::v1 {

using Vector3 = std::array<double, 3>;
using FaceCurrentDensity = transport::v1::FaceCurrentDensity;

inline constexpr std::string_view api_version =
    "fullmag.fdm.cpu.oersted_fft_open.v1";
inline constexpr std::string_view formula_version = "current_transport.fullmag.v1";
inline constexpr std::string_view reconstruction_version =
    "fdm_face_to_cell_current.v1";
inline constexpr std::string_view operator_version =
    "fdm_oersted_cell_integrated_open.v1";
inline constexpr std::string_view realization_version =
    "oersted_fdm_fft_open.v1";
inline constexpr std::string_view engine_version = "fdm_oersted_fft_open_v1";
inline constexpr std::string_view certificate_version =
    "global_closed_current_certificate.v1";
inline constexpr std::string_view kernel_policy_version =
    "exact_cell_integral_all_offsets.v1";
inline constexpr std::string_view exact_zero_policy_version =
    "exact_zero_by_symmetry.v1";
inline constexpr std::string_view diagnostic_operator_version =
    "fdm_oersted_centered_differential_diagnostics.v1";
inline constexpr std::string_view direct_oracle_version =
    "oersted_direct_surface_potential_long_double.v1";
inline constexpr std::string_view oracle_spot_check_version =
    "oersted_surface_adaptive_spot_check.v1";

enum class AxisBoundary : std::uint32_t {
    open = 0,
    periodic = 1,
};

struct Grid {
    std::size_t nx = 0;
    std::size_t ny = 0;
    std::size_t nz = 0;
    double dx_m = 0.0;
    double dy_m = 0.0;
    double dz_m = 0.0;
    Vector3 origin_m{};
    std::array<AxisBoundary, 3> boundaries{
        AxisBoundary::open,
        AxisBoundary::open,
        AxisBoundary::open,
    };
};

enum class ClosureKind : std::uint32_t {
    closed_geometry = 0,
    certified_import = 1,
};

inline constexpr std::uint64_t inactive_component_label =
    std::numeric_limits<std::uint64_t>::max();

struct SourceCutRecord {
    std::string stable_id;
    std::uint64_t component_label = inactive_component_label;
    std::vector<std::uint64_t> ordered_internal_face_ids;
    std::vector<std::int8_t> ordered_normals;
    std::string drive_id;
    std::string drive_kind;
    double drive_value = 0.0;
    std::string drive_si_unit;
    std::uint64_t revision = 0;
    std::string digest;
};

struct GlobalClosedCurrentCertificate {
    std::string version;
    ClosureKind closure_kind = ClosureKind::closed_geometry;
    std::uint64_t revision = 0;
    std::string digest;
    std::string geometry_digest;
    std::uint64_t conductor_mask_revision = 0;
    std::string conductor_mask_digest;
    std::uint64_t face_current_revision = 0;
    std::string face_current_digest;
    std::vector<std::uint64_t> component_labels;
    std::size_t component_count = 0;
    bool global_continuity_passed = false;
    bool exterior_flux_passed = false;
    bool component_flux_passed = false;
    bool return_path_complete = false;
    double divergence_tolerance_a_per_m3 = 0.0;
    double exterior_current_tolerance_a = 0.0;
    double measured_max_abs_divergence_a_per_m3 = 0.0;
    std::vector<double> measured_component_exterior_current_a;
    std::vector<SourceCutRecord> source_cuts;
    std::string imported_certification_method;
    std::string imported_field_digest;
};

struct Problem {
    Grid grid;
    std::vector<std::uint8_t> conductor_mask;
    std::vector<std::uint8_t> target_mask;
    FaceCurrentDensity face_current_density_a_per_m2;
    std::uint64_t geometry_revision = 0;
    std::string geometry_digest;
    std::uint64_t conductor_mask_revision = 0;
    std::string conductor_mask_digest;
    std::uint64_t target_mask_revision = 0;
    std::string target_mask_digest;
    std::uint64_t face_current_revision = 0;
    std::string face_current_digest;
    std::string source_identity;
    std::uint64_t envelope_revision = 0;
    std::string envelope_digest;
    std::uint64_t stage_identity = 0;
    double evaluation_time_s = 0.0;
    double evaluated_envelope_multiplier = 1.0;
    std::uint64_t trusted_snapshot_revision = 0;
    std::string trusted_snapshot_digest;
    GlobalClosedCurrentCertificate closure_certificate;
};

enum class Status : std::uint32_t {
    ok = 0,
    invalid_argument = 1,
    shape_mismatch = 2,
    nonfinite_input = 3,
    periodic_unsupported = 4,
    missing_certificate = 5,
    stale_certificate = 6,
    open_circuit = 7,
    closure_failure = 8,
    numerical_failure = 9,
};

struct CacheDiagnostics {
    std::uint64_t plan_build_count = 0;
    std::uint64_t kernel_build_count = 0;
    std::uint64_t numerical_buffer_allocation_count = 0;
    std::uint64_t resolved_field_hit_count = 0;
    std::uint64_t resolved_field_miss_count = 0;
    std::uint64_t resolved_field_invalidation_count = 0;
    std::uint64_t trusted_fast_path_hit_count = 0;
    bool resolved_field_reused = false;
    std::string last_invalidation_reason;
    std::string resolved_field_cache_key_digest;
    std::string kernel_plan_cache_key_digest;
};

struct DifferentialDiagnostics {
    std::string_view operator_version = diagnostic_operator_version;
    std::size_t excluded_open_boundary_cells = 2;
    bool available = false;
    double current_scale_a_per_m2 = 0.0;
    double ampere_scale_a_per_m2 = 0.0;
    double divergence_current_rms_a_per_m3 = 0.0;
    double divergence_field_rms_a_per_m2 = 0.0;
    double curl_h_minus_j_rms_a_per_m2 = 0.0;
    double rho_div_j = 0.0;
    double rho_div_h = 0.0;
    double rho_ampere = 0.0;
};

struct Provenance {
    std::string_view api_version = v1::api_version;
    std::string_view formula_version = v1::formula_version;
    std::string_view reconstruction_version = v1::reconstruction_version;
    std::string_view operator_version = v1::operator_version;
    std::string_view realization_version = v1::realization_version;
    std::string_view engine_version = v1::engine_version;
    std::string_view certificate_version = v1::certificate_version;
    std::string_view kernel_policy_version = v1::kernel_policy_version;
    std::string_view exact_zero_policy_version = v1::exact_zero_policy_version;
    std::array<std::size_t, 3> physical_shape{};
    std::array<std::size_t, 3> padded_shape{};
    Vector3 origin_m{};
    Vector3 spacing_m{};
    std::string_view axis_order = "x-fastest";
    std::string_view scalar_precision = "fp64";
    std::string_view near_far_cutoff = "none";
    std::string_view fft_layout = "r2c-[Pz][Py][Px/2+1]-x-contiguous";
    std::string_view source_pack = "low-index-box-zero-padded.v1";
    std::string_view crop = "low-index-physical-box.v1";
    std::string_view inverse_normalization = "one_over_Px_Py_Pz_once.v1";
    std::uint64_t geometry_revision = 0;
    std::uint64_t conductor_mask_revision = 0;
    std::uint64_t target_mask_revision = 0;
    std::uint64_t face_current_revision = 0;
    std::uint64_t certificate_revision = 0;
    std::uint64_t trusted_snapshot_revision = 0;
    std::uint64_t envelope_revision = 0;
    std::uint64_t stage_identity = 0;
    double evaluation_time_s = 0.0;
    double evaluated_envelope_multiplier = 1.0;
    ClosureKind closure_kind = ClosureKind::closed_geometry;
    std::string geometry_digest;
    std::string conductor_mask_digest;
    std::string target_mask_digest;
    std::string face_current_digest;
    std::string certificate_digest;
    std::string trusted_snapshot_digest;
    std::string source_identity;
    std::string envelope_digest;
    std::string imported_certification_method;
    std::string imported_field_digest;
    std::vector<SourceCutRecord> source_cuts;
    CacheDiagnostics cache;
};

struct Solution {
    std::vector<Vector3> cell_current_density_a_per_m2;
    std::vector<Vector3> field_a_per_m;
    DifferentialDiagnostics diagnostics;
    Provenance provenance;
};

struct SolveResult {
    Status status = Status::invalid_argument;
    std::string message;
    Solution solution;

    bool ok() const noexcept { return status == Status::ok; }
};

std::string canonical_geometry_digest(const Grid &grid);
std::string canonical_mask_digest(const std::vector<std::uint8_t> &mask);
std::string canonical_face_current_digest(const FaceCurrentDensity &face_current);
std::string canonical_source_cut_digest(const SourceCutRecord &source_cut);
std::string canonical_certificate_digest(
    const GlobalClosedCurrentCertificate &certificate);
std::string canonical_trusted_snapshot_digest(const Problem &problem);

Status reconstruct_face_to_cell(const Grid &grid,
                                const std::vector<std::uint8_t> &conductor_mask,
                                const FaceCurrentDensity &face_current,
                                std::vector<Vector3> &cell_current,
                                std::string &message);

Vector3 cell_integrated_kernel_m(const Grid &grid,
                                 std::array<std::ptrdiff_t, 3> displacement_cells);

class Solver {
  public:
    Solver();
    ~Solver();
    Solver(Solver &&) noexcept;
    Solver &operator=(Solver &&) noexcept;
    Solver(const Solver &) = delete;
    Solver &operator=(const Solver &) = delete;

    const SolveResult &solve(const Problem &problem);
    const CacheDiagnostics &cache_diagnostics() const noexcept;

  private:
    class Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace fullmag::fdm::cpu::oersted::v1
