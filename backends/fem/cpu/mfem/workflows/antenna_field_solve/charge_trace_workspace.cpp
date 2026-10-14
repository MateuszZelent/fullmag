#include "cpu/mfem/workflows/antenna_field_solve/charge_trace_workspace.hpp"

#include <mfem.hpp>

#include <algorithm>
#include <cmath>
#include <map>
#include <numeric>
#include <set>
#include <stdexcept>
#include <utility>

namespace fullmag::fem::antenna_field_solve {
namespace {

class Components {
public:
    explicit Components(int size) : parents_(static_cast<std::size_t>(size))
    {
        std::iota(parents_.begin(), parents_.end(), 0);
    }
    int root(int value)
    {
        while (parents_[static_cast<std::size_t>(value)] != value) {
            auto &parent = parents_[static_cast<std::size_t>(value)];
            parent = parents_[static_cast<std::size_t>(parent)];
            value = parent;
        }
        return value;
    }
    void join(int left, int right)
    {
        left = root(left);
        right = root(right);
        parents_[static_cast<std::size_t>(std::max(left, right))] = std::min(left, right);
    }
private:
    std::vector<int> parents_;
};

class CheckedConductivity final : public mfem::Coefficient {
public:
    explicit CheckedConductivity(mfem::Coefficient &source) : source_(source) {}
    double Eval(mfem::ElementTransformation &transformation,
        const mfem::IntegrationPoint &point) override
    {
        const double value = source_.Eval(transformation, point);
        if (!std::isfinite(value) || value <= 0.0 ||
            !std::isfinite(transformation.Weight()) || transformation.Weight() <= 0.0) {
            throw std::invalid_argument("charge trace conductivity must be finite and positive");
        }
        return value;
    }
private:
    mfem::Coefficient &source_;
};

} // namespace

class ChargeTraceWorkspace::Impl {
public:
    explicit Impl(const ChargeTraceSolveRequest &request);
    std::shared_ptr<const ChargeTraceSolution> solve(
        const std::vector<double> &trace_jumps_v,
        const std::vector<double> &anchor_potentials_v) const;
    bool is_component_constant_control(
        const std::vector<double> &trace_jumps_v,
        const std::vector<double> &anchor_potentials_v) const;
    int original_volume_component_for_full_dof(int full_dof) const;
    int vertex_index_for_full_dof(int full_dof) const;
    void require_control_topology(const ChargeTraceSolveRequest &request) const;
private:
    ChargeTraceSolveRequest prototype_;
    ChargeTraceSolution carrier_;
    std::vector<int> vertex_dofs_;
    std::vector<int> dof_vertices_;
    std::vector<int> original_volume_components_;
    std::vector<int> electrical_roots_;
    std::map<int, int> component_gauge_dof_;
    std::vector<int> full_to_reduced_;
    std::unique_ptr<mfem::SparseMatrix> matrix_;
};

ChargeTraceWorkspace::Impl::Impl(const ChargeTraceSolveRequest &request)
    : prototype_(request)
{
    if (request.mesh == nullptr || request.conductivity == nullptr ||
        !std::isfinite(request.algebraic_relative_tolerance) ||
        request.algebraic_relative_tolerance <= 0.0 ||
        request.algebraic_relative_tolerance >= 1.0 || request.maximum_iterations <= 0) {
        throw std::invalid_argument("invalid charge trace solve request");
    }
    auto &mesh = *request.mesh;
#if defined(MFEM_USE_MPI)
    if (dynamic_cast<mfem::ParMesh *>(&mesh) != nullptr) {
        throw std::invalid_argument("charge trace workspace requires a global serial mesh");
    }
#endif
    if (mesh.Dimension() != 3 || mesh.SpaceDimension() != 3 ||
        mesh.GetNE() <= 0 || mesh.GetNV() <= 0 || mesh.GetNodes() != nullptr ||
        request.stable_vertex_identities.version != "stable_mesh_vertex_u64.v1" ||
        request.stable_vertex_identities.local_to_stable.size() !=
            static_cast<std::size_t>(mesh.GetNV())) {
        throw std::invalid_argument("charge trace workspace requires straight 3D tet4 and stable IDs");
    }
    auto result = std::make_shared<ChargeTraceSolution>();
    result->stable_vertex_identities = request.stable_vertex_identities;
    std::set<std::uint64_t> unique_ids;
    for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) {
        const auto id = request.stable_vertex_identities.local_to_stable[
            static_cast<std::size_t>(vertex)];
        const double *position = mesh.GetVertex(vertex);
        if (id == 0 || !unique_ids.insert(id).second ||
            !std::isfinite(position[0]) || !std::isfinite(position[1]) ||
            !std::isfinite(position[2])) {
            throw std::invalid_argument("charge trace IDs or vertex coordinates are invalid");
        }
        result->vertex_positions_m.push_back({position[0], position[1], position[2]});
    }
    mfem::H1_FECollection collection(1, 3);
    mfem::FiniteElementSpace space(&mesh, &collection);
    if (space.GetVSize() != mesh.GetNV() || space.GetVSize() != space.GetTrueVSize()) {
        throw std::invalid_argument("charge trace workspace requires conforming scalar P1");
    }
    const int count = space.GetVSize();
    const auto trace = transport::reduce_affine_trace_relations(count,
        request.trace_relations, request.absolute_jump_tolerance_v,
        request.relative_jump_tolerance);
    std::vector<int> vertex_dofs(static_cast<std::size_t>(mesh.GetNV()));
    std::vector<int> dof_vertices(static_cast<std::size_t>(count), -1);
    for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) {
        mfem::Array<int> dofs;
        space.GetVertexDofs(vertex, dofs);
        if (dofs.Size() != 1 || dofs[0] < 0 || dofs[0] >= count ||
            dof_vertices[static_cast<std::size_t>(dofs[0])] != -1) {
            throw std::invalid_argument("charge trace vertex to DOF map is not a bijection");
        }
        vertex_dofs[static_cast<std::size_t>(vertex)] = dofs[0];
        dof_vertices[static_cast<std::size_t>(dofs[0])] = vertex;
    }
    Components volume_components(mesh.GetNE());
    for (int face = 0; face < mesh.GetNumFaces(); ++face) {
        int first = -1, second = -1;
        mesh.GetFaceElements(face, &first, &second);
        if (first >= 0 && second >= 0) volume_components.join(first, second);
    }
    Components electrical(trace.reduced_size);
    std::vector<int> vertex_volume(static_cast<std::size_t>(mesh.GetNV()), -1);
    std::vector<bool> used(static_cast<std::size_t>(trace.reduced_size), false);
    for (int element = 0; element < mesh.GetNE(); ++element) {
        if (mesh.GetElementBaseGeometry(element) != mfem::Geometry::TETRAHEDRON) {
            throw std::invalid_argument("charge trace workspace does not support non-tet4 elements");
        }
        mfem::Array<int> vertices;
        mesh.GetElementVertices(element, vertices);
        const int volume = volume_components.root(element);
        const int anchor = trace.full_to_reduced[static_cast<std::size_t>(
            vertex_dofs[static_cast<std::size_t>(vertices[0])])];
        for (int vertex : vertices) {
            auto &assigned = vertex_volume[static_cast<std::size_t>(vertex)];
            if (assigned >= 0 && assigned != volume) {
                throw std::invalid_argument("charge trace mesh contains an unqualified point or edge contact");
            }
            assigned = volume;
            const int reduced = trace.full_to_reduced[static_cast<std::size_t>(
                vertex_dofs[static_cast<std::size_t>(vertex)])];
            used[static_cast<std::size_t>(reduced)] = true;
            electrical.join(anchor, reduced);
        }
    }
    if (std::find(used.begin(), used.end(), false) != used.end() ||
        std::find(vertex_volume.begin(), vertex_volume.end(), -1) != vertex_volume.end()) {
        throw std::invalid_argument("charge trace mesh contains unused potential DOFs");
    }
    std::map<int, int> component_gauge_dof;
    for (int dof = 0; dof < count; ++dof) {
        const int component = electrical.root(trace.full_to_reduced[static_cast<std::size_t>(dof)]);
        const auto found = component_gauge_dof.find(component);
        const auto stable_id = [&](int index) {
            return result->stable_vertex_identities.local_to_stable[
                static_cast<std::size_t>(dof_vertices[static_cast<std::size_t>(index)])];
        };
        if (found == component_gauge_dof.end() || stable_id(dof) < stable_id(found->second)) {
            component_gauge_dof[component] = dof;
        }
    }
    CheckedConductivity conductivity(*request.conductivity);
    mfem::BilinearForm diffusion(&space);
    diffusion.AddDomainIntegrator(new mfem::DiffusionIntegrator(conductivity));
    diffusion.Assemble();
    diffusion.Finalize();
    matrix_ = std::make_unique<mfem::SparseMatrix>(diffusion.SpMat());
    carrier_ = *result;
    original_volume_components_.resize(static_cast<std::size_t>(count));
    for (int dof = 0; dof < count; ++dof) {
        original_volume_components_[static_cast<std::size_t>(dof)] =
            vertex_volume[static_cast<std::size_t>(dof_vertices[static_cast<std::size_t>(dof)])];
    }
    vertex_dofs_ = std::move(vertex_dofs);
    dof_vertices_ = std::move(dof_vertices);
    component_gauge_dof_ = std::move(component_gauge_dof);
    full_to_reduced_ = trace.full_to_reduced;
    electrical_roots_.resize(static_cast<std::size_t>(trace.reduced_size));
    for (int reduced = 0; reduced < trace.reduced_size; ++reduced) {
        electrical_roots_[static_cast<std::size_t>(reduced)] = electrical.root(reduced);
    }
    prototype_.mesh = nullptr;
    prototype_.conductivity = nullptr;
}

