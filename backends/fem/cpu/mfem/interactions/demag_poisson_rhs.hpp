#pragma once

#include <string>
#include <vector>

namespace mfem {
class FiniteElementSpace;
class Vector;
} // namespace mfem

namespace fullmag::fem {

struct Context;

#if FULLMAG_HAS_MFEM_STACK
/*
 * RHS assembly workspace for native FEM Poisson demag.
 *
 * This module owns the weak magnetic-charge RHS
 *
 *   b(v) = integral_Omega_m M . grad(v) dV,
 *
 * with M = Ms m in A/m. It keeps the reusable MFEM LinearForm, true-DOF RHS
 * vector, and magnetization vector coefficient behind Context's transitional
 * workspace handles. It does not build boundary operators, solve Poisson,
 * recover H_demag, or compute demag energy.
 */
bool initialize_demag_poisson_rhs_workspace(
    Context &ctx,
    mfem::FiniteElementSpace &fes,
    std::string &error);

void destroy_demag_poisson_rhs_workspace(Context &ctx);

bool assemble_demag_poisson_rhs(
    Context &ctx,
    const std::vector<double> &m_xyz,
    mfem::Vector *&rhs,
    std::string &error);
#endif

} // namespace fullmag::fem
