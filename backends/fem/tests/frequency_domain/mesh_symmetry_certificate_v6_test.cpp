#include "frequency_domain/mesh_symmetry_certificate.hpp"

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

namespace fd = fullmag::fem::frequency_domain;

namespace {

void require(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::abort();
    }
}

struct Fixture {
    const std::uint32_t regions[4] = {7, 7, 7, 7};
    const std::uint32_t boundary_axes[4] = {0, 1, 2, 3};
    const fd::MeshSymmetryCertificateRegionRole region_roles[1] = {
        {7, fd::MeshSymmetryCertificatePartRole::magnetic},
    };
    const fd::MeshSymmetryCertificateV6Relation generators[4] = {
        {0, 1, 1, fd::MeshSymmetryCertificateRelationKind::face},
        {2, 3, 1, fd::MeshSymmetryCertificateRelationKind::face},
        {0, 2, 2, fd::MeshSymmetryCertificateRelationKind::face},
        {1, 3, 2, fd::MeshSymmetryCertificateRelationKind::face},
    };
    const fd::MeshSymmetryCertificateV6Relation closure[6] = {
        {0, 1, 1, fd::MeshSymmetryCertificateRelationKind::face},
        {2, 3, 1, fd::MeshSymmetryCertificateRelationKind::face},
        {0, 2, 2, fd::MeshSymmetryCertificateRelationKind::face},
        {1, 3, 2, fd::MeshSymmetryCertificateRelationKind::face},
        {0, 3, 3, fd::MeshSymmetryCertificateRelationKind::edge},
        {1, 2, 3, fd::MeshSymmetryCertificateRelationKind::edge},
    };
    const std::uint64_t class_ids[4] = {0, 0, 0, 0};
    // Canonical v6 per-class digest for the four-node x/y fixture.
    fd::MeshSymmetryCertificateV6ClassDigest class_digests[1] = {
        {0, 4, "sha256:88feeb3b3663fbb296e50c8f7793b69577d882945f921a5d296cbbd0d93cebac"},
    };
};

