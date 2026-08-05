#pragma once

#include "fullmag_fem.h"

#include <array>
#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Runtime owner for the local prescribed-SOT source.
 *
 * The state is intentionally separate from solved SHE/spin transport. It
 * stores the signed conventional current, damping-like/field-like
 * efficiencies, the normalized spin-polarization axis, the ferromagnet
 * thickness, the constant stage envelope, and the realized FEM node mask.
 */
struct SotRuntimeState {
    bool enabled = false;
    uint32_t formula_version = FULLMAG_FEM_SOT_FORMULA_NONE;
    double current_density_am2 = 0.0;
    double xi_dl = 0.0;
    double xi_fl = 0.0;
    double thickness = 0.0;
    double envelope_value = 1.0;
    std::array<double, 3> sigma{0.0, 0.0, 1.0};
    std::vector<uint8_t> active_node_mask{};
};

/* Copy and validate the append-only SOT descriptor. */
bool initialize_sot_plan_fields(
    Context &ctx,
    const fullmag_fem_plan_desc &plan,
    std::string &error);

/* Add the explicit Gilbert-converted prescribed-SOT RHS contribution. */
void add_sot_rhs_aos(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &rhs_xyz,
    double &max_rhs);

} // namespace fullmag::fem
