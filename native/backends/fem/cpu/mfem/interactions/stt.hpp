#pragma once

#include "cpu/mfem/interactions/stt_slonczewski.hpp"
#include "cpu/mfem/interactions/stt_zhang_li.hpp"

#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Add all enabled executable STT families and refresh max_rhs when the RHS
 * changed.
 */
void add_stt_rhs_aos(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &rhs_xyz,
    double &max_rhs);

} // namespace fullmag::fem
