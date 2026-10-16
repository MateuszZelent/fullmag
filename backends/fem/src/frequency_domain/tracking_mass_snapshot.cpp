#include "core/fem_mesh.hpp"
#include "cpu/frequency_domain/modal/tracking_mass_provider.hpp"
#include "cpu/mfem/runtime/mfem_mesh_builder.hpp"
#include "frequency_domain/canonical_digest.hpp"
#include "fullmag_fem.h"

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <exception>
#include <limits>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

void fullmag_fem_set_global_error(const std::string &message);
void fullmag_fem_clear_global_error();

namespace {

using Digest = std::array<std::uint8_t, FULLMAG_FEM_TRACKING_MASS_SNAPSHOT_DIGEST_BYTES>;
using fullmag::fem::frequency_domain::CanonicalDigestBuilder;
using fullmag::fem::frequency_domain::TrackingMassCsrSnapshot;
using fullmag::fem::frequency_domain::TrackingMassProviderResult;

static_assert(sizeof(fullmag_fem_tracking_mass_snapshot_request_v1) == 40u,
    "tracking mass snapshot request ABI layout changed");
static_assert(alignof(fullmag_fem_tracking_mass_snapshot_request_v1) == 8u,
    "tracking mass snapshot request ABI alignment changed");
static_assert(sizeof(fullmag_fem_tracking_mass_snapshot_info_v1) == 264u,
    "tracking mass snapshot info ABI layout changed");
static_assert(alignof(fullmag_fem_tracking_mass_snapshot_info_v1) == 8u,
    "tracking mass snapshot info ABI alignment changed");
static_assert(sizeof(std::size_t) <= sizeof(std::uint64_t),
    "tracking mass snapshot requires size_t no wider than its uint64 ABI");

int publish_error(const std::string &message, int status, char *buffer, std::uint64_t capacity)
{
    fullmag_fem_set_global_error(message);
    if (buffer != nullptr && capacity > 0u) {
        const std::size_t writable = static_cast<std::size_t>(capacity - 1u);
        const std::size_t count = std::min(message.size(), writable);
        std::memcpy(buffer, message.data(), count);
        buffer[count] = '\0';
    }
    return status;
}

int invalid_error_buffer(char *buffer, std::uint64_t capacity)
{
    if (buffer == nullptr && capacity != 0u) {
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (buffer != nullptr && capacity > 0u) {
        buffer[0] = '\0';
    }
    return FULLMAG_FEM_OK;
}

void append_u32_be(std::vector<std::uint8_t> &output, std::uint32_t value)
{
    for (int shift = 24; shift >= 0; shift -= 8) {
        output.push_back(static_cast<std::uint8_t>(value >> shift));
    }
}

void append_u64_be(std::vector<std::uint8_t> &output, std::uint64_t value)
{
    for (int shift = 56; shift >= 0; shift -= 8) {
        output.push_back(static_cast<std::uint8_t>(value >> shift));
    }
}

void append_double_be(std::vector<std::uint8_t> &output, double value)
{
    std::uint64_t bits = 0u;
    if (value != 0.0) {
        std::memcpy(&bits, &value, sizeof(bits));
    }
    append_u64_be(output, bits);
}

template <typename T>
bool checked_packed_size(std::size_t count, std::size_t width, std::size_t &size)
{
    (void)sizeof(T);
    if (width != 0u && count > std::numeric_limits<std::size_t>::max() / width) {
        return false;
    }
    size = count * width;
    return true;
}

bool pack_u32(const std::vector<std::uint32_t> &values, std::vector<std::uint8_t> &output)
{
    std::size_t size = 0u;
    if (!checked_packed_size<std::uint32_t>(values.size(), sizeof(std::uint32_t), size)) {
        return false;
    }
    output.clear();
    output.reserve(size);
    for (std::uint32_t value : values) {
        append_u32_be(output, value);
    }
    return true;
}

bool pack_u64(const std::vector<std::uint64_t> &values, std::vector<std::uint8_t> &output)
{
    std::size_t size = 0u;
    if (!checked_packed_size<std::uint64_t>(values.size(), sizeof(std::uint64_t), size)) {
        return false;
    }
    output.clear();
    output.reserve(size);
    for (std::uint64_t value : values) {
        append_u64_be(output, value);
    }
    return true;
}

bool pack_doubles(const std::vector<double> &values, std::vector<std::uint8_t> &output)
{
    std::size_t size = 0u;
    if (!checked_packed_size<double>(values.size(), sizeof(double), size)) {
        return false;
    }
    output.clear();
    output.reserve(size);
    for (double value : values) {
        if (!std::isfinite(value)) {
            return false;
        }
        append_double_be(output, value);
    }
    return true;
}

bool digest_bytes(std::string_view schema, const std::vector<std::uint8_t> &bytes, Digest &output)
{
    CanonicalDigestBuilder digest(schema);
    digest.add_bytes("payload_be", bytes.data(), static_cast<std::uint64_t>(bytes.size()));
    const std::string hex = digest.sha256_hex();
    if (hex.size() != 64u) {
        return false;
    }
    const auto nibble = [](char value) -> int {
        if (value >= '0' && value <= '9') {
            return value - '0';
        }
        if (value >= 'a' && value <= 'f') {
            return value - 'a' + 10;
        }
        return -1;
    };
    for (std::size_t index = 0; index < output.size(); ++index) {
        const int high = nibble(hex[index * 2u]);
        const int low = nibble(hex[index * 2u + 1u]);
        if (high < 0 || low < 0) {
            return false;
        }
        output[index] = static_cast<std::uint8_t>((high << 4) | low);
    }
    return true;
}

bool source_snapshot_digest(Digest &output)
{
#if defined(FULLMAG_FEM_SOURCE_SNAPSHOT_SHA256)
    constexpr std::string_view hex = FULLMAG_FEM_SOURCE_SNAPSHOT_SHA256;
    if (hex.size() != 64u) {
        return false;
    }
    const auto nibble = [](char value) -> int {
        if (value >= '0' && value <= '9') {
            return value - '0';
        }
        if (value >= 'a' && value <= 'f') {
            return value - 'a' + 10;
        }
        return -1;
    };
    for (std::size_t index = 0; index < output.size(); ++index) {
        const int high = nibble(hex[index * 2u]);
        const int low = nibble(hex[index * 2u + 1u]);
        if (high < 0 || low < 0) {
            return false;
        }
        output[index] = static_cast<std::uint8_t>((high << 4) | low);
    }
    return true;
#else
    (void)output;
    return false;
#endif
}

bool component_digest(
    const fullmag::fem::FemMeshRuntimeState &mesh,
    const std::vector<std::uint8_t> &mask,
    const std::vector<int> &mfem_attributes,
    const TrackingMassCsrSnapshot &snapshot,
    const Digest &source_sha,
    std::uint64_t generation,
    fullmag_fem_tracking_mass_snapshot_info_v1 &info)
{
    std::vector<std::uint8_t> packed;
    CanonicalDigestBuilder topology("mfem_tracking_mass.topology.v1");
    topology.add_u64("node_count", mesh.n_nodes);
    topology.add_u64("cell_count", mesh.n_elements);
    topology.add_u64("facet_count", mesh.n_boundary_faces);
    if (!pack_doubles(mesh.nodes_xyz, packed)) {
        return false;
    }
    topology.add_bytes("nodes_xyz_be", packed.data(), packed.size());
    if (!pack_u32(mesh.cell_types, packed)) {
        return false;
    }
    topology.add_bytes("cell_types_be", packed.data(), packed.size());
    if (!pack_u32(mesh.cell_offsets, packed)) {
        return false;
    }
    topology.add_bytes("cell_offsets_be", packed.data(), packed.size());
    if (!pack_u32(mesh.cell_nodes, packed)) {
        return false;
    }
    topology.add_bytes("cell_nodes_be", packed.data(), packed.size());
    if (!pack_u64(mesh.cell_global_ordinals, packed)) {
        return false;
    }
    topology.add_bytes("cell_global_ordinals_be", packed.data(), packed.size());
    if (!pack_u32(mesh.facet_types, packed)) {
        return false;
    }
    topology.add_bytes("facet_types_be", packed.data(), packed.size());
    if (!pack_u32(mesh.facet_roles, packed)) {
        return false;
    }
    topology.add_bytes("facet_roles_be", packed.data(), packed.size());
    if (!pack_u32(mesh.facet_offsets, packed)) {
        return false;
    }
    topology.add_bytes("facet_offsets_be", packed.data(), packed.size());
    if (!pack_u32(mesh.facet_nodes, packed)) {
        return false;
    }
    topology.add_bytes("facet_nodes_be", packed.data(), packed.size());
    if (!pack_u64(mesh.facet_global_ordinals, packed)) {
        return false;
    }
    topology.add_bytes("facet_global_ordinals_be", packed.data(), packed.size());
    if (!pack_u32(mesh.periodic_node_pairs, packed)) {
        return false;
    }
    topology.add_bytes("periodic_node_pairs_be", packed.data(), packed.size());
    const std::string topology_hex = topology.sha256_hex();
    const auto hex_to_bytes = [](const std::string &hex, std::uint8_t *destination) {
        if (hex.size() != 64u || destination == nullptr) {
            return false;
        }
        const auto nibble = [](char value) -> int {
            if (value >= '0' && value <= '9') return value - '0';
            if (value >= 'a' && value <= 'f') return value - 'a' + 10;
            return -1;
        };
        for (std::size_t index = 0; index < 32u; ++index) {
            const int high = nibble(hex[index * 2u]);
            const int low = nibble(hex[index * 2u + 1u]);
            if (high < 0 || low < 0) return false;
            destination[index] = static_cast<std::uint8_t>((high << 4) | low);
        }
        return true;
    };
    if (!hex_to_bytes(topology_hex, info.topology_sha256)) {
        return false;
    }

    CanonicalDigestBuilder marker_map("mfem_tracking_mass.marker_map.v1");
    marker_map.add_u64("cell_count", mesh.n_elements);
    marker_map.add_u64("facet_count", mesh.n_boundary_faces);
    const std::vector<std::uint32_t> raw_cell_markers = mesh.cell_markers;
    if (!pack_u32(raw_cell_markers, packed)) {
        return false;
    }
    marker_map.add_bytes("cell_markers_be", packed.data(), packed.size());
    std::vector<std::uint32_t> mapped_attributes;
    mapped_attributes.reserve(mfem_attributes.size());
    for (int attribute : mfem_attributes) {
        if (attribute <= 0) return false;
        mapped_attributes.push_back(static_cast<std::uint32_t>(attribute));
    }
    if (!pack_u32(mapped_attributes, packed)) {
        return false;
    }
    marker_map.add_bytes("mfem_volume_attributes_be", packed.data(), packed.size());
    if (!pack_u32(mesh.facet_markers, packed)) {
        return false;
    }
    marker_map.add_bytes("facet_markers_be", packed.data(), packed.size());
    if (!pack_u32(mesh.periodic_boundary_pair_markers, packed)) {
        return false;
    }
    marker_map.add_bytes("periodic_boundary_pair_markers_be", packed.data(), packed.size());
    if (!hex_to_bytes(marker_map.sha256_hex(), info.marker_map_sha256)) {
        return false;
    }

    CanonicalDigestBuilder element_mask("mfem_tracking_mass.element_mask.v1");
    element_mask.add_u64("cell_count", mesh.n_elements);
    if (!pack_u64(mesh.cell_global_ordinals, packed)) {
        return false;
    }
    element_mask.add_bytes("cell_global_ordinals_be", packed.data(), packed.size());
    element_mask.add_bytes("magnetic_cell_mask", mask.data(), mask.size());
    if (!hex_to_bytes(element_mask.sha256_hex(), info.element_mask_sha256)) {
        return false;
    }

    CanonicalDigestBuilder canonical_map("mfem_tracking_mass.canonical_dof_map.v1");
    canonical_map.add_u64("vertex_count", snapshot.rows());
    std::vector<std::uint8_t> vertex_map;
    std::vector<std::uint8_t> dof_map;
    vertex_map.reserve(snapshot.canonical_vertex_ids().size() * sizeof(std::uint32_t));
    dof_map.reserve(snapshot.scalar_dof_ids().size() * sizeof(std::uint32_t));
    for (std::uint32_t vertex : snapshot.canonical_vertex_ids()) {
        append_u32_be(vertex_map, vertex);
    }
    for (std::uint32_t dof : snapshot.scalar_dof_ids()) {
        append_u32_be(dof_map, dof);
    }
    canonical_map.add_bytes("canonical_vertex_ids_be", vertex_map.data(), vertex_map.size());
    canonical_map.add_bytes("scalar_dof_ids_be", dof_map.data(), dof_map.size());
    if (!hex_to_bytes(canonical_map.sha256_hex(), info.canonical_dof_map_sha256)) {
        return false;
    }

    std::size_t csr_bytes = 0u;
    std::size_t offsets_bytes = 0u;
    std::size_t columns_bytes = 0u;
    std::size_t values_bytes = 0u;
    if (!checked_packed_size<std::uint64_t>(snapshot.row_offsets().size(), 8u, offsets_bytes) ||
        !checked_packed_size<std::uint32_t>(snapshot.column_indices().size(), 4u, columns_bytes) ||
        !checked_packed_size<double>(snapshot.values_m3().size(), 8u, values_bytes) ||
        offsets_bytes > std::numeric_limits<std::size_t>::max() - columns_bytes ||
        offsets_bytes + columns_bytes > std::numeric_limits<std::size_t>::max() - values_bytes) {
        return false;
    }
    csr_bytes = offsets_bytes + columns_bytes + values_bytes;
    std::vector<std::uint8_t> csr_payload;
    csr_payload.reserve(csr_bytes);
    for (std::size_t offset : snapshot.row_offsets()) {
        append_u64_be(csr_payload, static_cast<std::uint64_t>(offset));
    }
    for (std::uint32_t column : snapshot.column_indices()) {
        append_u32_be(csr_payload, column);
    }
    for (double value : snapshot.values_m3()) {
        if (!std::isfinite(value)) return false;
        append_double_be(csr_payload, value);
    }
    Digest csr_digest{};
    if (!digest_bytes("mfem_tracking_mass.csr.v1", csr_payload, csr_digest)) {
        return false;
    }
    std::memcpy(info.csr_sha256, csr_digest.data(), csr_digest.size());

    std::memcpy(info.source_snapshot_sha256, source_sha.data(), source_sha.size());
    CanonicalDigestBuilder identity("mfem_tracking_mass.snapshot_identity.v1");
    identity.add_u64("generation", generation);
    identity.add_u64("canonical_vertex_count", snapshot.rows());
    identity.add_u64("nonzero_count", snapshot.values_m3().size());
    identity.add_double("magnetic_volume_m3", snapshot.magnetic_volume_m3());
    identity.add_bytes("topology_sha256", info.topology_sha256, sizeof(info.topology_sha256));
    identity.add_bytes("marker_map_sha256", info.marker_map_sha256, sizeof(info.marker_map_sha256));
    identity.add_bytes("element_mask_sha256", info.element_mask_sha256, sizeof(info.element_mask_sha256));
    identity.add_bytes("canonical_dof_map_sha256", info.canonical_dof_map_sha256,
        sizeof(info.canonical_dof_map_sha256));
    identity.add_bytes("csr_sha256", info.csr_sha256, sizeof(info.csr_sha256));
    identity.add_bytes("source_snapshot_sha256", info.source_snapshot_sha256,
        sizeof(info.source_snapshot_sha256));
    if (!hex_to_bytes(identity.sha256_hex(), info.identity_sha256)) {
        return false;
    }
    return true;
}

bool build_marker_map(
    const fullmag::fem::FemMeshRuntimeState &source,
    const std::vector<std::uint8_t> &mask,
    std::vector<int> &attributes,
    std::vector<int> &selected_attributes,
    std::string &error)
{
    if (mask.size() != source.n_elements ||
        (!source.cell_markers.empty() && source.cell_markers.size() != source.n_elements)) {
        error = "tracking mass mask or cell-marker count does not match the typed mesh";
        return false;
    }
    std::uint32_t maximum_marker = 0u;
    bool has_air = source.cell_markers.empty();
    for (std::uint32_t marker : source.cell_markers) {
        if (marker > static_cast<std::uint32_t>(std::numeric_limits<int>::max())) {
            error = "tracking mass cell marker exceeds the positive MFEM attribute range";
            return false;
        }
        maximum_marker = std::max(maximum_marker, marker);
        has_air = has_air || marker == 0u;
    }
    int air_attribute = 1;
    if (has_air) {
        if (maximum_marker >= static_cast<std::uint32_t>(std::numeric_limits<int>::max())) {
            error = "tracking mass cannot allocate the MFEM air attribute";
            return false;
        }
        air_attribute = static_cast<int>(maximum_marker + 1u);
    }
    attributes.clear();
    attributes.reserve(source.n_elements);
    std::set<int> selected;
    std::map<int, std::uint8_t> attribute_selection;
    bool any_selected = false;
    for (std::size_t cell = 0; cell < source.n_elements; ++cell) {
        if (mask[cell] > 1u) {
            error = "tracking mass element mask values must be zero or one";
            return false;
        }
        const std::uint32_t marker = source.cell_markers.empty() ? 1u : source.cell_markers[cell];
        if (marker == 0u && mask[cell] != 0u) {
            error = "tracking mass magnetic mask selects a cell classified as air by marker zero";
            return false;
        }
        const int attribute = marker == 0u ? air_attribute : static_cast<int>(marker);
        attributes.push_back(attribute);
        const auto inserted = attribute_selection.emplace(attribute, mask[cell]);
        if (!inserted.second && inserted.first->second != mask[cell]) {
            error = "tracking mass mask splits cells that share one MFEM volume attribute";
            return false;
        }
        if (mask[cell] == 1u) {
            selected.insert(attribute);
            any_selected = true;
        }
    }
    if (!any_selected) {
        error = "tracking mass requires at least one selected magnetic cell";
        return false;
    }
    selected_attributes.assign(selected.begin(), selected.end());
    return true;
}

bool checked_nnz_bound(
    const fullmag::fem::FemMeshRuntimeState &source,
    const std::vector<std::uint8_t> &mask,
    std::uint64_t &bound,
    std::string &error)
{
    bound = 0u;
    for (std::size_t cell = 0; cell < mask.size(); ++cell) {
        if (mask[cell] == 0u) continue;
        if (cell >= source.cell_types.size()) {
            error = "tracking mass typed cell array is incomplete";
            return false;
        }
        std::uint64_t contribution = 0u;
        if (source.cell_types[cell] == FULLMAG_FEM_CELL_TET4) {
            contribution = 16u;
        } else if (source.cell_types[cell] == FULLMAG_FEM_CELL_PRISM6) {
            contribution = 36u;
        } else {
            error = "tracking mass selected cells must be Tet4 or Prism6";
            return false;
        }
        if (bound > std::numeric_limits<std::uint64_t>::max() - contribution) {
            error = "tracking mass topological nonzero bound overflows uint64";
            return false;
        }
        bound += contribution;
    }
    const std::uint64_t max_size = static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max());
    if (bound > max_size || source.n_nodes == std::numeric_limits<std::uint32_t>::max()) {
        error = "tracking mass snapshot exceeds addressable CSR index storage";
        return false;
    }
    return true;
}

} // namespace