struct CornerFixture {
    const std::uint32_t regions[8] = {7, 7, 7, 7, 7, 7, 7, 7};
    const std::uint32_t boundary_axes[8] = {0, 1, 2, 3, 4, 5, 6, 7};
    const fd::MeshSymmetryCertificateRegionRole region_roles[1] = {
        {7, fd::MeshSymmetryCertificatePartRole::magnetic},
    };
    const fd::MeshSymmetryCertificateV6Relation generators[12] = {
        {0, 1, 1, fd::MeshSymmetryCertificateRelationKind::face},
        {2, 3, 1, fd::MeshSymmetryCertificateRelationKind::face},
        {4, 5, 1, fd::MeshSymmetryCertificateRelationKind::face},
        {6, 7, 1, fd::MeshSymmetryCertificateRelationKind::face},
        {0, 2, 2, fd::MeshSymmetryCertificateRelationKind::face},
        {1, 3, 2, fd::MeshSymmetryCertificateRelationKind::face},
        {4, 6, 2, fd::MeshSymmetryCertificateRelationKind::face},
        {5, 7, 2, fd::MeshSymmetryCertificateRelationKind::face},
        {0, 4, 4, fd::MeshSymmetryCertificateRelationKind::face},
        {1, 5, 4, fd::MeshSymmetryCertificateRelationKind::face},
        {2, 6, 4, fd::MeshSymmetryCertificateRelationKind::face},
        {3, 7, 4, fd::MeshSymmetryCertificateRelationKind::face},
    };
    const fd::MeshSymmetryCertificateV6Relation closure[28] = {
        {0, 1, 1, fd::MeshSymmetryCertificateRelationKind::face},
        {2, 3, 1, fd::MeshSymmetryCertificateRelationKind::face},
        {4, 5, 1, fd::MeshSymmetryCertificateRelationKind::face},
        {6, 7, 1, fd::MeshSymmetryCertificateRelationKind::face},
        {0, 2, 2, fd::MeshSymmetryCertificateRelationKind::face},
        {1, 3, 2, fd::MeshSymmetryCertificateRelationKind::face},
        {4, 6, 2, fd::MeshSymmetryCertificateRelationKind::face},
        {5, 7, 2, fd::MeshSymmetryCertificateRelationKind::face},
        {0, 4, 4, fd::MeshSymmetryCertificateRelationKind::face},
        {1, 5, 4, fd::MeshSymmetryCertificateRelationKind::face},
        {2, 6, 4, fd::MeshSymmetryCertificateRelationKind::face},
        {3, 7, 4, fd::MeshSymmetryCertificateRelationKind::face},
        {0, 3, 3, fd::MeshSymmetryCertificateRelationKind::edge},
        {1, 2, 3, fd::MeshSymmetryCertificateRelationKind::edge},
        {4, 7, 3, fd::MeshSymmetryCertificateRelationKind::edge},
        {5, 6, 3, fd::MeshSymmetryCertificateRelationKind::edge},
        {0, 5, 5, fd::MeshSymmetryCertificateRelationKind::edge},
        {1, 4, 5, fd::MeshSymmetryCertificateRelationKind::edge},
        {2, 7, 5, fd::MeshSymmetryCertificateRelationKind::edge},
        {3, 6, 5, fd::MeshSymmetryCertificateRelationKind::edge},
        {0, 6, 6, fd::MeshSymmetryCertificateRelationKind::edge},
        {1, 7, 6, fd::MeshSymmetryCertificateRelationKind::edge},
        {2, 4, 6, fd::MeshSymmetryCertificateRelationKind::edge},
        {3, 5, 6, fd::MeshSymmetryCertificateRelationKind::edge},
        {0, 7, 7, fd::MeshSymmetryCertificateRelationKind::corner},
        {1, 6, 7, fd::MeshSymmetryCertificateRelationKind::corner},
        {2, 5, 7, fd::MeshSymmetryCertificateRelationKind::corner},
        {3, 4, 7, fd::MeshSymmetryCertificateRelationKind::corner},
    };
    const std::uint64_t class_ids[8] = {0, 0, 0, 0, 0, 0, 0, 0};
    fd::MeshSymmetryCertificateV6ClassDigest class_digests[1] = {
        {0, 8, "sha256:8ca8a8395f56806231086e1d061779d0fcc68db8d312f3583f754b3a04b99f15"},
    };
};

fd::MeshSymmetryCertificateV6View make_view(
    const Fixture &fixture,
    fd::MeshSymmetryCertificateV6ViewKind view_kind,
    fd::MeshSymmetryCertificatePartRole part_role,
    const char *part_identity,
    const char *topology_fingerprint,
    const fd::MeshSymmetryCertificateRegionRole *region_roles = nullptr,
    const std::uint32_t *region_ids = nullptr)
{
    fd::MeshSymmetryCertificateV6View view{};
    view.schema_version = "periodic_mesh_certificate.v6";
    view.view_kind = view_kind;
    view.part_role = part_role;
    view.part_identity = part_identity;
    view.topology_fingerprint = topology_fingerprint;
    view.node_count = 4;
    view.region_ids = region_ids != nullptr ? region_ids : fixture.regions;
    view.boundary_axis_masks = fixture.boundary_axes;
    view.region_roles = region_roles != nullptr ? region_roles : fixture.region_roles;
    view.region_role_count = 1;
    view.generator_relations = fixture.generators;
    view.generator_relation_count = 4;
    view.closure_relations = fixture.closure;
    view.closure_relation_count = 6;
    view.expected_class_ids = fixture.class_ids;
    view.expected_class_id_count = 4;
    view.expected_class_digests = fixture.class_digests;
    view.expected_class_digest_count = 1;
    view.require_complete_closure = true;
    return view;
}

