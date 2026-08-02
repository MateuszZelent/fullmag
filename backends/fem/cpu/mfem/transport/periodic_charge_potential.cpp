#include "cpu/mfem/transport/periodic_charge_potential.hpp"

#include <mfem.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <map>
#include <memory>
#include <numeric>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace fullmag::fem::transport {
namespace {

constexpr const char *kOperatorVersion = "fem_charge_h1_periodic_jump.v1";

using FaceKey = std::array<std::uint64_t, 3>;
struct DisjointSet {
    explicit DisjointSet(int size)
        : parent(static_cast<std::size_t>(size)),
          rank(static_cast<std::size_t>(size), 0)
    {
        std::iota(parent.begin(), parent.end(), 0);
    }

    int find(int value)
    {
        int &next = parent.at(static_cast<std::size_t>(value));
        if (next != value) {
            next = find(next);
        }
        return next;
    }

    void unite(int left, int right)
    {
        left = find(left);
        right = find(right);
        if (left == right) {
            return;
        }
        auto &left_rank = rank.at(static_cast<std::size_t>(left));
        auto &right_rank = rank.at(static_cast<std::size_t>(right));
        if (left_rank < right_rank) {
            std::swap(left, right);
        }
        parent.at(static_cast<std::size_t>(right)) = left;
        if (left_rank == right_rank) {
            ++left_rank;
        }
    }

