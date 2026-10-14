#pragma once

#include "cpu/mfem/workflows/antenna_field_solve/charge_trace_workspace.hpp"

#include <string>

namespace fullmag::fem::antenna_field_solve {

struct ChargeVoltageControlColumn {
    std::string id;
    std::vector<double> trace_jump_coefficients;
    std::vector<double> anchor_potential_coefficients;
    double requested_conjugate_current_a = 0.0;
};

struct ChargeCurrentResponseRequest {
    ChargeTraceSolveRequest zero_baseline;
    std::vector<ChargeVoltageControlColumn> columns;
};

// Currents are conjugate to the authored controls, not physical terminal or
// RT0 flux certificates. All numerical payloads and the accepted V/KV are owned.
struct ChargeCurrentResponseSolution {
    std::shared_ptr<const ChargeTraceSolution> accepted_solution;
    std::vector<std::string> control_ids;
    std::vector<double> control_voltages_v;
    std::vector<double> measured_conjugate_currents_a;
    std::vector<double> current_residuals_a;
    std::vector<double> response_matrix_s;
    double maximum_scaled_symmetry_error = 0.0;
    double minimum_scaled_cholesky_pivot = 0.0;
};

std::shared_ptr<const ChargeCurrentResponseSolution> solve_charge_current_response(
    const ChargeCurrentResponseRequest &request);
// Explicit prepared-owner reuse; mesh/material pointers in zero_baseline are
// not reread. Stable IDs, trace/anchor topology and solver policy must match.
std::shared_ptr<const ChargeCurrentResponseSolution> solve_charge_current_response_prepared(
    const ChargeCurrentResponseRequest &request, const ChargeTraceWorkspace &workspace);

} // namespace fullmag::fem::antenna_field_solve
