/*
 * frequency_domain_contract.hpp - native FEM frequency-domain integration contract.
 *
 * This header owns solver-family availability and status vocabulary only. Solver
 * implementation, MFEM operator assembly, and FFI routing must live in dedicated
 * modules instead of src/mfem_bridge.cpp or src/api.cpp.
 */

#pragma once

#include <cstdint>

namespace fullmag::fem::frequency_domain {

enum class FrequencyDomainStatus : std::uint32_t {
    ok,
    unavailable,
    validation_error,
    operator_error,
    solve_error,
    artifact_error,
    interrupted,
};

enum class FrequencyDomainStudyKind : std::uint32_t {
    driven_frequency_response,
    modal_dynamic_matrix,
};

enum class FrequencyDomainPhaseConvention : std::uint32_t {
    exp_i_omega_t,
    exp_minus_i_omega_t,
};

struct FrequencyDomainFloquetPeriodicPair {
    const char *pair_id = nullptr;
    std::uint64_t node_a = 0;
    std::uint64_t node_b = 0;
    bool has_translation = false;
    double translation_m[3] = {0.0, 0.0, 0.0};
    bool has_phase = false;
    double phase_rad = 0.0;
};

struct FrequencyDomainAvailabilityRequest {
    FrequencyDomainStudyKind study_kind = FrequencyDomainStudyKind::driven_frequency_response;
    bool requires_driven_solver = false;
    bool requires_modal_solver = false;
    bool requires_static_periodic_boundary = false;
    bool requires_floquet_boundary = false;
    bool requires_nonzero_k_dynamic_demag = false;
    bool requires_gpu = false;
    bool strict_device = false;
    bool has_floquet_k_vector = false;
    double floquet_k_vector_rad_per_m[3] = {0.0, 0.0, 0.0};
    FrequencyDomainPhaseConvention phase_convention =
        FrequencyDomainPhaseConvention::exp_i_omega_t;
};

struct FrequencyDomainAvailabilityResult {
    FrequencyDomainStatus status = FrequencyDomainStatus::unavailable;
    bool driven_response_available = false;
    bool modal_solver_available = false;
    bool static_periodic_response_available = false;
    bool floquet_modal_available = false;
    bool floquet_response_available = false;
    bool dynamic_demag_k_available = false;
    bool gpu_available = false;
    const char *error_message = "";
    const char *diagnostics_json = "";
};

struct FrequencyDomainSweepProgress {
    std::uint64_t total_frequency_points = 0;
    std::uint64_t completed_frequency_points = 0;
    std::uint64_t written_frequency_point_artifacts = 0;
    double current_frequency_hz = 0.0;
    bool partial_artifacts_available = false;
    const char *latest_artifact_manifest_path = "";
    const char *progress_json = "";
};

const char *status_to_string(FrequencyDomainStatus status) noexcept;
const char *study_kind_to_string(FrequencyDomainStudyKind study_kind) noexcept;
bool status_is_error(FrequencyDomainStatus status) noexcept;
FrequencyDomainSweepProgress initial_sweep_progress(
    std::uint64_t total_frequency_points) noexcept;
FrequencyDomainSweepProgress interrupted_sweep_progress(
    std::uint64_t total_frequency_points,
    std::uint64_t completed_frequency_points,
    std::uint64_t written_frequency_point_artifacts,
    double current_frequency_hz,
    const char *latest_artifact_manifest_path) noexcept;
FrequencyDomainSweepProgress cancelling_sweep_progress(
    std::uint64_t total_frequency_points,
    std::uint64_t completed_frequency_points,
    std::uint64_t written_frequency_point_artifacts,
    double current_frequency_hz,
    const char *latest_artifact_manifest_path) noexcept;
FrequencyDomainSweepProgress completed_sweep_progress(
    std::uint64_t total_frequency_points,
    std::uint64_t completed_frequency_points,
    std::uint64_t written_frequency_point_artifacts,
    double current_frequency_hz,
    const char *latest_artifact_manifest_path) noexcept;

FrequencyDomainAvailabilityResult frequency_domain_availability(
    const FrequencyDomainAvailabilityRequest &request) noexcept;

} // namespace fullmag::fem::frequency_domain
