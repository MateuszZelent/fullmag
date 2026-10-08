#include "cpu/mfem/workflows/antenna_field_solve/accepted_terminal_charge_source.hpp"
#include "frequency_domain/canonical_digest.hpp"

#include <mfem.hpp>

#include <algorithm>
#include <cmath>
#include <map>
#include <limits>
#include <set>
#include <stdexcept>
#include <string_view>
#include <utility>

namespace fullmag::fem::antenna_field_solve {
namespace {

class FrozenElementConductivity final : public mfem::Coefficient {
public:
    explicit FrozenElementConductivity(const std::vector<double> &values) : values_(values)
    {
        for (double value : values_) {
            if (!std::isfinite(value) || value <= 0.0) {
                throw std::invalid_argument("accepted terminal conductivity must be finite and positive");
            }
        }
    }
    double Eval(mfem::ElementTransformation &transformation, const mfem::IntegrationPoint &) override
    {
        if (transformation.ElementNo < 0 ||
            static_cast<std::size_t>(transformation.ElementNo) >= values_.size()) {
            throw std::invalid_argument("accepted terminal conductivity element map differs from its mesh");
        }
        return values_[static_cast<std::size_t>(transformation.ElementNo)];
    }
    const std::vector<double> &values() const { return values_; }
private:
    std::vector<double> values_;
};

void import_accepted_p1(mfem::GridFunction &potential, const ChargeTraceSolution &charge,
    const transport::StableMeshVertexIdentities &ids)
{
    auto &space = *potential.FESpace();
    auto &mesh = *space.GetMesh();
    const auto vertices = static_cast<std::size_t>(mesh.GetNV());
    if (space.GetVSize() != mesh.GetNV() || space.GetVSize() != space.GetTrueVSize() ||
        charge.stable_vertex_identities.version != ids.version ||
        charge.stable_vertex_identities.local_to_stable != ids.local_to_stable ||
        charge.vertex_positions_m.size() != vertices || charge.potential_vertex_values_v.size() != vertices) {
        throw std::runtime_error("accepted terminal P1 payload differs from its frozen mesh");
    }
    std::vector<bool> used(vertices, false);
    for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) {
        const auto index = static_cast<std::size_t>(vertex);
        const auto *position = mesh.GetVertex(vertex);
        for (int component = 0; component < 3; ++component) {
            if (position[component] != charge.vertex_positions_m[index][static_cast<std::size_t>(component)]) {
                throw std::runtime_error("accepted terminal P1 coordinates differ from its frozen mesh");
            }
        }
        mfem::Array<int> dofs;
        space.GetVertexDofs(vertex, dofs);
        if (dofs.Size() != 1 || dofs[0] < 0 || dofs[0] >= space.GetVSize() ||
            used[static_cast<std::size_t>(dofs[0])] || !std::isfinite(charge.potential_vertex_values_v[index])) {
            throw std::runtime_error("accepted terminal P1 vertex map is not a finite bijection");
        }
        used[static_cast<std::size_t>(dofs[0])] = true;
        potential[dofs[0]] = charge.potential_vertex_values_v[index];
    }
}

std::vector<transport::AffineTraceRelation> derive_interface_trace_relations(mfem::Mesh &mesh,
    const transport::StableMeshVertexIdentities &ids,
    const std::vector<transport::Rt0InterfaceFacePair> &interfaces)
{
    if (interfaces.empty()) return {};
    mfem::H1_FECollection collection(1, 3);
    mfem::FiniteElementSpace space(&mesh, &collection);
    if (space.GetVSize() != mesh.GetNV() || space.GetVSize() != space.GetTrueVSize()) {
        throw std::invalid_argument("accepted terminal interface requires conforming scalar P1");
    }
    std::map<std::uint64_t, int> dof_by_id;
    std::vector<bool> used(static_cast<std::size_t>(space.GetVSize()), false);
    for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) {
        mfem::Array<int> dofs;
        space.GetVertexDofs(vertex, dofs);
        if (dofs.Size() != 1 || dofs[0] < 0 || dofs[0] >= space.GetVSize() ||
            used[static_cast<std::size_t>(dofs[0])]) {
            throw std::invalid_argument("accepted terminal interface P1 vertex map is not a bijection");
        }
        used[static_cast<std::size_t>(dofs[0])] = true;
        dof_by_id.emplace(ids.local_to_stable.at(static_cast<std::size_t>(vertex)), dofs[0]);
    }
    // Deduplicate authored vertex pairs, not geometric proximity or volume edges.
    std::set<std::array<std::uint64_t, 2>> vertex_pairs;
    for (const auto &interface : interfaces) {
        for (auto pair : interface.vertex_pairs) {
            std::sort(pair.begin(), pair.end());
            vertex_pairs.insert(pair);
        }
    }
    std::vector<transport::AffineTraceRelation> relations;
    relations.reserve(vertex_pairs.size());
    for (const auto &pair : vertex_pairs) {
        relations.push_back({dof_by_id.at(pair[0]), dof_by_id.at(pair[1]), 0.0,
            "interface-vertex:" + std::to_string(pair[0]) + ":" + std::to_string(pair[1])});
    }
    return relations;
}