    std::vector<int> parent;
    std::vector<unsigned char> rank;
};

double norm3(const std::array<double, 3> &value)
{
    return std::sqrt(value[0] * value[0] + value[1] * value[1] +
        value[2] * value[2]);
}

std::array<double, 3> vertex_coordinate(const mfem::Mesh &mesh, int vertex)
{
    const double *coordinate = mesh.GetVertex(vertex);
    return {coordinate[0], coordinate[1], coordinate[2]};
}

std::array<double, 3> subtract(
    const std::array<double, 3> &left,
    const std::array<double, 3> &right)
{
    return {left[0] - right[0], left[1] - right[1], left[2] - right[2]};
}

double dot(
    const std::array<double, 3> &left,
    const std::array<double, 3> &right)
{
    return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

std::array<double, 3> cross(
    const std::array<double, 3> &left,
    const std::array<double, 3> &right)
{
    return {
        left[1] * right[2] - left[2] * right[1],
        left[2] * right[0] - left[0] * right[2],
        left[0] * right[1] - left[1] * right[0],
    };
}

double coordinate_scale(const mfem::Mesh &mesh)
{
    double scale = 1.0;
    for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) {
        const auto coordinate = vertex_coordinate(mesh, vertex);
        scale = std::max(scale, std::abs(coordinate[0]));
        scale = std::max(scale, std::abs(coordinate[1]));
        scale = std::max(scale, std::abs(coordinate[2]));
    }
    return scale;
}

double geometry_tolerance(const mfem::Mesh &mesh)
{
    return 256.0 * std::numeric_limits<double>::epsilon() *
        coordinate_scale(mesh);
}

void require_finite_string(const std::string &value, const char *name)
{
    if (value.empty()) {
        throw std::invalid_argument(std::string(name) + " must be nonempty");
    }
}

FaceKey sorted_face_key(
    const mfem::Mesh &mesh,
    const StableMeshVertexIdentities &identities,
    int boundary_element)
{
    int face = -1;
    int orientation = 0;
    mesh.GetBdrElementFace(boundary_element, &face, &orientation);
    if (face < 0) {
        throw std::invalid_argument(
            "classified boundary element has no physical mesh face");
    }
    int first_element = -1;
    int second_element = -1;
    mesh.GetFaceElements(face, &first_element, &second_element);
    if (first_element < 0 || second_element >= 0) {
        throw std::invalid_argument(
            "classified boundary key is not a one-sided physical boundary face");
    }
    mfem::Array<int> vertices;
    mesh.GetBdrElementVertices(boundary_element, vertices);
    if (vertices.Size() != 3) {
        throw std::invalid_argument(
            "periodic source cut requires triangular boundary faces");
    }
    FaceKey key{
        identities.local_to_stable.at(static_cast<std::size_t>(vertices[0])),
        identities.local_to_stable.at(static_cast<std::size_t>(vertices[1])),
        identities.local_to_stable.at(static_cast<std::size_t>(vertices[2])),
    };
    std::sort(key.begin(), key.end());
    if (key[0] == 0 || key[0] == key[1] || key[1] == key[2]) {
        throw std::invalid_argument(
            "boundary face has invalid stable vertex identities");
    }
    (void)orientation;
    return key;
}

std::array<double, 3> element_centroid(const mfem::Mesh &mesh, int element)
{
    mfem::Array<int> vertices;
    mesh.GetElementVertices(element, vertices);
    std::array<double, 3> centroid{};
    for (int index = 0; index < vertices.Size(); ++index) {
        const auto coordinate = vertex_coordinate(mesh, vertices[index]);
        for (int component = 0; component < 3; ++component) {
            centroid[component] += coordinate[component];
        }
    }
    for (double &component : centroid) {
        component /= static_cast<double>(vertices.Size());
    }
    return centroid;
}

std::array<double, 3> boundary_centroid(
    const mfem::Mesh &mesh,
    int boundary_element)
{
    mfem::Array<int> vertices;
    mesh.GetBdrElementVertices(boundary_element, vertices);
    std::array<double, 3> centroid{};
    for (int index = 0; index < vertices.Size(); ++index) {
        const auto coordinate = vertex_coordinate(mesh, vertices[index]);
        for (int component = 0; component < 3; ++component) {
            centroid[component] += coordinate[component];
        }
    }
    for (double &component : centroid) {
        component /= static_cast<double>(vertices.Size());
    }
    return centroid;
}

std::array<double, 3> outward_unit_normal(
    mfem::Mesh &mesh,
    int boundary_element)
{
    mfem::Array<int> vertices;
    mesh.GetBdrElementVertices(boundary_element, vertices);
    const auto p0 = vertex_coordinate(mesh, vertices[0]);
    const auto p1 = vertex_coordinate(mesh, vertices[1]);
    const auto p2 = vertex_coordinate(mesh, vertices[2]);
    auto normal = cross(subtract(p1, p0), subtract(p2, p0));
    const double magnitude = norm3(normal);
    if (!(std::isfinite(magnitude) && magnitude > 0.0)) {
        throw std::invalid_argument("periodic source-cut face is degenerate");
    }
    int adjacent_element = -1;
    int face_info = 0;
    mesh.GetBdrElementAdjacentElement(
        boundary_element, adjacent_element, face_info);
    if (adjacent_element < 0) {
        throw std::invalid_argument(
            "periodic source-cut face has no adjacent volume element");
    }
    const auto inward = subtract(
        element_centroid(mesh, adjacent_element),
        boundary_centroid(mesh, boundary_element));
    if (dot(normal, inward) > 0.0) {
        for (double &component : normal) {
            component = -component;
        }
    }
    for (double &component : normal) {
        component /= magnitude;
    }
    return normal;
}

std::vector<std::pair<int, int>> match_pair_vertices(
    const mfem::Mesh &mesh,
    const StableMeshVertexIdentities &identities,
    int minus_boundary,
    int plus_boundary,
    const std::array<double, 3> &translation,
    double tolerance)
{
    mfem::Array<int> minus_vertices;
    mfem::Array<int> plus_vertices;
    mesh.GetBdrElementVertices(minus_boundary, minus_vertices);
    mesh.GetBdrElementVertices(plus_boundary, plus_vertices);
    if (minus_vertices.Size() != 3 || plus_vertices.Size() != 3) {
        throw std::invalid_argument(
            "periodic source cut requires triangular face pairs");
    }
    std::vector<std::pair<int, int>> result;
    std::set<int> used_plus;
    for (int minus_index = 0; minus_index < minus_vertices.Size(); ++minus_index) {
        const int minus_vertex = minus_vertices[minus_index];
        const auto minus_coordinate = vertex_coordinate(mesh, minus_vertex);
        int match = -1;
        for (int plus_index = 0; plus_index < plus_vertices.Size(); ++plus_index) {
            const int plus_vertex = plus_vertices[plus_index];
            if (used_plus.count(plus_vertex) != 0) {
                continue;
            }
            const auto plus_coordinate = vertex_coordinate(mesh, plus_vertex);
            double error = 0.0;
            for (int component = 0; component < 3; ++component) {
                error = std::max(error, std::abs(
                    plus_coordinate[component] - minus_coordinate[component] -
                    translation[component]));
            }
            if (error <= tolerance) {
                if (match >= 0) {
                    throw std::invalid_argument(
                        "periodic source-cut vertex translation is ambiguous");
                }
                match = plus_vertex;
            }
        }
        if (match < 0) {
            throw std::invalid_argument(
                "periodic source-cut faces do not match the declared translation");
        }
        used_plus.insert(match);
        result.emplace_back(minus_vertex, match);
    }
    if (used_plus.size() != 3) {
        throw std::invalid_argument(
            "periodic source-cut vertex pairing is not bijective");
    }
    (void)identities;
    return result;
}

void validate_affine_tetrahedral_mesh(mfem::Mesh &mesh)
{
    if (mesh.Dimension() != 3 || mesh.SpaceDimension() != 3 ||
        mesh.GetNV() <= 0 || mesh.GetNE() <= 0 || mesh.GetNBE() <= 0) {
        throw std::invalid_argument(
            "periodic charge v1 requires a nonempty three-dimensional mesh");
    }
    if (mesh.GetNodes() != nullptr) {
        throw std::invalid_argument(
            "periodic charge v1 requires straight affine tetrahedra");
    }
    const double scale = coordinate_scale(mesh);
    const double determinant_floor =
        4096.0 * std::numeric_limits<double>::epsilon() * scale * scale * scale;
    for (int element = 0; element < mesh.GetNE(); ++element) {
        if (mesh.GetElementBaseGeometry(element) != mfem::Geometry::TETRAHEDRON) {
            throw std::invalid_argument(
                "periodic charge v1 accepts tetrahedral elements only");
        }
        mfem::Array<int> vertices;
        mesh.GetElementVertices(element, vertices);
        if (vertices.Size() != 4) {
            throw std::invalid_argument("invalid tetrahedral element vertex count");
        }
        std::set<int> unique(vertices.begin(), vertices.end());
        if (unique.size() != 4) {
            throw std::invalid_argument("tetrahedral element repeats a vertex");
        }
        const auto p0 = vertex_coordinate(mesh, vertices[0]);
        const auto p1 = vertex_coordinate(mesh, vertices[1]);
        const auto p2 = vertex_coordinate(mesh, vertices[2]);
        const auto p3 = vertex_coordinate(mesh, vertices[3]);
        const double determinant = dot(
            subtract(p1, p0), cross(subtract(p2, p0), subtract(p3, p0)));
        if (!(std::isfinite(determinant) &&
                std::abs(determinant) > determinant_floor)) {
            throw std::invalid_argument(
                "periodic charge v1 rejects degenerate tetrahedra");
        }
    }
}

void validate_conductivity(mfem::Mesh &mesh, mfem::Coefficient &conductivity)
{
    for (int element = 0; element < mesh.GetNE(); ++element) {
        auto *transformation = mesh.GetElementTransformation(element);
        const auto &rule = mfem::IntRules.Get(
            mesh.GetElementBaseGeometry(element), 4);
        for (int point_index = 0; point_index < rule.GetNPoints(); ++point_index) {
            const auto &point = rule.IntPoint(point_index);
            transformation->SetIntPoint(&point);
            const double value = conductivity.Eval(*transformation, point);
            if (!(std::isfinite(value) && value > 0.0)) {
                throw std::invalid_argument(
                    "periodic charge conductivity must be finite and positive");
            }
        }
    }
}

double independent_relative_residual(
    const mfem::SparseMatrix &matrix,
    const mfem::Vector &solution,
    const mfem::Vector &rhs)
{
    mfem::Vector residual(rhs.Size());
    matrix.Mult(solution, residual);
    residual -= rhs;
    const double denominator = std::max(rhs.Norml2(), 1.0e-30);
    return residual.Norml2() / denominator;
}

#if defined(MFEM_USE_MPI)
template <typename Record>
std::vector<Record> gather_records_to_root(
    MPI_Comm communicator,
    const std::vector<Record> &local,
    int root)
{
    int rank = 0;
    int size = 0;
    MPI_Comm_rank(communicator, &rank);
    MPI_Comm_size(communicator, &size);
    if (local.size() > static_cast<std::size_t>(
            std::numeric_limits<int>::max() / sizeof(Record))) {
        throw std::runtime_error("MPI reference record payload exceeds INT_MAX");
    }
    const int local_bytes = static_cast<int>(local.size() * sizeof(Record));
    std::vector<int> byte_counts(rank == root ? size : 0);
    MPI_Gather(&local_bytes, 1, MPI_INT,
        rank == root ? byte_counts.data() : nullptr, 1, MPI_INT,
        root, communicator);
    std::vector<int> displacements(rank == root ? size : 0);
    int total_bytes = 0;
    if (rank == root) {
        for (int source = 0; source < size; ++source) {
            if (byte_counts[source] < 0 ||
                total_bytes > std::numeric_limits<int>::max() -
                    byte_counts[source]) {
                throw std::runtime_error(
                    "MPI reference gathered record payload exceeds INT_MAX");
            }
            displacements[source] = total_bytes;
            total_bytes += byte_counts[source];
        }
        if (total_bytes % static_cast<int>(sizeof(Record)) != 0) {
            throw std::runtime_error("MPI reference record payload is misaligned");
        }
    }
    std::vector<Record> gathered(rank == root
        ? static_cast<std::size_t>(total_bytes) / sizeof(Record)
        : 0);
    MPI_Gatherv(local.empty() ? nullptr : local.data(), local_bytes, MPI_BYTE,
        rank == root && !gathered.empty() ? gathered.data() : nullptr,
        rank == root ? byte_counts.data() : nullptr,
        rank == root ? displacements.data() : nullptr,
        MPI_BYTE, root, communicator);
    return gathered;
}

void broadcast_bytes(
    MPI_Comm communicator,
    std::vector<unsigned char> &bytes,
    int root)
{
    int rank = 0;
    MPI_Comm_rank(communicator, &rank);
    std::uint64_t size = rank == root
        ? static_cast<std::uint64_t>(bytes.size()) : 0;
    MPI_Bcast(&size, 1, MPI_UINT64_T, root, communicator);
    if (size > static_cast<std::uint64_t>(std::numeric_limits<int>::max())) {
        throw std::runtime_error("MPI reference broadcast payload exceeds INT_MAX");
    }
    if (rank != root) {
        bytes.resize(static_cast<std::size_t>(size));
    }
    MPI_Bcast(bytes.empty() ? nullptr : bytes.data(), static_cast<int>(size),
        MPI_BYTE, root, communicator);
}

struct MpiVertexRecord {
    HYPRE_BigInt global_index = -1;
    std::uint64_t stable_id = 0;
    double coordinate[3]{};
};

struct MpiElementRecord {
    HYPRE_BigInt global_index = -1;
    std::uint64_t stable_vertices[4]{};
    double conductivity = 0.0;
};

struct MpiBoundaryRecord {
    std::uint64_t stable_vertices[3]{};
    std::uint8_t role = 0;
};
#endif

double integrate_boundary_flux(
    mfem::Mesh &mesh,
    const mfem::GridFunction &potential,
    mfem::Coefficient &conductivity,
    int boundary_element)
{
    int adjacent_element = -1;
    int face_info = 0;
    mesh.GetBdrElementAdjacentElement(
        boundary_element, adjacent_element, face_info);
    if (adjacent_element < 0) {
        throw std::invalid_argument(
            "periodic boundary face has no adjacent element");
    }
    auto *boundary_transformation =
        mesh.GetBdrElementTransformation(boundary_element);
    auto *element_transformation =
        mesh.GetElementTransformation(adjacent_element);
    mfem::InverseElementTransformation inverse(element_transformation);
    const auto normal = outward_unit_normal(mesh, boundary_element);
    const auto &rule = mfem::IntRules.Get(mfem::Geometry::TRIANGLE, 4);
    double flux = 0.0;
    for (int point_index = 0; point_index < rule.GetNPoints(); ++point_index) {
        const auto &boundary_point = rule.IntPoint(point_index);
        mfem::Vector physical(3);
        boundary_transformation->Transform(boundary_point, physical);
        mfem::IntegrationPoint element_point;
        if (inverse.Transform(physical, element_point) !=
                mfem::InverseElementTransformation::Inside) {
            throw std::runtime_error(
                "cannot map periodic boundary quadrature point to its element");
        }
        element_transformation->SetIntPoint(&element_point);
        mfem::Vector gradient(3);
        potential.GetGradient(*element_transformation, gradient);
        const double sigma = conductivity.Eval(
            *element_transformation, element_point);
        const double normal_gradient = gradient[0] * normal[0] +
            gradient[1] * normal[1] + gradient[2] * normal[2];
        boundary_transformation->SetIntPoint(&boundary_point);
        flux += boundary_point.weight * boundary_transformation->Weight() *
            sigma * normal_gradient;
    }
    return flux;
}

} // namespace

