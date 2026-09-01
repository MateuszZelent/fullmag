#pragma once

#include "frequency_domain/frequency_domain_contract.hpp"
#include "frequency_domain/tangent_frame.hpp"

#include <cstdint>
#include <string>
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

// A pair-map view used by the backend-neutral certificate binding verifier.
// `mesh_*` maps are reconstructed from the authoritative mesh metadata while
// `payload_*` maps are the compact maps about to be handed to MFEM.  The
// verifier intentionally keeps the two views separate so a stale or tampered
// payload cannot validate itself.
struct MeshSymmetryCertificatePairMap {
    const PeriodicNodePair *pairs = nullptr;
    std::uint64_t pair_count = 0;
    std::uint64_t source_node_count = 0;
    std::uint64_t destination_node_count = 0;
    // Region markers are required for the authoritative mesh view.  They are
    // optional for a compact payload view; when present they are checked too.
    // There is no implicit fallback to mesh_desc state: missing authoritative
    // markers fail closed in the verifier.
    const std::uint32_t *source_region_ids = nullptr;
    const std::uint32_t *destination_region_ids = nullptr;
};

struct MeshSymmetryCertificateMapBindingRequest {
    const char *schema_version = "periodic_mesh_certificate.v6";
    MeshSymmetryCertificatePairMap mesh_magnetic;
    MeshSymmetryCertificatePairMap payload_magnetic;
    MeshSymmetryCertificatePairMap mesh_airbox;
    MeshSymmetryCertificatePairMap payload_airbox;
    const char *mesh_magnetic_part_identity = nullptr;
    const char *payload_magnetic_part_identity = nullptr;
    const char *mesh_airbox_part_identity = nullptr;
    const char *payload_airbox_part_identity = nullptr;
    // The digest carried by the payload.  It must match the verifier's
    // canonical preimage digest; a missing digest is never accepted.
    const char *payload_map_binding_digest = nullptr;
};

struct MeshSymmetryCertificateMapBinding {
    bool accepted = false;
    std::uint64_t magnetic_pair_count = 0;
    std::uint64_t airbox_pair_count = 0;
    char canonical_preimage_sha256[96] = "";
    char rejection_reason[128] = "";
};

// Append-only v6 canonical certificate boundary.  This model is deliberately
// independent of the public C ABI: it is the typed contract a native mesh
// owner must materialize before a compact map is handed to MFEM.  The
// append-only C ABI relation-view tail is converted to this type at the modal
// boundary; no solver code consumes raw C records directly.
enum class MeshSymmetryCertificateV6ViewKind : std::uint32_t {
    authoritative_mesh = 1,
    compact_payload = 2,
};

enum class MeshSymmetryCertificatePartRole : std::uint32_t {
    magnetic = 1,
    scalar_airbox = 2,
};

enum class MeshSymmetryCertificateRelationKind : std::uint32_t {
    face = 1,
    edge = 2,
    corner = 3,
};

struct MeshSymmetryCertificateRegionRole {
    std::uint32_t region_id = 0;
    MeshSymmetryCertificatePartRole part_role =
        MeshSymmetryCertificatePartRole::magnetic;
};

struct MeshSymmetryCertificateV6Relation {
    std::uint64_t source_node = 0;
    std::uint64_t destination_node = 0;
    // Bit 0/1/2 denote x/y/z seam axes.  A face, edge, or corner relation
    // must carry respectively one, two, or three bits.
    std::uint32_t axis_mask = 0;
    MeshSymmetryCertificateRelationKind kind =
        MeshSymmetryCertificateRelationKind::face;
};

struct MeshSymmetryCertificateV6ClassDigest {
    std::uint64_t canonical_class_id = 0;
    std::uint64_t member_count = 0;
    const char *sha256 = nullptr;
};

struct MeshSymmetryCertificateV6View {
    const char *schema_version = "periodic_mesh_certificate.v6";
    MeshSymmetryCertificateV6ViewKind view_kind =
        MeshSymmetryCertificateV6ViewKind::compact_payload;
    MeshSymmetryCertificatePartRole part_role =
        MeshSymmetryCertificatePartRole::magnetic;
    const char *part_identity = nullptr;
    const char *topology_fingerprint = nullptr;

    std::uint64_t node_count = 0;
    const std::uint32_t *region_ids = nullptr;
    const std::uint32_t *boundary_axis_masks = nullptr;
    const MeshSymmetryCertificateRegionRole *region_roles = nullptr;
    std::uint64_t region_role_count = 0;