fd::MeshSymmetryCertificateV6BindingRequest make_request(Fixture &fixture)
{
    fd::MeshSymmetryCertificateV6BindingRequest request{};
    request.schema_version = "periodic_mesh_certificate.v6";
    request.mesh_generation_identity = "mesh-generation:periodic-film-v1";
    request.mesh_magnetic = make_view(
        fixture,
        fd::MeshSymmetryCertificateV6ViewKind::authoritative_mesh,
        fd::MeshSymmetryCertificatePartRole::magnetic,
        "magnetic:film:v1",
        "sha256:1111111111111111111111111111111111111111111111111111111111111111");
    request.payload_magnetic = make_view(
        fixture,
        fd::MeshSymmetryCertificateV6ViewKind::compact_payload,
        fd::MeshSymmetryCertificatePartRole::magnetic,
        "magnetic:film:v1",
        "sha256:1111111111111111111111111111111111111111111111111111111111111111");

    static const std::uint32_t scalar_regions[4] = {100, 100, 100, 100};
    static const fd::MeshSymmetryCertificateRegionRole scalar_roles[1] = {
        {100, fd::MeshSymmetryCertificatePartRole::scalar_airbox},
    };
    static Fixture scalar_fixture{};
    request.mesh_scalar = make_view(
        scalar_fixture,
        fd::MeshSymmetryCertificateV6ViewKind::authoritative_mesh,
        fd::MeshSymmetryCertificatePartRole::scalar_airbox,
        "airbox:poisson:v1",
        "sha256:2222222222222222222222222222222222222222222222222222222222222222",
        scalar_roles,
        scalar_regions);
    request.payload_scalar = make_view(
        scalar_fixture,
        fd::MeshSymmetryCertificateV6ViewKind::compact_payload,
        fd::MeshSymmetryCertificatePartRole::scalar_airbox,
        "airbox:poisson:v1",
        "sha256:2222222222222222222222222222222222222222222222222222222222222222",
        scalar_roles,
        scalar_regions);
    static fd::MeshSymmetryCertificateV6ClassDigest scalar_class_digests[1] = {
        {0, 4, "sha256:7ff33f86d0dc4a728a5beaf03ef9b05fb20ee1821b92218d846272a01db7366c"},
    };
    request.mesh_scalar.expected_class_digests = scalar_class_digests;
    request.payload_scalar.expected_class_digests = scalar_class_digests;
    request.mesh_scalar.expected_class_digest_count = 1;
    request.payload_scalar.expected_class_digest_count = 1;
    request.payload_binding_digest = nullptr;
    return request;
}

fd::MeshSymmetryCertificateV6View make_corner_view(
    const CornerFixture &fixture,
    fd::MeshSymmetryCertificateV6ViewKind view_kind,
    fd::MeshSymmetryCertificatePartRole part_role,
    const char *part_identity,
    const char *topology_fingerprint,
    const std::uint32_t *region_ids,
    const fd::MeshSymmetryCertificateRegionRole *region_roles,
    fd::MeshSymmetryCertificateV6ClassDigest *class_digests)
{
    fd::MeshSymmetryCertificateV6View view{};
    view.schema_version = "periodic_mesh_certificate.v6";
    view.view_kind = view_kind;
    view.part_role = part_role;
    view.part_identity = part_identity;
    view.topology_fingerprint = topology_fingerprint;
    view.node_count = 8;
    view.region_ids = region_ids != nullptr ? region_ids : fixture.regions;
    view.boundary_axis_masks = fixture.boundary_axes;
    view.region_roles = region_roles != nullptr ? region_roles : fixture.region_roles;
    view.region_role_count = 1;
    view.generator_relations = fixture.generators;
    view.generator_relation_count = 12;
    view.closure_relations = fixture.closure;
    view.closure_relation_count = 28;
    view.require_complete_closure = true;
    view.expected_class_ids = fixture.class_ids;
    view.expected_class_id_count = 8;
    view.expected_class_digests = class_digests != nullptr ? class_digests : fixture.class_digests;
    view.expected_class_digest_count = 1;
    return view;
}

