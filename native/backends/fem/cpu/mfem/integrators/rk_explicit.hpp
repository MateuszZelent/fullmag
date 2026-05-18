#pragma once

#include "cpu/mfem/integrators/rk_tableau.hpp"
#include "cpu/mfem/integrators/rk_stepper_workspace.hpp"
#include "fullmag_fem.h"

#include <cstddef>

namespace fullmag::fem {

/*
 * Own explicit RK tableau dispatch and reusable workspace allocation.
 *
 * This aggregate integrator header exposes the two shared entrypoints used by
 * the explicit RK stepper: selecting the configured tableau and sizing the
 * scratch buffers for stage evaluation.
 *
 * It does not evaluate stage RHS, perform complete RK steps, compose H_eff, or
 * own adaptive control.
 */
const ExplicitTableau &tableau_for_integrator(fullmag_fem_integrator integrator);
void stepper_workspace_allocate(StepperWorkspace &ws, std::size_t dof_len, int stages);

} // namespace fullmag::fem
