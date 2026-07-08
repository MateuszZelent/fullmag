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

struct EquilibriumArtifactDescriptor {
    const char *equilibrium_id = nullptr;
    const char *mesh_snapshot_id = nullptr;
    const char *magnetic_mesh_id = nullptr;
    const char *airbox_mesh_id = nullptr;
    const char *material_snapshot_id = nullptr;
    const char *physics_snapshot_id = nullptr;
    const char *boundary_snapshot_id = nullptr;

    CartesianVectorFieldView m0_unit;
    CartesianVectorFieldView h_eff0_a_per_m;
    CartesianVectorFieldView h_demag0_a_per_m;
    const double *phi0 = nullptr;

    std::uint64_t magnetic_node_count = 0;
    std::uint64_t airbox_node_count = 0;
    bool accepted_for_linearization = false;
    const char *demag_model = nullptr;
};

struct LinearizationBuildOptions {
    const char *expected_mesh_snapshot_id = nullptr;
    const char *expected_material_snapshot_id = nullptr;
    const char *expected_physics_snapshot_id = nullptr;
    double m0_norm_tolerance = 1.0e-10;
    double equilibrium_torque_relative_tolerance = 1.0e-6;
    double periodic_seam_tolerance = 1.0e-8;
    bool allow_m0_renormalization = true;
    bool require_static_demag_if_enabled = true;
    bool require_symmetric_periodic_mesh = true;
    bool recompute_h_eff0_and_compare = true;
};

struct LinearizationStateNative {
    std::uint64_t node_count = 0;
    std::vector<TangentFrameNode> tangent_frames;
    std::vector<double> m0_xyz;
    std::vector<double> h_eff0_xyz;
    std::vector<double> h_demag0_xyz;
    std::vector<double> tangent_lumped_mass;
    std::string equilibrium_id;
    std::string mesh_snapshot_id;
    std::string material_snapshot_id;
    std::string physics_snapshot_id;
    std::string boundary_snapshot_id;
    std::string demag_model;
    std::string linearization_signature_hash;
};

struct LinearizationDiagnostics {
    std::uint64_t node_count = 0;
    double max_m0_norm_error = 0.0;
    double max_m0_cross_heff0_relative = 0.0;
    double max_tangent_basis_dot_abs = 0.0;
    bool accepted_equilibrium = false;
    bool static_demag_available = false;
    char reject_reason[96] = "";
    char error_message[128] = "";
};

FrequencyDomainStatus build_linearization_state_from_equilibrium(
    const EquilibriumArtifactDescriptor &artifact,
    const LinearizationBuildOptions &options,
    LinearizationStateNative &out_state,
    LinearizationDiagnostics &out_diagnostics) noexcept;

} // namespace fullmag::fem::frequency_domain
