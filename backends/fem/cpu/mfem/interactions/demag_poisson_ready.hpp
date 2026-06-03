#pragma once

#include "fullmag_fem.h"

#include <string>

namespace fullmag::fem {

/*
 * Validate whether the native Poisson-demag operator can run a fresh solve.
 *
 * This module owns the executable-realization readiness predicate for fresh
 * Poisson-demag solves.
 * Only airbox Dirichlet and airbox Robin realizations are executable in this
 * module. The caller must also have initialized the Poisson operator workspace.
 * It does not initialize MFEM resources, assemble RHS, solve Poisson, or recover fields.
 */
bool demag_poisson_operator_ready_for_fresh_solve(
    int demag_realization,
    bool poisson_ready,
    std::string &error);

} // namespace fullmag::fem
