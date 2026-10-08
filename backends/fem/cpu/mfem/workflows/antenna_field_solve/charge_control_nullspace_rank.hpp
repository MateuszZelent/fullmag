#pragma once

#include "cpu/mfem/workflows/antenna_field_solve/charge_current_response.hpp"

namespace fullmag::fem::antenna_field_solve {

// Exact authored-control feasibility and rank modulo the ORIGINAL K nullspace.
// Numerical energy/Cholesky and physical terminal certificates remain separate.
void validate_charge_control_rank(const ChargeCurrentResponseRequest &request,
    const ChargeTraceWorkspace &workspace);

} // namespace fullmag::fem::antenna_field_solve
