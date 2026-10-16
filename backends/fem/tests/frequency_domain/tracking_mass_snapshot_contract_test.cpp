#include "fullmag_fem.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <limits>
#include <string_view>

namespace {

int failures = 0;

void check(bool condition, const char *message)
{
    if (!condition) {
        std::cerr << "FAIL: " << message << '\n';
        ++failures;
    }
}

bool close(double actual, double expected)
{
    const double scale = std::max(std::abs(actual), std::abs(expected));
    return std::isfinite(actual) && std::isfinite(expected) &&
        (scale == 0.0 || std::abs(actual - expected) <= 1.0e-12 * scale);
}

#if FULLMAG_HAS_MFEM_STACK

bool nonzero_digest(const std::uint8_t *bytes)
{
    return std::any_of(
        bytes,
        bytes + FULLMAG_FEM_TRACKING_MASS_SNAPSHOT_DIGEST_BYTES,
        [](std::uint8_t value) { return value != 0u; });
}

void check_source_snapshot_digest(const std::uint8_t *actual)
{
#if defined(FULLMAG_FEM_SOURCE_SNAPSHOT_SHA256)
    constexpr std::string_view expected = FULLMAG_FEM_SOURCE_SNAPSHOT_SHA256;
    check(expected.size() == FULLMAG_FEM_TRACKING_MASS_SNAPSHOT_DIGEST_BYTES * 2u,
        "compiled source snapshot SHA-256 has the expected hexadecimal width");
    std::array<std::uint8_t, FULLMAG_FEM_TRACKING_MASS_SNAPSHOT_DIGEST_BYTES> decoded{};
    const auto nibble = [](char value) -> int {
        if (value >= '0' && value <= '9') return value - '0';
        if (value >= 'a' && value <= 'f') return value - 'a' + 10;
        return -1;
    };
    bool valid = expected.size() == decoded.size() * 2u;
    if (valid) {
        for (std::size_t index = 0; index < decoded.size(); ++index) {
            const int high = nibble(expected[index * 2u]);
            const int low = nibble(expected[index * 2u + 1u]);
            if (high < 0 || low < 0) {
                valid = false;
                break;
            }
            decoded[index] = static_cast<std::uint8_t>((high << 4) | low);
        }
    }
    check(valid && std::equal(decoded.begin(), decoded.end(), actual),
        "native source identity digest matches the CMake-bound snapshot SHA-256");
#else
    check(false, "C ABI contract target receives the bound source snapshot digest");
#endif
}

struct MixedTetMesh {
    std::array<double, 15> nodes{
        0.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, -1.0,
    };
    std::array<std::uint32_t, 2> cell_types{FULLMAG_FEM_CELL_TET4, FULLMAG_FEM_CELL_TET4};
    std::array<std::uint32_t, 3> cell_offsets{0u, 4u, 8u};
    std::array<std::uint32_t, 8> cell_nodes{0u, 1u, 2u, 3u, 0u, 2u, 1u, 4u};
    std::array<std::uint64_t, 2> cell_ordinals{0u, 1u};
    std::array<std::uint32_t, 2> cell_markers{7u, 0u};
    std::array<std::uint32_t, 6> facet_types{
        FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
        FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
    };
    std::array<std::uint32_t, 6> facet_roles{
        FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
        FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
        FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
    };
    std::array<std::uint32_t, 7> facet_offsets{0u, 3u, 6u, 9u, 12u, 15u, 18u};
    std::array<std::uint32_t, 18> facet_nodes{
        1u, 2u, 3u,
        0u, 3u, 2u,
        0u, 1u, 3u,
        2u, 1u, 4u,
        0u, 4u, 1u,
        0u, 2u, 4u,
    };
    std::array<std::uint64_t, 6> facet_ordinals{0u, 1u, 2u, 3u, 4u, 5u};
    std::array<std::uint32_t, 6> facet_markers{1u, 1u, 1u, 1u, 1u, 1u};
    fullmag_fem_mesh_desc descriptor{};