fd::MeshSymmetryCertificateV6BindingRequest make_corner_request(CornerFixture &fixture)
{
    static const std::uint32_t scalar_regions[8] = {100, 100, 100, 100, 100, 100, 100, 100};
    static const fd::MeshSymmetryCertificateRegionRole scalar_roles[1] = {
        {100, fd::MeshSymmetryCertificatePartRole::scalar_airbox},
    };
    static fd::MeshSymmetryCertificateV6ClassDigest scalar_class_digests[1] = {
        {0, 8, "sha256:09bf28a66f6106bccb5392af3c688e7476c1266d9b82644d78dd852a9cdeae8e"},
    };
    fd::MeshSymmetryCertificateV6BindingRequest request{};
    request.schema_version = "periodic_mesh_certificate.v6";
    request.mesh_generation_identity = "mesh-generation:periodic-corner-v1";
    request.mesh_magnetic = make_corner_view(
        fixture,
        fd::MeshSymmetryCertificateV6ViewKind::authoritative_mesh,
        fd::MeshSymmetryCertificatePartRole::magnetic,
        "magnetic:film:corner-v1",
        "sha256:3333333333333333333333333333333333333333333333333333333333333333",
        nullptr,
        nullptr,
        nullptr);
    request.payload_magnetic = make_corner_view(
        fixture,
        fd::MeshSymmetryCertificateV6ViewKind::compact_payload,
        fd::MeshSymmetryCertificatePartRole::magnetic,
        "magnetic:film:corner-v1",
        "sha256:3333333333333333333333333333333333333333333333333333333333333333",
        nullptr,
        nullptr,
        nullptr);
    request.mesh_scalar = make_corner_view(
        fixture,
        fd::MeshSymmetryCertificateV6ViewKind::authoritative_mesh,
        fd::MeshSymmetryCertificatePartRole::scalar_airbox,
        "airbox:poisson:corner-v1",
        "sha256:4444444444444444444444444444444444444444444444444444444444444444",
        scalar_regions,
        scalar_roles,
        scalar_class_digests);
    request.payload_scalar = make_corner_view(
        fixture,
        fd::MeshSymmetryCertificateV6ViewKind::compact_payload,
        fd::MeshSymmetryCertificatePartRole::scalar_airbox,
        "airbox:poisson:corner-v1",
        "sha256:4444444444444444444444444444444444444444444444444444444444444444",
        scalar_regions,
        scalar_roles,
        scalar_class_digests);
    return request;
}

void accepts_complete_v6_fixture_and_emits_stable_digest()
{
    Fixture fixture{};
    auto request = make_request(fixture);
    fd::MeshSymmetryCertificateV6Binding result{};
    request.payload_binding_digest =
        "sha256:4397ddf3cf87bf263647dfc9d0d7f1e95ceda79ffe0b547ba99497e4d79c23a7";
    require(
        fd::verify_mesh_symmetry_certificate_v6(request, result) ==
            fd::FrequencyDomainStatus::ok,
        "complete magnetic/scalar v6 fixture is accepted");
    require(result.accepted, "complete v6 fixture is explicitly accepted");
    require(result.magnetic_class_count == 1, "magnetic transitive class count is stable");
    require(result.scalar_class_count == 1, "scalar transitive class count is stable");
    require(result.magnetic_canonical_class_ids == std::vector<std::uint64_t>{0, 0, 0, 0},
            "magnetic union-find canonical ids are stable");
    require(result.scalar_canonical_class_ids == std::vector<std::uint64_t>{0, 0, 0, 0},
            "scalar union-find canonical ids are stable");
    require(
        std::strcmp(
            result.canonical_preimage_sha256,
            "sha256:4397ddf3cf87bf263647dfc9d0d7f1e95ceda79ffe0b547ba99497e4d79c23a7") == 0,
        "common v6 golden preimage digest is stable");
    require(
        result.canonical_preimage.rfind(
            "periodic_modal_equivalence_map_binding.v1\nschema=periodic_mesh_certificate.v6\n",
            0) == 0,
        "golden preimage carries the canonical schema marker");
}

void accepts_corner_closure_and_golden_digest()
{
    CornerFixture fixture{};
    auto request = make_corner_request(fixture);
    request.payload_binding_digest =
        "sha256:8dcf86c285f26ceca7b663ed3775c7c99e3a03baf0257649f33daa27f6723757";
    fd::MeshSymmetryCertificateV6Binding result{};
    require(
        fd::verify_mesh_symmetry_certificate_v6(request, result) ==
            fd::FrequencyDomainStatus::ok,
        "corner/edge-complete v6 fixture is accepted");
    require(result.accepted, "corner/edge-complete fixture is explicitly accepted");
    require(result.magnetic_class_count == 1, "corner magnetic class count is stable");
    require(result.magnetic_closure_relation_count == 28, "corner closure relation count is stable");
    require(
        std::strcmp(
            result.canonical_preimage_sha256,
            "sha256:8dcf86c285f26ceca7b663ed3775c7c99e3a03baf0257649f33daa27f6723757") == 0,
        "corner common preimage digest is stable");
}

