#pragma once

#include "fullmag_fem.h"

#include <cstddef>

namespace fullmag::fem {

struct ExplicitTableau;
struct StepperWorkspace;

const ExplicitTableau &tableau_for_integrator(fullmag_fem_integrator integrator);
void stepper_workspace_allocate(StepperWorkspace &ws, std::size_t dof_len, int stages);

} // namespace fullmag::fem
