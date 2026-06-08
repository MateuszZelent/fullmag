/*
 * Exchange no-MFEM fallback source contract.
 *
 * This source owns disabled zero-field behavior and explicit MFEM-stack errors
 * for builds without the native MFEM runtime. It does not assemble MFEM operators or claim active exchange execution.
 */
#include "cpu/mfem/interactions/exchange_fallback.hpp"

#include "context.hpp"
#include "cpu/mfem/interactions/exchange_field.hpp"
#include "cpu/mfem/interactions/exchange_operator.hpp"

#include <string>
#include <vector>

namespace fullmag::fem {

#if !FULLMAG_HAS_MFEM_STACK
bool initialize_exchange_operator_mfem(
    Context &,
    mfem::Mesh &,
    mfem::FiniteElementSpace &,
    mfem::Coefficient &,
    mfem::Coefficient &,
    std::string &error)
{
    error = "Native FEM exchange requires the MFEM stack";
    return false;
}

bool compute_exchange_for_magnetization(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_ex_xyz,
    std::vector<double> *h_eff_xyz,
    double *exchange_energy,
    bool,
    std::string &error)
{
    const size_t field_size =
        !m_xyz.empty() ? m_xyz.size() : static_cast<size_t>(ctx.mesh.n_nodes) * 3u;
    h_ex_xyz.assign(field_size, 0.0);
    if (h_eff_xyz != nullptr) {
        *h_eff_xyz = h_ex_xyz;
    }
    if (exchange_energy != nullptr) {
        *exchange_energy = 0.0;
    }
    if (!ctx.exchange.enabled || ctx.material_fields.material.exchange_stiffness == 0.0) {
        return true;
    }
    error = "Native FEM exchange requires the MFEM stack";
    return false;
}
#endif

} // namespace fullmag::fem