int ChargeTraceWorkspace::Impl::original_volume_component_for_full_dof(int full_dof) const
{
    if (full_dof < 0 || static_cast<std::size_t>(full_dof) >= original_volume_components_.size()) {
        throw std::invalid_argument("charge control DOF is outside the owned volume partition");
    }
    return original_volume_components_[static_cast<std::size_t>(full_dof)];
}

int ChargeTraceWorkspace::Impl::vertex_index_for_full_dof(int full_dof) const
{
    if (full_dof < 0 || static_cast<std::size_t>(full_dof) >= dof_vertices_.size()) {
        throw std::invalid_argument("charge control DOF is outside the owned vertex map");
    }
    return dof_vertices_[static_cast<std::size_t>(full_dof)];
}

void ChargeTraceWorkspace::Impl::require_control_topology(const ChargeTraceSolveRequest &request) const
{
    const bool same_metadata =
        request.stable_vertex_identities.version == prototype_.stable_vertex_identities.version &&
        request.stable_vertex_identities.local_to_stable == prototype_.stable_vertex_identities.local_to_stable &&
        request.trace_relations.size() == prototype_.trace_relations.size() &&
        request.potential_anchors.size() == prototype_.potential_anchors.size() &&
        request.absolute_jump_tolerance_v == prototype_.absolute_jump_tolerance_v &&
        request.relative_jump_tolerance == prototype_.relative_jump_tolerance &&
        request.algebraic_relative_tolerance == prototype_.algebraic_relative_tolerance &&
        request.maximum_iterations == prototype_.maximum_iterations;
    if (!same_metadata) throw std::invalid_argument("charge response metadata differs from its owned workspace");
    for (std::size_t index = 0; index < request.trace_relations.size(); ++index) {
        const auto &authored = request.trace_relations[index];
        const auto &owned = prototype_.trace_relations[index];
        if (authored.minus_dof != owned.minus_dof || authored.plus_dof != owned.plus_dof ||
            authored.id != owned.id || authored.potential_jump_v != 0.0 || owned.potential_jump_v != 0.0) {
            throw std::invalid_argument("charge response trace topology differs from its owned workspace");
        }
    }
    for (std::size_t index = 0; index < request.potential_anchors.size(); ++index) {
        const auto &authored = request.potential_anchors[index];
        const auto &owned = prototype_.potential_anchors[index];
        if (authored.full_dof != owned.full_dof || authored.potential_v != 0.0 || owned.potential_v != 0.0) {
            throw std::invalid_argument("charge response anchor topology differs from its owned workspace");
        }
    }
    // Borrowed mesh/material pointers are deliberately not consulted: this
    // overload explicitly solves the frozen operator owned by this workspace.
}

