#pragma once

#include "fullmag_fem.h"

namespace fullmag::fem {

/*
 * Solve the optional GPU dense generalized eigenproblem.
 *
 * Owns descriptor validation, unavailable-path reason strings, and the
 * cuSolverDN generalized symmetric-definite solve when CUDA/cuSolver support is
 * compiled in. It does not own exported C ABI entrypoint plumbing; api.cpp
 * remains the C ABI facade and delegates here.
 */
int solve_dense_generalized_eigenproblem(fullmag_fem_eigen_dense_desc *desc);

} // namespace fullmag::fem
