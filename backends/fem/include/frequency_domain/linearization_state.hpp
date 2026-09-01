#pragma once

#include "frequency_domain/frequency_domain_contract.hpp"
#include "frequency_domain/tangent_frame.hpp"

#include <cstdint>
#include <string>
#include <vector>

namespace fullmag::fem::frequency_domain {

struct CartesianVectorFieldView {
    const double *x = nullptr;
    const double *y = nullptr;
    const double *z = nullptr;
    std::uint64_t node_count = 0;
};

struct EquilibriumAcceptanceCertificateDescriptor {
    const char *criterion = nullptr;
    const char *metric_kind = nullptr;
    const char *unit = nullptr;
    double metric_value = 0.0;
    double threshold = 0.0;
    const char *certificate_sha256 = nullptr;
};

struct EquilibriumArtifactDescriptor {
    // v7 is deliberately explicit: callers may not reinterpret a pre-v7
    // equilibrium payload as a modal-linearization input.
    const char *schema_version = "equilibrium_artifact.v7";
    const char *equilibrium_id = nullptr;
    const char *mesh_snapshot_id = nullptr;
    const char *magnetic_mesh_id = nullptr;
    const char *airbox_mesh_id = nullptr;
    const char *material_snapshot_id = nullptr;
    const char *physics_snapshot_id = nullptr;
    const char *boundary_snapshot_id = nullptr;
    const char *producer_run_id = nullptr;
    const char *content_sha256 = nullptr;

    CartesianVectorFieldView m0_unit;
    CartesianVectorFieldView h_eff0_a_per_m;
    CartesianVectorFieldView h_demag0_a_per_m;
    const double *phi0 = nullptr;
    const double *tangent_lumped_mass = nullptr;

    std::uint64_t magnetic_node_count = 0;
    std::uint64_t airbox_node_count = 0;
    std::uint64_t tangent_lumped_mass_count = 0;
    bool accepted_for_linearization = false;
    EquilibriumAcceptanceCertificateDescriptor acceptance{};
    const char *demag_model = nullptr;
};

struct LinearizationBuildOptions {
    const char *expected_equilibrium_id = nullptr;
    const char *expected_mesh_snapshot_id = nullptr;
    const char *expected_material_snapshot_id = nullptr;
    const char *expected_physics_snapshot_id = nullptr;
    const char *expected_boundary_snapshot_id = nullptr;
    double m0_norm_tolerance = 1.0e-10;
    bool allow_m0_renormalization = false;
    bool require_static_demag_if_enabled = true;
};

struct LinearizationStateNative {
    std::string schema_version = "LinearizationState.v6";
    std::uint64_t node_count = 0;
    std::vector<TangentFrameNode> tangent_frames;
    std::vector<double> m0_xyz;
    std::vector<double> h_eff0_xyz;
    std::vector<double> h_demag0_xyz;
    std::vector<double> phi0;
    std::vector<double> tangent_lumped_mass;
    std::string equilibrium_id;
    std::string mesh_snapshot_id;
    std::string material_snapshot_id;
    std::string physics_snapshot_id;
    std::string boundary_snapshot_id;
    std::string producer_run_id;
    std::string equilibrium_content_sha256;
    std::string demag_model;
    std::string acceptance_criterion;
    std::string acceptance_metric_kind;
    std::string acceptance_unit;
    double acceptance_metric_value = 0.0;
    double acceptance_threshold = 0.0;
    std::string acceptance_certificate_sha256;
    std::string linearization_signature_hash;
    double accepted_m0_norm_tolerance = 0.0;
};

struct LinearizationDiagnostics {
    std::uint64_t node_count = 0;
    double max_m0_norm_error = 0.0;
    double max_m0_cross_heff0_relative = 0.0;
    double weighted_m0_cross_heff0_relative_l2 = 0.0;
    double max_tangent_basis_dot_abs = 0.0;
    bool accepted_equilibrium = false;
    bool static_demag_available = false;
    char acceptance_certificate_sha256[96] = "";
    char reject_reason[96] = "";
    char error_message[128] = "";
};

FrequencyDomainStatus validate_equilibrium_acceptance_certificate(
    const EquilibriumAcceptanceCertificateDescriptor &certificate,
    char error_message[128]) noexcept;

FrequencyDomainStatus build_linearization_state_from_equilibrium(
    const EquilibriumArtifactDescriptor &artifact,
    const LinearizationBuildOptions &options,
    LinearizationStateNative &out_state,
    LinearizationDiagnostics &out_diagnostics) noexcept;

} // namespace fullmag::fem::frequency_domain