bool ChargeTraceWorkspace::Impl::is_component_constant_control(
    const std::vector<double> &trace_jumps_v,
    const std::vector<double> &anchor_potentials_v) const
{
    if (trace_jumps_v.size() != prototype_.trace_relations.size() ||
        anchor_potentials_v.size() != prototype_.potential_anchors.size()) {
        throw std::invalid_argument("charge control values do not match the assembled topology");
    }
    bool constant = true;
    for (double jump : trace_jumps_v) {
        if (!std::isfinite(jump)) throw std::invalid_argument("nonfinite charge control jump");
        if (jump != 0.0) constant = false;
    }
    std::map<int, double> component_values;
    for (std::size_t index = 0; index < anchor_potentials_v.size(); ++index) {
        const int dof = prototype_.potential_anchors[index].full_dof;
        const double value = anchor_potentials_v[index];
        if (dof < 0 || dof >= matrix_->Height() || !std::isfinite(value)) {
            throw std::invalid_argument("invalid charge control anchor");
        }
        const int component = electrical_roots_[static_cast<std::size_t>(
            full_to_reduced_[static_cast<std::size_t>(dof)])];
        const auto [found, inserted] = component_values.emplace(component, value);
        if (!inserted && found->second != value) constant = false;
    }
    // An unanchored component has its implicit zero gauge. Different
    // anchored components may have different constants and still no current.
    return constant;
}

