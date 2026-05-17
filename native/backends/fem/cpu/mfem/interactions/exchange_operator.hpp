#pragma once

#include <string>

namespace mfem {
class FiniteElementSpace;
class GridFunctionCoefficient;
class Mesh;
} // namespace mfem

namespace fullmag::fem {

struct Context;

/*
 * Initialize the native FEM exchange operator.
 *
 * The assembled operator represents
 *
 *   E_ex = integral_Omega A_ex |grad m|^2 dV,
 *
 * on magnetic elements with natural exchange boundary conditions. This module
 * owns magnetic-attribute selection, MFEM exchange/mass form setup, lumped mass
 * initialization, and transitional Context handles for the assembled forms.
 */
bool initialize_exchange_operator_mfem(
    Context &ctx,
    mfem::Mesh &mesh,
    mfem::FiniteElementSpace &fes,
    mfem::GridFunctionCoefficient &a_coeff,
    std::string &error);

} // namespace fullmag::fem