class PeriodicChargePotentialSnapshot::Impl {
public:
    explicit Impl(std::unique_ptr<mfem::Mesh> owned_mesh)
        : mesh(std::move(owned_mesh)),
          collection(std::make_unique<mfem::H1_FECollection>(1, 3)),
          space(std::make_unique<mfem::FiniteElementSpace>(
              mesh.get(), collection.get())),
          field(std::make_unique<mfem::GridFunction>(space.get()))
    {
    }

    std::unique_ptr<mfem::Mesh> mesh;
    std::unique_ptr<mfem::H1_FECollection> collection;
    std::unique_ptr<mfem::FiniteElementSpace> space;
    std::unique_ptr<mfem::GridFunction> field;
    StableMeshVertexIdentities stable_ids;
    std::string operator_version;
    bool converged = false;
    double relative_residual = std::numeric_limits<double>::infinity();
    double potential_jump = 0.0;
    double gauge_mean = 0.0;
    double paired_flux_mismatch = std::numeric_limits<double>::infinity();
    std::string mesh_revision;
    std::string geometry_digest;
    std::string conductivity_digest;
    std::string source_cut_digest;
    std::string source_module_id;
    std::string source_state_revision;
    std::string source_field_digest;
    double evaluation_time = 0.0;
    std::uint64_t stage_identity = 0;
    std::string envelope_revision;
    std::string envelope_digest;
    double envelope_multiplier = 1.0;
};

PeriodicChargePotentialSnapshot::PeriodicChargePotentialSnapshot(
    std::unique_ptr<Impl> impl)
    : impl_(std::move(impl))
{
}

PeriodicChargePotentialSnapshot::~PeriodicChargePotentialSnapshot() = default;

const mfem::FiniteElementSpace &
PeriodicChargePotentialSnapshot::potential_space() const
{
    return *impl_->space;
}

const mfem::GridFunction &
PeriodicChargePotentialSnapshot::potential_field() const
{
    return *impl_->field;
}

const StableMeshVertexIdentities &
PeriodicChargePotentialSnapshot::stable_vertex_identities() const
{
    return impl_->stable_ids;
}

const std::string &PeriodicChargePotentialSnapshot::operator_version() const
{
    return impl_->operator_version;
}

bool PeriodicChargePotentialSnapshot::converged() const
{
    return impl_->converged;
}

double PeriodicChargePotentialSnapshot::algebraic_relative_residual() const
{
    return impl_->relative_residual;
}

double PeriodicChargePotentialSnapshot::potential_jump_v() const
{
    return impl_->potential_jump;
}

double PeriodicChargePotentialSnapshot::gauge_mean_v() const
{
    return impl_->gauge_mean;
}

double PeriodicChargePotentialSnapshot::max_paired_weak_flux_mismatch_a() const
{
    return impl_->paired_flux_mismatch;
}

const std::string &PeriodicChargePotentialSnapshot::mesh_revision() const
{
    return impl_->mesh_revision;
}

const std::string &PeriodicChargePotentialSnapshot::geometry_digest() const
{
    return impl_->geometry_digest;
}

const std::string &PeriodicChargePotentialSnapshot::conductivity_digest() const
{
    return impl_->conductivity_digest;
}

const std::string &PeriodicChargePotentialSnapshot::source_cut_digest() const
{
    return impl_->source_cut_digest;
}

