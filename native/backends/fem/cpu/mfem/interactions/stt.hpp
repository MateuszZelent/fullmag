#pragma once

#include "cpu/mfem/interactions/stt_slonczewski.hpp"
#include "cpu/mfem/interactions/stt_zhang_li.hpp"
#include "fullmag_fem.h"

#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Initialize executable STT plan fields.
 *
 * Copies Slonczewski CPP and Zhang-Li CIP plan parameters into Context
 * compatibility storage, enforces that only one executable STT family is
 * active, and normalizes the Slonczewski spin-polarization vector.
 */
bool initialize_stt_plan_fields(
    Context &ctx,
    const fullmag_fem_plan_desc &plan,
    std::string &error);

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
