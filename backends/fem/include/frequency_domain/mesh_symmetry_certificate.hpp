#pragma once

#include "frequency_domain/frequency_domain_contract.hpp"
#include "frequency_domain/tangent_frame.hpp"

#include <cstdint>
#include <vector>

namespace fullmag::fem::frequency_domain {

struct PeriodicNodePair {
    std::uint64_t source_node = 0;
    std::uint64_t destination_node = 0;
};

enum class MeshSymmetryPoissonGaugePolicy : std::uint32_t {
    unspecified = 0,
    not_required = 1,
    mean_zero = 2,
    pinned_dof = 3,
    provider_responsibility = 4,
};

struct MeshSymmetryCertificateRequest {
    const char *schema_version = "periodic_mesh_certificate.v6";
    const double *magnetic_source_xyz = nullptr;
    const double *magnetic_destination_xyz = nullptr;
    const std::uint32_t *magnetic_source_material_ids = nullptr;
    const std::uint32_t *magnetic_destination_material_ids = nullptr;
    const std::uint32_t *magnetic_source_region_ids = nullptr;
    const std::uint32_t *magnetic_destination_region_ids = nullptr;
    const TangentFrameNode *magnetic_source_frame_nodes = nullptr;
    const TangentFrameNode *magnetic_destination_frame_nodes = nullptr;
    const double *static_demag_source_a_per_m = nullptr;
    const double *static_demag_destination_a_per_m = nullptr;
    std::uint64_t magnetic_source_node_count = 0;
    std::uint64_t magnetic_destination_node_count = 0;
    const PeriodicNodePair *magnetic_pairs = nullptr;
    std::uint64_t magnetic_pair_count = 0;

    const double *airbox_source_xyz = nullptr;
    const double *airbox_destination_xyz = nullptr;
    std::uint64_t airbox_source_node_count = 0;
    std::uint64_t airbox_destination_node_count = 0;
    const PeriodicNodePair *airbox_pairs = nullptr;
    std::uint64_t airbox_pair_count = 0;

    double translation_m[3] = {0.0, 0.0, 0.0};
    double translation_tolerance_m = 1.0e-12;
    double frame_transport_tolerance = 1.0e-10;
    double m0_pair_tolerance = 1.0e-10;
    double static_demag_pair_tolerance_a_per_m = 1.0e-6;
    bool require_static_demag_pair_consistency = false;
    bool require_poisson_gauge_policy = false;
    MeshSymmetryPoissonGaugePolicy poisson_gauge_policy =
        MeshSymmetryPoissonGaugePolicy::unspecified;
};

struct MeshSymmetryCertificate {
    char schema_version[64] = "periodic_mesh_certificate.v6";
    char certificate_id[96] = "";
    char content_sha256[96] = "";
    bool accepted = false;
    std::uint64_t source_node_count = 0;
    std::uint64_t destination_node_count = 0;
    std::uint64_t pair_count = 0;
    std::uint64_t airbox_pair_count = 0;
    double max_translation_residual_m = 0.0;
    double max_material_mismatch = 0.0;
    double max_region_mismatch = 0.0;
    double max_m0_pair_mismatch = 0.0;
    double max_h_demag0_pair_mismatch_a_per_m = 0.0;
    double max_frame_transport_error = 0.0;
    double max_airbox_phi_pair_mismatch = 0.0;
    bool static_demag_pair_consistency_available = false;
    bool poisson_gauge_policy_explicit = false;
    MeshSymmetryPoissonGaugePolicy poisson_gauge_policy =
        MeshSymmetryPoissonGaugePolicy::unspecified;
    bool magnetic_pair_map_fingerprint_available = false;
    bool airbox_pair_map_fingerprint_available = false;
    bool magnetic_pair_map_sha256_available = false;
    bool airbox_pair_map_sha256_available = false;
    bool tangent_frame_transfer_available = false;
    char magnetic_pair_map_fingerprint[96] = "";
    char airbox_pair_map_fingerprint[96] = "";
    char magnetic_pair_map_sha256[96] = "";
    char airbox_pair_map_sha256[96] = "";
    std::vector<double> tangent_frame_transfer_blocks_row_major_2x2;
    char rejection_reason[128] = "";
};

FrequencyDomainStatus build_mesh_symmetry_certificate(
    const MeshSymmetryCertificateRequest &request,
    MeshSymmetryCertificate &out_certificate) noexcept;

} // namespace fullmag::fem::frequency_domain