    MixedTetMesh()
    {
        descriptor.abi_version = FULLMAG_FEM_MESH_DESC_ABI_VERSION;
        descriptor.struct_size = sizeof(descriptor);
        descriptor.nodes_xyz = nodes.data();
        descriptor.nodes_xyz_len = nodes.size();
        descriptor.cell_types = cell_types.data();
        descriptor.cell_types_len = cell_types.size();
        descriptor.cell_offsets = cell_offsets.data();
        descriptor.cell_offsets_len = cell_offsets.size();
        descriptor.cell_nodes = cell_nodes.data();
        descriptor.cell_nodes_len = cell_nodes.size();
        descriptor.cell_global_ordinals = cell_ordinals.data();
        descriptor.cell_global_ordinals_len = cell_ordinals.size();
        descriptor.cell_markers = cell_markers.data();
        descriptor.cell_markers_len = cell_markers.size();
        descriptor.facet_types = facet_types.data();
        descriptor.facet_types_len = facet_types.size();
        descriptor.facet_roles = facet_roles.data();
        descriptor.facet_roles_len = facet_roles.size();
        descriptor.facet_offsets = facet_offsets.data();
        descriptor.facet_offsets_len = facet_offsets.size();
        descriptor.facet_nodes = facet_nodes.data();
        descriptor.facet_nodes_len = facet_nodes.size();
        descriptor.facet_global_ordinals = facet_ordinals.data();
        descriptor.facet_global_ordinals_len = facet_ordinals.size();
        descriptor.facet_markers = facet_markers.data();
        descriptor.facet_markers_len = facet_markers.size();
    }
};

struct SinglePrismMesh {
    std::array<double, 18> nodes{
        0.0, 0.0, 0.0,
        1.0e-9, 0.0, 0.0,
        0.0, 1.0e-9, 0.0,
        0.0, 0.0, 1.0e-9,
        1.0e-9, 0.0, 1.0e-9,
        0.0, 1.0e-9, 1.0e-9,
    };
    std::array<std::uint32_t, 1> cell_types{FULLMAG_FEM_CELL_PRISM6};
    std::array<std::uint32_t, 2> cell_offsets{0u, 6u};
    std::array<std::uint32_t, 6> cell_nodes{0u, 1u, 2u, 3u, 4u, 5u};
    std::array<std::uint64_t, 1> cell_ordinals{0u};
    std::array<std::uint32_t, 1> cell_markers{1u};
    std::array<std::uint32_t, 5> facet_types{
        FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
        FULLMAG_FEM_FACET_QUAD4, FULLMAG_FEM_FACET_QUAD4, FULLMAG_FEM_FACET_QUAD4,
    };
    std::array<std::uint32_t, 5> facet_roles{
        FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
        FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
        FULLMAG_FEM_FACET_ROLE_EXTERIOR,
    };
    std::array<std::uint32_t, 6> facet_offsets{0u, 3u, 6u, 10u, 14u, 18u};
    std::array<std::uint32_t, 18> facet_nodes{
        0u, 2u, 1u, 3u, 4u, 5u,
        0u, 1u, 4u, 3u,
        1u, 2u, 5u, 4u,
        2u, 0u, 3u, 5u,
    };
    std::array<std::uint64_t, 5> facet_ordinals{0u, 1u, 2u, 3u, 4u};
    std::array<std::uint32_t, 5> facet_markers{1u, 1u, 1u, 1u, 1u};
    fullmag_fem_mesh_desc descriptor{};