struct fullmag_fem_tracking_mass_snapshot_v1 {
    std::unique_ptr<const TrackingMassCsrSnapshot> snapshot;
    fullmag_fem_tracking_mass_snapshot_info_v1 info{};
};

int fullmag_fem_tracking_mass_snapshot_create_v1(
    const fullmag_fem_tracking_mass_snapshot_request_v1 *request,
    fullmag_fem_tracking_mass_snapshot_v1 **out_snapshot,
    char *error_message,
    std::uint64_t error_message_capacity)
{
    if (out_snapshot != nullptr) {
        *out_snapshot = nullptr;
    }
    if (invalid_error_buffer(error_message, error_message_capacity) != FULLMAG_FEM_OK) {
        return publish_error(
            "tracking mass snapshot error buffer is null with nonzero capacity",
            FULLMAG_FEM_ERR_INVALID,
            error_message,
            error_message_capacity);
    }
    fullmag_fem_clear_global_error();
    if (request == nullptr || out_snapshot == nullptr || request->mesh == nullptr) {
        return publish_error(
            "tracking mass snapshot create requires a request, mesh, and output handle",
            FULLMAG_FEM_ERR_INVALID,
            error_message,
            error_message_capacity);
    }
    if (request->abi_version != FULLMAG_FEM_TRACKING_MASS_SNAPSHOT_ABI_VERSION ||
        request->struct_size != sizeof(fullmag_fem_tracking_mass_snapshot_request_v1) ||
        request->generation == 0u) {
        return publish_error(
            "tracking mass snapshot request ABI or generation is invalid",
            FULLMAG_FEM_ERR_INVALID,
            error_message,
            error_message_capacity);
    }
#if !FULLMAG_HAS_MFEM_STACK
    return publish_error(
        "tracking mass snapshot is unavailable without the MFEM stack",
        FULLMAG_FEM_ERR_UNAVAILABLE,
        error_message,
        error_message_capacity);
#else
    try {
        if (request->magnetic_cell_mask == nullptr || request->magnetic_cell_mask_count == 0u) {
            return publish_error(
                "tracking mass snapshot requires a nonempty magnetic cell mask",
                FULLMAG_FEM_ERR_INVALID,
                error_message,
                error_message_capacity);
        }
        fullmag::fem::FemMeshRuntimeState source;
        std::string diagnostic;
        if (!fullmag::fem::import_mesh_descriptor(*request->mesh, source, diagnostic)) {
            return publish_error(diagnostic, FULLMAG_FEM_ERR_INVALID, error_message, error_message_capacity);
        }
        if (request->magnetic_cell_mask_count != source.n_elements ||
            request->magnetic_cell_mask_count > std::numeric_limits<std::size_t>::max()) {
            return publish_error(
                "tracking mass mask length does not match the typed cell count",
                FULLMAG_FEM_ERR_INVALID,
                error_message,
                error_message_capacity);
        }
        std::vector<std::uint8_t> mask(
            request->magnetic_cell_mask,
            request->magnetic_cell_mask + static_cast<std::size_t>(request->magnetic_cell_mask_count));
        std::vector<int> mfem_attributes;
        std::vector<int> selected_attributes;
        if (!build_marker_map(source, mask, mfem_attributes, selected_attributes, diagnostic)) {
            return publish_error(diagnostic, FULLMAG_FEM_ERR_INVALID, error_message, error_message_capacity);
        }
        std::uint64_t nnz_bound = 0u;
        if (!checked_nnz_bound(source, mask, nnz_bound, diagnostic)) {
            return publish_error(diagnostic, FULLMAG_FEM_ERR_INVALID, error_message, error_message_capacity);
        }
        std::uint64_t digest_bound = 0u;
        if (nnz_bound > (std::numeric_limits<std::uint64_t>::max() -
                (static_cast<std::uint64_t>(source.n_nodes) + 1u) * 8u) / 20u) {
            return publish_error(
                "tracking mass digest payload bound overflows uint64",
                FULLMAG_FEM_ERR_INVALID,
                error_message,
                error_message_capacity);
        }
        digest_bound = nnz_bound * 20u + (static_cast<std::uint64_t>(source.n_nodes) + 1u) * 8u;
        if (digest_bound > static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max())) {
            return publish_error(
                "tracking mass digest payload exceeds addressable memory",
                FULLMAG_FEM_ERR_INVALID,
                error_message,
                error_message_capacity);
        }
        std::unique_ptr<mfem::Mesh> mesh;
        if (!fullmag::fem::build_mfem_mesh(source, mesh, diagnostic) || mesh == nullptr) {
            return publish_error(diagnostic, FULLMAG_FEM_ERR_INVALID, error_message, error_message_capacity);
        }
        if (mesh->GetNE() < 0 ||
            static_cast<std::size_t>(mesh->GetNE()) != mfem_attributes.size()) {
            return publish_error(
                "MFEM mesh element count differs from the canonical tracking-mass marker map",
                FULLMAG_FEM_ERR_INVALID,
                error_message,
                error_message_capacity);
        }
        for (int element = 0; element < mesh->GetNE(); ++element) {
            if (mesh->GetAttribute(element) != mfem_attributes[static_cast<std::size_t>(element)]) {
                return publish_error(
                    "MFEM mesh volume attributes differ from the canonical tracking-mass marker map",
                    FULLMAG_FEM_ERR_INVALID,
                    error_message,
                    error_message_capacity);
            }
        }
        mfem::H1_FECollection collection(1, 3);
        mfem::FiniteElementSpace space(mesh.get(), &collection);
        TrackingMassProviderResult assembled =
            fullmag::fem::frequency_domain::assemble_consistent_p1_tracking_mass(
                space, selected_attributes);
        if (!assembled.ok()) {
            return publish_error(
                assembled.diagnostic.empty() ? "tracking mass assembly failed" : assembled.diagnostic,
                FULLMAG_FEM_ERR_INVALID,
                error_message,
                error_message_capacity);
        }
        const auto &snapshot = *assembled.snapshot;
        if (snapshot.rows() != source.n_nodes || snapshot.values_m3().size() > nnz_bound ||
            snapshot.row_offsets().size() != snapshot.rows() + 1u ||
            !std::isfinite(snapshot.magnetic_volume_m3()) || !(snapshot.magnetic_volume_m3() > 0.0)) {
            return publish_error(
                "tracking mass provider output violates its preflighted CSR bounds",
                FULLMAG_FEM_ERR_INTERNAL,
                error_message,
                error_message_capacity);
        }
        Digest source_sha{};
        if (!source_snapshot_digest(source_sha)) {
            return publish_error(
                "native FEM source snapshot SHA-256 is unavailable or malformed",
                FULLMAG_FEM_ERR_UNAVAILABLE,
                error_message,
                error_message_capacity);
        }
        auto candidate = std::make_unique<fullmag_fem_tracking_mass_snapshot_v1>();
        candidate->snapshot = std::move(assembled.snapshot);
        candidate->info.abi_version = FULLMAG_FEM_TRACKING_MASS_SNAPSHOT_ABI_VERSION;
        candidate->info.struct_size = sizeof(candidate->info);
        candidate->info.generation = request->generation;
        candidate->info.canonical_vertex_count = candidate->snapshot->rows();
        candidate->info.nonzero_count = candidate->snapshot->values_m3().size();
        candidate->info.magnetic_volume_m3 = candidate->snapshot->magnetic_volume_m3();
        if (!component_digest(source, mask, mfem_attributes, *candidate->snapshot, source_sha,
                request->generation, candidate->info)) {
            return publish_error(
                "tracking mass canonical digest construction failed",
                FULLMAG_FEM_ERR_INTERNAL,
                error_message,
                error_message_capacity);
        }
        *out_snapshot = candidate.release();
        if (error_message != nullptr && error_message_capacity > 0u) {
            error_message[0] = '\0';
        }
        fullmag_fem_clear_global_error();
        return FULLMAG_FEM_OK;
    } catch (const std::exception &exception) {
        return publish_error(
            std::string("tracking mass snapshot creation failed: ") + exception.what(),
            FULLMAG_FEM_ERR_INTERNAL,
            error_message,
            error_message_capacity);
    } catch (...) {
        return publish_error(
            "tracking mass snapshot creation failed with a non-standard exception",
            FULLMAG_FEM_ERR_INTERNAL,
            error_message,
            error_message_capacity);
    }
