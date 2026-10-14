#pragma once

#include "cpu/mfem/workflows/antenna_field_solve/charge_current_response.hpp"

namespace fullmag::fem::antenna_field_solve {

struct ResolvedChargeTerminal {
    std::string id;
    std::vector<std::array<std::uint64_t, 3>> boundary_face_vertex_ids;
    double requested_outward_current_a = 0.0;
};

struct ChargeTerminalCurrentRequest {
    ChargeTraceSolveRequest conductor;
    std::vector<ResolvedChargeTerminal> terminals;
};

// Owned H1 terminal reactions, not an RT0 moment or complete V/J/H certificate.
struct ChargeTerminalCurrentSolution {
    std::shared_ptr<const ChargeTraceSolution> accepted_solution;
    std::vector<std::string> terminal_ids;
    std::vector<std::vector<std::array<std::uint64_t, 3>>> terminal_boundary_face_vertex_ids;
    std::vector<double> terminal_voltages_v;
    std::vector<double> requested_outward_currents_a;
    std::vector<double> measured_outward_currents_a;
    std::vector<double> current_residuals_a;
    std::vector<std::uint64_t> terminal_component_ids;
    std::vector<std::string> reference_terminal_ids;
    std::vector<std::uint64_t> reference_component_ids;
    std::shared_ptr<const ChargeCurrentResponseSolution> response;
};

std::shared_ptr<const ChargeTerminalCurrentSolution> solve_charge_terminal_current_constraints(
    const ChargeTerminalCurrentRequest &request);

} // namespace fullmag::fem::antenna_field_solve
