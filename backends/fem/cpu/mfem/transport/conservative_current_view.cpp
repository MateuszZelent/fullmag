#include "cpu/mfem/transport/conservative_current_view.hpp"

#include <mfem.hpp>

#if defined(MFEM_USE_MPI) && !defined(FULLMAG_OET0_DISABLE_MPI)
#include <mpi.h>
#endif

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <iomanip>
#include <limits>
#include <map>
#include <memory>
#include <numeric>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <tuple>
#include <utility>
#include <vector>

namespace fullmag::fem::transport {
namespace {

using ElementKey = std::array<std::uint64_t, 4>;
using FaceKey = std::array<std::uint64_t, 3>;
using Bytes = std::vector<std::uint8_t>;

constexpr ElementKey kZeroElementKey{};
constexpr FaceKey kZeroFaceKey{};
constexpr std::uint64_t kMaximumCertificateRows = 0x7fffffffu;
constexpr std::size_t kMaximumSemanticStringBytes = 4096;
constexpr double kGeometryTolerance = 1.0e-12;
constexpr double kCertificateToleranceA = 1.0e-12;

[[noreturn]] void reject(const std::string &message)
{
    throw std::invalid_argument(message);
}

void require(bool condition, const std::string &message)
{
    if (!condition) {
        reject(message);
    }
}

bool valid_utf8_without_nul(const std::string &value)
{
    const auto *data = reinterpret_cast<const std::uint8_t *>(value.data());
    const std::size_t size = value.size();
    for (std::size_t offset = 0; offset < size;) {
        const std::uint8_t lead = data[offset];
        if (lead == 0) return false;
        std::size_t continuation = 0;
        std::uint32_t code_point = 0;
        std::uint32_t minimum = 0;
        if (lead <= 0x7f) {
            ++offset;
            continue;
        }
        if ((lead & 0xe0u) == 0xc0u) {
            continuation = 1;
            code_point = lead & 0x1fu;
            minimum = 0x80u;
        } else if ((lead & 0xf0u) == 0xe0u) {
            continuation = 2;
            code_point = lead & 0x0fu;
            minimum = 0x800u;
        } else if ((lead & 0xf8u) == 0xf0u) {
            continuation = 3;
            code_point = lead & 0x07u;
            minimum = 0x10000u;
        } else {
            return false;
        }
        if (continuation > size - offset - 1) return false;
        for (std::size_t i = 1; i <= continuation; ++i) {
            const auto byte = data[offset + i];
            if ((byte & 0xc0u) != 0x80u) return false;
            code_point = (code_point << 6u) | (byte & 0x3fu);
        }
        if (code_point < minimum || code_point > 0x10ffffu ||
                (code_point >= 0xd800u && code_point <= 0xdfffu)) {
            return false;
        }
        offset += continuation + 1;
    }
    return true;
}

void validate_semantic_string(
    const std::string &value,
    const char *name,
    bool allow_empty = false)
{
    require((allow_empty || !value.empty()) &&
            value.size() <= kMaximumSemanticStringBytes &&
            valid_utf8_without_nul(value),
        std::string(name) + " must be valid bounded UTF-8 without NUL");
}

void validate_finite(double value, const char *name)
{
    require(std::isfinite(value), std::string(name) + " must be finite");
}

void append_u8(Bytes &bytes, std::uint8_t value)
{
    bytes.push_back(value);
}

void append_u64_le(Bytes &bytes, std::uint64_t value)
{
    for (unsigned shift = 0; shift < 64; shift += 8) {
        bytes.push_back(static_cast<std::uint8_t>(value >> shift));
    }
}

void append_f64_le(Bytes &bytes, double value)
{
    validate_finite(value, "canonical binary64 value");
    const double normalized = value == 0.0 ? 0.0 : value;
    std::uint64_t bits = 0;
    static_assert(sizeof(bits) == sizeof(normalized));
    std::memcpy(&bits, &normalized, sizeof(bits));
    append_u64_le(bytes, bits);
}

void append_lp(Bytes &bytes, const std::string &value)
{
    validate_semantic_string(value, "canonical string", true);
    append_u64_le(bytes, static_cast<std::uint64_t>(value.size()));
    bytes.insert(bytes.end(), value.begin(), value.end());
}

std::uint32_t rotate_right(std::uint32_t value, unsigned count)
{
    return (value >> count) | (value << (32u - count));
}

std::string sha256_hex(const Bytes &message)
{
    static constexpr std::array<std::uint32_t, 64> k{
        0x428a2f98u,0x71374491u,0xb5c0fbcfu,0xe9b5dba5u,0x3956c25bu,0x59f111f1u,0x923f82a4u,0xab1c5ed5u,
        0xd807aa98u,0x12835b01u,0x243185beu,0x550c7dc3u,0x72be5d74u,0x80deb1feu,0x9bdc06a7u,0xc19bf174u,
        0xe49b69c1u,0xefbe4786u,0x0fc19dc6u,0x240ca1ccu,0x2de92c6fu,0x4a7484aau,0x5cb0a9dcu,0x76f988dau,
        0x983e5152u,0xa831c66du,0xb00327c8u,0xbf597fc7u,0xc6e00bf3u,0xd5a79147u,0x06ca6351u,0x14292967u,
        0x27b70a85u,0x2e1b2138u,0x4d2c6dfcu,0x53380d13u,0x650a7354u,0x766a0abbu,0x81c2c92eu,0x92722c85u,
        0xa2bfe8a1u,0xa81a664bu,0xc24b8b70u,0xc76c51a3u,0xd192e819u,0xd6990624u,0xf40e3585u,0x106aa070u,
        0x19a4c116u,0x1e376c08u,0x2748774cu,0x34b0bcb5u,0x391c0cb3u,0x4ed8aa4au,0x5b9cca4fu,0x682e6ff3u,
        0x748f82eeu,0x78a5636fu,0x84c87814u,0x8cc70208u,0x90befffau,0xa4506cebu,0xbef9a3f7u,0xc67178f2u};
    Bytes padded = message;
    require(message.size() <= std::numeric_limits<std::uint64_t>::max() / 8u,
        "SHA-256 input is too large");
    const std::uint64_t bit_length =
        static_cast<std::uint64_t>(message.size()) * 8u;
    padded.push_back(0x80u);
    while ((padded.size() % 64u) != 56u) padded.push_back(0u);
    for (int shift = 56; shift >= 0; shift -= 8) {
        padded.push_back(static_cast<std::uint8_t>(bit_length >> shift));
    }
    std::array<std::uint32_t, 8> h{
        0x6a09e667u,0xbb67ae85u,0x3c6ef372u,0xa54ff53au,
        0x510e527fu,0x9b05688cu,0x1f83d9abu,0x5be0cd19u};
    for (std::size_t offset = 0; offset < padded.size(); offset += 64u) {
        std::array<std::uint32_t, 64> w{};
        for (std::size_t i = 0; i < 16; ++i) {
            const std::size_t p = offset + 4u * i;
            w[i] = (static_cast<std::uint32_t>(padded[p]) << 24u) |
                (static_cast<std::uint32_t>(padded[p + 1]) << 16u) |
                (static_cast<std::uint32_t>(padded[p + 2]) << 8u) |
                static_cast<std::uint32_t>(padded[p + 3]);
        }
        for (std::size_t i = 16; i < 64; ++i) {
            const auto s0 = rotate_right(w[i - 15], 7) ^
                rotate_right(w[i - 15], 18) ^ (w[i - 15] >> 3u);
            const auto s1 = rotate_right(w[i - 2], 17) ^
                rotate_right(w[i - 2], 19) ^ (w[i - 2] >> 10u);
            w[i] = w[i - 16] + s0 + w[i - 7] + s1;
        }
        auto [a,b,c,d,e,f,g,hh] = h;
        for (std::size_t i = 0; i < 64; ++i) {
            const auto s1 = rotate_right(e, 6) ^ rotate_right(e, 11) ^
                rotate_right(e, 25);
            const auto choice = (e & f) ^ ((~e) & g);
            const auto temp1 = hh + s1 + choice + k[i] + w[i];
            const auto s0 = rotate_right(a, 2) ^ rotate_right(a, 13) ^
                rotate_right(a, 22);
            const auto majority = (a & b) ^ (a & c) ^ (b & c);
            const auto temp2 = s0 + majority;
            hh = g; g = f; f = e; e = d + temp1;
            d = c; c = b; b = a; a = temp1 + temp2;
        }
        h[0]+=a; h[1]+=b; h[2]+=c; h[3]+=d;
        h[4]+=e; h[5]+=f; h[6]+=g; h[7]+=hh;
    }
    static constexpr char hex[] = "0123456789abcdef";
    std::string result;
    result.reserve(64);
    for (const auto word : h) {
        for (int shift = 28; shift >= 0; shift -= 4) {
            result.push_back(hex[(word >> shift) & 0x0fu]);
        }
    }
    return result;
}

Bytes decode_hex_32(const std::string &hex)
{
    require(hex.size() == 64, "nested SHA-256 must have 64 lowercase hex digits");
    auto nibble = [](char value) -> std::uint8_t {
        if (value >= '0' && value <= '9') return value - '0';
        if (value >= 'a' && value <= 'f') return value - 'a' + 10;
        reject("nested SHA-256 is not lowercase hexadecimal");
    };
    Bytes result;
    result.reserve(32);
    for (std::size_t i = 0; i < hex.size(); i += 2) {
        result.push_back(static_cast<std::uint8_t>(
            (nibble(hex[i]) << 4u) | nibble(hex[i + 1])));
    }
    return result;
}

mfem::Vector coordinate(const mfem::Mesh &mesh, int vertex)
{
    mfem::Vector result(3);
    const double *point = mesh.GetVertex(vertex);
    for (int component = 0; component < 3; ++component) {
        require(std::isfinite(point[component]), "mesh coordinate is non-finite");
        result[component] = point[component];
    }
    return result;
}

ElementKey element_key(
    const mfem::Mesh &mesh,
    const StableMeshVertexIdentities &ids,
    int element)
{
    mfem::Array<int> vertices;
    mesh.GetElementVertices(element, vertices);
    require(vertices.Size() == 4, "OE-T0 requires tetrahedral elements");
    ElementKey key{};
    for (int i = 0; i < 4; ++i) key[i] = ids.local_to_stable.at(vertices[i]);
    std::sort(key.begin(), key.end());
    return key;
}

FaceKey mesh_face_key(
    const mfem::Mesh &mesh,
    const StableMeshVertexIdentities &ids,
    int face)
{
    mfem::Array<int> vertices;
    mesh.GetFaceVertices(face, vertices);
    require(vertices.Size() == 3, "OE-T0 requires triangular faces");
    FaceKey key{};
    for (int i = 0; i < 3; ++i) key[i] = ids.local_to_stable.at(vertices[i]);
    std::sort(key.begin(), key.end());
    return key;
}

FaceKey boundary_face_key(
    const mfem::Mesh &mesh,
    const StableMeshVertexIdentities &ids,
    int boundary)
{
    mfem::Array<int> vertices;
    mesh.GetBdrElementVertices(boundary, vertices);
    require(vertices.Size() == 3, "OE-T0 requires triangular boundary faces");
    FaceKey key{};
    for (int i = 0; i < 3; ++i) key[i] = ids.local_to_stable.at(vertices[i]);
    std::sort(key.begin(), key.end());
    return key;
}

mfem::Vector element_centroid(const mfem::Mesh &mesh, int element)
{
    mfem::Array<int> vertices;
    mesh.GetElementVertices(element, vertices);
    mfem::Vector result(3);
    result = 0.0;
    for (int i = 0; i < vertices.Size(); ++i) result += coordinate(mesh, vertices[i]);
    result /= static_cast<double>(vertices.Size());
    return result;
}

mfem::Vector face_centroid(const mfem::Mesh &mesh, int face)
{
    mfem::Array<int> vertices;
    mesh.GetFaceVertices(face, vertices);
    mfem::Vector result(3);
    result = 0.0;
    for (int i = 0; i < vertices.Size(); ++i) result += coordinate(mesh, vertices[i]);
    result /= static_cast<double>(vertices.Size());
    return result;
}

mfem::Vector canonical_face_area(
    const mfem::Mesh &mesh,
    const StableMeshVertexIdentities &ids,
    int face)
{
    mfem::Array<int> vertices;
    mesh.GetFaceVertices(face, vertices);
    require(vertices.Size() == 3, "canonical face is not triangular");
    std::array<int, 3> ordered{vertices[0], vertices[1], vertices[2]};
    std::sort(ordered.begin(), ordered.end(), [&](int left, int right) {
        return ids.local_to_stable.at(left) < ids.local_to_stable.at(right);
    });
    const auto p0 = coordinate(mesh, ordered[0]);
    auto e1 = coordinate(mesh, ordered[1]);
    auto e2 = coordinate(mesh, ordered[2]);
    e1 -= p0;
    e2 -= p0;
    mfem::Vector area(3);
    area[0] = 0.5 * (e1[1] * e2[2] - e1[2] * e2[1]);
    area[1] = 0.5 * (e1[2] * e2[0] - e1[0] * e2[2]);
    area[2] = 0.5 * (e1[0] * e2[1] - e1[1] * e2[0]);
    require(std::isfinite(area.Norml2()) && area.Norml2() > 0.0,
        "canonical face is degenerate");
    return area;
}

int canonical_outward_sign(
    const mfem::Mesh &mesh,
    const StableMeshVertexIdentities &ids,
    int face,
    int element)
{
    const auto area = canonical_face_area(mesh, ids, face);
    auto inward = element_centroid(mesh, element);
    inward -= face_centroid(mesh, face);
    const double dot = area * inward;
    require(std::abs(dot) > 0.0 && std::isfinite(dot),
        "cannot determine canonical face orientation");
    return dot < 0.0 ? 1 : -1;
}

void validate_stable_ids(
    const mfem::Mesh &mesh,
    const StableMeshVertexIdentities &ids)
{
    require(ids.version == "stable_mesh_vertex_u64.v1",
        "unsupported stable vertex identity version");
    require(ids.local_to_stable.size() == static_cast<std::size_t>(mesh.GetNV()),
        "stable vertex identity cardinality differs from mesh vertices");
    std::set<std::uint64_t> unique;
    for (const auto id : ids.local_to_stable) {
        require(id != 0 && unique.insert(id).second,
            "stable vertex identities must be nonzero and unique");
    }
}

void validate_affine_tetrahedral_mesh(const mfem::Mesh &mesh)
{
    require(mesh.Dimension() == 3 && mesh.SpaceDimension() == 3,
        "OE-T0 requires a three-dimensional mesh");
    require(mesh.GetNodes() == nullptr,
        "OE-T0 v1 rejects curved or high-order geometry");
    require(mesh.GetNE() > 0, "OE-T0 requires a nonempty mesh");
    for (int element = 0; element < mesh.GetNE(); ++element) {
        require(mesh.GetElementBaseGeometry(element) == mfem::Geometry::TETRAHEDRON,
            "OE-T0 v1 accepts tetrahedra only");
        mfem::Array<int> vertices;
        mesh.GetElementVertices(element, vertices);
        require(vertices.Size() == 4, "tetrahedron does not have four vertices");
        const auto p0 = coordinate(mesh, vertices[0]);
        auto a = coordinate(mesh, vertices[1]);
        auto b = coordinate(mesh, vertices[2]);
        auto c = coordinate(mesh, vertices[3]);
        a -= p0; b -= p0; c -= p0;
        const double determinant =
            a[0] * (b[1] * c[2] - b[2] * c[1]) -
            a[1] * (b[0] * c[2] - b[2] * c[0]) +
            a[2] * (b[0] * c[1] - b[1] * c[0]);
        const double scale = std::max({a.Norml2(), b.Norml2(), c.Norml2(), 1.0});
        require(std::isfinite(determinant) &&
                std::abs(determinant) > kGeometryTolerance * scale * scale * scale,
            "OE-T0 rejects degenerate tetrahedra");
    }
}

struct BoundaryTopology {
    std::map<FaceKey, int> key_to_boundary;
    std::map<FaceKey, ConservativeCurrentBoundaryFace> roles;
};

BoundaryTopology validate_boundary_roles(
    const mfem::Mesh &mesh,
    const StableMeshVertexIdentities &ids,
    const std::vector<ConservativeCurrentBoundaryFace> &input)
{
    require(input.size() == static_cast<std::size_t>(mesh.GetNBE()),
        "every physical boundary face must be classified exactly once");
    std::vector<bool> seen(mesh.GetNBE(), false);
    BoundaryTopology result;
    for (const auto &entry : input) {
        require(entry.boundary_element >= 0 && entry.boundary_element < mesh.GetNBE(),
            "boundary classification references an invalid element");
        require(!seen[entry.boundary_element],
            "boundary element was classified more than once");
        seen[entry.boundary_element] = true;
        switch (entry.role) {
        case ConservativeCurrentBoundaryRole::InsulatingOuter:
            require(entry.circuit_id.empty(),
                "insulating boundary must not carry a circuit ID");
            break;
        case ConservativeCurrentBoundaryRole::SourceCut:
        case ConservativeCurrentBoundaryRole::ClosureInterface:
            validate_semantic_string(entry.circuit_id, "boundary circuit ID");
            break;
        default:
            reject("unknown conservative-current boundary role");
        }
        const auto key = boundary_face_key(mesh, ids, entry.boundary_element);
        require(result.key_to_boundary.emplace(key, entry.boundary_element).second,
            "boundary faces must have unique stable keys");
        result.roles.emplace(key, entry);
    }
    return result;
}

void validate_identity_and_pins(
    const ConservativeCurrentIdentityInput &identity,
    const ConservativeCurrentPins &pins)
{
    validate_semantic_string(identity.source_module_id, "source module ID");
    validate_semantic_string(identity.source_state_revision, "source state revision");
    validate_semantic_string(identity.source_field_digest, "source field digest");
    validate_semantic_string(identity.mesh_revision, "mesh revision");
    validate_semantic_string(identity.topology_revision, "topology revision");
    validate_semantic_string(identity.geometry_digest, "geometry digest");
    validate_semantic_string(identity.envelope_revision, "envelope revision");
    validate_semantic_string(identity.envelope_digest, "envelope digest");
    validate_finite(identity.evaluated_envelope_multiplier,
        "evaluated envelope multiplier");
    validate_finite(identity.evaluation_time_s, "evaluation time");
    require(identity.source_state_revision == pins.required_source_state_revision,
        "source state revision pin is stale");
    require(identity.source_field_digest == pins.required_source_field_digest,
        "source field digest pin is stale");
    require(identity.mesh_revision == pins.required_mesh_revision,
        "mesh revision pin is stale");
    require(identity.topology_revision == pins.required_topology_revision,
        "topology revision pin is stale");
}

std::string divergence_id(const ElementKey &key)
{
    std::ostringstream output;
    output << "divergence";
    for (const auto value : key) output << ':' << value;
    return output.str();
}

mfem::Mesh combine_disjoint_meshes(const mfem::Mesh &device, const mfem::Mesh &lead)
{
    mfem::Mesh output(3, device.GetNV() + lead.GetNV(),
        device.GetNE() + lead.GetNE(), device.GetNBE() + lead.GetNBE(), 3);
    const auto append = [&](const mfem::Mesh &mesh, int vertex_offset) {
        for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) {
            output.AddVertex(mesh.GetVertex(vertex));
        }
        for (int element = 0; element < mesh.GetNE(); ++element) {
            mfem::Array<int> vertices;
            mesh.GetElementVertices(element, vertices);
            require(vertices.Size() == 4, "combined mesh requires tetrahedra");
            int tetrahedron[4]{vertices[0] + vertex_offset,
                vertices[1] + vertex_offset, vertices[2] + vertex_offset,
                vertices[3] + vertex_offset};
            output.AddTet(tetrahedron, mesh.GetElement(element)->GetAttribute());
        }
        for (int boundary = 0; boundary < mesh.GetNBE(); ++boundary) {
            mfem::Array<int> vertices;
            mesh.GetBdrElementVertices(boundary, vertices);
            require(vertices.Size() == 3, "combined mesh requires triangular boundary");
            int triangle[3]{vertices[0] + vertex_offset,
                vertices[1] + vertex_offset, vertices[2] + vertex_offset};
            output.AddBdrTriangle(
                triangle, mesh.GetBdrElement(boundary)->GetAttribute());
        }
    };
    append(device, 0);
    append(lead, device.GetNV());
    output.FinalizeTetMesh(1, 1, true);
    return output;
}

} // namespace