#endif
}

int fullmag_fem_tracking_mass_snapshot_get_info_v1(
    const fullmag_fem_tracking_mass_snapshot_v1 *snapshot,
    fullmag_fem_tracking_mass_snapshot_info_v1 *out_info,
    char *error_message,
    std::uint64_t error_message_capacity)
{
    if (invalid_error_buffer(error_message, error_message_capacity) != FULLMAG_FEM_OK) {
        return publish_error(
            "tracking mass snapshot info error buffer is null with nonzero capacity",
            FULLMAG_FEM_ERR_INVALID,
            error_message,
            error_message_capacity);
    }
    fullmag_fem_clear_global_error();
    if (snapshot == nullptr || snapshot->snapshot == nullptr || out_info == nullptr) {
        return publish_error(
            "tracking mass snapshot info requires a valid handle and output record",
            FULLMAG_FEM_ERR_INVALID,
            error_message,
            error_message_capacity);
    }
    if (out_info->abi_version != FULLMAG_FEM_TRACKING_MASS_SNAPSHOT_ABI_VERSION ||
        out_info->struct_size != sizeof(fullmag_fem_tracking_mass_snapshot_info_v1)) {
        return publish_error(
            "tracking mass snapshot info ABI version or size mismatch",
            FULLMAG_FEM_ERR_INVALID,
            error_message,
            error_message_capacity);
    }
    *out_info = snapshot->info;
    if (error_message != nullptr && error_message_capacity > 0u) error_message[0] = '\0';
    fullmag_fem_clear_global_error();
    return FULLMAG_FEM_OK;
}