std::shared_ptr<const ChargeTraceSolution> ChargeTraceWorkspace::Impl::solve(
    const std::vector<double> &trace_jumps_v,
    const std::vector<double> &anchor_potentials_v) const
{
    if (trace_jumps_v.size() != prototype_.trace_relations.size() ||
        anchor_potentials_v.size() != prototype_.potential_anchors.size()) {
        throw std::invalid_argument("charge trace solve values do not match the assembled topology");
    }
    auto request = prototype_;
    for (std::size_t index = 0; index < trace_jumps_v.size(); ++index) {
        request.trace_relations[index].potential_jump_v = trace_jumps_v[index];
    }
    for (std::size_t index = 0; index < anchor_potentials_v.size(); ++index) {
        request.potential_anchors[index].potential_v = anchor_potentials_v[index];
    }
    const int count = matrix_->Height();
    const auto trace = transport::reduce_affine_trace_relations(count,
        request.trace_relations, request.absolute_jump_tolerance_v,
        request.relative_jump_tolerance);
    if (trace.full_to_reduced != full_to_reduced_) {
        throw std::runtime_error("charge trace solve changed the assembled quotient topology");
    }
    auto result = std::make_shared<ChargeTraceSolution>(carrier_);
    const auto &vertex_dofs = vertex_dofs_;
    const auto &dof_vertices = dof_vertices_;
    const auto &component_gauge_dof = component_gauge_dof_;
    const auto electrical_root = [&](int reduced) {
        return electrical_roots_[static_cast<std::size_t>(reduced)];
    };
    std::map<int, double> fixed;
    std::set<int> anchored_components;
    for (const auto &anchor : request.potential_anchors) {
        if (anchor.full_dof < 0 || anchor.full_dof >= count || !std::isfinite(anchor.potential_v)) {
            throw std::invalid_argument("invalid charge trace potential anchor");
        }
        const int reduced = trace.full_to_reduced[static_cast<std::size_t>(anchor.full_dof)];
        const double value = anchor.potential_v - trace.lift_v[static_cast<std::size_t>(anchor.full_dof)];
        if (!std::isfinite(value)) throw std::invalid_argument("charge trace anchor overflow");
        const auto [found, inserted] = fixed.emplace(reduced, value);
        if (!inserted && found->second != value) {
            throw std::invalid_argument("charge trace potential anchors conflict on one quotient DOF");
        }
        anchored_components.insert(electrical_root(reduced));
    }
    for (const auto &[component, dof] : component_gauge_dof) {
        if (anchored_components.count(component) == 0) {
            fixed.emplace(trace.full_to_reduced[static_cast<std::size_t>(dof)],
                -trace.lift_v[static_cast<std::size_t>(dof)]);
            result->gauge_vertex_ids.push_back(result->stable_vertex_identities.local_to_stable[
                static_cast<std::size_t>(dof_vertices[static_cast<std::size_t>(dof)])]);
        }
    }
    std::vector<int> free_index(static_cast<std::size_t>(trace.reduced_size), -1);
    int free_count = 0;
    for (int reduced = 0; reduced < trace.reduced_size; ++reduced) {
        if (fixed.count(reduced) == 0) free_index[static_cast<std::size_t>(reduced)] = free_count++;
    }
    const auto &matrix = *matrix_;
    mfem::Vector potential(count);
    for (int dof = 0; dof < count; ++dof) {
        const auto fixed_value = fixed.find(trace.full_to_reduced[static_cast<std::size_t>(dof)]);
        potential[dof] = trace.lift_v[static_cast<std::size_t>(dof)] +
            (fixed_value == fixed.end() ? 0.0 : fixed_value->second);
        if (!std::isfinite(potential[dof])) throw std::invalid_argument("charge trace base potential overflow");
    }
    mfem::Vector action(count);
    matrix.Mult(potential, action);
    mfem::Vector rhs(free_count), solution(free_count);
    rhs = 0.0;
    solution = 0.0;
    if (free_count > 0) {
        mfem::SparseMatrix reduced_matrix(free_count);
        mfem::Array<int> columns;
        mfem::Vector values;
        for (int row = 0; row < count; ++row) {
            const int reduced_row = free_index[static_cast<std::size_t>(trace.full_to_reduced[
                static_cast<std::size_t>(row)])];
            if (reduced_row < 0) continue;
            rhs[reduced_row] -= action[row];
            matrix.GetRow(row, columns, values);
            for (int entry = 0; entry < columns.Size(); ++entry) {
                const int reduced_column = free_index[static_cast<std::size_t>(trace.full_to_reduced[
                    static_cast<std::size_t>(columns[entry])])];
                if (reduced_column >= 0) reduced_matrix.Add(reduced_row, reduced_column, values[entry]);
            }
        }
        reduced_matrix.Finalize();
        const double rhs_norm = rhs.Norml2();
        if (!std::isfinite(rhs_norm)) {
            throw std::runtime_error("charge trace right-hand-side norm overflow");
        }
        if (rhs_norm != 0.0) {
            mfem::GSSmoother preconditioner(reduced_matrix);
            mfem::CGSolver solver;
            solver.SetOperator(reduced_matrix);
            solver.SetPreconditioner(preconditioner);
            solver.SetRelTol(request.algebraic_relative_tolerance);
            solver.SetAbsTol(0.0);
            solver.SetMaxIter(request.maximum_iterations);
            solver.SetPrintLevel(0);
            solver.Mult(rhs, solution);
            if (!solver.GetConverged()) throw std::runtime_error("charge trace H1 solve did not converge");
        }
        for (int dof = 0; dof < count; ++dof) {
            const int index = free_index[static_cast<std::size_t>(trace.full_to_reduced[
                static_cast<std::size_t>(dof)])];
            if (index >= 0) potential[dof] += solution[index];
        }
    }
    // Affine relations must also hold after adding fixed values and the
    // solved quotient vector. A common large offset can erase a small jump.
    for (const auto &relation : request.trace_relations) {
        const long double measured = static_cast<long double>(potential[relation.plus_dof]) -
            static_cast<long double>(potential[relation.minus_dof]);
        const long double tolerance = static_cast<long double>(request.absolute_jump_tolerance_v) +
            static_cast<long double>(request.relative_jump_tolerance) *
                std::abs(static_cast<long double>(relation.potential_jump_v));
        if (!std::isfinite(measured) || !std::isfinite(tolerance) ||
            std::abs(measured - relation.potential_jump_v) > tolerance) {
            throw std::runtime_error("charge trace solution lost an authored jump: " + relation.id);
        }
    }
    for (const auto &anchor : request.potential_anchors) {
        const long double error = static_cast<long double>(potential[anchor.full_dof]) - anchor.potential_v;
        const long double tolerance = static_cast<long double>(request.absolute_jump_tolerance_v) +
            static_cast<long double>(request.relative_jump_tolerance) *
                std::abs(static_cast<long double>(anchor.potential_v));
        if (!std::isfinite(error) || !std::isfinite(tolerance) || std::abs(error) > tolerance) {
            throw std::runtime_error("charge trace solution lost an authored potential anchor");
        }
    }
    for (const auto &[component, dof] : component_gauge_dof) {
        if (anchored_components.count(component) == 0 &&
            (!std::isfinite(potential[dof]) ||
                std::abs(potential[dof]) > request.absolute_jump_tolerance_v)) {
            throw std::runtime_error("charge trace solution lost a component gauge");
        }
    }
    matrix.Mult(potential, action);
    std::vector<long double> quotient_reactions(static_cast<std::size_t>(trace.reduced_size), 0.0L);
    for (int dof = 0; dof < count; ++dof) {
        if (!std::isfinite(potential[dof]) || !std::isfinite(action[dof])) {
            throw std::runtime_error("charge trace solution or reaction is nonfinite");
        }
        quotient_reactions[static_cast<std::size_t>(trace.full_to_reduced[
            static_cast<std::size_t>(dof)])] += action[dof];
    }
    std::map<int, std::pair<long double, long double>> component_norms;
    for (int reduced = 0; reduced < trace.reduced_size; ++reduced) {
        const int index = free_index[static_cast<std::size_t>(reduced)];
        if (index < 0) continue;
        auto &norms = component_norms[electrical_root(reduced)];
        const long double residual = quotient_reactions[static_cast<std::size_t>(reduced)];
        const long double forcing = rhs[index];
        norms.first += residual * residual;
        norms.second += forcing * forcing;
    }
    for (const auto &[component, dof] : component_gauge_dof) {
        const auto norms = component_norms[component];
        const long double relative = std::sqrt(norms.first) /
            std::max(std::sqrt(norms.second), 1.0e-30L);
        if (!std::isfinite(relative) || relative > request.algebraic_relative_tolerance) {
            throw std::runtime_error("charge trace component failed the independent H1 residual gate");
        }
        result->component_relative_residuals.push_back(static_cast<double>(relative));
        result->component_ids.push_back(result->stable_vertex_identities.local_to_stable[
            static_cast<std::size_t>(dof_vertices[static_cast<std::size_t>(dof)])]);
    }
    for (int vertex = 0; vertex < count; ++vertex) {
        const int dof = vertex_dofs[static_cast<std::size_t>(vertex)];
        result->potential_vertex_values_v.push_back(potential[dof]);
        result->reaction_vertex_values_a.push_back(action[dof]);
        const int component = electrical_root(trace.full_to_reduced[static_cast<std::size_t>(dof)]);
        const int anchor_vertex = dof_vertices[static_cast<std::size_t>(component_gauge_dof.at(component))];
        result->vertex_component_ids.push_back(result->stable_vertex_identities.local_to_stable[
            static_cast<std::size_t>(anchor_vertex)]);
    }
    return result;
}