class ConservativeCurrentView::Impl {
public:
    std::unique_ptr<mfem::Mesh> mesh;
    std::unique_ptr<mfem::RT_FECollection> collection;
    std::unique_ptr<mfem::FiniteElementSpace> space;
    std::unique_ptr<mfem::GridFunction> field;
    StableMeshVertexIdentities stable_ids;
    ConservativeCurrentIdentity identity;
    ConservativeCurrentBalanceCertificate balance;
    ConstraintRankCertificate rank_certificate;
    std::vector<CanonicalFaceFluxRecord> records;
    Bytes balance_bytes;
    bool global_and_broadcast = false;
};

namespace {

struct PairConstraint {
    std::uint8_t kind = 0;
    std::string id;
    FaceKey face_a{};
    FaceKey face_b{};
};

struct ElementBalanceRow {
    ElementKey key{};
    double residual_a = 0.0;
    double denominator_a = 0.0;
};

struct FaceBalanceRow {
    FaceKey key{};
    std::uint8_t side_count = 0;
    double side1_flux_a = 0.0;
    double side2_flux_a = 0.0;
    double canonical_jump_a = 0.0;
};

struct CircuitBalanceRow {
    std::uint8_t kind = 0;
    std::string id;
    FaceKey face_a{};
    FaceKey face_b{};
    double flux_a = 0.0;
    double paired_flux_a = 0.0;
    double mismatch_a = 0.0;
};

struct PhysicalCertificate {
    std::vector<ElementBalanceRow> elements;
    std::vector<FaceBalanceRow> faces;
    std::vector<CircuitBalanceRow> circuits;
    std::vector<CanonicalFaceFluxRecord> records;
    ConservativeCurrentBalanceCertificate summary;
};

mfem::Vector evaluate_field_at(
    const mfem::GridFunction &field,
    int element,
    const mfem::Vector &physical_point)
{
    auto *transformation = field.FESpace()->GetMesh()->
        GetElementTransformation(element);
    mfem::InverseElementTransformation inverse(transformation);
    mfem::IntegrationPoint reference;
    require(inverse.Transform(physical_point, reference) ==
            mfem::InverseElementTransformation::Inside,
        "physical certificate could not invert a face centroid");
    mfem::Vector value(3);
    field.GetVectorValue(element, reference, value);
    for (int component = 0; component < 3; ++component) {
        validate_finite(value[component], "physical RT0 field value");
    }
    return value;
}

std::map<FaceKey, int> boundary_face_map(
    const mfem::Mesh &mesh,
    const StableMeshVertexIdentities &ids)
{
    std::map<FaceKey, int> result;
    for (int boundary = 0; boundary < mesh.GetNBE(); ++boundary) {
        const auto key = boundary_face_key(mesh, ids, boundary);
        require(result.emplace(key, boundary).second,
            "combined mesh boundary face keys must be unique");
    }
    return result;
}

int boundary_adjacent_element(const mfem::Mesh &mesh, int boundary)
{
    int element = -1;
    int face_info = 0;
    mesh.GetBdrElementAdjacentElement(boundary, element, face_info);
    (void)face_info;
    require(element >= 0, "boundary face has no adjacent element");
    return element;
}

PhysicalCertificate integrate_physical_certificate(
    const mfem::GridFunction &field,
    const StableMeshVertexIdentities &ids,
    const std::vector<PairConstraint> &pairs,
    const std::vector<FaceKey> &terminal_faces,
    const std::string &terminal_id,
    double physical_relative_gate,
    double physical_absolute_gate_a)
{
    const auto &mesh = *field.FESpace()->GetMesh();
    std::vector<double> element_balance(mesh.GetNE(), 0.0);
    std::vector<double> element_scale(mesh.GetNE(), 0.0);
    std::map<FaceKey, FaceBalanceRow> face_rows;
    PhysicalCertificate result;
    result.records.reserve(mesh.GetNumFaces());
    result.faces.reserve(mesh.GetNumFaces());

    for (int face = 0; face < mesh.GetNumFaces(); ++face) {
        const auto key = mesh_face_key(mesh, ids, face);
        const auto area = canonical_face_area(mesh, ids, face);
        const auto centroid = face_centroid(mesh, face);
        int element1 = -1;
        int element2 = -1;
        mesh.GetFaceElements(face, &element1, &element2);
        require(element1 >= 0, "mesh face has no adjacent element");
        const auto value1 = evaluate_field_at(field, element1, centroid);
        const double canonical_flux1 = value1 * area;
        validate_finite(canonical_flux1, "canonical face flux");
        CanonicalFaceFluxRecord record;
        record.face_vertex_ids = key;
        record.flux_a = canonical_flux1 == 0.0 ? 0.0 : canonical_flux1;
        result.records.push_back(record);

        FaceBalanceRow row;
        row.key = key;
        row.side_count = element2 >= 0 ? 2 : 1;
        const double outward1 =
            canonical_outward_sign(mesh, ids, face, element1) * canonical_flux1;
        row.side1_flux_a = outward1 == 0.0 ? 0.0 : outward1;
        element_balance.at(element1) += outward1;
        element_scale.at(element1) += std::abs(outward1);
        if (element2 >= 0) {
            const auto value2 = evaluate_field_at(field, element2, centroid);
            const double canonical_flux2 = value2 * area;
            validate_finite(canonical_flux2, "second-side canonical face flux");
            const double outward2 =
                canonical_outward_sign(mesh, ids, face, element2) * canonical_flux2;
            row.side2_flux_a = outward2 == 0.0 ? 0.0 : outward2;
            row.canonical_jump_a = canonical_flux1 - canonical_flux2;
            if (row.canonical_jump_a == 0.0) row.canonical_jump_a = 0.0;
            element_balance.at(element2) += outward2;
            element_scale.at(element2) += std::abs(outward2);
            if (element_key(mesh, ids, element2) <
                    element_key(mesh, ids, element1)) {
                std::swap(row.side1_flux_a, row.side2_flux_a);
            }
            result.summary.max_internal_face_jump_a = std::max(
                result.summary.max_internal_face_jump_a,
                std::abs(row.canonical_jump_a));
        }
        require(face_rows.emplace(key, row).second,
            "physical face keys must be globally unique");
        result.faces.push_back(row);
    }

    for (int element = 0; element < mesh.GetNE(); ++element) {
        ElementBalanceRow row;
        row.key = element_key(mesh, ids, element);
        row.residual_a = element_balance.at(element) == 0.0
            ? 0.0 : element_balance.at(element);
        row.denominator_a = element_scale.at(element) == 0.0
            ? 0.0 : element_scale.at(element);
        result.summary.max_element_divergence_a = std::max(
            result.summary.max_element_divergence_a,
            std::abs(row.residual_a));
        result.elements.push_back(row);
    }

    std::set<FaceKey> used_boundary_faces;
    for (const auto &pair : pairs) {
        require(pair.kind == 2 || pair.kind == 3,
            "paired circuit row has an invalid kind");
        validate_semantic_string(pair.id, "paired circuit ID");
        require(pair.face_a != pair.face_b,
            "paired circuit faces must have distinct stable keys");
        require(face_rows.count(pair.face_a) == 1 &&
                face_rows.at(pair.face_a).side_count == 1 &&
                face_rows.count(pair.face_b) == 1 &&
                face_rows.at(pair.face_b).side_count == 1,
            "paired circuit references a non-boundary face");
        require(used_boundary_faces.insert(pair.face_a).second &&
                used_boundary_faces.insert(pair.face_b).second,
            "physical boundary face is paired more than once");
        CircuitBalanceRow row;
        row.kind = pair.kind;
        row.id = pair.id;
        row.face_a = pair.face_a;
        row.face_b = pair.face_b;
        row.flux_a = face_rows.at(pair.face_a).side1_flux_a;
        row.paired_flux_a = face_rows.at(pair.face_b).side1_flux_a;
        row.mismatch_a = row.flux_a + row.paired_flux_a;
        if (row.mismatch_a == 0.0) row.mismatch_a = 0.0;
        result.summary.max_closure_interface_mismatch_a = std::max(
            result.summary.max_closure_interface_mismatch_a,
            std::abs(row.mismatch_a));
        result.circuits.push_back(std::move(row));
    }

    validate_semantic_string(terminal_id, "terminal drive ID",
        terminal_faces.empty());
    double terminal_net_flux = 0.0;
    double terminal_scale = 0.0;
    for (const auto &face : terminal_faces) {
        require(face_rows.count(face) == 1 &&
                face_rows.at(face).side_count == 1,
            "terminal references a non-boundary face");
        require(used_boundary_faces.insert(face).second,
            "terminal face is multiply classified");
        CircuitBalanceRow row;
        row.kind = 1;
        row.id = terminal_id;
        row.face_a = face;
        row.flux_a = face_rows.at(face).side1_flux_a;
        terminal_net_flux += row.flux_a;
        terminal_scale += std::abs(row.flux_a);
        result.circuits.push_back(std::move(row));
    }

    for (const auto &[key, face_row] : face_rows) {
        if (face_row.side_count != 1 || used_boundary_faces.count(key) != 0) {
            continue;
        }
        CircuitBalanceRow row;
        row.kind = 4;
        row.face_a = key;
        row.flux_a = face_row.side1_flux_a;
        result.summary.net_outer_flux_a += row.flux_a;
        result.circuits.push_back(std::move(row));
    }

    std::sort(result.elements.begin(), result.elements.end(),
        [](const auto &left, const auto &right) { return left.key < right.key; });
    std::sort(result.faces.begin(), result.faces.end(),
        [](const auto &left, const auto &right) { return left.key < right.key; });
    std::sort(result.records.begin(), result.records.end(),
        [](const auto &left, const auto &right) {
            return left.face_vertex_ids < right.face_vertex_ids;
        });
    std::sort(result.circuits.begin(), result.circuits.end(),
        [](const auto &left, const auto &right) {
            return std::tie(left.kind, left.id, left.face_a, left.face_b) <
                std::tie(right.kind, right.id, right.face_a, right.face_b);
        });

    const double pair_scale = [&] {
        double scale = 0.0;
        for (const auto &row : result.circuits) {
            if (row.kind == 2 || row.kind == 3) {
                scale = std::max(scale,
                    std::abs(row.flux_a) + std::abs(row.paired_flux_a));
            }
        }
        return scale;
    }();
    result.summary.electrode_balance_relative =
        std::max(result.summary.max_closure_interface_mismatch_a,
            std::abs(terminal_net_flux)) /
        std::max({pair_scale, terminal_scale, 1.0e-30});
    const auto gate = [&](double value, double scale) {
        return std::abs(value) <= std::max(physical_absolute_gate_a,
            physical_relative_gate * std::max(scale, 1.0e-30));
    };
    bool elements_ok = true;
    for (const auto &row : result.elements) {
        elements_ok = elements_ok && gate(row.residual_a, row.denominator_a);
    }
    bool faces_ok = true;
    for (const auto &row : result.faces) {
        if (row.side_count == 2) {
            faces_ok = faces_ok && gate(row.canonical_jump_a,
                std::abs(row.side1_flux_a) + std::abs(row.side2_flux_a));
        }
    }
    bool pairs_ok = true;
    for (const auto &row : result.circuits) {
        if (row.kind == 2 || row.kind == 3) {
            pairs_ok = pairs_ok && gate(row.mismatch_a,
                std::abs(row.flux_a) + std::abs(row.paired_flux_a));
        }
    }
    const bool terminals_ok = gate(terminal_net_flux, terminal_scale);
    result.summary.closure_complete =
        elements_ok && faces_ok && pairs_ok && terminals_ok;
    require(result.summary.closure_complete,
        "physical Piola current certificate failed closed");
    return result;
}

std::vector<std::vector<int>> component_adjacency(
    const mfem::Mesh &mesh,
    const StableMeshVertexIdentities &ids,
    const std::vector<PairConstraint> &pairs)
{
    std::vector<std::vector<int>> adjacency(mesh.GetNE());
    for (int face = 0; face < mesh.GetNumFaces(); ++face) {
        int first = -1;
        int second = -1;
        mesh.GetFaceElements(face, &first, &second);
        if (first >= 0 && second >= 0) {
            adjacency[first].push_back(second);
            adjacency[second].push_back(first);
        }
    }
    const auto boundaries = boundary_face_map(mesh, ids);
    for (const auto &pair : pairs) {
        const int first = boundary_adjacent_element(
            mesh, boundaries.at(pair.face_a));
        const int second = boundary_adjacent_element(
            mesh, boundaries.at(pair.face_b));
        adjacency[first].push_back(second);
        adjacency[second].push_back(first);
    }
    return adjacency;
}

ConstraintRankCertificate analyze_physical_constraint_rank(
    const mfem::Mesh &mesh,
    const StableMeshVertexIdentities &ids,
    const std::vector<PairConstraint> &pairs,
    const std::vector<FaceKey> &terminal_faces,
    double physical_absolute_gate_a,
    double physical_relative_gate)
{
    std::set<FaceKey> free_boundary_faces;
    for (const auto &pair : pairs) {
        free_boundary_faces.insert(pair.face_a);
        free_boundary_faces.insert(pair.face_b);
    }
    free_boundary_faces.insert(terminal_faces.begin(), terminal_faces.end());

    std::vector<FaceKey> free_columns;
    std::map<FaceKey, int> key_to_face;
    for (int face = 0; face < mesh.GetNumFaces(); ++face) {
        const auto key = mesh_face_key(mesh, ids, face);
        require(key_to_face.emplace(key, face).second,
            "rank input has duplicate canonical face keys");
        int first = -1;
        int second = -1;
        mesh.GetFaceElements(face, &first, &second);
        if (second >= 0 || free_boundary_faces.count(key) != 0) {
            free_columns.push_back(key);
        }
    }
    std::sort(free_columns.begin(), free_columns.end());
    std::map<FaceKey, std::uint64_t> column_ids;
    for (std::size_t column = 0; column < free_columns.size(); ++column) {
        column_ids.emplace(free_columns[column],
            static_cast<std::uint64_t>(column + 1));
    }

    const auto adjacency = component_adjacency(mesh, ids, pairs);
    std::vector<ElementKey> component_anchor(mesh.GetNE());
    std::vector<bool> visited(mesh.GetNE(), false);
    for (int seed = 0; seed < mesh.GetNE(); ++seed) {
        if (visited[seed]) continue;
        std::vector<int> stack{seed};
        std::vector<int> members;
        visited[seed] = true;
        ElementKey anchor = element_key(mesh, ids, seed);
        while (!stack.empty()) {
            const int element = stack.back();
            stack.pop_back();
            members.push_back(element);
            anchor = std::min(anchor, element_key(mesh, ids, element));
            for (const int peer : adjacency[element]) {
                if (!visited[peer]) {
                    visited[peer] = true;
                    stack.push_back(peer);
                }
            }
        }
        for (const int member : members) component_anchor[member] = anchor;
    }

    std::vector<ConservativeConstraintRankRow> rows;
    rows.reserve(static_cast<std::size_t>(mesh.GetNE()) + pairs.size());
    for (int element = 0; element < mesh.GetNE(); ++element) {
        ConservativeConstraintRankRow row;
        row.constraint_id = divergence_id(element_key(mesh, ids, element));
        row.kind = ConservativeConstraintRankRowKind::ClosedComponentDivergence;
        row.closed_component_anchor_element = component_anchor[element];
        row.row_element_key = element_key(mesh, ids, element);
        for (int face = 0; face < mesh.GetNumFaces(); ++face) {
            int first = -1;
            int second = -1;
            mesh.GetFaceElements(face, &first, &second);
            if (first != element && second != element) continue;
            const auto key = mesh_face_key(mesh, ids, face);
            const auto column = column_ids.find(key);
            if (column == column_ids.end()) continue;
            row.canonical_column_ids.push_back(column->second);
            row.incidence_coefficients.push_back(
                canonical_outward_sign(mesh, ids, face, element));
        }
        std::vector<std::size_t> order(row.canonical_column_ids.size());
        std::iota(order.begin(), order.end(), 0);
        std::sort(order.begin(), order.end(), [&](std::size_t left, std::size_t right) {
            return row.canonical_column_ids[left] < row.canonical_column_ids[right];
        });
        auto columns = row.canonical_column_ids;
        auto coefficients = row.incidence_coefficients;
        for (std::size_t i = 0; i < order.size(); ++i) {
            row.canonical_column_ids[i] = columns[order[i]];
            row.incidence_coefficients[i] = coefficients[order[i]];
        }
        rows.push_back(std::move(row));
    }
    for (const auto &pair : pairs) {
        ConservativeConstraintRankRow row;
        std::ostringstream id;
        id << (pair.kind == 2 ? "source-cut:" : "closure-interface:") << pair.id;
        for (const auto value : pair.face_a) id << ':' << value;
        for (const auto value : pair.face_b) id << ':' << value;
        row.constraint_id = id.str();
        for (const auto &key : {pair.face_a, pair.face_b}) {
            const int face = key_to_face.at(key);
            int first = -1;
            int second = -1;
            mesh.GetFaceElements(face, &first, &second);
            require(first >= 0 && second < 0,
                "paired constraint must reference physical boundary faces");
            row.canonical_column_ids.push_back(column_ids.at(key));
            row.incidence_coefficients.push_back(
                canonical_outward_sign(mesh, ids, face, first));
        }
        if (row.canonical_column_ids[1] < row.canonical_column_ids[0]) {
            std::swap(row.canonical_column_ids[0], row.canonical_column_ids[1]);
            std::swap(row.incidence_coefficients[0], row.incidence_coefficients[1]);
        }
        rows.push_back(std::move(row));
    }
    return ConservativeConstraintRank::Analyze(
        rows, physical_absolute_gate_a, physical_relative_gate);
}

Bytes encode_records(const std::vector<CanonicalFaceFluxRecord> &records)
{
    Bytes bytes;
    bytes.reserve(records.size() * 32u);
    for (const auto &record : records) {
        require(record.face_vertex_ids[0] < record.face_vertex_ids[1] &&
                record.face_vertex_ids[1] < record.face_vertex_ids[2],
            "canonical face record key is not strictly increasing");
        for (const auto id : record.face_vertex_ids) append_u64_le(bytes, id);
        append_f64_le(bytes, record.flux_a);
    }
    return bytes;
}

Bytes encode_balance_certificate(
    double algebraic_relative_tolerance,
    double physical_relative_gate,
    double physical_absolute_gate_a,
    const ConstraintRankCertificate &rank,
    const PhysicalCertificate &physical)
{
    require(physical.elements.size() <= kMaximumCertificateRows &&
            physical.faces.size() <= kMaximumCertificateRows &&
            physical.circuits.size() <= kMaximumCertificateRows &&
            rank.omitted_rows.size() <= kMaximumCertificateRows,
        "balance certificate row-family cap exceeded");
    Bytes bytes;
    append_lp(bytes, "fem_conservative_current_balance_certificate.v1");
    append_f64_le(bytes, algebraic_relative_tolerance);
    append_f64_le(bytes, physical_relative_gate);
    append_f64_le(bytes, physical_absolute_gate_a);
    append_u64_le(bytes, rank.rows_before);
    append_u64_le(bytes, rank.rank);
    append_u64_le(bytes, physical.elements.size());
    append_u64_le(bytes, physical.faces.size());
    append_u64_le(bytes, physical.circuits.size());
    append_u64_le(bytes, rank.omitted_rows.size());
    for (const auto &row : physical.elements) {
        for (const auto id : row.key) append_u64_le(bytes, id);
        append_f64_le(bytes, row.residual_a);
        append_f64_le(bytes, row.denominator_a);
        append_f64_le(bytes,
            row.residual_a / std::max(row.denominator_a, 1.0e-30));
    }
    for (const auto &row : physical.faces) {
        for (const auto id : row.key) append_u64_le(bytes, id);
        append_u8(bytes, row.side_count);
        append_f64_le(bytes, row.side1_flux_a);
        append_f64_le(bytes, row.side2_flux_a);
        append_f64_le(bytes, row.canonical_jump_a);
    }
    for (const auto &row : physical.circuits) {
        append_u8(bytes, row.kind);
        append_lp(bytes, row.id);
        for (const auto id : row.face_a) append_u64_le(bytes, id);
        for (const auto id : row.face_b) append_u64_le(bytes, id);
        append_f64_le(bytes, row.flux_a);
        append_f64_le(bytes, row.paired_flux_a);
        append_f64_le(bytes, row.mismatch_a);
    }
    for (const auto &row : rank.omitted_rows) {
        append_lp(bytes, row.constraint_id);
        const auto reason = row.reason ==
                ConstraintOmissionReason::ClosedComponentDivergenceDependency
            ? 1u : row.reason == ConstraintOmissionReason::ConsistentLinearDependency
            ? 2u : 0u;
        require(reason != 0, "unknown omitted constraint reason");
        append_u8(bytes, static_cast<std::uint8_t>(reason));
        for (const auto id : row.closed_component_anchor_element) {
            append_u64_le(bytes, id);
        }
        append_f64_le(bytes, row.residual_a);
    }
    append_f64_le(bytes, physical.summary.max_element_divergence_a);
    append_f64_le(bytes, physical.summary.max_internal_face_jump_a);
    append_f64_le(bytes, physical.summary.net_outer_flux_a);
    append_f64_le(bytes, physical.summary.electrode_balance_relative);
    append_u8(bytes, physical.summary.closure_complete ? 1u : 0u);
    return bytes;
}

ConservativeCurrentIdentity make_identity(
    const ConservativeCurrentIdentityInput &input,
    const std::string &closure_revision,
    const std::string &closure_digest,
    const std::vector<CanonicalFaceFluxRecord> &records,
    const Bytes &balance_bytes)
{
    ConservativeCurrentIdentity identity;
    identity.operator_version = ConservativeCurrentView::operator_version;
    identity.source_module_id = input.source_module_id;
    identity.source_state_revision = input.source_state_revision;
    identity.source_field_digest = input.source_field_digest;
    identity.mesh_revision = input.mesh_revision;
    identity.topology_revision = input.topology_revision;
    identity.geometry_digest = input.geometry_digest;
    identity.closure_revision = closure_revision;
    identity.closure_digest = closure_digest;
    identity.envelope_revision = input.envelope_revision;
    identity.envelope_digest = input.envelope_digest;
    identity.evaluated_envelope_multiplier =
        input.evaluated_envelope_multiplier == 0.0
        ? 0.0 : input.evaluated_envelope_multiplier;
    identity.evaluation_time_s = input.evaluation_time_s == 0.0
        ? 0.0 : input.evaluation_time_s;
    identity.stage_identity = input.stage_identity;
    identity.canonical_face_record_count = records.size();
    const auto payload = encode_records(records);
    identity.face_record_payload_sha256 = sha256_hex(payload);

    Bytes canonical_preimage;
    append_lp(canonical_preimage, "fem_rt0_canonical_face_digest.v1");
    append_lp(canonical_preimage, ConservativeCurrentView::operator_version);
    append_lp(canonical_preimage, "stable_vertex_lexicographic_normal.v1");
    append_lp(canonical_preimage, identity.geometry_digest);
    append_u64_le(canonical_preimage, identity.canonical_face_record_count);
    const auto nested_payload = decode_hex_32(identity.face_record_payload_sha256);
    canonical_preimage.insert(canonical_preimage.end(),
        nested_payload.begin(), nested_payload.end());
    identity.canonical_face_digest = sha256_hex(canonical_preimage);
    identity.balance_certificate_digest = sha256_hex(balance_bytes);

    Bytes view_preimage;
    append_lp(view_preimage, "fem_conservative_current_view_identity_digest.v1");
    const auto append_nested = [&](const std::string &digest) {
        const auto decoded = decode_hex_32(digest);
        view_preimage.insert(view_preimage.end(), decoded.begin(), decoded.end());
    };
    append_nested(identity.canonical_face_digest);
    append_lp(view_preimage, identity.source_module_id);
    append_lp(view_preimage, identity.source_state_revision);
    append_lp(view_preimage, identity.source_field_digest);
    append_lp(view_preimage, identity.mesh_revision);
    append_lp(view_preimage, identity.topology_revision);
    append_lp(view_preimage, identity.geometry_digest);
    append_lp(view_preimage, identity.closure_revision);
    append_lp(view_preimage, identity.closure_digest);
    append_lp(view_preimage, identity.envelope_revision);
    append_lp(view_preimage, identity.envelope_digest);
    append_f64_le(view_preimage, identity.evaluated_envelope_multiplier);
    append_f64_le(view_preimage, identity.evaluation_time_s);
    append_u64_le(view_preimage, identity.stage_identity);
    append_nested(identity.balance_certificate_digest);
    identity.view_identity_digest = sha256_hex(view_preimage);
    return identity;
}

struct FinalizedViewData {
    std::unique_ptr<mfem::Mesh> mesh;
    std::unique_ptr<mfem::RT_FECollection> collection;
    std::unique_ptr<mfem::FiniteElementSpace> space;
    std::unique_ptr<mfem::GridFunction> field;
    StableMeshVertexIdentities stable_ids;
    ConservativeCurrentIdentity identity;
    ConservativeCurrentBalanceCertificate balance;
    ConstraintRankCertificate rank_certificate;
    std::vector<CanonicalFaceFluxRecord> records;
    Bytes balance_bytes;
    bool global_and_broadcast = false;
};

FinalizedViewData finalize_view_data(
    std::unique_ptr<mfem::Mesh> mesh,
    StableMeshVertexIdentities ids,
    std::unique_ptr<mfem::RT_FECollection> collection,
    std::unique_ptr<mfem::FiniteElementSpace> space,
    std::unique_ptr<mfem::GridFunction> field,
    const ConservativeCurrentIdentityInput &identity_input,
    const std::string &closure_revision,
    const std::string &closure_digest,
    const std::vector<PairConstraint> &pairs,
    const std::vector<FaceKey> &terminal_faces,
    const std::string &terminal_id,
    double algebraic_relative_tolerance,
    double physical_relative_gate,
    double physical_absolute_gate_a,
    bool global_and_broadcast)
{
    FinalizedViewData data;
    data.mesh = std::move(mesh);
    data.stable_ids = std::move(ids);
    data.collection = std::move(collection);
    data.space = std::move(space);
    data.field = std::move(field);
    for (int dof = 0; dof < data.field->Size(); ++dof) {
        require(std::isfinite((*data.field)[dof]),
            "RT0 field contains a non-finite degree of freedom");
    }
    data.rank_certificate = analyze_physical_constraint_rank(
        *data.mesh, data.stable_ids, pairs, terminal_faces,
        physical_absolute_gate_a, physical_relative_gate);
    const auto physical = integrate_physical_certificate(
        *data.field, data.stable_ids, pairs, terminal_faces, terminal_id,
        physical_relative_gate, physical_absolute_gate_a);
    data.balance = physical.summary;
    data.records = physical.records;
    data.balance_bytes = encode_balance_certificate(
        algebraic_relative_tolerance, physical_relative_gate,
        physical_absolute_gate_a, data.rank_certificate, physical);
    data.identity = make_identity(identity_input, closure_revision,
        closure_digest, data.records, data.balance_bytes);
    data.global_and_broadcast = global_and_broadcast;
    return data;
}

struct ClosureTopology {
    std::string revision;
    std::string digest;
    std::vector<PairConstraint> pairs;
    std::vector<FaceKey> terminal_faces;
    std::string terminal_id;
};

mfem::Vector boundary_centroid(const mfem::Mesh &mesh, int boundary)
{
    mfem::Array<int> vertices;
    mesh.GetBdrElementVertices(boundary, vertices);
    require(vertices.Size() == 3, "closure boundary face must be triangular");
    mfem::Vector result(3);
    result = 0.0;
    for (int i = 0; i < vertices.Size(); ++i) result += coordinate(mesh, vertices[i]);
    result /= 3.0;
    return result;
}

ClosureTopology validate_closed_geometry_closure(
    const mfem::Mesh &mesh,
    const StableMeshVertexIdentities &ids,
    const BoundaryTopology &boundaries,
    const ClosedGeometryCurrentClosure &closure)
{
    require(closure.operator_version == "fem_closed_current_geometry.v1",
        "unsupported closed-geometry closure operator");
    validate_semantic_string(closure.revision, "closure revision");
    validate_semantic_string(closure.digest, "closure digest");
    require(!closure.source_cuts.empty(),
        "closed geometry requires at least one explicit source cut");
    ClosureTopology result;
    result.revision = closure.revision;
    result.digest = closure.digest;
    std::set<std::string> cut_ids;
    std::set<FaceKey> used;
    for (const auto &cut : closure.source_cuts) {
        validate_semantic_string(cut.id, "source-cut ID");
        require(cut_ids.insert(cut.id).second, "source-cut IDs must be unique");
        validate_finite(cut.potential_drop_v, "source-cut potential drop");
        double translation_norm2 = 0.0;
        for (const auto value : cut.translation_m) {
            validate_finite(value, "source-cut translation");
            translation_norm2 += value * value;
        }
        require(translation_norm2 > 0.0,
            "source-cut translation must be nonzero");
        require(!cut.face_pairs.empty(), "source cut has no paired faces");
        for (const auto &pair : cut.face_pairs) {
            require(pair.minus_face_vertex_ids[0] < pair.minus_face_vertex_ids[1] &&
                    pair.minus_face_vertex_ids[1] < pair.minus_face_vertex_ids[2] &&
                    pair.plus_face_vertex_ids[0] < pair.plus_face_vertex_ids[1] &&
                    pair.plus_face_vertex_ids[1] < pair.plus_face_vertex_ids[2],
                "source-cut stable face keys must be strictly increasing");
            const auto minus = boundaries.key_to_boundary.find(
                pair.minus_face_vertex_ids);
            const auto plus = boundaries.key_to_boundary.find(
                pair.plus_face_vertex_ids);
            require(minus != boundaries.key_to_boundary.end() &&
                    plus != boundaries.key_to_boundary.end(),
                "source-cut pair references an unknown boundary face");
            const auto &minus_role = boundaries.roles.at(pair.minus_face_vertex_ids);
            const auto &plus_role = boundaries.roles.at(pair.plus_face_vertex_ids);
            require(minus_role.role == ConservativeCurrentBoundaryRole::SourceCut &&
                    plus_role.role == ConservativeCurrentBoundaryRole::SourceCut &&
                    minus_role.circuit_id == cut.id && plus_role.circuit_id == cut.id,
                "source-cut pair disagrees with boundary classification");
            require(used.insert(pair.minus_face_vertex_ids).second &&
                    used.insert(pair.plus_face_vertex_ids).second,
                "source-cut boundary face is paired more than once");
            auto displacement = boundary_centroid(mesh, plus->second);
            displacement -= boundary_centroid(mesh, minus->second);
            for (int component = 0; component < 3; ++component) {
                require(std::abs(displacement[component] -
                            cut.translation_m[component]) <= kGeometryTolerance,
                    "source-cut face geometry disagrees with authored translation");
            }
            result.pairs.push_back(PairConstraint{
                2, cut.id, pair.minus_face_vertex_ids,
                pair.plus_face_vertex_ids});
        }
    }
    for (const auto &[key, role] : boundaries.roles) {
        if (role.role == ConservativeCurrentBoundaryRole::SourceCut) {
            require(used.count(key) == 1,
                "source-cut boundary face is not paired exactly once");
        } else {
            require(used.count(key) == 0,
                "non-source boundary face was used by a source cut");
        }
    }
    return result;
}

ClosureTopology validate_external_lead_closure(
    const mfem::Mesh &device_mesh,
    const StableMeshVertexIdentities &device_ids,
    const BoundaryTopology &device_boundaries,
    const ExternalLeadExtensionCurrentClosure &closure)
{
    require(closure.operator_version == "fem_closed_current_extension.v1",
        "unsupported external-lead closure operator");
    validate_semantic_string(closure.revision, "closure revision");
    validate_semantic_string(closure.digest, "closure digest");
    validate_semantic_string(closure.drive_id, "external-lead drive ID");
    validate_semantic_string(
        closure.lead_conductivity_digest, "lead conductivity digest");
    validate_finite(closure.outer_electrode_potential_drop_v,
        "outer-electrode potential drop");
    require(closure.outer_electrode_potential_drop_v != 0.0,
        "external-lead drive must have a nonzero potential drop");
    require(closure.lead_mesh != nullptr && closure.lead_conductivity != nullptr,
        "external-lead closure requires a volumetric mesh and conductivity");
    validate_affine_tetrahedral_mesh(*closure.lead_mesh);
    validate_stable_ids(*closure.lead_mesh, closure.lead_vertex_identities);
    std::set<std::uint64_t> all_ids(
        device_ids.local_to_stable.begin(), device_ids.local_to_stable.end());
    for (const auto id : closure.lead_vertex_identities.local_to_stable) {
        require(all_ids.insert(id).second,
            "device and lead stable vertex namespaces must be disjoint");
    }

    const auto lead_boundaries = boundary_face_map(
        *closure.lead_mesh, closure.lead_vertex_identities);
    ClosureTopology result;
    result.revision = closure.revision;
    result.digest = closure.digest;
    result.terminal_id = closure.drive_id;
    require(!closure.interface_pairs.empty(),
        "external lead requires a complete interface map");
    std::set<FaceKey> used_device;
    std::set<FaceKey> used_lead;
    for (const auto &pair : closure.interface_pairs) {
        require(device_boundaries.key_to_boundary.count(
                    pair.transport_face_vertex_ids) == 1 &&
                lead_boundaries.count(pair.lead_face_vertex_ids) == 1,
            "external-lead pair references an unknown boundary face");
        const auto &role = device_boundaries.roles.at(
            pair.transport_face_vertex_ids);
        require(role.role == ConservativeCurrentBoundaryRole::ClosureInterface,
            "external-lead pair does not reference a closure-interface face");
        require(used_device.insert(pair.transport_face_vertex_ids).second &&
                used_lead.insert(pair.lead_face_vertex_ids).second,
            "external-lead interface face is paired more than once");
        const auto device_centroid = boundary_centroid(device_mesh,
            device_boundaries.key_to_boundary.at(pair.transport_face_vertex_ids));
        const auto lead_centroid = boundary_centroid(*closure.lead_mesh,
            lead_boundaries.at(pair.lead_face_vertex_ids));
        auto separation = device_centroid;
        separation -= lead_centroid;
        require(separation.Norml2() <= kGeometryTolerance,
            "external-lead paired faces are not geometrically coincident");
        result.pairs.push_back(PairConstraint{3, role.circuit_id,
            pair.transport_face_vertex_ids, pair.lead_face_vertex_ids});
    }
    for (const auto &[key, role] : device_boundaries.roles) {
        if (role.role == ConservativeCurrentBoundaryRole::ClosureInterface) {
            require(used_device.count(key) == 1,
                "device closure-interface map is incomplete");
        } else {
            require(used_device.count(key) == 0,
                "non-interface device boundary was paired to a lead");
        }
    }

    require(!closure.minus_outer_electrode_faces.empty() &&
            !closure.plus_outer_electrode_faces.empty(),
        "external lead requires both outer electrodes");
    std::set<FaceKey> electrodes;
    for (const auto &faces : {&closure.minus_outer_electrode_faces,
                              &closure.plus_outer_electrode_faces}) {
        for (const auto &key : *faces) {
            require(lead_boundaries.count(key) == 1,
                "outer electrode references an unknown lead boundary face");
            require(used_lead.count(key) == 0 && electrodes.insert(key).second,
                "lead boundary is multiply classified");
            result.terminal_faces.push_back(key);
        }
    }
    for (const auto &[key, boundary] : lead_boundaries) {
        (void)boundary;
        if (used_lead.count(key) != 0 || electrodes.count(key) != 0) continue;
        // Remaining lead faces are insulating outer support and are emitted as
        // kind-4 rows by the physical certificate.
    }
    return result;
}

void validate_gates(
    double algebraic_relative_tolerance,
    double physical_relative_gate,
    double physical_absolute_gate_a)
{
    require(std::isfinite(algebraic_relative_tolerance) &&
            algebraic_relative_tolerance > 0.0,
        "algebraic relative tolerance must be finite and positive");
    require(std::isfinite(physical_relative_gate) &&
            physical_relative_gate >= 0.0 &&
            std::isfinite(physical_absolute_gate_a) &&
            physical_absolute_gate_a >= 0.0,
        "physical current gates must be finite and nonnegative");
}

} // namespace