void rejects_missing_corner_closure()
{
    CornerFixture fixture{};
    auto request = make_corner_request(fixture);
    request.mesh_magnetic.closure_relation_count = 27;
    fd::MeshSymmetryCertificateV6Binding result{};
    require(
        fd::verify_mesh_symmetry_certificate_v6(request, result) ==
            fd::FrequencyDomainStatus::validation_error,
        "removing corner closure must fail closed");
    require(
        std::strcmp(
            result.rejection_reason,
            "periodic_mesh_certificate_v6_corner_closure_incomplete") == 0,
        "missing corner closure has a stable rejection reason");
}

void canonical_digest_is_independent_of_relation_input_order()
{
    Fixture fixture{};
    auto request = make_request(fixture);
    request.payload_binding_digest =
        "sha256:4397ddf3cf87bf263647dfc9d0d7f1e95ceda79ffe0b547ba99497e4d79c23a7";
    std::vector<fd::MeshSymmetryCertificateV6Relation> reordered_generators(
        fixture.generators,
        fixture.generators + 4);
    std::vector<fd::MeshSymmetryCertificateV6Relation> reordered_closure(
        fixture.closure,
        fixture.closure + 6);
    std::reverse(reordered_generators.begin(), reordered_generators.end());
    std::reverse(reordered_closure.begin(), reordered_closure.end());
    request.mesh_magnetic.generator_relations = reordered_generators.data();
    request.payload_magnetic.generator_relations = reordered_generators.data();
    request.mesh_magnetic.closure_relations = reordered_closure.data();
    request.payload_magnetic.closure_relations = reordered_closure.data();
    fd::MeshSymmetryCertificateV6Binding result{};
    require(
        fd::verify_mesh_symmetry_certificate_v6(request, result) ==
            fd::FrequencyDomainStatus::ok,
        "reordered relation inputs remain accepted");
    require(
        std::strcmp(
            result.canonical_preimage_sha256,
            "sha256:4397ddf3cf87bf263647dfc9d0d7f1e95ceda79ffe0b547ba99497e4d79c23a7") == 0,
        "canonical digest does not depend on relation input order");
}

void rejects_missing_edge_closure()
{
    Fixture fixture{};
    auto request = make_request(fixture);
    request.mesh_magnetic.closure_relation_count = 5;
    fd::MeshSymmetryCertificateV6Binding result{};
    require(
        fd::verify_mesh_symmetry_certificate_v6(request, result) ==
            fd::FrequencyDomainStatus::validation_error,
        "missing edge closure must fail closed");
    require(
        std::strcmp(
            result.rejection_reason,
            "periodic_mesh_certificate_v6_edge_closure_incomplete") == 0,
        "missing edge closure has a stable rejection reason");
}

void rejects_payload_class_tampering()
{
    Fixture fixture{};
    auto request = make_request(fixture);
    const std::uint64_t tampered_ids[4] = {0, 0, 2, 2};
    request.payload_magnetic.expected_class_ids = tampered_ids;
    fd::MeshSymmetryCertificateV6Binding result{};
    require(
        fd::verify_mesh_symmetry_certificate_v6(request, result) ==
            fd::FrequencyDomainStatus::validation_error,
        "payload class ids must be checked against transitive union-find");
}

void rejects_stale_class_digest()
{
    Fixture fixture{};
    auto request = make_request(fixture);
    static const fd::MeshSymmetryCertificateV6ClassDigest stale_digest[1] = {
        {0, 4, "sha256:0000000000000000000000000000000000000000000000000000000000000000"},
    };
    request.payload_magnetic.expected_class_digests = stale_digest;
    fd::MeshSymmetryCertificateV6Binding result{};
    require(
        fd::verify_mesh_symmetry_certificate_v6(request, result) ==
            fd::FrequencyDomainStatus::validation_error,
        "payload class digest mutation must fail closed");
    require(
        std::strcmp(
            result.rejection_reason,
            "periodic_mesh_certificate_v6_class_digest_mismatch") == 0,
        "stale class digest has a stable rejection reason");
}