    SinglePrismMesh()
    {
        descriptor.abi_version = FULLMAG_FEM_MESH_DESC_ABI_VERSION;
        descriptor.struct_size = sizeof(descriptor);
        descriptor.nodes_xyz = nodes.data();
        descriptor.nodes_xyz_len = nodes.size();
        descriptor.cell_types = cell_types.data();
        descriptor.cell_types_len = cell_types.size();
        descriptor.cell_offsets = cell_offsets.data();
        descriptor.cell_offsets_len = cell_offsets.size();
        descriptor.cell_nodes = cell_nodes.data();
        descriptor.cell_nodes_len = cell_nodes.size();
        descriptor.cell_global_ordinals = cell_ordinals.data();
        descriptor.cell_global_ordinals_len = cell_ordinals.size();
        descriptor.cell_markers = cell_markers.data();
        descriptor.cell_markers_len = cell_markers.size();
        descriptor.facet_types = facet_types.data();
        descriptor.facet_types_len = facet_types.size();
        descriptor.facet_roles = facet_roles.data();
        descriptor.facet_roles_len = facet_roles.size();
        descriptor.facet_offsets = facet_offsets.data();
        descriptor.facet_offsets_len = facet_offsets.size();
        descriptor.facet_nodes = facet_nodes.data();
        descriptor.facet_nodes_len = facet_nodes.size();
        descriptor.facet_global_ordinals = facet_ordinals.data();
        descriptor.facet_global_ordinals_len = facet_ordinals.size();
        descriptor.facet_markers = facet_markers.data();
        descriptor.facet_markers_len = facet_markers.size();
    }
};

fullmag_fem_tracking_mass_snapshot_request_v1 request_for(
    const fullmag_fem_mesh_desc *mesh,
    const std::uint8_t *mask,
    std::uint64_t mask_count,
    std::uint64_t generation)
{
    fullmag_fem_tracking_mass_snapshot_request_v1 request{};
    request.abi_version = FULLMAG_FEM_TRACKING_MASS_SNAPSHOT_ABI_VERSION;
    request.struct_size = sizeof(request);
    request.mesh = mesh;
    request.magnetic_cell_mask = mask;
    request.magnetic_cell_mask_count = mask_count;
    request.generation = generation;
    return request;
}

void check_mixed_snapshot_and_atomic_copy()
{
    MixedTetMesh fixture;
    const std::array<std::uint8_t, 2> magnetic_mask{1u, 0u};
    const auto request = request_for(&fixture.descriptor, magnetic_mask.data(), magnetic_mask.size(), 42u);
    fullmag_fem_tracking_mass_snapshot_v1 *snapshot = nullptr;
    std::array<char, 512> error{};
    const int create_status = fullmag_fem_tracking_mass_snapshot_create_v1(
        &request, &snapshot, error.data(), error.size());
    check(create_status == FULLMAG_FEM_OK && snapshot != nullptr,
        "typed mixed Tet4 mesh creates one immutable C ABI snapshot");
    if (create_status != FULLMAG_FEM_OK || snapshot == nullptr) {
        std::cerr << "snapshot create diagnostic: " << error.data() << '\n';
        fullmag_fem_tracking_mass_snapshot_destroy_v1(snapshot);
        return;
    }

    fullmag_fem_tracking_mass_snapshot_info_v1 info{};
    info.abi_version = FULLMAG_FEM_TRACKING_MASS_SNAPSHOT_ABI_VERSION;
    info.struct_size = sizeof(info);
    check(fullmag_fem_tracking_mass_snapshot_get_info_v1(
            snapshot, &info, error.data(), error.size()) == FULLMAG_FEM_OK,
        "snapshot metadata is returned through the versioned ABI");
    check(info.generation == 42u && info.canonical_vertex_count == 5u && info.nonzero_count == 16u,
        "metadata binds generation and full physical CSR extents");
    check(close(info.magnetic_volume_m3, 1.0 / 6.0),
        "unweighted selected Tet4 volume is measured in cubic metres");
    check_source_snapshot_digest(info.source_snapshot_sha256);
    check(nonzero_digest(info.topology_sha256) && nonzero_digest(info.marker_map_sha256) &&
            nonzero_digest(info.element_mask_sha256) && nonzero_digest(info.canonical_dof_map_sha256) &&
            nonzero_digest(info.csr_sha256) && nonzero_digest(info.source_snapshot_sha256) &&
            nonzero_digest(info.identity_sha256),
        "snapshot exposes component, source, and overall identity digests");

    std::array<std::uint64_t, 6> row_offsets{};
    std::array<std::uint32_t, 16> columns{};
    std::array<double, 16> values{};
    std::array<std::uint32_t, 5> vertices{};
    std::array<std::uint32_t, 5> dofs{};
    check(fullmag_fem_tracking_mass_snapshot_copy_v1(
            snapshot, info.generation, info.identity_sha256,
            row_offsets.size(), columns.size(), values.size(), vertices.size(), dofs.size(),
            row_offsets.data(), columns.data(), values.data(), vertices.data(), dofs.data(),
            error.data(), error.size()) == FULLMAG_FEM_OK,
        "snapshot copy accepts its exact generation and identity");
    check(row_offsets == std::array<std::uint64_t, 6>{0u, 4u, 8u, 12u, 16u, 16u},
        "CSR retains one empty air-only physical vertex row");
    for (std::uint32_t vertex = 0; vertex < 5u; ++vertex) {
        check(vertices[vertex] == vertex && dofs[vertex] == vertex,
            "copied canonical vertex and scalar DOF maps preserve input order");
    }
    const double volume = 1.0 / 6.0;
    for (std::uint64_t row = 0; row < 4u; ++row) {
        double row_sum = 0.0;
        for (std::uint64_t offset = row_offsets[row]; offset < row_offsets[row + 1u]; ++offset) {
            check(columns[offset] < 4u, "magnetic mass does not couple to air-only vertices");
            const double expected = columns[offset] == row ? volume / 10.0 : volume / 20.0;
            check(close(values[offset], expected),
                "C ABI returns exact consistent Tet4 P1 geometric entries");
            row_sum += values[offset];
        }
        check(close(row_sum, volume / 4.0), "magnetic row sum equals Tet4 volume divided by four");
    }

    row_offsets.fill(UINT64_C(0xaaaaaaaaaaaaaaaa));
    columns.fill(UINT32_C(0xdeadbeef));
    values.fill(-777.0);
    vertices.fill(UINT32_C(0xdeadbeef));
    dofs.fill(UINT32_C(0xdeadbeef));
    const auto offsets_before = row_offsets;
    const auto columns_before = columns;
    const auto values_before = values;
    const auto vertices_before = vertices;
    const auto dofs_before = dofs;
    check(fullmag_fem_tracking_mass_snapshot_copy_v1(
            snapshot, info.generation, info.identity_sha256,
            row_offsets.size() - 1u, columns.size(), values.size(), vertices.size(), dofs.size(),
            row_offsets.data(), columns.data(), values.data(), vertices.data(), dofs.data(),
            error.data(), error.size()) == FULLMAG_FEM_ERR_INVALID,
        "undersized output capacity rejects the copy before any writes");
    check(row_offsets == offsets_before && columns == columns_before && values == values_before &&
            vertices == vertices_before && dofs == dofs_before,
        "failed capacity preflight leaves every caller buffer unchanged");

    std::array<std::uint8_t, FULLMAG_FEM_TRACKING_MASS_SNAPSHOT_DIGEST_BYTES> identity_before{};
    std::copy_n(info.identity_sha256, identity_before.size(), identity_before.begin());
    auto wrong_identity = identity_before;
    wrong_identity[0] ^= 0xffu;
    check(fullmag_fem_tracking_mass_snapshot_copy_v1(
            snapshot, info.generation, wrong_identity.data(),
            row_offsets.size(), columns.size(), values.size(), vertices.size(), dofs.size(),
            row_offsets.data(), columns.data(), values.data(), vertices.data(), dofs.data(),
            error.data(), error.size()) == FULLMAG_FEM_ERR_INVALID,
        "copy rejects a mismatched immutable snapshot identity");
    check(std::equal(identity_before.begin(), identity_before.end(), info.identity_sha256),
        "mismatched identity is an independent caller copy and cannot mutate snapshot metadata");
    check(row_offsets == offsets_before && columns == columns_before && values == values_before &&
            vertices == vertices_before && dofs == dofs_before,
        "failed identity preflight leaves every caller buffer unchanged");
    check(fullmag_fem_tracking_mass_snapshot_copy_v1(
            snapshot, info.generation + 1u, info.identity_sha256,
            row_offsets.size(), columns.size(), values.size(), vertices.size(), dofs.size(),
            row_offsets.data(), columns.data(), values.data(), vertices.data(), dofs.data(),
            error.data(), error.size()) == FULLMAG_FEM_ERR_INVALID,
        "copy rejects a mismatched mesh generation");
    check(row_offsets == offsets_before && columns == columns_before && values == values_before &&
            vertices == vertices_before && dofs == dofs_before,
        "failed generation preflight leaves every caller buffer unchanged");

    fullmag_fem_tracking_mass_snapshot_destroy_v1(snapshot);
}

void check_marker_one_and_air_zero_mapping()
{
    MixedTetMesh fixture;
    fixture.cell_markers = {1u, 0u};
    fixture.descriptor.cell_markers = fixture.cell_markers.data();
    const std::array<std::uint8_t, 2> magnetic_mask{1u, 0u};
    const auto request = request_for(&fixture.descriptor, magnetic_mask.data(), magnetic_mask.size(), 43u);
    fullmag_fem_tracking_mass_snapshot_v1 *snapshot = nullptr;
    std::array<char, 512> error{};
    const int status = fullmag_fem_tracking_mass_snapshot_create_v1(
        &request, &snapshot, error.data(), error.size());
    check(status == FULLMAG_FEM_OK && snapshot != nullptr,
        "marker one plus air zero survives the actual MFEM attribute remap");
    if (status == FULLMAG_FEM_OK && snapshot != nullptr) {
        fullmag_fem_tracking_mass_snapshot_info_v1 info{};
        info.abi_version = FULLMAG_FEM_TRACKING_MASS_SNAPSHOT_ABI_VERSION;
        info.struct_size = sizeof(info);
        check(fullmag_fem_tracking_mass_snapshot_get_info_v1(
                snapshot, &info, error.data(), error.size()) == FULLMAG_FEM_OK,
            "marker-one remap snapshot metadata remains queryable");
        check(close(info.magnetic_volume_m3, 1.0 / 6.0),
            "marker-one remap selects only the intended magnetic Tet4 volume");
    } else {
        std::cerr << "marker-one remap diagnostic: " << error.data() << '\n';
    }
    fullmag_fem_tracking_mass_snapshot_destroy_v1(snapshot);
}

void check_prism6_roundtrip_at_nanoscale()
{
    SinglePrismMesh fixture;
    const std::array<std::uint8_t, 1> magnetic_mask{1u};
    const auto request = request_for(&fixture.descriptor, magnetic_mask.data(), magnetic_mask.size(), 44u);
    fullmag_fem_tracking_mass_snapshot_v1 *snapshot = nullptr;
    std::array<char, 512> error{};
    const int status = fullmag_fem_tracking_mass_snapshot_create_v1(
        &request, &snapshot, error.data(), error.size());
    check(status == FULLMAG_FEM_OK && snapshot != nullptr,
        "typed Prism6 mesh creates a C ABI snapshot at nanometre scale");
    if (status != FULLMAG_FEM_OK || snapshot == nullptr) {
        std::cerr << "Prism6 snapshot diagnostic: " << error.data() << '\n';
        fullmag_fem_tracking_mass_snapshot_destroy_v1(snapshot);
        return;
    }

    fullmag_fem_tracking_mass_snapshot_info_v1 info{};
    info.abi_version = FULLMAG_FEM_TRACKING_MASS_SNAPSHOT_ABI_VERSION;
    info.struct_size = sizeof(info);
    check(fullmag_fem_tracking_mass_snapshot_get_info_v1(
            snapshot, &info, error.data(), error.size()) == FULLMAG_FEM_OK,
        "Prism6 snapshot metadata is returned through the versioned ABI");
    constexpr double volume = 5.0e-28;
    check(info.generation == 44u && info.canonical_vertex_count == 6u && info.nonzero_count == 36u,
        "Prism6 metadata binds all six canonical physical vertices and the full CSR");
    check(close(info.magnetic_volume_m3, volume),
        "Prism6 geometric volume remains SI-scaled at nanometre dimensions");
    check_source_snapshot_digest(info.source_snapshot_sha256);

    std::array<std::uint64_t, 7> row_offsets{};
    std::array<std::uint32_t, 36> columns{};
    std::array<double, 36> values{};
    std::array<std::uint32_t, 6> vertices{};
    std::array<std::uint32_t, 6> dofs{};
    check(fullmag_fem_tracking_mass_snapshot_copy_v1(
            snapshot, info.generation, info.identity_sha256,
            row_offsets.size(), columns.size(), values.size(), vertices.size(), dofs.size(),
            row_offsets.data(), columns.data(), values.data(), vertices.data(), dofs.data(),
            error.data(), error.size()) == FULLMAG_FEM_OK,
        "Prism6 snapshot round-trips through the bounded C ABI copy");
    check(row_offsets == std::array<std::uint64_t, 7>{0u, 6u, 12u, 18u, 24u, 30u, 36u},
        "Prism6 CSR retains six canonical physical rows");
    for (std::uint32_t row = 0; row < 6u; ++row) {
        check(vertices[row] == row && dofs[row] == row,
            "Prism6 C ABI preserves canonical vertex and scalar DOF ordering");
        double row_sum = 0.0;
        for (std::uint64_t offset = row_offsets[row]; offset < row_offsets[row + 1u]; ++offset) {
            const std::uint32_t column = columns[offset];
            const bool same_triangle_vertex = row % 3u == column % 3u;
            const bool same_axial_level = (row < 3u) == (column < 3u);
            const double expected = same_triangle_vertex
                ? (same_axial_level ? volume / 18.0 : volume / 36.0)
                : (same_axial_level ? volume / 36.0 : volume / 72.0);
            check(close(values[offset], expected),
                "C ABI returns exact consistent Prism6 P1 geometric entries");
            row_sum += values[offset];
        }
        check(close(row_sum, volume / 6.0),
            "Prism6 geometric row sum equals the SI volume divided by six");
    }
    fullmag_fem_tracking_mass_snapshot_destroy_v1(snapshot);
}

void check_invalid_mask_requests_fail_closed()
{
    MixedTetMesh fixture;
    std::array<char, 512> error{};
    fullmag_fem_tracking_mass_snapshot_v1 *snapshot = nullptr;
    const std::array<std::uint8_t, 2> empty_mask{0u, 0u};
    auto request = request_for(&fixture.descriptor, empty_mask.data(), empty_mask.size(), 1u);
    check(fullmag_fem_tracking_mass_snapshot_create_v1(
            &request, &snapshot, error.data(), error.size()) == FULLMAG_FEM_ERR_INVALID && snapshot == nullptr,
        "empty magnetic selection is rejected without a handle");

    fixture.cell_markers = {7u, 7u};
    fixture.descriptor.cell_markers = fixture.cell_markers.data();
    const std::array<std::uint8_t, 2> split_attribute_mask{1u, 0u};
    request = request_for(&fixture.descriptor, split_attribute_mask.data(), split_attribute_mask.size(), 2u);
    check(fullmag_fem_tracking_mass_snapshot_create_v1(
            &request, &snapshot, error.data(), error.size()) == FULLMAG_FEM_ERR_INVALID && snapshot == nullptr,
        "magnetic mask cannot split one shared MFEM attribute class");

    const std::array<std::uint8_t, 2> invalid_bit_mask{1u, 2u};
    request = request_for(&fixture.descriptor, invalid_bit_mask.data(), invalid_bit_mask.size(), 3u);
    check(fullmag_fem_tracking_mass_snapshot_create_v1(
            &request, &snapshot, error.data(), error.size()) == FULLMAG_FEM_ERR_INVALID && snapshot == nullptr,
        "mask values outside zero/one are rejected");
}

#else

void check_stub_reports_unavailable_without_handles()
{
    fullmag_fem_mesh_desc descriptor{};
    descriptor.abi_version = FULLMAG_FEM_MESH_DESC_ABI_VERSION;
    descriptor.struct_size = sizeof(descriptor);
    const std::array<std::uint8_t, 1> magnetic_mask{1u};
    fullmag_fem_tracking_mass_snapshot_request_v1 request{};
    request.abi_version = FULLMAG_FEM_TRACKING_MASS_SNAPSHOT_ABI_VERSION;
    request.struct_size = sizeof(request);
    request.mesh = &descriptor;
    request.magnetic_cell_mask = magnetic_mask.data();
    request.magnetic_cell_mask_count = magnetic_mask.size();
    request.generation = 1u;

    auto *snapshot = reinterpret_cast<fullmag_fem_tracking_mass_snapshot_v1 *>(
        static_cast<std::uintptr_t>(1u));
    std::array<char, 512> error{};
    check(fullmag_fem_tracking_mass_snapshot_create_v1(
            &request, &snapshot, error.data(), error.size()) == FULLMAG_FEM_ERR_UNAVAILABLE,
        "no-stack build reports tracking-mass support as unavailable");
    check(snapshot == nullptr,
        "no-stack create clears the caller handle and never fabricates a snapshot");
    check(std::strstr(error.data(), "without the MFEM stack") != nullptr,
        "no-stack create explains the unavailable backend explicitly");

    fullmag_fem_tracking_mass_snapshot_info_v1 info{};
    info.abi_version = FULLMAG_FEM_TRACKING_MASS_SNAPSHOT_ABI_VERSION;
    info.struct_size = sizeof(info);
    info.generation = 99u;
    check(fullmag_fem_tracking_mass_snapshot_get_info_v1(
            nullptr, &info, error.data(), error.size()) == FULLMAG_FEM_ERR_INVALID,
        "no-stack query symbol rejects a null handle without dereferencing it");
    check(info.generation == 99u,
        "no-stack query leaves caller metadata untouched on an invalid handle");
    std::array<std::uint8_t, FULLMAG_FEM_TRACKING_MASS_SNAPSHOT_DIGEST_BYTES> identity{};
    std::array<std::uint64_t, 1> row_offsets{UINT64_C(0xaaaaaaaaaaaaaaaa)};
    check(fullmag_fem_tracking_mass_snapshot_copy_v1(
            nullptr, 1u, identity.data(), 0u, 0u, 0u, 0u, 0u,
            row_offsets.data(), nullptr, nullptr, nullptr, nullptr,
            error.data(), error.size()) == FULLMAG_FEM_ERR_INVALID,
        "no-stack copy symbol rejects a null handle without writing outputs");
    check(row_offsets[0] == UINT64_C(0xaaaaaaaaaaaaaaaa),
        "no-stack copy preserves caller storage when no snapshot exists");
    fullmag_fem_tracking_mass_snapshot_destroy_v1(nullptr);
}

} // namespace

int main()
{
#if FULLMAG_HAS_MFEM_STACK
    check_mixed_snapshot_and_atomic_copy();
    check_marker_one_and_air_zero_mapping();
    check_prism6_roundtrip_at_nanoscale();
    check_invalid_mask_requests_fail_closed();
#else
    check_stub_reports_unavailable_without_handles();
#endif
    if (failures != 0) {
        std::cerr << "Tracking mass snapshot C ABI contract failed with " << failures
                  << " assertion(s)\n";
        return 1;
    }
#if FULLMAG_HAS_MFEM_STACK
    std::cout << "PASS: fem_tracking_mass_snapshot_cabi_contract\n";
#else
    std::cout << "PASS: fem_tracking_mass_snapshot_stub_contract\n";
#endif
    return 0;
}
