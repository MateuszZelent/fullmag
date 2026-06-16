#pragma once

#include <vector>

namespace mfem {
class BilinearForm;
class GridFunction;
class Vector;
} // namespace mfem

namespace fullmag::fem {

struct Context;

#if FULLMAG_HAS_MFEM_STACK
/*
 * Mass projection for the native FEM exchange interaction.
 *
 * Exchange assembly produces the stiffness RHS K_A m for one magnetization
 * component. This module owns the projection from that RHS to H_ex in A/m:
 * magnetic lumped-mass setup, optional consistent-mass CG projection, periodic
 * reduced-node aggregation/lift, Ms scaling, and host-side component export.
 * Lumped projection applies pointwise 1/Ms_i scaling after the volume-mass
 * inverse. Consistent projection solves with the Ms-weighted mass form and then
 * applies the common -2/mu0 field scale, which is the weak-form equivalent of
 * H_ex = 2 div(A grad m)/(mu0 Ms).
 *
 * It does not assemble the exchange stiffness form, choose magnetic element
 * attributes, upload legacy sparse GPU operators, pack AoS fields, add Zeeman
 * or other H_eff terms, or apply gamma/damping/torque factors.
 */
void prepare_exchange_mass_lumping(
    mfem::BilinearForm &mass_form,
    mfem::Vector &ones,
    mfem::Vector &lumped,
    mfem::Vector &inv_lumped,
    std::vector<double> &host_lumped,
    bool use_device = true);

bool apply_exchange_component_mass_projection(
    Context *ctx,
    bool allow_interrupt,
    mfem::BilinearForm &exchange_form,
    mfem::GridFunction &m_component,
    mfem::GridFunction &ms_field,
    mfem::Vector &inv_lumped_mass,
    mfem::BilinearForm &mass_form,
    bool use_consistent_mass,
    mfem::Vector &tmp,
    mfem::Vector &h_component,
    std::vector<double> &h_component_host,
    double *energy_out);
#endif

} // namespace fullmag::fem