ConservativeCurrentView::ConservativeCurrentView(std::unique_ptr<Impl> impl)
    : impl_(std::move(impl))
{
    if (!impl_) reject("ConservativeCurrentView requires a complete implementation");
}

ConservativeCurrentView::~ConservativeCurrentView() = default;

ConservativeCurrentView::Ptr ConservativeCurrentView::Import(
    const ConservativeCurrentImportRequest &request)
{
    require(request.mesh != nullptr && request.rt0_field != nullptr,
        "Import requires a mesh and an RT0 field");
    validate_identity_and_pins(request.identity, request.pins);
    validate_gates(1.0e-12, request.physical_relative_gate,
        request.physical_absolute_gate_a);
    validate_affine_tetrahedral_mesh(*request.mesh);
    validate_stable_ids(*request.mesh, request.stable_vertex_identities);
    const auto device_boundaries = validate_boundary_roles(*request.mesh,
        request.stable_vertex_identities, request.boundary_faces);

    std::unique_ptr<mfem::Mesh> owned_mesh;
    StableMeshVertexIdentities owned_ids;
    ClosureTopology topology;
    if (const auto *closed =
            std::get_if<ClosedGeometryCurrentClosure>(&request.closure)) {
        topology = validate_closed_geometry_closure(*request.mesh,
            request.stable_vertex_identities, device_boundaries, *closed);
        owned_mesh = std::make_unique<mfem::Mesh>(*request.mesh);
        owned_ids = request.stable_vertex_identities;
    } else {
        const auto &external =
            std::get<ExternalLeadExtensionCurrentClosure>(request.closure);
        topology = validate_external_lead_closure(*request.mesh,
            request.stable_vertex_identities, device_boundaries, external);
        owned_mesh = std::make_unique<mfem::Mesh>(
            combine_disjoint_meshes(*request.mesh, *external.lead_mesh));
        owned_ids.version = request.stable_vertex_identities.version;
        owned_ids.local_to_stable = request.stable_vertex_identities.local_to_stable;
        owned_ids.local_to_stable.insert(owned_ids.local_to_stable.end(),
            external.lead_vertex_identities.local_to_stable.begin(),
            external.lead_vertex_identities.local_to_stable.end());
    }
    validate_affine_tetrahedral_mesh(*owned_mesh);
    validate_stable_ids(*owned_mesh, owned_ids);

    const auto *input_space = request.rt0_field->FESpace();
    require(input_space != nullptr && input_space->FEColl() != nullptr &&
            input_space->FEColl()->Name() == std::string("RT_3D_P0") &&
            input_space->GetVDim() == 1,
        "Import accepts only a scalar-DOF RT0/H(div) field");
    auto collection = std::make_unique<mfem::RT_FECollection>(0, 3);
    auto space = std::make_unique<mfem::FiniteElementSpace>(
        owned_mesh.get(), collection.get());
    require(space->GetVSize() == request.rt0_field->Size(),
        "imported RT0 field does not match the resolved owned mesh");
    auto field = std::make_unique<mfem::GridFunction>(space.get());
    for (int dof = 0; dof < field->Size(); ++dof) {
        const double value = (*request.rt0_field)[dof];
        require(std::isfinite(value),
            "imported RT0 field contains a non-finite degree of freedom");
        (*field)[dof] = value == 0.0 ? 0.0 : value;
    }

    auto data = finalize_view_data(std::move(owned_mesh), std::move(owned_ids),
        std::move(collection), std::move(space), std::move(field),
        request.identity, topology.revision, topology.digest, topology.pairs,
        topology.terminal_faces, topology.terminal_id, 1.0e-12,
        request.physical_relative_gate, request.physical_absolute_gate_a,
        request.reference_mpi_gather_broadcast);
    auto impl = std::make_unique<Impl>();
    impl->mesh = std::move(data.mesh);
    impl->collection = std::move(data.collection);
    impl->space = std::move(data.space);
    impl->field = std::move(data.field);
    impl->stable_ids = std::move(data.stable_ids);
    impl->identity = std::move(data.identity);
    impl->balance = data.balance;
    impl->rank_certificate = std::move(data.rank_certificate);
    impl->records = std::move(data.records);
    impl->balance_bytes = std::move(data.balance_bytes);
    impl->global_and_broadcast = data.global_and_broadcast;
    return Ptr(new ConservativeCurrentView(std::move(impl)));
}