void rejects_region_role_and_identity_tampering()
{
    Fixture fixture{};
    auto request = make_request(fixture);
    const fd::MeshSymmetryCertificateRegionRole wrong_role[1] = {
        {7, fd::MeshSymmetryCertificatePartRole::scalar_airbox},
    };
    request.payload_magnetic.region_roles = wrong_role;
    fd::MeshSymmetryCertificateV6Binding result{};
    require(
        fd::verify_mesh_symmetry_certificate_v6(request, result) ==
            fd::FrequencyDomainStatus::validation_error,
        "region role mismatch must fail closed");

    request = make_request(fixture);
    request.payload_scalar.part_identity = "magnetic:wrong-part";
    require(
        fd::verify_mesh_symmetry_certificate_v6(request, result) ==
            fd::FrequencyDomainStatus::validation_error,
        "part identity collision/mismatch must fail closed");

    request = make_request(fixture);
    request.payload_magnetic.topology_fingerprint =
        "sha256:9999999999999999999999999999999999999999999999999999999999999999";
    require(
        fd::verify_mesh_symmetry_certificate_v6(request, result) ==
            fd::FrequencyDomainStatus::validation_error,
        "payload topology fingerprint mutation must fail closed");

    request = make_request(fixture);
    request.mesh_generation_identity = nullptr;
    require(
        fd::verify_mesh_symmetry_certificate_v6(request, result) ==
            fd::FrequencyDomainStatus::validation_error,
        "missing mesh-generation identity must fail closed");

    request = make_request(fixture);
    request.payload_magnetic.view_kind =
        fd::MeshSymmetryCertificateV6ViewKind::authoritative_mesh;
    require(
        fd::verify_mesh_symmetry_certificate_v6(request, result) ==
            fd::FrequencyDomainStatus::validation_error,
        "payload cannot self-authorize as an authoritative mesh view");
}

void validates_c_abi_preimage_handoff_without_claiming_relation_views()
{
    static constexpr char preimage[] =
        "periodic_modal_equivalence_map_binding.v1\n"
        "schema=periodic_mesh_certificate.v6\n";
    static constexpr char digest[] =
        "sha256:5c4867e34716043a16db534f5ffca90613cff84119573b5da0afdb2f1aafb6d2";
    char actual[96]{};
    char reason[160]{};
    require(
        fd::verify_mesh_symmetry_certificate_v6_preimage(
            preimage,
            sizeof(preimage) - 1u,
            digest,
            actual,
            sizeof(actual),
            reason,
            sizeof(reason)) == fd::FrequencyDomainStatus::ok,
        "canonical preimage SHA-256 handoff accepts the golden digest");
    require(std::strcmp(actual, digest) == 0, "preimage handoff returns the recomputed digest");
    require(std::strcmp(reason, "none") == 0, "accepted preimage has no rejection reason");

    static constexpr char invalid_utf8[] = "canonical\xC0\xAF";
    require(
        fd::verify_mesh_symmetry_certificate_v6_preimage(
            invalid_utf8,
            sizeof(invalid_utf8) - 1u,
            digest,
            actual,
            sizeof(actual),
            reason,
            sizeof(reason)) == fd::FrequencyDomainStatus::validation_error,
        "canonical preimage handoff rejects invalid UTF-8");
    require(std::strcmp(reason, "canonical_preimage_utf8_invalid") == 0,
            "invalid UTF-8 has a stable rejection reason");
}

} // namespace

int main()
{
    accepts_complete_v6_fixture_and_emits_stable_digest();
    accepts_corner_closure_and_golden_digest();
    rejects_missing_edge_closure();
    rejects_missing_corner_closure();
    canonical_digest_is_independent_of_relation_input_order();
    rejects_payload_class_tampering();
    rejects_stale_class_digest();
    rejects_region_role_and_identity_tampering();
    validates_c_abi_preimage_handoff_without_claiming_relation_views();
    std::puts("mesh_symmetry_certificate_v6_test: PASS");
    return 0;
}