class AcceptedElementCurrent final : public mfem::VectorCoefficient {
public:
    AcceptedElementCurrent(mfem::Mesh &mesh, const ChargeTraceSolution &charge,
        const transport::StableMeshVertexIdentities &ids, FrozenElementConductivity &conductivity)
        : mfem::VectorCoefficient(3)
    {
        // No FE space survives mesh ownership transfer, including on RT0 failure.
        mfem::H1_FECollection collection(1, 3);
        mfem::FiniteElementSpace space(&mesh, &collection);
        mfem::GridFunction potential(&space);
        import_accepted_p1(potential, charge, ids);
        values_.reserve(static_cast<std::size_t>(mesh.GetNE()));
        const auto &point = mfem::Geometries.GetCenter(mfem::Geometry::TETRAHEDRON);
        for (int element = 0; element < mesh.GetNE(); ++element) {
            auto *transformation = mesh.GetElementTransformation(element);
            transformation->SetIntPoint(&point);
            mfem::Vector gradient(3);
            potential.GetGradient(*transformation, gradient);
            const double sigma = conductivity.Eval(*transformation, point);
            std::array<double, 3> value{};
            for (int component = 0; component < 3; ++component) {
                value[static_cast<std::size_t>(component)] = -sigma * gradient[component];
                if (!std::isfinite(gradient[component]) || !std::isfinite(value[static_cast<std::size_t>(component)])) {
                    throw std::runtime_error("accepted terminal raw current is not finite");
                }
            }
            values_.push_back(value);
        }
    }
    void Eval(mfem::Vector &value, mfem::ElementTransformation &transformation,
        const mfem::IntegrationPoint &) override
    {
        if (transformation.ElementNo < 0 ||
            static_cast<std::size_t>(transformation.ElementNo) >= values_.size()) {
            throw std::runtime_error("accepted terminal raw current element map differs from its mesh");
        }
        value.SetSize(3);
        const auto &owned = values_[static_cast<std::size_t>(transformation.ElementNo)];
        for (int component = 0; component < 3; ++component) value[component] = owned[static_cast<std::size_t>(component)];
    }
private:
    std::vector<std::array<double, 3>> values_;
};

class BoundedAcceptedSourceDigest {
public:
    BoundedAcceptedSourceDigest() : builder_(AcceptedTerminalChargeSource::digest_schema)
    {
        consume("schema", std::string_view(AcceptedTerminalChargeSource::digest_schema).size());
    }
    void text(std::string_view name, std::string_view value)
    {
        consume(name, value.size());
        builder_.add_string(name, value);
    }
    void integer(std::string_view name, std::uint64_t value)
    {
        consume(name, 8);
        builder_.add_u64(name, value);
    }
    void real(std::string_view name, double value)
    {
        if (!std::isfinite(value)) throw std::runtime_error("accepted terminal digest requires finite doubles");
        consume(name, 8);
        builder_.add_double(name, value);
    }
    std::string finish() const { return builder_.sha256_hex(); }
    std::string release_payload() && { return std::move(builder_).release_payload(); }
private:
    void consume(std::string_view name, std::uint64_t size)
    {
        // Two u64 lengths, one type byte, and the actual UTF-8 field name.
        const std::uint64_t framing = 17 + name.size();
        if (framing > remaining_ || size > remaining_ - framing) {
            throw std::runtime_error("accepted terminal digest preimage exceeds its 128 MiB resource limit");
        }
        remaining_ -= framing + size;
    }
    frequency_domain::CanonicalDigestBuilder builder_;
    std::uint64_t remaining_ = AcceptedTerminalChargeSource::maximum_digest_preimage_bytes;
};

struct AcceptedContentRecord {
    std::string digest;
    std::string payload;
};