namespace {

class PotentialCurrentCoefficient final : public mfem::VectorCoefficient {
public:
    PotentialCurrentCoefficient(
        const mfem::GridFunction &potential,
        mfem::Coefficient &conductivity)
        : mfem::VectorCoefficient(3), potential_(potential),
          conductivity_(conductivity)
    {
    }

    void Eval(mfem::Vector &value, mfem::ElementTransformation &transformation,
        const mfem::IntegrationPoint &point) override
    {
        const int element = transformation.ElementNo;
        require(element >= 0 && element <
                potential_.FESpace()->GetMesh()->GetNE(),
            "potential/current mesh element maps differ");
        auto *potential_transformation =
            potential_.FESpace()->GetMesh()->GetElementTransformation(element);
        potential_transformation->SetIntPoint(&point);
        mfem::Vector gradient(3);
        potential_.GetGradient(*potential_transformation, gradient);
        const double sigma = conductivity_.Eval(transformation, point);
        require(std::isfinite(sigma) && sigma > 0.0,
            "conductivity must be finite and strictly positive");
        value.SetSize(3);
        for (int component = 0; component < 3; ++component) {
            value[component] = -sigma * gradient[component];
            validate_finite(value[component], "reconstructed current density");
        }
    }

private:
    const mfem::GridFunction &potential_;
    mfem::Coefficient &conductivity_;
};

class CombinedConductivity final : public mfem::Coefficient {
public:
    CombinedConductivity(
        int device_elements,
        mfem::Coefficient &device,
        mfem::Coefficient &lead)
        : device_elements_(device_elements), device_(device), lead_(lead)
    {
    }