int fullmag_fem_tracking_mass_snapshot_copy_v1(
    const fullmag_fem_tracking_mass_snapshot_v1 *snapshot,
    std::uint64_t expected_generation,
    const std::uint8_t expected_identity_sha256[FULLMAG_FEM_TRACKING_MASS_SNAPSHOT_DIGEST_BYTES],
    std::uint64_t row_offsets_capacity,
    std::uint64_t columns_capacity,
    std::uint64_t values_capacity,
    std::uint64_t canonical_vertices_capacity,
    std::uint64_t scalar_dofs_capacity,
    std::uint64_t *row_offsets,
    std::uint32_t *columns,
    double *values_m3,
    std::uint32_t *canonical_vertex_ids,
    std::uint32_t *scalar_dof_ids,
    char *error_message,
    std::uint64_t error_message_capacity)
{
    if (invalid_error_buffer(error_message, error_message_capacity) != FULLMAG_FEM_OK) {
        return publish_error(
            "tracking mass snapshot copy error buffer is null with nonzero capacity",
            FULLMAG_FEM_ERR_INVALID,
            error_message,
            error_message_capacity);
    }
    fullmag_fem_clear_global_error();
    if (snapshot == nullptr || snapshot->snapshot == nullptr || expected_identity_sha256 == nullptr) {
        return publish_error(
            "tracking mass snapshot copy requires a handle and identity digest",
            FULLMAG_FEM_ERR_INVALID,
            error_message,
            error_message_capacity);
    }
    const auto &data = *snapshot->snapshot;
    const std::uint64_t row_count = snapshot->info.canonical_vertex_count;
    const std::uint64_t row_offset_count = row_count + 1u;
    const std::uint64_t nnz = snapshot->info.nonzero_count;
    if (expected_generation != snapshot->info.generation ||
        std::memcmp(expected_identity_sha256, snapshot->info.identity_sha256,
            FULLMAG_FEM_TRACKING_MASS_SNAPSHOT_DIGEST_BYTES) != 0) {
        return publish_error(
            "tracking mass snapshot generation or identity changed before copy",
            FULLMAG_FEM_ERR_INVALID,
            error_message,
            error_message_capacity);
    }
    if (row_offsets_capacity < row_offset_count || columns_capacity < nnz || values_capacity < nnz ||
        canonical_vertices_capacity < row_count || scalar_dofs_capacity < row_count ||
        row_offsets == nullptr || canonical_vertex_ids == nullptr || scalar_dof_ids == nullptr ||
        (nnz > 0u && (columns == nullptr || values_m3 == nullptr))) {
        return publish_error(
            "tracking mass snapshot copy buffers are null or undersized",
            FULLMAG_FEM_ERR_INVALID,
            error_message,
            error_message_capacity);
    }
    if (data.row_offsets().size() != row_offset_count || data.column_indices().size() != nnz ||
        data.values_m3().size() != nnz || data.canonical_vertex_ids().size() != row_count ||
        data.scalar_dof_ids().size() != row_count) {
        return publish_error(
            "tracking mass snapshot internal extents do not match its immutable metadata",
            FULLMAG_FEM_ERR_INTERNAL,
            error_message,
            error_message_capacity);
    }
    for (std::size_t index = 0; index < data.row_offsets().size(); ++index) {
        row_offsets[index] = static_cast<std::uint64_t>(data.row_offsets()[index]);
    }
    std::copy(data.column_indices().begin(), data.column_indices().end(), columns);
    std::copy(data.values_m3().begin(), data.values_m3().end(), values_m3);
    std::copy(data.canonical_vertex_ids().begin(), data.canonical_vertex_ids().end(), canonical_vertex_ids);
    std::copy(data.scalar_dof_ids().begin(), data.scalar_dof_ids().end(), scalar_dof_ids);
    if (error_message != nullptr && error_message_capacity > 0u) error_message[0] = '\0';
    fullmag_fem_clear_global_error();
    return FULLMAG_FEM_OK;
}

void fullmag_fem_tracking_mass_snapshot_destroy_v1(
    fullmag_fem_tracking_mass_snapshot_v1 *snapshot)
{
    delete snapshot;
}