AcceptedContentRecord compute_accepted_terminal_content_digest(const AcceptedTerminalChargeSource &source,
    const ChargeTraceSolveRequest &policy)
{
    static_assert(sizeof(double) == 8 && std::numeric_limits<double>::is_iec559,
        "accepted terminal digest requires IEEE-754 binary64");
    BoundedAcceptedSourceDigest digest;
    digest.text("operator", AcceptedTerminalChargeSource::operator_version);
    digest.real("absolute_jump_tolerance_v", policy.absolute_jump_tolerance_v);
    digest.real("relative_jump_tolerance", policy.relative_jump_tolerance);
    digest.real("algebraic_relative_tolerance", policy.algebraic_relative_tolerance);
    digest.integer("maximum_iterations", static_cast<std::uint64_t>(policy.maximum_iterations));
    const auto &projection = source.rt0_projection();
    const auto &ids = projection.stable_vertex_identities();
    const auto &space = *projection.field().FESpace();
    const auto &mesh = *space.GetMesh();
    const auto &terminal = source.terminal_solution();
    const auto &charge = *terminal.accepted_solution;
    digest.integer("vertices", static_cast<std::uint64_t>(mesh.GetNV()));
    digest.text("stable_vertex_version", ids.version);
    for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) {
        const auto index = static_cast<std::size_t>(vertex);
        digest.integer("vertex_id", ids.local_to_stable.at(index));
        for (int component = 0; component < 3; ++component) digest.real("xyz_m", mesh.GetVertex(vertex)[component]);
        digest.real("potential_v", charge.potential_vertex_values_v.at(index));
        digest.real("reaction_a", charge.reaction_vertex_values_a.at(index));
        digest.integer("vertex_component_id", charge.vertex_component_ids.at(index));
    }
    const auto add_vertices = [&](const mfem::Array<int> &vertices) {
        for (int vertex : vertices) digest.integer("vertex_id", ids.local_to_stable.at(static_cast<std::size_t>(vertex)));
    };
    const auto signed_integer = [](int value) { return static_cast<std::uint64_t>(static_cast<std::int64_t>(value)); };
    digest.integer("elements", static_cast<std::uint64_t>(mesh.GetNE()));
    for (int element = 0; element < mesh.GetNE(); ++element) {
        digest.integer("attribute", signed_integer(mesh.GetElement(element)->GetAttribute()));
        mfem::Array<int> vertices;
        mesh.GetElementVertices(element, vertices);
        add_vertices(vertices);
        digest.real("conductivity_spm", source.conductivity_spm_per_element().at(static_cast<std::size_t>(element)));
    }
    digest.integer("boundary", static_cast<std::uint64_t>(mesh.GetNBE()));
    for (int boundary = 0; boundary < mesh.GetNBE(); ++boundary) {
        digest.integer("attribute", signed_integer(mesh.GetBdrElement(boundary)->GetAttribute()));
        mfem::Array<int> vertices;
        mesh.GetBdrElementVertices(boundary, vertices);
        add_vertices(vertices);
    }
    digest.integer("faces", static_cast<std::uint64_t>(mesh.GetNumFaces()));
    for (int face = 0; face < mesh.GetNumFaces(); ++face) {
        mfem::Array<int> vertices, dofs;
        mesh.GetFaceVertices(face, vertices);
        add_vertices(vertices);
        int first = -1, second = -1;
        mesh.GetFaceElements(face, &first, &second);
        digest.integer("first_element", signed_integer(first));
        digest.integer("second_element", signed_integer(second));
        space.GetFaceDofs(face, dofs);
        if (dofs.Size() != 1) throw std::runtime_error("accepted terminal digest requires one RT0 DOF per face");
        digest.integer("signed_rt0_dof", signed_integer(dofs[0]));
    }
    digest.integer("rt0", static_cast<std::uint64_t>(projection.field().Size()));
    for (int dof = 0; dof < projection.field().Size(); ++dof) digest.real("rt0_flux_a", projection.field()[dof]);
    digest.integer("terminals", terminal.terminal_ids.size());
    for (std::size_t index = 0; index < terminal.terminal_ids.size(); ++index) {
        digest.text("terminal_id", terminal.terminal_ids[index]);
        const auto &faces = terminal.terminal_boundary_face_vertex_ids.at(index);
        digest.integer("terminal_faces", faces.size());
        for (const auto &face : faces) for (auto id : face) digest.integer("vertex_id", id);
        digest.real("requested_current_a", terminal.requested_outward_currents_a.at(index));
        digest.real("h1_current_a", terminal.measured_outward_currents_a.at(index));
        digest.real("h1_residual_a", terminal.current_residuals_a.at(index));
        digest.real("rt0_current_a", projection.measured_outward_currents_a().at(index));
        digest.real("rt0_residual_a", projection.current_residuals_a().at(index));
        digest.real("terminal_voltage_v", terminal.terminal_voltages_v.at(index));
        digest.integer("terminal_component_id", terminal.terminal_component_ids.at(index));
    }
    digest.integer("references", terminal.reference_terminal_ids.size());
    for (std::size_t index = 0; index < terminal.reference_terminal_ids.size(); ++index) {
        digest.text("terminal_id", terminal.reference_terminal_ids[index]);
        digest.integer("component_id", terminal.reference_component_ids.at(index));
    }
    digest.integer("components", charge.component_ids.size());
    for (std::size_t index = 0; index < charge.component_ids.size(); ++index) {
        digest.integer("component_id", charge.component_ids[index]);
        digest.real("component_relative_residual", charge.component_relative_residuals.at(index));
    }
    digest.integer("gauges", charge.gauge_vertex_ids.size());
    for (auto id : charge.gauge_vertex_ids) digest.integer("vertex_id", id);
    digest.integer("interfaces", source.interface_pairs().size());
    for (std::size_t index = 0; index < source.interface_pairs().size(); ++index) {
        const auto &pair = source.interface_pairs()[index];
        digest.text("interface_id", pair.id);
        for (auto id : pair.first_face_vertex_ids) digest.integer("vertex_id", id);
        for (auto id : pair.second_face_vertex_ids) digest.integer("vertex_id", id);
        for (const auto &map : pair.vertex_pairs) for (auto id : map) digest.integer("vertex_id", id);
        const auto &measured = projection.interface_flux_measurements().at(index);
        digest.real("first_current_a", measured.first_outward_current_a);
        digest.real("second_current_a", measured.second_outward_current_a);
        digest.real("interface_mismatch_a", measured.mismatch_a);
    }
    const auto &rank = projection.constraint_rank_certificate();
    digest.integer("rows_before", rank.rows_before);
    digest.integer("rank", rank.rank);
    digest.integer("omitted", rank.omitted_rows.size());
    for (const auto &row : rank.omitted_rows) {
        digest.text("constraint_id", row.constraint_id);
        digest.integer("omission_reason", static_cast<std::uint64_t>(row.reason));
        digest.real("omitted_residual_a", row.residual_a);
        for (auto id : row.closed_component_anchor_element) digest.integer("vertex_id", id);
    }
    return {digest.finish(), std::move(digest).release_payload()};
}

} // namespace