    double Eval(mfem::ElementTransformation &transformation,
        const mfem::IntegrationPoint &point) override
    {
        const double value = transformation.ElementNo < device_elements_
            ? device_.Eval(transformation, point)
            : lead_.Eval(transformation, point);
        require(std::isfinite(value) && value > 0.0,
            "combined conductivity must be finite and strictly positive");
        return value;
    }

private:
    int device_elements_;
    mfem::Coefficient &device_;
    mfem::Coefficient &lead_;
};

class DisjointSet {
public:
    explicit DisjointSet(int size) : parent_(size), rank_(size, 0)
    {
        std::iota(parent_.begin(), parent_.end(), 0);
    }

    int find(int value)
    {
        if (parent_[value] != value) parent_[value] = find(parent_[value]);
        return parent_[value];
    }

    void unite(int left, int right)
    {
        left = find(left);
        right = find(right);
        if (left == right) return;
        if (rank_[left] < rank_[right]) std::swap(left, right);
        parent_[right] = left;
        if (rank_[left] == rank_[right]) ++rank_[left];
    }

private:
    std::vector<int> parent_;
    std::vector<unsigned> rank_;
};

std::map<std::uint64_t, int> stable_id_to_vertex(
    const StableMeshVertexIdentities &ids,
    int offset = 0)
{
    std::map<std::uint64_t, int> result;
    for (std::size_t vertex = 0; vertex < ids.local_to_stable.size(); ++vertex) {
        result.emplace(ids.local_to_stable[vertex],
            offset + static_cast<int>(vertex));
    }
    return result;
}

std::unique_ptr<mfem::GridFunction> solve_external_lead_potential(
    mfem::Mesh &combined_mesh,
    mfem::FiniteElementSpace &h1_space,
    const StableMeshVertexIdentities &combined_ids,
    int device_vertex_count,
    int device_element_count,
    const StableMeshVertexIdentities &device_ids,
    const ExternalLeadExtensionCurrentClosure &closure,
    CombinedConductivity &conductivity,
    double algebraic_relative_tolerance)
{
    require(h1_space.GetVSize() == combined_mesh.GetNV(),
        "external-lead quotient solve requires scalar P1 vertex DOFs");
    DisjointSet quotient(combined_mesh.GetNV());
    const auto device_vertices = stable_id_to_vertex(device_ids);
    const auto lead_vertices = stable_id_to_vertex(
        closure.lead_vertex_identities, device_vertex_count);
    for (const auto &pair : closure.interface_pairs) {
        std::set<int> unmatched_lead;
        for (const auto id : pair.lead_face_vertex_ids) {
            unmatched_lead.insert(lead_vertices.at(id));
        }
        for (const auto device_id : pair.transport_face_vertex_ids) {
            const int device_vertex = device_vertices.at(device_id);
            const auto device_point = coordinate(combined_mesh, device_vertex);
            const auto match = std::find_if(unmatched_lead.begin(),
                unmatched_lead.end(), [&](int lead_vertex) {
                    auto separation = coordinate(combined_mesh, lead_vertex);
                    separation -= device_point;
                    return separation.Norml2() <= kGeometryTolerance;
                });
            require(match != unmatched_lead.end(),
                "external-lead interface has no coincident vertex quotient");
            quotient.unite(device_vertex, *match);
            unmatched_lead.erase(match);
        }
        require(unmatched_lead.empty(),
            "external-lead interface vertex quotient is incomplete");
    }

    std::map<int, int> root_to_quotient;
    std::vector<int> vertex_to_quotient(combined_mesh.GetNV());
    for (int vertex = 0; vertex < combined_mesh.GetNV(); ++vertex) {
        const int root = quotient.find(vertex);
        const auto [iterator, inserted] = root_to_quotient.emplace(
            root, static_cast<int>(root_to_quotient.size()));
        (void)inserted;
        vertex_to_quotient[vertex] = iterator->second;
    }
    const int quotient_size = static_cast<int>(root_to_quotient.size());

    mfem::BilinearForm diffusion(&h1_space);
    diffusion.AddDomainIntegrator(new mfem::DiffusionIntegrator(conductivity));
    diffusion.Assemble();
    diffusion.Finalize();
    const auto &full = diffusion.SpMat();
    mfem::SparseMatrix reduced(quotient_size);
    const int *row_offsets = full.GetI();
    const int *columns = full.GetJ();
    const double *values = full.GetData();
    for (int row = 0; row < full.Height(); ++row) {
        const int quotient_row = vertex_to_quotient.at(row);
        for (int entry = row_offsets[row]; entry < row_offsets[row + 1]; ++entry) {
            reduced.Add(quotient_row, vertex_to_quotient.at(columns[entry]),
                values[entry]);
        }
    }
    reduced.Finalize();

    std::map<int, double> essential;
    const auto add_electrode = [&](const std::vector<FaceKey> &faces,
                                   double potential) {
        for (const auto &face : faces) {
            for (const auto id : face) {
                const int vertex = lead_vertices.at(id);
                const int dof = vertex_to_quotient.at(vertex);
                const auto [iterator, inserted] = essential.emplace(dof, potential);
                require(inserted || iterator->second == potential,
                    "external-lead electrode potentials conflict");
            }
        }
    };
    add_electrode(closure.minus_outer_electrode_faces, 0.0);
    add_electrode(closure.plus_outer_electrode_faces,
        closure.outer_electrode_potential_drop_v);
    require(!essential.empty() && essential.size() <
            static_cast<std::size_t>(quotient_size),
        "external-lead quotient has an invalid essential set");

    std::vector<int> quotient_to_free(quotient_size, -1);
    int free_size = 0;
    for (int dof = 0; dof < quotient_size; ++dof) {
        if (essential.count(dof) == 0) quotient_to_free[dof] = free_size++;
    }
    require(free_size > 0, "external-lead quotient has no free unknowns");
    mfem::SparseMatrix free_matrix(free_size);
    mfem::Vector rhs(free_size);
    rhs = 0.0;
    const int *reduced_offsets = reduced.GetI();
    const int *reduced_columns = reduced.GetJ();
    const double *reduced_values = reduced.GetData();
    for (int row = 0; row < quotient_size; ++row) {
        const int free_row = quotient_to_free[row];
        if (free_row < 0) continue;
        for (int entry = reduced_offsets[row];
                entry < reduced_offsets[row + 1]; ++entry) {
            const int column = reduced_columns[entry];
            const double value = reduced_values[entry];
            const auto prescribed = essential.find(column);
            if (prescribed != essential.end()) {
                rhs[free_row] -= value * prescribed->second;
            } else {
                free_matrix.Add(free_row, quotient_to_free[column], value);
            }
        }
    }
    free_matrix.Finalize();
    mfem::Vector free_solution(free_size);
    free_solution = 0.0;
    mfem::GSSmoother preconditioner(free_matrix);
    mfem::CGSolver solver;
    solver.SetOperator(free_matrix);
    solver.SetPreconditioner(preconditioner);
    solver.SetRelTol(std::min(algebraic_relative_tolerance, 1.0e-14));
    solver.SetAbsTol(1.0e-15);
    solver.SetMaxIter(std::max(1000, free_size * 20));
    solver.SetPrintLevel(-1);
    solver.Mult(rhs, free_solution);
    require(solver.GetConverged(),
        "external-lead coupled scalar-potential solve did not converge");

    mfem::Vector quotient_solution(quotient_size);
    for (int dof = 0; dof < quotient_size; ++dof) {
        const auto prescribed = essential.find(dof);
        quotient_solution[dof] = prescribed != essential.end()
            ? prescribed->second : free_solution[quotient_to_free[dof]];
    }
    auto potential = std::make_unique<mfem::GridFunction>(&h1_space);
    for (int vertex = 0; vertex < combined_mesh.GetNV(); ++vertex) {
        (*potential)[vertex] = quotient_solution[vertex_to_quotient[vertex]];
    }
    (void)combined_ids;
    (void)device_element_count;
    return potential;
}

} // namespace