    // Generator relations define the transitive union-find classes.  Closure
    // relations are diagnostic seam edges (including edge/corner closure);
    // they must not silently create a new equivalence class.
    const MeshSymmetryCertificateV6Relation *generator_relations = nullptr;
    std::uint64_t generator_relation_count = 0;
    const MeshSymmetryCertificateV6Relation *closure_relations = nullptr;
    std::uint64_t closure_relation_count = 0;
    bool require_complete_closure = true;

    // Canonical global class IDs and per-class digests are required from the
    // compact payload.  The authoritative mesh may omit them; the verifier
    // derives them and compares them with the payload view.
    const std::uint64_t *expected_class_ids = nullptr;
    std::uint64_t expected_class_id_count = 0;
    const MeshSymmetryCertificateV6ClassDigest *expected_class_digests = nullptr;
    std::uint64_t expected_class_digest_count = 0;
};

struct MeshSymmetryCertificateV6BindingRequest {
    const char *schema_version = "periodic_mesh_certificate.v6";
    // This identity is generated by the native mesh owner and is included in
    // the common preimage.  It prevents a payload from self-authorizing a
    // different mesh generation with an otherwise matching local map.
    const char *mesh_generation_identity = nullptr;
    MeshSymmetryCertificateV6View mesh_magnetic;
    MeshSymmetryCertificateV6View payload_magnetic;
    MeshSymmetryCertificateV6View mesh_scalar;
    MeshSymmetryCertificateV6View payload_scalar;
    const char *payload_binding_digest = nullptr;
};

struct MeshSymmetryCertificateV6Binding {
    bool accepted = false;
    std::uint64_t magnetic_class_count = 0;
    std::uint64_t scalar_class_count = 0;
    std::uint64_t magnetic_generator_relation_count = 0;
    std::uint64_t scalar_generator_relation_count = 0;
    std::uint64_t magnetic_closure_relation_count = 0;
    std::uint64_t scalar_closure_relation_count = 0;
    char magnetic_class_digest_sha256[96] = "";
    char scalar_class_digest_sha256[96] = "";
    char canonical_preimage_sha256[96] = "";
    char rejection_reason[160] = "";
    std::vector<std::uint64_t> magnetic_canonical_class_ids;
    std::vector<std::uint64_t> scalar_canonical_class_ids;
    // Diagnostic copies make failed validation actionable without weakening
    // the fail-closed decision.  They are not part of the C ABI.
    std::vector<std::string> magnetic_class_digests;
    std::vector<std::string> scalar_class_digests;
    std::string canonical_preimage;
};

FrequencyDomainStatus build_mesh_symmetry_certificate(
    const MeshSymmetryCertificateRequest &request,
    MeshSymmetryCertificate &out_certificate) noexcept;

// Verify the append-only map-binding boundary before native MFEM assembly.
// The function is backend-neutral and does not touch solver state.  Every
// malformed, stale, or unverifiable input returns validation_error with a
// stable rejection_reason and leaves accepted=false.
FrequencyDomainStatus verify_mesh_symmetry_certificate_map_binding(
    const MeshSymmetryCertificateMapBindingRequest &request,
    MeshSymmetryCertificateMapBinding &out_binding) noexcept;

// Verify two authoritative/payload pairs against the complete canonical v6
// model.  This is intentionally a backend-neutral, append-only contract: it
// computes transitive classes, validates region roles and part identities,
// checks face/edge/corner closure, verifies payload class digests, and emits a
// single `periodic_modal_equivalence_map_binding.v1` SHA-256 preimage.  It is
// not yet wired to the existing C ABI because that ABI lacks these buffers.
FrequencyDomainStatus verify_mesh_symmetry_certificate_v6(
    const MeshSymmetryCertificateV6BindingRequest &request,
    MeshSymmetryCertificateV6Binding &out_binding) noexcept;

// Validate and hash a producer-supplied canonical v6 preimage without
// claiming that the authoritative relation views were available.  This is
// the bounded C-ABI handoff used until the full mesh/payload views are
// materialized at the boundary.
FrequencyDomainStatus verify_mesh_symmetry_certificate_v6_preimage(
    const char *preimage,
    std::uint64_t preimage_len,
    const char *expected_digest,
    char *out_digest,
    std::uint64_t out_digest_size,
    char *out_reason,
    std::uint64_t out_reason_size) noexcept;

} // namespace fullmag::fem::frequency_domain