const std::string &PeriodicChargePotentialSnapshot::source_module_id() const
{
    return impl_->source_module_id;
}

const std::string &PeriodicChargePotentialSnapshot::source_state_revision() const
{
    return impl_->source_state_revision;
}

const std::string &PeriodicChargePotentialSnapshot::source_field_digest() const
{
    return impl_->source_field_digest;
}

double PeriodicChargePotentialSnapshot::evaluation_time_s() const
{
    return impl_->evaluation_time;
}

std::uint64_t PeriodicChargePotentialSnapshot::stage_identity() const
{
    return impl_->stage_identity;
}

const std::string &PeriodicChargePotentialSnapshot::envelope_revision() const
{
    return impl_->envelope_revision;
}

const std::string &PeriodicChargePotentialSnapshot::envelope_digest() const
{
    return impl_->envelope_digest;
}

double PeriodicChargePotentialSnapshot::evaluated_envelope_multiplier() const
{
    return impl_->envelope_multiplier;
}

std::shared_ptr<const PeriodicChargePotentialSnapshot>
PeriodicChargePotentialSolver::Solve(
    const PeriodicChargePotentialSolveRequest &request)
{
    if (request.mesh == nullptr || request.conductivity == nullptr) {
        throw std::invalid_argument(
            "periodic charge solve requires mesh and conductivity");
    }
    if (request.operator_version != kOperatorVersion) {
        throw std::invalid_argument(
            "periodic charge operator_version is unsupported");
    }
    require_finite_string(request.stable_vertex_identities.version,
        "stable vertex identity version");
    require_finite_string(request.source_cut.id, "source cut id");
    require_finite_string(request.source_module_id, "source module id");
    require_finite_string(request.source_state_revision, "source state revision");
    require_finite_string(request.source_field_digest, "source field digest");
    require_finite_string(request.envelope_revision, "envelope revision");
    require_finite_string(request.envelope_digest, "envelope digest");
    require_finite_string(request.mesh_revision, "mesh revision");
    require_finite_string(request.geometry_digest, "geometry digest");
    require_finite_string(request.conductivity_digest, "conductivity digest");
    require_finite_string(request.source_cut_digest, "source cut digest");
    if (!std::isfinite(request.source_cut.potential_drop_v) ||
        !std::isfinite(request.evaluation_time_s) ||
        request.evaluation_time_s < 0.0 ||
        !std::isfinite(request.evaluated_envelope_multiplier) ||
        !(std::isfinite(request.algebraic_relative_tolerance) &&
            request.algebraic_relative_tolerance > 0.0 &&
            request.algebraic_relative_tolerance < 1.0) ||
        request.maximum_iterations <= 0) {
        throw std::invalid_argument(
            "periodic charge request contains invalid finite/tolerance metadata");
    }
    for (double component : request.source_cut.translation_m) {
        if (!std::isfinite(component)) {
            throw std::invalid_argument(
                "periodic source-cut translation must be finite");
        }
    }
    if (!(norm3(request.source_cut.translation_m) > 0.0)) {
        throw std::invalid_argument(
            "periodic source-cut translation must be nonzero");
    }
    if (request.source_cut.face_pairs.empty()) {
        throw std::invalid_argument(
            "periodic source cut must contain at least one face pair");
    }

#if defined(MFEM_USE_MPI)
    if (auto *parallel_mesh = dynamic_cast<mfem::ParMesh *>(request.mesh)) {
        if (!request.reference_mpi_gather_rank0_broadcast) {
            throw std::runtime_error(
                "fem_charge_h1_periodic_jump.v1 requires explicit MPI reference gather-rank0-broadcast for ParMesh input");
        }
        const MPI_Comm communicator = parallel_mesh->GetComm();
        int rank = 0;
        MPI_Comm_rank(communicator, &rank);
        constexpr int root = 0;
        if (request.stable_vertex_identities.local_to_stable.size() !=
                static_cast<std::size_t>(parallel_mesh->GetNV())) {
            throw std::invalid_argument(
                "local stable vertex identity count does not match ParMesh");
        }

        mfem::Array<HYPRE_BigInt> global_vertex_indices;
        parallel_mesh->GetGlobalVertexIndices(global_vertex_indices);
        if (global_vertex_indices.Size() != parallel_mesh->GetNV()) {
            throw std::runtime_error(
                "MFEM global vertex index map does not cover local ParMesh vertices");
        }
        std::vector<MpiVertexRecord> local_vertices(
            static_cast<std::size_t>(parallel_mesh->GetNV()));
        for (int vertex = 0; vertex < parallel_mesh->GetNV(); ++vertex) {
            auto &record = local_vertices.at(static_cast<std::size_t>(vertex));
            record.global_index = global_vertex_indices[vertex];
            record.stable_id = request.stable_vertex_identities.local_to_stable.at(
                static_cast<std::size_t>(vertex));
            const auto coordinate = vertex_coordinate(*parallel_mesh, vertex);
            std::copy(coordinate.begin(), coordinate.end(), record.coordinate);
            if (record.global_index < 0 || record.stable_id == 0 ||
                !std::isfinite(record.coordinate[0]) ||
                !std::isfinite(record.coordinate[1]) ||
                !std::isfinite(record.coordinate[2])) {
                throw std::invalid_argument(
                    "MPI reference vertex record is invalid");
            }
        }

        std::vector<MpiElementRecord> local_elements(
            static_cast<std::size_t>(parallel_mesh->GetNE()));
        for (int element = 0; element < parallel_mesh->GetNE(); ++element) {
            if (parallel_mesh->GetElementBaseGeometry(element) !=
                    mfem::Geometry::TETRAHEDRON) {
                throw std::invalid_argument(
                    "MPI periodic charge v1 accepts tetrahedra only");
            }
            mfem::Array<int> vertices;
            parallel_mesh->GetElementVertices(element, vertices);
            if (vertices.Size() != 4) {
                throw std::invalid_argument(
                    "MPI periodic charge element is not tetrahedral");
            }
            auto &record = local_elements.at(static_cast<std::size_t>(element));
            record.global_index = parallel_mesh->GetGlobalElementNum(element);
            for (int local = 0; local < 4; ++local) {
                record.stable_vertices[local] =
                    request.stable_vertex_identities.local_to_stable.at(
                        static_cast<std::size_t>(vertices[local]));
            }
            std::sort(std::begin(record.stable_vertices),
                std::end(record.stable_vertices));
            auto *transformation = parallel_mesh->GetElementTransformation(element);
            const auto &rule = mfem::IntRules.Get(
                mfem::Geometry::TETRAHEDRON, 4);
            double first_value = 0.0;
            for (int point_index = 0; point_index < rule.GetNPoints();
                    ++point_index) {
                const auto &point = rule.IntPoint(point_index);
                transformation->SetIntPoint(&point);
                const double value = request.conductivity->Eval(
                    *transformation, point);
                if (!(std::isfinite(value) && value > 0.0)) {
                    throw std::invalid_argument(
                        "MPI reference conductivity must be finite and positive");
                }
                if (point_index == 0) {
                    first_value = value;
                } else if (std::abs(value - first_value) >
                        256.0 * std::numeric_limits<double>::epsilon() *
                            std::max({1.0, std::abs(value),
                                std::abs(first_value)})) {
                    throw std::invalid_argument(
                        "MPI reference conductivity must be elementwise constant");
                }
            }
            record.conductivity = first_value;
        }

        if (request.boundary_faces.size() !=
                static_cast<std::size_t>(parallel_mesh->GetNBE())) {
            throw std::invalid_argument(
                "MPI reference requires every local physical boundary face classification");
        }
        std::vector<MpiBoundaryRecord> local_boundaries;
        local_boundaries.reserve(request.boundary_faces.size());
        std::set<int> classified_local_boundaries;
        for (const auto &classification : request.boundary_faces) {
            if (classification.boundary_element < 0 ||
                classification.boundary_element >= parallel_mesh->GetNBE() ||
                !classified_local_boundaries.insert(
                    classification.boundary_element).second) {
                throw std::invalid_argument(
                    "MPI boundary classifications are incomplete or duplicated");
            }
            if (classification.role ==
                    ConservativeCurrentBoundaryRole::SourceCut) {
                if (classification.circuit_id != request.source_cut.id) {
                    throw std::invalid_argument(
                        "MPI source-cut boundary has the wrong circuit id");
                }
            } else if (classification.role ==
                    ConservativeCurrentBoundaryRole::InsulatingOuter) {
                if (!classification.circuit_id.empty()) {
                    throw std::invalid_argument(
                        "MPI insulating boundary carries a circuit id");
                }
            } else {
                throw std::invalid_argument(
                    "MPI periodic charge v1 received an unsupported boundary role");
            }
            const auto face_key = sorted_face_key(*parallel_mesh,
                request.stable_vertex_identities,
                classification.boundary_element);
            MpiBoundaryRecord record;
            std::copy(face_key.begin(), face_key.end(), record.stable_vertices);
            record.role = static_cast<std::uint8_t>(classification.role);
            local_boundaries.push_back(record);
        }

        mfem::Mesh serial_mesh = parallel_mesh->GetSerialMesh(root);
        const auto gathered_vertices = gather_records_to_root(
            communicator, local_vertices, root);
        const auto gathered_elements = gather_records_to_root(
            communicator, local_elements, root);
        const auto gathered_boundaries = gather_records_to_root(
            communicator, local_boundaries, root);

        std::shared_ptr<const PeriodicChargePotentialSnapshot> root_snapshot;
        std::vector<unsigned char> error_bytes;
        if (rank == root) {
            try {
                validate_affine_tetrahedral_mesh(serial_mesh);
                StableMeshVertexIdentities serial_ids;
                serial_ids.version = request.stable_vertex_identities.version;
                serial_ids.local_to_stable.assign(
                    static_cast<std::size_t>(serial_mesh.GetNV()), 0);
                const double coordinate_gate = geometry_tolerance(serial_mesh);
                for (const auto &record : gathered_vertices) {
                    if (record.global_index < 0 ||
                        record.global_index >= serial_mesh.GetNV()) {
                        throw std::runtime_error(
                            "MPI global vertex index is outside the serial mesh");
                    }
                    const auto index = static_cast<std::size_t>(record.global_index);
                    auto &stable_id = serial_ids.local_to_stable.at(index);
                    if (stable_id != 0 && stable_id != record.stable_id) {
                        throw std::runtime_error(
                            "MPI shared vertex has inconsistent stable identities");
                    }
                    stable_id = record.stable_id;
                    const auto coordinate = vertex_coordinate(
                        serial_mesh, static_cast<int>(record.global_index));
                    for (int component = 0; component < 3; ++component) {
                        if (std::abs(coordinate[component] -
                                record.coordinate[component]) > coordinate_gate) {
                            throw std::runtime_error(
                                "MFEM serial mesh vertex ordering disagrees with global indices");
                        }
                    }
                }
                std::set<std::uint64_t> global_stable_ids;
                for (const auto stable_id : serial_ids.local_to_stable) {
                    if (stable_id == 0 ||
                        !global_stable_ids.insert(stable_id).second) {
                        throw std::runtime_error(
                            "MPI global stable vertex map is incomplete or duplicated");
                    }
                }

                using ElementKey = std::array<std::uint64_t, 4>;
                std::map<ElementKey, double> conductivity_by_element;
                for (const auto &record : gathered_elements) {
                    ElementKey key;
                    std::copy(std::begin(record.stable_vertices),
                        std::end(record.stable_vertices), key.begin());
                    const auto insertion = conductivity_by_element.emplace(
                        key, record.conductivity);
                    if (!insertion.second &&
                        insertion.first->second != record.conductivity) {
                        throw std::runtime_error(
                            "MPI element conductivity records disagree");
                    }
                }
                mfem::Vector serial_conductivity(serial_mesh.GetNE());
                for (int element = 0; element < serial_mesh.GetNE(); ++element) {
                    mfem::Array<int> vertices;
                    serial_mesh.GetElementVertices(element, vertices);
                    ElementKey key;
                    for (int local = 0; local < 4; ++local) {
                        key[local] = serial_ids.local_to_stable.at(
                            static_cast<std::size_t>(vertices[local]));
                    }
                    std::sort(key.begin(), key.end());
                    const auto found = conductivity_by_element.find(key);
                    if (found == conductivity_by_element.end()) {
                        throw std::runtime_error(
                            "MPI conductivity map does not cover the serial mesh");
                    }
                    serial_mesh.GetElement(element)->SetAttribute(element + 1);
                    serial_conductivity[element] = found->second;
                }
                if (conductivity_by_element.size() !=
                        static_cast<std::size_t>(serial_mesh.GetNE())) {
                    throw std::runtime_error(
                        "MPI conductivity map contains duplicate or extra elements");
                }
                mfem::PWConstCoefficient conductivity(serial_conductivity);

                std::map<FaceKey, ConservativeCurrentBoundaryRole>
                    role_by_face;
                for (const auto &record : gathered_boundaries) {
                    FaceKey key;
                    std::copy(std::begin(record.stable_vertices),
                        std::end(record.stable_vertices), key.begin());
                    const auto role = static_cast<ConservativeCurrentBoundaryRole>(
                        record.role);
                    const auto insertion = role_by_face.emplace(key, role);
                    if (!insertion.second && insertion.first->second != role) {
                        throw std::runtime_error(
                            "MPI physical boundary role records disagree");
                    }
                }
                std::vector<ConservativeCurrentBoundaryFace> serial_boundaries;
                serial_boundaries.reserve(
                    static_cast<std::size_t>(serial_mesh.GetNBE()));
                for (int boundary = 0; boundary < serial_mesh.GetNBE(); ++boundary) {
                    const FaceKey key = sorted_face_key(
                        serial_mesh, serial_ids, boundary);
                    const auto found = role_by_face.find(key);
                    if (found == role_by_face.end()) {
                        throw std::runtime_error(
                            "MPI boundary role map does not cover the serial mesh");
                    }
                    ConservativeCurrentBoundaryFace classification;
                    classification.boundary_element = boundary;
                    classification.role = found->second;
                    if (found->second ==
                            ConservativeCurrentBoundaryRole::SourceCut) {
                        classification.circuit_id = request.source_cut.id;
                    }
                    serial_boundaries.push_back(std::move(classification));
                }
                if (role_by_face.size() !=
                        static_cast<std::size_t>(serial_mesh.GetNBE())) {
                    throw std::runtime_error(
                        "MPI boundary role map contains duplicate or extra faces");
                }

                auto serial_request = request;
                serial_request.mesh = &serial_mesh;
                serial_request.conductivity = &conductivity;
                serial_request.stable_vertex_identities = std::move(serial_ids);
                serial_request.boundary_faces = std::move(serial_boundaries);
                serial_request.reference_mpi_gather_rank0_broadcast = false;
                root_snapshot = Solve(serial_request);
            } catch (const std::exception &error) {
                const std::string message = error.what();
                error_bytes.assign(message.begin(), message.end());
            }
        }
        broadcast_bytes(communicator, error_bytes, root);
        if (!error_bytes.empty()) {
            throw std::runtime_error(std::string(
                error_bytes.begin(), error_bytes.end()));
        }

        std::vector<unsigned char> mesh_bytes;
        std::vector<unsigned char> stable_bytes;
        std::vector<unsigned char> field_bytes;
        std::array<std::string, 11> metadata;
        std::array<double, 6> diagnostics{};
        std::uint64_t broadcast_stage_identity = 0;
        if (rank == root) {
            std::ostringstream stream;
            root_snapshot->potential_space().GetMesh()->Print(stream);
            const std::string serialized_mesh = stream.str();
            mesh_bytes.assign(serialized_mesh.begin(), serialized_mesh.end());
            const auto &ids = root_snapshot->stable_vertex_identities().
                local_to_stable;
            stable_bytes.resize(ids.size() * sizeof(std::uint64_t));
            std::memcpy(stable_bytes.data(), ids.data(), stable_bytes.size());
            const auto &field = root_snapshot->potential_field();
            field_bytes.resize(
                static_cast<std::size_t>(field.Size()) * sizeof(double));
            std::memcpy(field_bytes.data(), field.GetData(), field_bytes.size());
            diagnostics = {
                root_snapshot->algebraic_relative_residual(),
                root_snapshot->potential_jump_v(),
                root_snapshot->gauge_mean_v(),
                root_snapshot->max_paired_weak_flux_mismatch_a(),
                root_snapshot->evaluation_time_s(),
                root_snapshot->evaluated_envelope_multiplier(),
            };
            metadata = {
                root_snapshot->operator_version(),
                root_snapshot->stable_vertex_identities().version,
                root_snapshot->mesh_revision(),
                root_snapshot->geometry_digest(),
                root_snapshot->conductivity_digest(),
                root_snapshot->source_cut_digest(),
                root_snapshot->source_module_id(),
                root_snapshot->source_state_revision(),
                root_snapshot->source_field_digest(),
                root_snapshot->envelope_revision(),
                root_snapshot->envelope_digest(),
            };
            broadcast_stage_identity = root_snapshot->stage_identity();
        }
        broadcast_bytes(communicator, mesh_bytes, root);
        broadcast_bytes(communicator, stable_bytes, root);
        broadcast_bytes(communicator, field_bytes, root);
        MPI_Bcast(diagnostics.data(), static_cast<int>(diagnostics.size()),
            MPI_DOUBLE, root, communicator);
        MPI_Bcast(&broadcast_stage_identity, 1, MPI_UINT64_T,
            root, communicator);
        for (auto &value : metadata) {
            std::vector<unsigned char> value_bytes;
            if (rank == root) {
                value_bytes.assign(value.begin(), value.end());
            }
            broadcast_bytes(communicator, value_bytes, root);
            if (rank != root) {
                value.assign(value_bytes.begin(), value_bytes.end());
            }
        }
        if (rank == root) {
            return root_snapshot;
        }

        const std::string serialized_mesh(mesh_bytes.begin(), mesh_bytes.end());
        std::istringstream stream(serialized_mesh);
        auto broadcast_mesh = std::make_unique<mfem::Mesh>(stream, 1, 1, true);
        auto impl = std::make_unique<PeriodicChargePotentialSnapshot::Impl>(
            std::move(broadcast_mesh));
        if (stable_bytes.size() !=
                static_cast<std::size_t>(impl->mesh->GetNV()) *
                    sizeof(std::uint64_t) ||
            field_bytes.size() !=
                static_cast<std::size_t>(impl->field->Size()) * sizeof(double)) {
            throw std::runtime_error(
                "MPI broadcast snapshot dimensions do not match the serial mesh");
        }
        impl->stable_ids.version = metadata[1];
        impl->stable_ids.local_to_stable.resize(
            static_cast<std::size_t>(impl->mesh->GetNV()));
        std::memcpy(impl->stable_ids.local_to_stable.data(),
            stable_bytes.data(), stable_bytes.size());
        std::memcpy(impl->field->GetData(), field_bytes.data(), field_bytes.size());
        impl->operator_version = metadata[0];
        impl->converged = true;
        impl->relative_residual = diagnostics[0];
        impl->potential_jump = diagnostics[1];
        impl->gauge_mean = diagnostics[2];
        impl->paired_flux_mismatch = diagnostics[3];
        impl->mesh_revision = metadata[2];
        impl->geometry_digest = metadata[3];
        impl->conductivity_digest = metadata[4];
        impl->source_cut_digest = metadata[5];
        impl->source_module_id = metadata[6];
        impl->source_state_revision = metadata[7];
        impl->source_field_digest = metadata[8];
        impl->evaluation_time = diagnostics[4];
        impl->stage_identity = broadcast_stage_identity;
        impl->envelope_revision = metadata[9];
        impl->envelope_digest = metadata[10];
        impl->envelope_multiplier = diagnostics[5];
        return std::shared_ptr<const PeriodicChargePotentialSnapshot>(
            new PeriodicChargePotentialSnapshot(std::move(impl)));
    }
#else
    if (request.reference_mpi_gather_rank0_broadcast) {
        throw std::runtime_error(
            "fem_charge_h1_periodic_jump.v1 MPI reference requires an MPI-enabled MFEM build");
    }
#endif

    auto mesh = std::make_unique<mfem::Mesh>(*request.mesh);
    validate_affine_tetrahedral_mesh(*mesh);
    if (request.stable_vertex_identities.local_to_stable.size() !=
            static_cast<std::size_t>(mesh->GetNV())) {
        throw std::invalid_argument(
            "stable vertex identity count does not match the mesh");
    }
    std::set<std::uint64_t> unique_ids;
    for (int vertex = 0; vertex < mesh->GetNV(); ++vertex) {
        const auto identity = request.stable_vertex_identities.local_to_stable.at(
            static_cast<std::size_t>(vertex));
        if (identity == 0 || !unique_ids.insert(identity).second) {
            throw std::invalid_argument(
                "stable vertex identities must be unique and nonzero");
        }
    }
    validate_conductivity(*mesh, *request.conductivity);

    if (request.boundary_faces.size() !=
            static_cast<std::size_t>(mesh->GetNBE())) {
        throw std::invalid_argument(
            "periodic charge requires one classification per boundary face");
    }
    std::map<int, ConservativeCurrentBoundaryFace> boundary_classification;
    std::map<FaceKey, int> boundary_by_key;
    std::set<FaceKey> classified_cut_keys;
    for (const auto &classification : request.boundary_faces) {
        if (classification.boundary_element < 0 ||
            classification.boundary_element >= mesh->GetNBE() ||
            !boundary_classification.emplace(
                classification.boundary_element, classification).second) {
            throw std::invalid_argument(
                "boundary classifications must be complete and unique");
        }
        const FaceKey key = sorted_face_key(*mesh,
            request.stable_vertex_identities, classification.boundary_element);
        if (!boundary_by_key.emplace(key, classification.boundary_element).second) {
            throw std::invalid_argument("duplicate physical boundary face key");
        }
        switch (classification.role) {
        case ConservativeCurrentBoundaryRole::InsulatingOuter:
            if (!classification.circuit_id.empty()) {
                throw std::invalid_argument(
                    "insulating boundary face must not carry a circuit id");
            }
            break;
        case ConservativeCurrentBoundaryRole::SourceCut:
            if (classification.circuit_id != request.source_cut.id) {
                throw std::invalid_argument(
                    "source-cut boundary circuit id does not match the solve cut");
            }
            classified_cut_keys.insert(key);
            break;
        case ConservativeCurrentBoundaryRole::ClosureInterface:
            throw std::invalid_argument(
                "periodic charge v1 does not accept closure-interface boundaries");
        default:
            throw std::invalid_argument("unknown boundary role");
        }
    }

    const double translation_tolerance = std::max(
        geometry_tolerance(*mesh),
        1.0e-13 * std::max(1.0, norm3(request.source_cut.translation_m)));
    std::set<FaceKey> paired_cut_keys;
    std::vector<std::pair<int, int>> paired_vertices;
    std::vector<std::pair<int, int>> paired_boundaries;
    for (const auto &pair : request.source_cut.face_pairs) {
        FaceKey minus_key = pair.minus_face_vertex_ids;
        FaceKey plus_key = pair.plus_face_vertex_ids;
        if (!std::is_sorted(minus_key.begin(), minus_key.end()) ||
            !std::is_sorted(plus_key.begin(), plus_key.end()) ||
            minus_key[0] == 0 || plus_key[0] == 0 ||
            minus_key[0] == minus_key[1] || minus_key[1] == minus_key[2] ||
            plus_key[0] == plus_key[1] || plus_key[1] == plus_key[2]) {
            throw std::invalid_argument(
                "source-cut face keys must contain three sorted unique nonzero IDs");
        }
        const auto minus_found = boundary_by_key.find(minus_key);
        const auto plus_found = boundary_by_key.find(plus_key);
        if (minus_found == boundary_by_key.end() ||
            plus_found == boundary_by_key.end() ||
            classified_cut_keys.count(minus_key) == 0 ||
            classified_cut_keys.count(plus_key) == 0 ||
            !paired_cut_keys.insert(minus_key).second ||
            !paired_cut_keys.insert(plus_key).second) {
            throw std::invalid_argument(
                "source-cut face pairing is incomplete, repeated, or not physical");
        }
        auto vertex_pairs = match_pair_vertices(*mesh,
            request.stable_vertex_identities, minus_found->second,
            plus_found->second, request.source_cut.translation_m,
            translation_tolerance);
        paired_vertices.insert(
            paired_vertices.end(), vertex_pairs.begin(), vertex_pairs.end());
        const auto minus_normal = outward_unit_normal(*mesh, minus_found->second);
        const auto plus_normal = outward_unit_normal(*mesh, plus_found->second);
        const double normal_mismatch = norm3({
            minus_normal[0] + plus_normal[0],
            minus_normal[1] + plus_normal[1],
            minus_normal[2] + plus_normal[2],
        });
        if (normal_mismatch > 1.0e-10) {
            throw std::invalid_argument(
                "source-cut paired faces have inconsistent outward orientation");
        }
        paired_boundaries.emplace_back(minus_found->second, plus_found->second);
    }
    if (paired_cut_keys != classified_cut_keys) {
        throw std::invalid_argument(
            "source-cut pair map is not a bijection over classified cut faces");
    }

    auto impl = std::make_unique<PeriodicChargePotentialSnapshot::Impl>(
        std::move(mesh));
    if (impl->space->GetVSize() != impl->space->GetTrueVSize()) {
        throw std::invalid_argument(
            "periodic charge v1 requires a conforming serial P1 space");
    }
    const int full_size = impl->space->GetVSize();
    DisjointSet quotient(full_size);
    for (const auto &[minus_vertex, plus_vertex] : paired_vertices) {
        mfem::Array<int> minus_dofs;
        mfem::Array<int> plus_dofs;
        impl->space->GetVertexDofs(minus_vertex, minus_dofs);
        impl->space->GetVertexDofs(plus_vertex, plus_dofs);
        if (minus_dofs.Size() != 1 || plus_dofs.Size() != 1 ||
            minus_dofs[0] < 0 || plus_dofs[0] < 0) {
            throw std::invalid_argument(
                "periodic charge v1 requires one positive P1 dof per vertex");
        }
        quotient.unite(minus_dofs[0], plus_dofs[0]);
    }

    std::map<int, int> root_to_reduced;
    std::vector<int> full_to_reduced(static_cast<std::size_t>(full_size));
    for (int dof = 0; dof < full_size; ++dof) {
        const int root = quotient.find(dof);
        const auto insertion = root_to_reduced.emplace(
            root, static_cast<int>(root_to_reduced.size()));
        full_to_reduced.at(static_cast<std::size_t>(dof)) = insertion.first->second;
    }
    const int reduced_size = static_cast<int>(root_to_reduced.size());
    if (reduced_size <= 0) {
        throw std::runtime_error("periodic charge quotient has no degrees of freedom");
    }

    mfem::BilinearForm diffusion(impl->space.get());
    diffusion.AddDomainIntegrator(
        new mfem::DiffusionIntegrator(*request.conductivity));
    diffusion.Assemble();
    diffusion.Finalize();
    const mfem::SparseMatrix &full_matrix = diffusion.SpMat();

    mfem::Vector lift(full_size);
    const double translation_squared = dot(
        request.source_cut.translation_m, request.source_cut.translation_m);
    for (int vertex = 0; vertex < impl->mesh->GetNV(); ++vertex) {
        mfem::Array<int> dofs;
        impl->space->GetVertexDofs(vertex, dofs);
        const auto coordinate = vertex_coordinate(*impl->mesh, vertex);
        lift[dofs[0]] = request.source_cut.potential_drop_v *
            dot(coordinate, request.source_cut.translation_m) /
            translation_squared;
    }

    mfem::SparseMatrix reduced_matrix(reduced_size);
    mfem::Array<int> columns;
    mfem::Vector values;
    for (int row = 0; row < full_matrix.Height(); ++row) {
        const int reduced_row = full_to_reduced.at(static_cast<std::size_t>(row));
        full_matrix.GetRow(row, columns, values);
        for (int entry = 0; entry < columns.Size(); ++entry) {
            const int reduced_column = full_to_reduced.at(
                static_cast<std::size_t>(columns[entry]));
            reduced_matrix.Add(reduced_row, reduced_column, values[entry]);
        }
    }
    reduced_matrix.Finalize();

    mfem::Vector full_lift_action(full_size);
    full_matrix.Mult(lift, full_lift_action);
    mfem::Vector reduced_rhs(reduced_size);
    reduced_rhs = 0.0;
    for (int dof = 0; dof < full_size; ++dof) {
        reduced_rhs[full_to_reduced.at(static_cast<std::size_t>(dof))] -=
            full_lift_action[dof];
    }

    mfem::Vector reduced_solution(reduced_size);
    reduced_solution = 0.0;
    mfem::SparseMatrix eliminated_matrix(reduced_matrix);
    reduced_rhs[0] = 0.0;
    eliminated_matrix.EliminateRowCol(0);

    mfem::GSSmoother preconditioner(eliminated_matrix);
    mfem::CGSolver solver;
    solver.SetOperator(eliminated_matrix);
    solver.SetPreconditioner(preconditioner);
    solver.SetRelTol(request.algebraic_relative_tolerance);
    solver.SetAbsTol(0.0);
    solver.SetMaxIter(request.maximum_iterations);
    solver.SetPrintLevel(0);
    solver.Mult(reduced_rhs, reduced_solution);
    const double relative_residual = independent_relative_residual(
        eliminated_matrix, reduced_solution, reduced_rhs);
    if (!solver.GetConverged() || !std::isfinite(relative_residual) ||
        relative_residual > request.algebraic_relative_tolerance) {
        throw std::runtime_error(
            "periodic charge quotient CG did not satisfy the requested tolerance");
    }

    *impl->field = lift;
    for (int dof = 0; dof < full_size; ++dof) {
        (*impl->field)[dof] += reduced_solution[
            full_to_reduced.at(static_cast<std::size_t>(dof))];
    }

    mfem::LinearForm mass_weights(impl->space.get());
    mfem::ConstantCoefficient one(1.0);
    mass_weights.AddDomainIntegrator(new mfem::DomainLFIntegrator(one));
    mass_weights.Assemble();
    const double volume = mass_weights.Sum();
    if (!(std::isfinite(volume) && volume > 0.0)) {
        throw std::runtime_error("periodic charge mesh has nonpositive volume");
    }
    const double mean_before_shift = mass_weights * *impl->field / volume;
    *impl->field -= mean_before_shift;
    const double mean_after_shift = mass_weights * *impl->field / volume;

    double jump_sum = 0.0;
    std::size_t jump_count = 0;
    double maximum_jump_error = 0.0;
    for (const auto &[minus_vertex, plus_vertex] : paired_vertices) {
        mfem::Array<int> minus_dofs;
        mfem::Array<int> plus_dofs;
        impl->space->GetVertexDofs(minus_vertex, minus_dofs);
        impl->space->GetVertexDofs(plus_vertex, plus_dofs);
        const double jump = (*impl->field)[plus_dofs[0]] -
            (*impl->field)[minus_dofs[0]];
        jump_sum += jump;
        ++jump_count;
        maximum_jump_error = std::max(maximum_jump_error,
            std::abs(jump - request.source_cut.potential_drop_v));
    }
    const double jump_tolerance = std::max(
        1.0e-12,
        128.0 * std::numeric_limits<double>::epsilon() *
            std::max(1.0, std::abs(request.source_cut.potential_drop_v)));
    if (jump_count == 0 || maximum_jump_error > jump_tolerance) {
        throw std::runtime_error(
            "periodic charge field does not satisfy the authored trace jump");
    }

    double maximum_flux_mismatch = 0.0;
    double maximum_flux_scale = 0.0;
    for (const auto &[minus_boundary, plus_boundary] : paired_boundaries) {
        const double minus_flux = integrate_boundary_flux(*impl->mesh,
            *impl->field, *request.conductivity, minus_boundary);
        const double plus_flux = integrate_boundary_flux(*impl->mesh,
            *impl->field, *request.conductivity, plus_boundary);
        maximum_flux_mismatch = std::max(
            maximum_flux_mismatch, std::abs(minus_flux + plus_flux));
        maximum_flux_scale = std::max(maximum_flux_scale,
            std::max(std::abs(minus_flux), std::abs(plus_flux)));
    }
    if (!std::isfinite(maximum_flux_mismatch)) {
        throw std::runtime_error(
            "periodic charge paired weak-flux diagnostic is nonfinite");
    }
    const double paired_flux_gate = std::max(1.0e-12,
        request.algebraic_relative_tolerance *
            std::max(maximum_flux_scale, 1.0e-30));
    if (maximum_flux_mismatch > paired_flux_gate) {
        throw std::runtime_error(
            "periodic charge field failed the independent paired weak-flux gate");
    }

    impl->stable_ids = request.stable_vertex_identities;
    impl->operator_version = request.operator_version;
    impl->converged = true;
    impl->relative_residual = relative_residual;
    impl->potential_jump = jump_sum / static_cast<double>(jump_count);
    impl->gauge_mean = mean_after_shift;
    impl->paired_flux_mismatch = maximum_flux_mismatch;
    impl->mesh_revision = request.mesh_revision;
    impl->geometry_digest = request.geometry_digest;
    impl->conductivity_digest = request.conductivity_digest;
    impl->source_cut_digest = request.source_cut_digest;
    impl->source_module_id = request.source_module_id;
    impl->source_state_revision = request.source_state_revision;
    impl->source_field_digest = request.source_field_digest;
    impl->evaluation_time = request.evaluation_time_s;
    impl->stage_identity = request.stage_identity;
    impl->envelope_revision = request.envelope_revision;
    impl->envelope_digest = request.envelope_digest;
    impl->envelope_multiplier = request.evaluated_envelope_multiplier;

    return std::shared_ptr<const PeriodicChargePotentialSnapshot>(
        new PeriodicChargePotentialSnapshot(std::move(impl)));
}

} // namespace fullmag::fem::transport
