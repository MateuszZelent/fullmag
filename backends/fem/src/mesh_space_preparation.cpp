/*
 * Stateless FEM mesh/function-space preparation producer.
 *
 * This source owns the additive preparation C ABI and the evidence produced
 * from actual MFEM Mesh and FiniteElementSpace instances. It deliberately does
 * not construct Context, inspect/configure mfem::Device, allocate CUDA state,
 * or initialize solver fields and operators.
 */

#include "fullmag_fem.h"

#include "core/fem_mesh.hpp"
#include "cpu/mfem/runtime/mfem_mesh_builder.hpp"
#include "frequency_domain/canonical_digest.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <exception>
#include <limits>
#include <memory>
#include <string>
#include <vector>

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

void fullmag_fem_set_global_error(const std::string &message);
void fullmag_fem_clear_global_error();

namespace {

static_assert(sizeof(fullmag_fem_mesh_space_preparation_request_v1) == 24u,
    "mesh-space preparation request ABI layout changed");
static_assert(alignof(fullmag_fem_mesh_space_preparation_request_v1) == 8u,
    "mesh-space preparation request ABI alignment changed");
static_assert(offsetof(fullmag_fem_mesh_space_preparation_request_v1, mesh) == 8u,
    "mesh-space preparation request mesh offset changed");
static_assert(sizeof(fullmag_fem_mesh_space_preparation_evidence_v1) == 360u,
    "mesh-space preparation evidence ABI layout changed");
static_assert(alignof(fullmag_fem_mesh_space_preparation_evidence_v1) == 8u,
    "mesh-space preparation evidence ABI alignment changed");
static_assert(offsetof(fullmag_fem_mesh_space_preparation_evidence_v1, node_count) == 24u,
    "mesh-space preparation evidence cardinality offset changed");
static_assert(offsetof(fullmag_fem_mesh_space_preparation_evidence_v1, topology_fingerprint) == 96u,
    "mesh-space preparation evidence fingerprint offset changed");

constexpr const char *kMeshTopologyDigestSchema = "mfem_mesh_space.topology.v1";
constexpr const char *kMarkerMapDigestSchema = "mfem_mesh_space.marker_map.v1";
constexpr const char *kQualityDigestSchema = "mfem_mesh_space.quality.v1";
constexpr const char *kSpaceDigestSchema = "mfem_mesh_space.h1_space.v1";

void append_u32_be(std::vector<std::uint8_t> &bytes, std::uint32_t value)
{
    for (int shift = 24; shift >= 0; shift -= 8) {
        bytes.push_back(static_cast<std::uint8_t>(value >> shift));
    }
}

void append_u64_be(std::vector<std::uint8_t> &bytes, std::uint64_t value)
{
    for (int shift = 56; shift >= 0; shift -= 8) {
        bytes.push_back(static_cast<std::uint8_t>(value >> shift));
    }
}

std::uint64_t normalized_double_bits(double value)
{
    if (value == 0.0) {
        return 0u;
    }
    std::uint64_t bits = 0u;
    static_assert(sizeof(bits) == sizeof(value), "double digest requires IEEE-754 binary64 storage");
    std::memcpy(&bits, &value, sizeof(bits));
    return bits;
}

void append_double_be(std::vector<std::uint8_t> &bytes, double value)
{
    append_u64_be(bytes, normalized_double_bits(value));
}

template <typename T, typename Append>
std::vector<std::uint8_t> pack_values(const std::vector<T> &values, Append append)
{
    std::vector<std::uint8_t> bytes;
    bytes.reserve(values.size() * sizeof(T));
    for (const T value : values) {
        append(bytes, value);
    }
    return bytes;
}

std::vector<std::uint8_t> pack_marker_pairs(
    const std::vector<std::uint64_t> &ordinals,
    const std::vector<std::uint32_t> &markers)
{
    std::vector<std::uint8_t> bytes;
    bytes.reserve(ordinals.size() * 12u);
    for (std::size_t index = 0; index < ordinals.size(); ++index) {
        append_u64_be(bytes, ordinals[index]);
        append_u32_be(bytes, markers[index]);
    }
    return bytes;
}

std::string digest_topology(const fullmag::fem::FemMeshRuntimeState &mesh)
{
    using fullmag::fem::frequency_domain::CanonicalDigestBuilder;
    CanonicalDigestBuilder digest(kMeshTopologyDigestSchema);
    digest.add_u64("node_count", mesh.n_nodes);
    digest.add_u64("cell_count", mesh.n_elements);
    digest.add_u64("facet_count", mesh.n_boundary_faces);

    const auto nodes = pack_values(mesh.nodes_xyz, append_double_be);
    const auto cell_types = pack_values(mesh.cell_types, append_u32_be);
    const auto cell_offsets = pack_values(mesh.cell_offsets, append_u32_be);
    const auto cell_nodes = pack_values(mesh.cell_nodes, append_u32_be);
    const auto cell_ordinals = pack_values(mesh.cell_global_ordinals, append_u64_be);
    const auto facet_types = pack_values(mesh.facet_types, append_u32_be);
    const auto facet_roles = pack_values(mesh.facet_roles, append_u32_be);
    const auto facet_offsets = pack_values(mesh.facet_offsets, append_u32_be);
    const auto facet_nodes = pack_values(mesh.facet_nodes, append_u32_be);
    const auto facet_ordinals = pack_values(mesh.facet_global_ordinals, append_u64_be);
    const auto periodic_pairs = pack_values(mesh.periodic_node_pairs, append_u32_be);
    digest.add_bytes("nodes_xyz_be", nodes.data(), nodes.size());
    digest.add_bytes("cell_types_be", cell_types.data(), cell_types.size());
    digest.add_bytes("cell_offsets_be", cell_offsets.data(), cell_offsets.size());
    digest.add_bytes("cell_nodes_be", cell_nodes.data(), cell_nodes.size());
    digest.add_bytes("cell_global_ordinals_be", cell_ordinals.data(), cell_ordinals.size());
    digest.add_bytes("facet_types_be", facet_types.data(), facet_types.size());
    digest.add_bytes("facet_roles_be", facet_roles.data(), facet_roles.size());
    digest.add_bytes("facet_offsets_be", facet_offsets.data(), facet_offsets.size());
    digest.add_bytes("facet_nodes_be", facet_nodes.data(), facet_nodes.size());
    digest.add_bytes("facet_global_ordinals_be", facet_ordinals.data(), facet_ordinals.size());
    digest.add_bytes("periodic_node_pairs_be", periodic_pairs.data(), periodic_pairs.size());
    return digest.sha256_hex();
}

std::string digest_marker_map(const fullmag::fem::FemMeshRuntimeState &mesh)
{
    using fullmag::fem::frequency_domain::CanonicalDigestBuilder;
    CanonicalDigestBuilder digest(kMarkerMapDigestSchema);
    digest.add_u64("cell_count", mesh.n_elements);
    digest.add_u64("facet_count", mesh.n_boundary_faces);
    const auto cell_markers = pack_marker_pairs(mesh.cell_global_ordinals, mesh.cell_markers);
    const auto facet_markers = pack_marker_pairs(mesh.facet_global_ordinals, mesh.facet_markers);
    const auto facet_roles = pack_values(mesh.facet_roles, append_u32_be);
    const auto periodic_boundary_markers =
        pack_values(mesh.periodic_boundary_pair_markers, append_u32_be);
    digest.add_bytes("cell_ordinal_marker_pairs_be", cell_markers.data(), cell_markers.size());
    digest.add_bytes("facet_ordinal_marker_pairs_be", facet_markers.data(), facet_markers.size());
    digest.add_bytes("facet_roles_be", facet_roles.data(), facet_roles.size());
    digest.add_bytes("periodic_boundary_pair_markers_be",
        periodic_boundary_markers.data(), periodic_boundary_markers.size());
    return digest.sha256_hex();
}

void copy_fingerprint(char (&destination)[FULLMAG_FEM_MESH_SPACE_PREPARATION_FINGERPRINT_CAPACITY],
    const std::string &fingerprint)
{
    const std::size_t copy_count = std::min(
        fingerprint.size(),
        static_cast<std::size_t>(FULLMAG_FEM_MESH_SPACE_PREPARATION_FINGERPRINT_CAPACITY - 1u));
    std::memcpy(destination, fingerprint.data(), copy_count);
    destination[copy_count] = '\0';
}

#if FULLMAG_HAS_MFEM_STACK

bool verify_marker_map(
    const fullmag::fem::FemMeshRuntimeState &source,
    const mfem::Mesh &mesh,
    std::string &error)
{
    if (mesh.GetNE() != static_cast<int>(source.n_elements)) {
        error = "MFEM mesh cell count differs from canonical marker map";
        return false;
    }

    std::uint32_t maximum_marker = 0u;
    bool has_air = false;
    for (const std::uint32_t marker : source.cell_markers) {
        maximum_marker = std::max(maximum_marker, marker);
        has_air = has_air || marker == 0u;
    }
    if (maximum_marker > static_cast<std::uint32_t>(std::numeric_limits<int>::max()) ||
        (has_air && maximum_marker == static_cast<std::uint32_t>(std::numeric_limits<int>::max()))) {
        error = "MFEM marker range cannot be represented by positive attributes";
        return false;
    }
    const int air_attribute = has_air ? static_cast<int>(maximum_marker + 1u) : 1;
    for (std::uint32_t element = 0; element < source.n_elements; ++element) {
        const std::uint32_t marker = source.cell_markers[element];
        const int expected = marker == 0u ? air_attribute : static_cast<int>(marker);
        if (mesh.GetAttribute(static_cast<int>(element)) != expected) {
            error = "MFEM mesh volume attributes differ from canonical cell markers";
            return false;
        }
    }

    int expected_boundary_count = 0;
    if (source.facet_types.empty()) {
        expected_boundary_count = mesh.GetNBE();
        for (int boundary = 0; boundary < mesh.GetNBE(); ++boundary) {
            if (mesh.GetBdrAttribute(boundary) != 1) {
                error = "MFEM generated boundary marker differs from the default canonical marker";
                return false;
            }
        }
        return true;
    }

    for (std::size_t facet = 0; facet < source.facet_types.size(); ++facet) {
        if (source.facet_roles[facet] == FULLMAG_FEM_FACET_ROLE_MATERIAL_INTERFACE) {
            continue;
        }
        if (expected_boundary_count >= mesh.GetNBE()) {
            error = "MFEM boundary count is smaller than the canonical exterior/seam marker map";
            return false;
        }
        const std::uint32_t marker = source.facet_markers[facet];
        const int expected = marker == 0u ? 1 : static_cast<int>(marker);
        if (mesh.GetBdrAttribute(expected_boundary_count) != expected) {
            error = "MFEM boundary attributes differ from canonical facet markers";
            return false;
        }
        ++expected_boundary_count;
    }
    if (expected_boundary_count != mesh.GetNBE()) {
        error = "MFEM boundary count differs from canonical exterior/seam facet markers";
        return false;
    }
    return true;
}

bool collect_quality(
    mfem::Mesh &mesh,
    std::uint64_t &sample_count,
    double &minimum,
    double &maximum,
    std::vector<std::uint8_t> &sample_bytes,
    std::string &error)
{
    sample_count = 0u;
    minimum = std::numeric_limits<double>::infinity();
    maximum = 0.0;
    for (int element = 0; element < mesh.GetNE(); ++element) {
        mfem::ElementTransformation *transformation = mesh.GetElementTransformation(element);
        if (transformation == nullptr) {
            error = "MFEM mesh returned a null element transformation during quality certification";
            return false;
        }
        const mfem::Geometry::Type geometry = mesh.GetElementGeometry(element);
        const mfem::IntegrationRule &rule = mfem::IntRules.Get(geometry, 2);
        for (int point = 0; point < rule.GetNPoints(); ++point) {
            const mfem::IntegrationPoint &integration_point = rule.IntPoint(point);
            transformation->SetIntPoint(&integration_point);
            const double determinant = transformation->Jacobian().Det();
            if (!std::isfinite(determinant) || determinant <= 0.0) {
                error = "MFEM mesh quality certificate requires finite positive order-two Jacobians";
                return false;
            }
            if (sample_count == std::numeric_limits<std::uint64_t>::max()) {
                error = "MFEM mesh quality sample count overflows u64";
                return false;
            }
            ++sample_count;
            minimum = std::min(minimum, determinant);
            maximum = std::max(maximum, determinant);
            append_u64_be(sample_bytes, static_cast<std::uint64_t>(element));
            append_double_be(sample_bytes, determinant);
        }
    }
    if (sample_count == 0u || !std::isfinite(minimum) || !std::isfinite(maximum)) {
        error = "MFEM mesh quality certificate contains no valid Jacobian samples";
        return false;
    }
    return true;
}

std::string digest_quality(
    const std::string &topology_fingerprint,
    std::uint64_t sample_count,
    double minimum,
    double maximum,
    const std::vector<std::uint8_t> &sample_bytes)
{
    using fullmag::fem::frequency_domain::CanonicalDigestBuilder;
    CanonicalDigestBuilder digest(kQualityDigestSchema);
    digest.add_string("topology_fingerprint", topology_fingerprint);
    digest.add_u64("sample_count", sample_count);
    digest.add_u64("invalid_cell_count", 0u);
    digest.add_double("min_jacobian_determinant", minimum);
    digest.add_double("max_jacobian_determinant", maximum);
    digest.add_bytes("element_order_two_jacobians_be", sample_bytes.data(), sample_bytes.size());
    return digest.sha256_hex();
}

bool collect_element_dofs(
    mfem::FiniteElementSpace &space,
    std::uint32_t expected_order,
    std::vector<std::uint8_t> &dof_bytes,
    std::string &error)
{
    for (int element = 0; element < space.GetNE(); ++element) {
        const mfem::FiniteElement *finite_element = space.GetFE(element);
        if (finite_element == nullptr ||
            finite_element->GetOrder() != static_cast<int>(expected_order)) {
            error = "MFEM H1 function space element family/order is inconsistent";
            return false;
        }
        mfem::Array<int> dofs;
        space.GetElementDofs(element, dofs);
        if (dofs.Size() <= 0) {
            error = "MFEM H1 function space returned an empty element DOF map";
            return false;
        }
        append_u64_be(dof_bytes, static_cast<std::uint64_t>(element));
        append_u64_be(dof_bytes, static_cast<std::uint64_t>(dofs.Size()));
        for (int dof : dofs) {
            append_u64_be(dof_bytes, static_cast<std::uint64_t>(static_cast<std::int64_t>(dof)));
        }
    }
    return true;
}

std::string digest_space(
    const std::string &topology_fingerprint,
    std::uint32_t order,
    std::uint64_t local_dofs,
    std::uint64_t true_dofs,
    const std::vector<std::uint8_t> &element_dof_bytes)
{
    using fullmag::fem::frequency_domain::CanonicalDigestBuilder;
    CanonicalDigestBuilder digest(kSpaceDigestSchema);
    digest.add_string("topology_fingerprint", topology_fingerprint);
    digest.add_string("family", "H1");
    digest.add_u64("order", order);
    digest.add_u64("local_dof_count", local_dofs);
    digest.add_u64("true_dof_count", true_dofs);
    digest.add_bytes("element_dof_maps_be", element_dof_bytes.data(), element_dof_bytes.size());
    return digest.sha256_hex();
}

bool produce_evidence(
    const fullmag_fem_mesh_space_preparation_request_v1 &request,
    fullmag_fem_mesh_space_preparation_evidence_v1 &evidence,
    std::string &error)
{
    if (request.mesh == nullptr) {
        error = "FEM mesh-space preparation requires a canonical mesh descriptor";
        return false;
    }
    if (request.fe_order != 1u) {
        error = "native FEM mesh-space preparation currently supports H1 order 1 only";
        return false;
    }

    fullmag::fem::FemMeshRuntimeState source;
    if (!fullmag::fem::import_mesh_descriptor(*request.mesh, source, error)) {
        return false;
    }
    const std::string topology_fingerprint = digest_topology(source);
    const std::string marker_map_fingerprint = digest_marker_map(source);

    std::unique_ptr<mfem::Mesh> mesh;
    if (!fullmag::fem::build_mfem_mesh(source, mesh, error)) {
        return false;
    }
    if (!mesh || mesh->Dimension() != 3 ||
        mesh->GetNV() != static_cast<int>(source.n_nodes) ||
        mesh->GetNE() != static_cast<int>(source.n_elements) ||
        !verify_marker_map(source, *mesh, error)) {
        if (error.empty()) {
            error = "MFEM mesh dimensions/cardinalities differ from canonical input";
        }
        return false;
    }

    std::uint64_t quality_sample_count = 0u;
    double minimum_jacobian = 0.0;
    double maximum_jacobian = 0.0;
    std::vector<std::uint8_t> quality_samples;
    if (!collect_quality(*mesh, quality_sample_count, minimum_jacobian,
            maximum_jacobian, quality_samples, error)) {
        return false;
    }
    const std::string quality_fingerprint = digest_quality(
        topology_fingerprint, quality_sample_count, minimum_jacobian,
        maximum_jacobian, quality_samples);

    auto fec = std::make_unique<mfem::H1_FECollection>(
        static_cast<int>(request.fe_order), mesh->Dimension());
    auto fes = std::make_unique<mfem::FiniteElementSpace>(mesh.get(), fec.get());
    const int local_dofs = fes->GetNDofs();
    const int true_dofs = fes->GetTrueVSize();
    if (local_dofs <= 0 || true_dofs <= 0 || true_dofs > local_dofs) {
        error = "MFEM H1 function space returned invalid local/true DOF counts";
        return false;
    }
    std::vector<std::uint8_t> element_dofs;
    if (!collect_element_dofs(*fes, request.fe_order, element_dofs, error)) {
        return false;
    }
    const std::string space_fingerprint = digest_space(
        topology_fingerprint, request.fe_order,
        static_cast<std::uint64_t>(local_dofs),
        static_cast<std::uint64_t>(true_dofs), element_dofs);

    evidence.mesh_dimension = static_cast<std::uint32_t>(mesh->Dimension());
    evidence.fe_family = FULLMAG_FEM_FE_FAMILY_H1;
    evidence.fe_order = request.fe_order;
    evidence.mesh_matches_canonical_input = 1u;
    evidence.node_count = static_cast<std::uint64_t>(mesh->GetNV());
    evidence.cell_count = static_cast<std::uint64_t>(mesh->GetNE());
    evidence.boundary_element_count = static_cast<std::uint64_t>(mesh->GetNBE());
    evidence.local_dof_count = static_cast<std::uint64_t>(local_dofs);
    evidence.true_dof_count = static_cast<std::uint64_t>(true_dofs);
    evidence.quality_sample_count = quality_sample_count;
    evidence.invalid_cell_count = 0u;
    evidence.min_jacobian_determinant = minimum_jacobian;
    evidence.max_jacobian_determinant = maximum_jacobian;
    copy_fingerprint(evidence.topology_fingerprint, topology_fingerprint);
    copy_fingerprint(evidence.marker_map_fingerprint, marker_map_fingerprint);
    copy_fingerprint(evidence.quality_fingerprint, quality_fingerprint);
    copy_fingerprint(evidence.space_fingerprint, space_fingerprint);
    return true;
}

#endif

} // namespace