ChargeTraceWorkspace::ChargeTraceWorkspace(const ChargeTraceSolveRequest &request)
    : impl_(std::make_unique<Impl>(request)) {}

ChargeTraceWorkspace::~ChargeTraceWorkspace() = default;

std::shared_ptr<const ChargeTraceSolution> ChargeTraceWorkspace::solve(
    const std::vector<double> &trace_jumps_v,
    const std::vector<double> &anchor_potentials_v) const
{
    return impl_->solve(trace_jumps_v, anchor_potentials_v);
}

bool ChargeTraceWorkspace::is_component_constant_control(
    const std::vector<double> &trace_jumps_v,
    const std::vector<double> &anchor_potentials_v) const
{
    return impl_->is_component_constant_control(trace_jumps_v, anchor_potentials_v);
}

int ChargeTraceWorkspace::original_volume_component_for_full_dof(int full_dof) const
{
    return impl_->original_volume_component_for_full_dof(full_dof);
}

int ChargeTraceWorkspace::vertex_index_for_full_dof(int full_dof) const
{
    return impl_->vertex_index_for_full_dof(full_dof);
}

void ChargeTraceWorkspace::require_control_topology(const ChargeTraceSolveRequest &request) const
{
    impl_->require_control_topology(request);
}

std::shared_ptr<const ChargeTraceSolution> solve_charge_trace_workspace(
    const ChargeTraceSolveRequest &request)
{
    ChargeTraceWorkspace workspace(request);
    std::vector<double> jumps, anchors;
    for (const auto &relation : request.trace_relations) jumps.push_back(relation.potential_jump_v);
    for (const auto &anchor : request.potential_anchors) anchors.push_back(anchor.potential_v);
    return workspace.solve(jumps, anchors);
}

} // namespace fullmag::fem::antenna_field_solve
