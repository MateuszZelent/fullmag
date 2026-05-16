#pragma once

#include <string>
#include <vector>

namespace mfem {
class FiniteElementSpace;
class GridFunctionCoefficient;
class Mesh;
class SparseMatrix;
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
 * on magnetic elements with natural exchange boundary conditions. The module
 * stores the MFEM stiffness, mass/lumped-mass workspaces, component grid
 * functions, and GPU upload metadata behind Context's transitional handles.
 */
bool initialize_exchange_operator_mfem(
    Context &ctx,
    mfem::Mesh &mesh,
    mfem::FiniteElementSpace &fes,
    mfem::GridFunctionCoefficient &a_coeff,
    std::string &error);

/*
 * Upload the assembled exchange operator to the legacy sparse GPU state.
 *
 * This is a compatibility bridge for the current GPU exchange-only path; the
 * physical exchange contract remains owned by this module.
 */
bool upload_legacy_sparse_exchange_to_gpu_state(
    Context &ctx,
    mfem::SparseMatrix &exchange_spmat,
    std::string &error);

/*
 * Compute the exchange field for a magnetization state.
 *
 * The returned `h_ex_xyz` is H_ex in A/m and the optional energy is in joules.
 * The module does not apply gamma, damping, or direct-torque scaling. When the
 * MFEM stack is unavailable, disabled exchange returns a zero field and active
 * exchange reports an explicit environment error.
 */
bool compute_exchange_for_magnetization(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_ex_xyz,
    std::vector<double> *h_eff_xyz,
    double *exchange_energy,
    bool allow_interrupt,
    std::string &error);

} // namespace fullmag::fem
