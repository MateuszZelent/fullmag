#pragma once

#include <cstddef>
#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Reusable Zhang-Li CIP scratch buffers.
 *
 * The torque projection first accumulates an element-weighted nodal RHS and
 * normalizes it by nodal weights before adding it to the caller's LLG RHS.
 * Keeping both arrays here avoids hot-path allocations and prevents the
 * normalization step from scaling pre-existing RHS terms.
 */
struct ZhangLiSttWorkspace {
    std::vector<double> rhs_xyz;
    std::vector<double> node_weight;
};

void prepare_zhang_li_stt_workspace(
    ZhangLiSttWorkspace &workspace,
    std::size_t dof_len,
    std::size_t n_nodes);

/*
 * Add Zhang-Li CIP spin-transfer torque directly to the LLG RHS.
 *
 * This module owns the current-in-plane torque contribution in dm/dt units. It
 * estimates one P1 tetrahedral gradient of reduced magnetization per magnetic
 * element, projects the element torque back to nodes with lumped P1 weights,
 * and applies the configured current-density vector, spin-polarization degree,
 * non-adiabatic beta, and Ms overrides. It does not own Slonczewski CPP torque, aggregate family dispatch, plan import, or effective-field composition.
 */
void add_zhang_li_stt_rhs_aos(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &rhs_xyz);

void add_zhang_li_stt_rhs_aos(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &rhs_xyz,
    ZhangLiSttWorkspace &workspace);

} // namespace fullmag::fem