class AcceptedTerminalChargeSource::Impl {
public:
    std::unique_ptr<FrozenElementConductivity> conductivity;
    std::vector<transport::Rt0InterfaceFacePair> interfaces;
    std::string digest;
    std::string canonical_bytes;
    std::shared_ptr<const ChargeTerminalCurrentSolution> terminal;
    transport::TerminalConstrainedRt0Projection::Ptr projection;
    std::unique_ptr<mfem::H1_FECollection> collection;
    std::unique_ptr<mfem::FiniteElementSpace> space;
    std::unique_ptr<mfem::GridFunction> potential;
};

AcceptedTerminalChargeSource::AcceptedTerminalChargeSource(std::unique_ptr<Impl> impl)
    : impl_(std::move(impl))
{}
AcceptedTerminalChargeSource::~AcceptedTerminalChargeSource() = default;
const ChargeTerminalCurrentSolution &AcceptedTerminalChargeSource::terminal_solution() const { return *impl_->terminal; }
const transport::TerminalConstrainedRt0Projection &AcceptedTerminalChargeSource::rt0_projection() const { return *impl_->projection; }
const mfem::GridFunction &AcceptedTerminalChargeSource::potential() const { return *impl_->potential; }
const std::vector<double> &AcceptedTerminalChargeSource::conductivity_spm_per_element() const { return impl_->conductivity->values(); }
const std::vector<transport::Rt0InterfaceFacePair> &AcceptedTerminalChargeSource::interface_pairs() const { return impl_->interfaces; }
const std::string &AcceptedTerminalChargeSource::content_digest() const { return impl_->digest; }
const std::string &AcceptedTerminalChargeSource::canonical_content_bytes() const { return impl_->canonical_bytes; }

