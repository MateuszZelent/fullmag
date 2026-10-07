#pragma once

#include "cpu/mfem/transport/affine_trace_relations.hpp"
#include "cpu/mfem/transport/periodic_charge_potential.hpp"

#include <array>
#include <cstdint>
#include <memory>
#include <vector>

namespace fullmag::fem::antenna_field_solve {

struct ChargePotentialAnchor {
    int full_dof = -1;
    double potential_v = 0.0;
};

// Mesh and material are borrowed only during workspace assembly. Trace relations must be resolved after
// meshing; this operator does not infer physical interfaces from coordinates.
struct ChargeTraceSolveRequest {
    mfem::Mesh *mesh = nullptr;
    mfem::Coefficient *conductivity = nullptr;
    transport::StableMeshVertexIdentities stable_vertex_identities;
    std::vector<transport::AffineTraceRelation> trace_relations;
    std::vector<ChargePotentialAnchor> potential_anchors;
    double absolute_jump_tolerance_v = 1.0e-12;
    double relative_jump_tolerance = 1.0e-12;
    double algebraic_relative_tolerance = 1.0e-12;
    int maximum_iterations = 1000;
};

// All payloads are owned; reactions are K*V before any boundary elimination.
// This is a voltage/trace solution, not a port-current or RT0 certificate.
struct ChargeTraceSolution {
    transport::StableMeshVertexIdentities stable_vertex_identities;
    std::vector<std::array<double, 3>> vertex_positions_m;
    std::vector<double> potential_vertex_values_v;
    std::vector<double> reaction_vertex_values_a;
    std::vector<std::uint64_t> vertex_component_ids;
    std::vector<std::uint64_t> gauge_vertex_ids;
    std::vector<std::uint64_t> component_ids;
    std::vector<double> component_relative_residuals;
};

// Assembly owns the original K and all vertex/component maps. Subsequent
// solves change values only, and never read the borrowed mesh or material.
class ChargeTraceWorkspace {
public:
    explicit ChargeTraceWorkspace(const ChargeTraceSolveRequest &request);
    ~ChargeTraceWorkspace();
    ChargeTraceWorkspace(const ChargeTraceWorkspace &) = delete;
    ChargeTraceWorkspace &operator=(const ChargeTraceWorkspace &) = delete;
    ChargeTraceWorkspace(ChargeTraceWorkspace &&) = delete;
    ChargeTraceWorkspace &operator=(ChargeTraceWorkspace &&) = delete;

    std::shared_ptr<const ChargeTraceSolution> solve(
        const std::vector<double> &trace_jumps_v,
        const std::vector<double> &anchor_potentials_v) const;
    bool is_component_constant_control(
        const std::vector<double> &trace_jumps_v,
        const std::vector<double> &anchor_potentials_v) const;
    // Original K nullspace partition, before electrical trace identification.
    int original_volume_component_for_full_dof(int full_dof) const;
    int vertex_index_for_full_dof(int full_dof) const;
    void require_control_topology(const ChargeTraceSolveRequest &request) const;

private:
    class Impl;
    std::unique_ptr<Impl> impl_;
};

std::shared_ptr<const ChargeTraceSolution> solve_charge_trace_workspace(
    const ChargeTraceSolveRequest &request);

} // namespace fullmag::fem::antenna_field_solve