ConservativeCurrentView::Ptr ConservativeCurrentView::Build(
    const ConservativeCurrentBuildRequest &request)
{
    require(request.mesh != nullptr && request.conductivity != nullptr,
        "Build requires a mesh and conductivity coefficient");
    require(request.raw_single_valued_potential == nullptr,
        "raw single-valued H1 potential cannot impersonate an accepted source");
    validate_identity_and_pins(request.identity, request.pins);
    validate_gates(request.algebraic_relative_tolerance,
        request.physical_relative_gate, request.physical_absolute_gate_a);
    validate_affine_tetrahedral_mesh(*request.mesh);
    validate_stable_ids(*request.mesh, request.stable_vertex_identities);
    const auto device_boundaries = validate_boundary_roles(*request.mesh,
        request.stable_vertex_identities, request.boundary_faces);

    FinalizedViewData data;
    if (const auto *closed =
            std::get_if<ClosedGeometryCurrentClosure>(&request.closure)) {
        require(!request.external_lead_coupled_solve,
            "closed geometry cannot request external-lead coupled solve");
        require(request.periodic_charge_potential != nullptr,
            "closed geometry requires an accepted periodic-potential drive");
        const auto topology = validate_closed_geometry_closure(*request.mesh,
            request.stable_vertex_identities, device_boundaries, *closed);
        const auto &snapshot = *request.periodic_charge_potential;
        require(snapshot.operator_version() == "fem_charge_h1_periodic_jump.v1" &&
                snapshot.converged() &&
                snapshot.algebraic_relative_residual() <=
                    request.algebraic_relative_tolerance,
            "periodic charge-potential snapshot is not accepted");
        require(snapshot.mesh_revision() == request.identity.mesh_revision &&
                snapshot.geometry_digest() == request.identity.geometry_digest &&
                snapshot.source_module_id() == request.identity.source_module_id &&
                snapshot.source_state_revision() ==
                    request.identity.source_state_revision &&
                snapshot.source_field_digest() ==
                    request.identity.source_field_digest &&
                snapshot.evaluation_time_s() == request.identity.evaluation_time_s &&
                snapshot.stage_identity() == request.identity.stage_identity &&
                snapshot.envelope_revision() == request.identity.envelope_revision &&
                snapshot.envelope_digest() == request.identity.envelope_digest &&
                snapshot.evaluated_envelope_multiplier() ==
                    request.identity.evaluated_envelope_multiplier &&
                snapshot.source_cut_digest() == closed->digest,
            "periodic charge-potential snapshot identity is stale");
        require(closed->source_cuts.size() == 1 &&
                std::abs(snapshot.potential_jump_v() -
                    closed->source_cuts.front().potential_drop_v) <= 1.0e-13,
            "periodic potential jump differs from the authored source cut");
        require(snapshot.max_paired_weak_flux_mismatch_a() <=
                kCertificateToleranceA,
            "periodic potential failed its paired weak-flux certificate");

        auto mesh = std::make_unique<mfem::Mesh>(*request.mesh);
        auto collection = std::make_unique<mfem::RT_FECollection>(0, 3);
        auto space = std::make_unique<mfem::FiniteElementSpace>(
            mesh.get(), collection.get());
        auto field = std::make_unique<mfem::GridFunction>(space.get());
        PotentialCurrentCoefficient current(
            snapshot.potential_field(), *request.conductivity);
        field->ProjectCoefficient(current);
        data = finalize_view_data(std::move(mesh),
            request.stable_vertex_identities, std::move(collection),
            std::move(space), std::move(field), request.identity,
            topology.revision, topology.digest, topology.pairs,
            topology.terminal_faces, topology.terminal_id,
            request.algebraic_relative_tolerance,
            request.physical_relative_gate, request.physical_absolute_gate_a,
            request.reference_mpi_gather_broadcast);
    } else {
        const auto &external =
            std::get<ExternalLeadExtensionCurrentClosure>(request.closure);
        require(request.external_lead_coupled_solve,
            "external lead requires the explicit coupled-solve mode");
        require(request.periodic_charge_potential == nullptr,
            "external-lead solve cannot reuse a separately solved periodic potential");
        const auto topology = validate_external_lead_closure(*request.mesh,
            request.stable_vertex_identities, device_boundaries, external);
        auto mesh = std::make_unique<mfem::Mesh>(
            combine_disjoint_meshes(*request.mesh, *external.lead_mesh));
        StableMeshVertexIdentities ids;
        ids.version = request.stable_vertex_identities.version;
        ids.local_to_stable = request.stable_vertex_identities.local_to_stable;
        ids.local_to_stable.insert(ids.local_to_stable.end(),
            external.lead_vertex_identities.local_to_stable.begin(),
            external.lead_vertex_identities.local_to_stable.end());
        validate_affine_tetrahedral_mesh(*mesh);
        validate_stable_ids(*mesh, ids);
        mfem::H1_FECollection h1_collection(1, 3);
        mfem::FiniteElementSpace h1_space(mesh.get(), &h1_collection);
        CombinedConductivity conductivity(
            request.mesh->GetNE(), *request.conductivity,
            *external.lead_conductivity);
        auto potential = solve_external_lead_potential(*mesh, h1_space, ids,
            request.mesh->GetNV(), request.mesh->GetNE(),
            request.stable_vertex_identities, external, conductivity,
            request.algebraic_relative_tolerance);
        auto collection = std::make_unique<mfem::RT_FECollection>(0, 3);
        auto space = std::make_unique<mfem::FiniteElementSpace>(
            mesh.get(), collection.get());
        auto field = std::make_unique<mfem::GridFunction>(space.get());
        PotentialCurrentCoefficient current(*potential, conductivity);
        field->ProjectCoefficient(current);
        data = finalize_view_data(std::move(mesh), std::move(ids),
            std::move(collection), std::move(space), std::move(field),
            request.identity, topology.revision, topology.digest,
            topology.pairs, topology.terminal_faces, topology.terminal_id,
            request.algebraic_relative_tolerance,
            request.physical_relative_gate, request.physical_absolute_gate_a,
            request.reference_mpi_gather_broadcast);
    }
    auto impl = std::make_unique<Impl>();
    impl->mesh = std::move(data.mesh);
    impl->collection = std::move(data.collection);
    impl->space = std::move(data.space);
    impl->field = std::move(data.field);
    impl->stable_ids = std::move(data.stable_ids);
    impl->identity = std::move(data.identity);
    impl->balance = data.balance;
    impl->rank_certificate = std::move(data.rank_certificate);
    impl->records = std::move(data.records);
    impl->balance_bytes = std::move(data.balance_bytes);
    impl->global_and_broadcast = data.global_and_broadcast;
    return Ptr(new ConservativeCurrentView(std::move(impl)));
}