AcceptedTerminalChargeSource::Ptr solve_accepted_terminal_charge_source(const AcceptedTerminalChargeRequest &request)
{
    if (request.mesh == nullptr || !request.trace_relations.empty()) {
        throw std::invalid_argument("accepted terminal source requires a mesh and no caller DOF trace interfaces");
    }
    auto &input = *request.mesh;
    transport::validate_terminal_current_mesh(input);
    if (request.conductivity_spm_per_element.size() != static_cast<std::size_t>(input.GetNE())) {
        throw std::invalid_argument("accepted terminal mesh or element conductivity count is invalid");
    }
    auto impl = std::make_unique<AcceptedTerminalChargeSource::Impl>();
    impl->conductivity = std::make_unique<FrozenElementConductivity>(request.conductivity_spm_per_element);
    auto mesh = std::make_unique<mfem::Mesh>(input);
    const auto ids = request.stable_vertex_identities;
    impl->interfaces = request.interface_pairs;
    ChargeTerminalCurrentRequest charge;
    charge.conductor.mesh = mesh.get();
    charge.conductor.conductivity = impl->conductivity.get();
    charge.conductor.stable_vertex_identities = ids;
    charge.conductor.absolute_jump_tolerance_v = request.absolute_jump_tolerance_v;
    charge.conductor.relative_jump_tolerance = request.relative_jump_tolerance;
    charge.conductor.algebraic_relative_tolerance = request.algebraic_relative_tolerance;
    charge.conductor.maximum_iterations = request.maximum_iterations;
    charge.terminals = request.terminals;
    std::vector<std::array<std::uint64_t, 3>> terminal_faces;
    for (const auto &terminal : charge.terminals) {
        if (terminal.boundary_face_vertex_ids.size() >
            static_cast<std::size_t>(mesh->GetNBE()) - terminal_faces.size()) {
            throw std::invalid_argument("accepted terminal face count exceeds the physical boundary");
        }
        terminal_faces.insert(terminal_faces.end(), terminal.boundary_face_vertex_ids.begin(),
            terminal.boundary_face_vertex_ids.end());
    }
    transport::validate_terminal_current_interfaces(*mesh, ids, terminal_faces, impl->interfaces);
    charge.conductor.trace_relations = derive_interface_trace_relations(*mesh, ids, impl->interfaces);
    impl->terminal = solve_charge_terminal_current_constraints(charge);
    const auto &terminal = *impl->terminal;
    AcceptedElementCurrent raw(*mesh, *terminal.accepted_solution, ids, *impl->conductivity);
    std::vector<transport::Rt0TerminalFluxConstraint> constraints;
    constraints.reserve(terminal.terminal_ids.size());
    for (std::size_t index = 0; index < terminal.terminal_ids.size(); ++index) {
        constraints.push_back({terminal.terminal_ids[index], terminal.terminal_boundary_face_vertex_ids.at(index),
            terminal.measured_outward_currents_a.at(index)});
    }
    impl->projection = transport::project_terminal_constrained_rt0_owned(std::move(mesh), ids,
        raw, *impl->conductivity, constraints, impl->interfaces);
    if (impl->projection->terminal_ids() != terminal.terminal_ids) {
        throw std::runtime_error("accepted terminal RT0 identities differ from H1");
    }
    for (std::size_t index = 0; index < terminal.terminal_ids.size(); ++index) {
        const long double requested = terminal.requested_outward_currents_a.at(index);
        const long double measured = impl->projection->measured_outward_currents_a().at(index);
        const long double residual = measured - requested;
        if (!std::isfinite(measured) || !std::isfinite(residual) ||
            std::abs(residual) > 1.0e-18L + 1.0e-8L * std::abs(requested)) {
            throw std::runtime_error("accepted terminal source failed its requested to RT0 current certificate");
        }
    }
    auto *owned_mesh = impl->projection->field().FESpace()->GetMesh();
    impl->collection = std::make_unique<mfem::H1_FECollection>(1, 3);
    impl->space = std::make_unique<mfem::FiniteElementSpace>(owned_mesh, impl->collection.get());
    impl->potential = std::make_unique<mfem::GridFunction>(impl->space.get());
    import_accepted_p1(*impl->potential, *terminal.accepted_solution, impl->projection->stable_vertex_identities());
    auto result = AcceptedTerminalChargeSource::Ptr(new AcceptedTerminalChargeSource(std::move(impl)));
    auto record = compute_accepted_terminal_content_digest(*result, charge.conductor);
    result->impl_->digest = std::move(record.digest);
    result->impl_->canonical_bytes = std::move(record.payload);
    return result;
}

} // namespace fullmag::fem::antenna_field_solve
