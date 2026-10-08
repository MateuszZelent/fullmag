#include "cpu/mfem/workflows/antenna_field_solve/charge_terminal_current_constraints.hpp"

#include <mfem.hpp>

#include <algorithm>
#include <cmath>
#include <map>
#include <set>
#include <stdexcept>
#include <utility>

namespace fullmag::fem::antenna_field_solve {
namespace {

using FaceKey = std::array<std::uint64_t, 3>;

double finite_double(long double value, const char *message)
{
    const double converted = static_cast<double>(value);
    if (!std::isfinite(value) || !std::isfinite(converted)) throw std::runtime_error(message);
    return converted == 0.0 ? 0.0 : converted;
}

std::vector<std::set<int>> resolve_terminal_dofs(const ChargeTerminalCurrentRequest &request)
{
    const auto &conductor = request.conductor;
    if (conductor.mesh == nullptr || request.terminals.empty() ||
        !conductor.potential_anchors.empty()) {
        throw std::invalid_argument("terminal current adapter requires a mesh, terminals and no authored anchors");
    }
    for (const auto &relation : conductor.trace_relations) {
        if (relation.potential_jump_v != 0.0) {
            throw std::invalid_argument("terminal current adapter does not accept nonzero cut actuators");
        }
    }
    auto &mesh = *conductor.mesh;
    if (mesh.Dimension() != 3 || mesh.SpaceDimension() != 3 || mesh.GetNodes() != nullptr ||
        mesh.GetNE() <= 0 || mesh.GetNV() <= 0 || mesh.GetNBE() <= 0 ||
        conductor.stable_vertex_identities.local_to_stable.size() != static_cast<std::size_t>(mesh.GetNV())) {
        throw std::invalid_argument("terminal current adapter mesh or stable vertex count is invalid");
    }
    std::map<FaceKey, std::size_t> requested_faces;
    std::set<std::string> terminal_ids;
    std::size_t face_count = 0;
    for (std::size_t terminal = 0; terminal < request.terminals.size(); ++terminal) {
        const auto &definition = request.terminals[terminal];
        if (definition.id.empty() || !terminal_ids.insert(definition.id).second ||
            definition.boundary_face_vertex_ids.empty() ||
            !std::isfinite(definition.requested_outward_current_a)) {
            throw std::invalid_argument("terminal identity, face list or signed current is invalid");
        }
        if (definition.boundary_face_vertex_ids.size() > static_cast<std::size_t>(mesh.GetNBE()) - face_count) {
            throw std::invalid_argument("terminal face count exceeds the physical mesh boundary");
        }
        face_count += definition.boundary_face_vertex_ids.size();
        for (const auto &key : definition.boundary_face_vertex_ids) {
            if (key[0] == 0 || !(key[0] < key[1] && key[1] < key[2]) ||
                !requested_faces.emplace(key, terminal).second) {
                throw std::invalid_argument("terminal face keys must be canonical, nonzero and globally unique");
            }
        }
    }
    mfem::H1_FECollection collection(1, 3);
    mfem::FiniteElementSpace space(&mesh, &collection);
    if (space.GetVSize() != mesh.GetNV() || space.GetVSize() != space.GetTrueVSize()) {
        throw std::invalid_argument("terminal current adapter requires conforming scalar P1");
    }
    std::vector<std::set<int>> terminal_dofs(request.terminals.size());
    std::set<FaceKey> found_faces;
    for (int boundary = 0; boundary < mesh.GetNBE(); ++boundary) {
        mfem::Array<int> vertices;
        mesh.GetBdrElementVertices(boundary, vertices);
        if (vertices.Size() != 3) throw std::invalid_argument("terminal current adapter requires triangular boundary faces");
        FaceKey key{};
        for (int index = 0; index < 3; ++index) {
            key[static_cast<std::size_t>(index)] = conductor.stable_vertex_identities.local_to_stable.at(
                static_cast<std::size_t>(vertices[index]));
        }
        std::sort(key.begin(), key.end());
        const auto requested = requested_faces.find(key);
        if (requested == requested_faces.end()) continue;
        int face = -1, orientation = 0, first = -1, second = -1;
        mesh.GetBdrElementFace(boundary, &face, &orientation);
        if (face < 0) throw std::invalid_argument("terminal boundary has no physical mesh face");
        mesh.GetFaceElements(face, &first, &second);
        if (first < 0 || second >= 0 || !found_faces.insert(key).second) {
            throw std::invalid_argument("terminal key does not identify one unique exterior boundary face");
        }
        for (int vertex : vertices) {
            mfem::Array<int> dofs;
            space.GetVertexDofs(vertex, dofs);
            if (dofs.Size() != 1 || dofs[0] < 0 || dofs[0] >= space.GetVSize()) {
                throw std::invalid_argument("terminal boundary vertex has no unique P1 DOF");
            }
            terminal_dofs[requested->second].insert(dofs[0]);
        }
    }
    if (found_faces.size() != requested_faces.size()) {
        throw std::invalid_argument("terminal references an unknown or nonboundary stable face key");
    }
    std::map<int, std::size_t> dof_terminal;
    for (std::size_t terminal = 0; terminal < terminal_dofs.size(); ++terminal) {
        const auto &dofs = terminal_dofs[terminal];
        if (dofs.empty()) throw std::invalid_argument("terminal has no essential P1 DOFs");
        for (int dof : dofs) {
            if (!dof_terminal.emplace(dof, terminal).second) throw std::invalid_argument("physical terminals share an essential DOF");
        }
    }
    for (int boundary = 0; boundary < mesh.GetNBE(); ++boundary) {
        mfem::Array<int> vertices;
        mesh.GetBdrElementVertices(boundary, vertices);
        FaceKey key{};
        std::size_t terminal = terminal_dofs.size();
        bool complete = true;
        bool mixed = false;
        for (int index = 0; index < 3; ++index) {
            mfem::Array<int> dofs;
            space.GetVertexDofs(vertices[index], dofs);
            if (dofs.Size() != 1 || dofs[0] < 0 || dofs[0] >= space.GetVSize()) {
                throw std::invalid_argument("terminal boundary vertex has no unique P1 DOF");
            }
            const auto owner = dof_terminal.find(dofs[0]);
            if (owner == dof_terminal.end()) {
                complete = false;
                break;
            }
            if (terminal == terminal_dofs.size()) terminal = owner->second;
            else mixed = mixed || owner->second != terminal;
            key[static_cast<std::size_t>(index)] = conductor.stable_vertex_identities.local_to_stable.at(
                static_cast<std::size_t>(vertices[index]));
        }
        if (!complete) continue;
        if (mixed) {
            throw std::invalid_argument("electrode separator face has no free P1 DOF");
        }
        std::sort(key.begin(), key.end());
        const auto requested = requested_faces.find(key);
        if (requested == requested_faces.end() || requested->second != terminal) {
            throw std::invalid_argument("terminal face list is not closed under its essential P1 DOFs");
        }
    }
    for (const auto &relation : conductor.trace_relations) {
        if (relation.minus_dof != relation.plus_dof &&
            (dof_terminal.count(relation.minus_dof) != 0 || dof_terminal.count(relation.plus_dof) != 0)) {
            throw std::invalid_argument("terminal current adapter does not support trace-aliased electrode DOFs");
        }
    }
    return terminal_dofs;
}

} // namespace

std::shared_ptr<const ChargeTerminalCurrentSolution> solve_charge_terminal_current_constraints(
    const ChargeTerminalCurrentRequest &request)
{
    const auto terminal_dofs = resolve_terminal_dofs(request);
    ChargeCurrentResponseRequest response_request;
    response_request.zero_baseline = request.conductor;
    std::map<int, std::size_t> anchor_index;
    for (const auto &dofs : terminal_dofs) {
        for (int dof : dofs) {
            anchor_index.emplace(dof, response_request.zero_baseline.potential_anchors.size());
            response_request.zero_baseline.potential_anchors.push_back({dof, 0.0});
        }
    }
    ChargeTraceWorkspace workspace(response_request.zero_baseline);
    const auto zero = workspace.solve(std::vector<double>(request.conductor.trace_relations.size(), 0.0),
        std::vector<double>(anchor_index.size(), 0.0));
    auto result = std::make_shared<ChargeTerminalCurrentSolution>();
    const std::size_t count = request.terminals.size();
    std::vector<std::uint64_t> minimum_vertex_ids(count);
    std::map<std::uint64_t, std::size_t> references;
    std::map<std::uint64_t, std::pair<long double, long double>> component_currents;
    for (std::size_t terminal = 0; terminal < count; ++terminal) {
        std::uint64_t component = 0, minimum_id = 0;
        for (int dof : terminal_dofs[terminal]) {
            const auto vertex = static_cast<std::size_t>(workspace.vertex_index_for_full_dof(dof));
            const auto assigned = zero->vertex_component_ids.at(vertex);
            const auto id = zero->stable_vertex_identities.local_to_stable.at(vertex);
            if (component != 0 && component != assigned) {
                throw std::invalid_argument("one physical terminal spans electrical components");
            }
            component = assigned;
            minimum_id = minimum_id == 0 ? id : std::min(minimum_id, id);
        }
        minimum_vertex_ids[terminal] = minimum_id;
        result->terminal_component_ids.push_back(component);
        const auto existing = references.find(component);
        if (existing == references.end() || minimum_id < minimum_vertex_ids[existing->second]) {
            references[component] = terminal;
        }
        const long double current = request.terminals[terminal].requested_outward_current_a;
        auto &balance = component_currents[component];
        balance.first += current;
        balance.second += std::abs(current);
    }
    for (const auto &[component, balance] : component_currents) {
        (void)component;
        if (!std::isfinite(balance.first) || !std::isfinite(balance.second) ||
            std::abs(balance.first) > 1.0e-18L + 1.0e-10L * balance.second) {
            throw std::invalid_argument("requested outward terminal currents do not balance on an electrical component");
        }
    }
    for (const auto &[component, reference] : references) {
        result->reference_component_ids.push_back(component);
        result->reference_terminal_ids.push_back(request.terminals[reference].id);
    }
    for (std::size_t terminal = 0; terminal < count; ++terminal) {
        if (references.at(result->terminal_component_ids[terminal]) == terminal) continue;
        if (response_request.columns.size() == 64) {
            throw std::invalid_argument("terminal current adapter exceeds 64 independent controls");
        }
        ChargeVoltageControlColumn column;
        column.id = request.terminals[terminal].id;
        column.trace_jump_coefficients.assign(request.conductor.trace_relations.size(), 0.0);
        column.anchor_potential_coefficients.assign(anchor_index.size(), 0.0);
        for (int dof : terminal_dofs[terminal]) column.anchor_potential_coefficients[anchor_index.at(dof)] = 1.0;
        column.requested_conjugate_current_a = request.terminals[terminal].requested_outward_current_a;
        response_request.columns.push_back(std::move(column));
    }
    if (response_request.columns.empty()) {
        result->accepted_solution = zero;
    } else {
        result->response = solve_charge_current_response_prepared(response_request, workspace);
        result->accepted_solution = result->response->accepted_solution;
    }
    const auto &accepted = *result->accepted_solution;
    if (accepted.stable_vertex_identities.version != zero->stable_vertex_identities.version ||
        accepted.stable_vertex_identities.local_to_stable != zero->stable_vertex_identities.local_to_stable ||
        accepted.vertex_component_ids != zero->vertex_component_ids || accepted.component_ids != zero->component_ids ||
        accepted.gauge_vertex_ids != zero->gauge_vertex_ids) {
        throw std::runtime_error("terminal solve changed its owned vertex/component/gauge partition");
    }
    const double relative_voltage_tolerance = std::max(request.conductor.relative_jump_tolerance,
        100.0 * request.conductor.algebraic_relative_tolerance);
    for (std::size_t terminal = 0; terminal < count; ++terminal) {
        const auto first_vertex = static_cast<std::size_t>(workspace.vertex_index_for_full_dof(*terminal_dofs[terminal].begin()));
        const double voltage = accepted.potential_vertex_values_v.at(first_vertex);
        const bool reference = references.at(result->terminal_component_ids[terminal]) == terminal;
        long double outward = 0.0L;
        for (int dof : terminal_dofs[terminal]) {
            const auto vertex = static_cast<std::size_t>(workspace.vertex_index_for_full_dof(dof));
            const double value = accepted.potential_vertex_values_v.at(vertex);
            const long double tolerance = request.conductor.absolute_jump_tolerance_v +
                relative_voltage_tolerance * std::max(std::abs(static_cast<long double>(value)),
                    std::abs(static_cast<long double>(voltage)));
            if (!std::isfinite(value) || !std::isfinite(tolerance) ||
                std::abs(static_cast<long double>(value) - voltage) > tolerance ||
                (reference && std::abs(static_cast<long double>(value)) > request.conductor.absolute_jump_tolerance_v)) {
                throw std::runtime_error("terminal solve failed its local equipotential/reference gate");
            }
            outward -= accepted.reaction_vertex_values_a.at(vertex);
        }
        const long double requested = request.terminals[terminal].requested_outward_current_a;
        const long double residual = outward - requested;
        if (!std::isfinite(outward) || !std::isfinite(residual) ||
            std::abs(residual) > 1.0e-18L + 1.0e-8L * std::abs(requested)) {
            throw std::runtime_error("terminal solve failed its signed physical-terminal current certificate");
        }
        result->terminal_ids.push_back(request.terminals[terminal].id);
        result->terminal_boundary_face_vertex_ids.push_back(request.terminals[terminal].boundary_face_vertex_ids);
        result->terminal_voltages_v.push_back(voltage);
        result->requested_outward_currents_a.push_back(request.terminals[terminal].requested_outward_current_a);
        result->measured_outward_currents_a.push_back(finite_double(outward, "terminal current overflow"));
        result->current_residuals_a.push_back(finite_double(residual, "terminal current residual overflow"));
    }
    std::set<std::uint64_t> terminal_components(result->terminal_component_ids.begin(), result->terminal_component_ids.end());
    for (std::size_t vertex = 0; vertex < accepted.vertex_component_ids.size(); ++vertex) {
        if (terminal_components.count(accepted.vertex_component_ids[vertex]) == 0 &&
            (!std::isfinite(accepted.potential_vertex_values_v.at(vertex)) ||
                std::abs(accepted.potential_vertex_values_v.at(vertex)) > request.conductor.absolute_jump_tolerance_v)) {
            throw std::runtime_error("unforced isolated charge component acquired a potential");
        }
    }
    return result;
}

} // namespace fullmag::fem::antenna_field_solve
