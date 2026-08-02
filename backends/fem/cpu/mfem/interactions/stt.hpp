#pragma once

#include "cpu/mfem/interactions/stt_slonczewski.hpp"
#include "cpu/mfem/interactions/stt_zhang_li.hpp"
#include "fullmag_fem.h"

#include <array>
#include <cstddef>
#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Aggregated include and dispatch surface for executable STT families.
 *
 * This compatibility umbrella owns plan import, family dispatch, and reusable
 * workspace routing for the RHS hot path. It does not define Slonczewski CPP
 * torque, Zhang-Li CIP torque, CPP thickness/current physics, or CIP gradient
 * projection. Those responsibilities stay in the dedicated owner modules:
 * stt_slonczewski.* and stt_zhang_li.*.
 */

/*
 * STT runtime plan storage owned by the aggregate.
 *
 * Owns executable STT family enablement, shared current-density and
 * polarization inputs, Zhang-Li CIP beta/degree, Slonczewski CPP
 * lambda/field-like/free-layer/current-sign parameters, and normalized
 * spin polarization after plan import.
 */
struct SttRuntimeState {
    bool zhang_li_enabled = false;
    bool slonczewski_enabled = false;
    std::array<double, 3> current_density_am2{0.0, 0.0, 0.0};
    double degree = 0.0;
    double beta = 0.0;
    std::array<double, 3> spin_polarization{0.0, 0.0, 1.0};
    double lambda = 1.0;
    double epsilon_prime = 0.0;
    double free_layer_thickness = 0.0; // 0 = geometry-derived
    double current_sign = 1.0;
    uint32_t formula_version = FULLMAG_FEM_STT_FORMULA_LEGACY_FULLMAG_V0;
    uint32_t realization_version = FULLMAG_FEM_STT_REALIZATION_NONE;
    uint32_t operator_version = FULLMAG_FEM_STT_OPERATOR_NONE;
    std::array<double, 3> stack_normal{0.0, 0.0, 1.0};
    double lande_g = 0.0;
    std::vector<uint8_t> active_node_mask{};
    std::vector<uint8_t> active_element_mask{};
};

/*
 * Reusable scratch for aggregate STT RHS assembly.
 *
 * Slonczewski is local and writes directly to the RHS. Zhang-Li needs a
 * projected nodal torque and weight buffer so the aggregate can add it to an
 * already-computed LLG RHS without allocating or scaling the existing RHS.
 */
struct SttWorkspace {
    ZhangLiSttWorkspace zhang_li;
};

void prepare_stt_workspace(
    SttWorkspace &workspace,
    std::size_t dof_len,
    std::size_t n_nodes);

/*
 * Initialize executable STT plan fields.
 *
 * Copies Slonczewski CPP and Zhang-Li CIP plan parameters into
 * SttRuntimeState, enforces that only one executable STT family is
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

void add_stt_rhs_aos(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &rhs_xyz,
    double &max_rhs,
    SttWorkspace &workspace);

} // namespace fullmag::fem