const mfem::FiniteElementSpace &ConservativeCurrentView::space() const
{
    return *impl_->space;
}

const mfem::GridFunction &ConservativeCurrentView::field() const
{
    return *impl_->field;
}

const ConservativeCurrentIdentity &ConservativeCurrentView::identity() const
{
    return impl_->identity;
}

const ConservativeCurrentBalanceCertificate &ConservativeCurrentView::balance() const
{
    return impl_->balance;
}

const ConstraintRankCertificate &
ConservativeCurrentView::constraint_rank_certificate() const
{
    return impl_->rank_certificate;
}

const std::vector<CanonicalFaceFluxRecord> &
ConservativeCurrentView::canonical_face_flux_records() const
{
    return impl_->records;
}

const std::vector<std::uint8_t> &
ConservativeCurrentView::canonical_balance_certificate_bytes() const
{
    return impl_->balance_bytes;
}

bool ConservativeCurrentView::
canonical_face_flux_records_are_global_and_broadcast() const
{
    return impl_->global_and_broadcast;
}

ConservativeCurrentViewOwner::ConservativeCurrentViewOwner(
    mfem::GridFunction &nodal_visualization)
    : nodal_visualization_(&nodal_visualization)
{
}

ConservativeCurrentViewOwner::~ConservativeCurrentViewOwner() = default;

ConservativeCurrentView::Ptr
ConservativeCurrentViewOwner::conservative_charge_current() const
{
    return std::atomic_load(&accepted_);
}

const mfem::GridFunction &
ConservativeCurrentViewOwner::charge_current_density() const
{
    if (!nodal_visualization_) reject("current visualization borrow is null");
    return *nodal_visualization_;
}

void ConservativeCurrentViewOwner::publish_accepted(
    ConservativeCurrentView::Ptr accepted)
{
    if (!accepted) reject("cannot publish a null conservative current view");
    std::atomic_store(&accepted_, std::move(accepted));
}

} // namespace fullmag::fem::transport