int fullmag_fem_prepare_mesh_space_v1(
    const fullmag_fem_mesh_space_preparation_request_v1 *request,
    fullmag_fem_mesh_space_preparation_evidence_v1 *out_evidence,
    char *error_message,
    std::uint64_t error_message_capacity)
{
    const auto publish_error = [error_message, error_message_capacity](
        const std::string &message,
        int status) {
        fullmag_fem_set_global_error(message);
        if (error_message != nullptr && error_message_capacity > 0u) {
            const std::size_t copy_count = std::min(
                message.size(),
                static_cast<std::size_t>(error_message_capacity - 1u));
            std::memcpy(error_message, message.data(), copy_count);
            error_message[copy_count] = '\0';
        }
        return status;
    };
    if (error_message == nullptr && error_message_capacity != 0u) {
        return publish_error(
            "fullmag_fem_prepare_mesh_space_v1 error buffer is null with non-zero capacity",
            FULLMAG_FEM_ERR_INVALID);
    }
    if (error_message != nullptr && error_message_capacity > 0u) {
        error_message[0] = '\0';
    }
    if (request == nullptr) {
        return publish_error(
            "fullmag_fem_prepare_mesh_space_v1 received null request",
            FULLMAG_FEM_ERR_INVALID);
    }
    if (request->abi_version != FULLMAG_FEM_MESH_SPACE_PREPARATION_ABI_VERSION ||
        request->struct_size != sizeof(fullmag_fem_mesh_space_preparation_request_v1) ||
        request->reserved_flags != 0u) {
        return publish_error(
            "fullmag_fem_prepare_mesh_space_v1 request ABI version/size/flags mismatch",
            FULLMAG_FEM_ERR_INVALID);
    }
    if (out_evidence == nullptr) {
        return publish_error(
            "fullmag_fem_prepare_mesh_space_v1 received null evidence output",
            FULLMAG_FEM_ERR_INVALID);
    }
    if (out_evidence->abi_version != FULLMAG_FEM_MESH_SPACE_PREPARATION_ABI_VERSION ||
        out_evidence->struct_size != sizeof(fullmag_fem_mesh_space_preparation_evidence_v1)) {
        return publish_error(
            "fullmag_fem_prepare_mesh_space_v1 evidence ABI version/size mismatch",
            FULLMAG_FEM_ERR_INVALID);
    }

#if !FULLMAG_HAS_MFEM_STACK
    return publish_error(
        "native MFEM mesh-space preparation is unavailable without the MFEM stack",
        FULLMAG_FEM_ERR_UNAVAILABLE);
#else
    try {
        fullmag_fem_mesh_space_preparation_evidence_v1 candidate{};
        candidate.abi_version = FULLMAG_FEM_MESH_SPACE_PREPARATION_ABI_VERSION;
        candidate.struct_size = static_cast<std::uint32_t>(sizeof(candidate));
        std::string error;
        if (!produce_evidence(*request, candidate, error)) {
            return publish_error(error, FULLMAG_FEM_ERR_INVALID);
        }
        *out_evidence = candidate;
        fullmag_fem_clear_global_error();
        return FULLMAG_FEM_OK;
    } catch (const std::exception &exception) {
        return publish_error(
            std::string("native MFEM mesh-space preparation failed: ") + exception.what(),
            FULLMAG_FEM_ERR_INTERNAL);
    } catch (...) {
        return publish_error(
            "native MFEM mesh-space preparation failed with an unknown exception",
            FULLMAG_FEM_ERR_INTERNAL);
    }
#endif
}
