#pragma once

#include "cpu/mfem/interactions/oersted_cylinder.hpp"
#include "cpu/mfem/interactions/oersted_explicit.hpp"
#include "fullmag_fem.h"

#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Oersted runtime state shared by explicit and cylinder paths.
 *
 * Owns plan-level realization selection, analytical-cylinder parameters,
 * current/time-envelope configuration, the non-public analytical unit-current
 * basis, and the public realized AoS-3 H_oe buffer.
 */
struct OerstedRuntimeState {
    bool has_cylinder = false;
    bool has_explicit_field = false;
    double current = 0.0;
    double radius = 0.0;
    std::array<double, 3> center{0.0, 0.0, 0.0};
    std::array<double, 3> axis{0.0, 0.0, 1.0};
    uint32_t time_dep_kind = 0;
    double time_dep_freq = 0.0;
    double time_dep_phase = 0.0;
    double time_dep_offset = 0.0;
    double time_dep_t_on = 0.0;
    double time_dep_t_off = 0.0;
    std::vector<double> h_basis_per_ampere_xyz;
    std::vector<double> h_xyz;

    /* Optional append-only native CPU RK stage provider.  This is interaction
       state, not a second solver policy: the callback owns transport/cache
       physics while this module owns stage identity and publication. */
    bool has_stage_callback = false;
    fullmag_fem_stage_oersted_callback_v1 stage_callback{};
    uint64_t stage_identity = 0;
    uint64_t stage_source_state_revision = 0;
    bool stage_attempt_active = false;
    uint64_t stage_attempt_target_step = 0;
    uint64_t stage_attempt_identity = 0;
    double stage_attempt_time_start_s = 0.0;
    double stage_attempt_dt_seconds = 0.0;
};

/*
 * Initialize Oersted plan fields.
 *
 * Copies either an analytical-cylinder realization or an explicit nodal
 * Oersted field from the ABI plan into OerstedRuntimeState. The function
 * validates mutually exclusive realizations, explicit field length,
 * cylinder-axis normalization, and precomputes the unit-current cylinder field.
 */
bool initialize_oersted_plan_fields(
    Context &ctx,
    const fullmag_fem_plan_desc &plan,
    std::string &error);

/* Materialize public H_oe(t) in A/m.  The cylinder basis remains immutable. */
const std::vector<double> &materialize_oersted_field(
    Context &ctx,
    double evaluation_time_s);

/* Evaluate the optional stage provider for the exact RK magnetization/time,
 * or materialize the legacy static realization when no provider is installed.
 */
bool materialize_oersted_stage_field(
    Context &ctx,
    const std::vector<double> &m_xyz,
    double evaluation_time_s,
    uint64_t stage_identity,
    std::string &error);

bool begin_oersted_stage_attempt(
    Context &ctx,
    uint64_t target_step,
    uint64_t attempt_identity,
    double time_start_s,
    double dt_seconds,
    std::string &error);

bool commit_oersted_stage_attempt(Context &ctx, std::string &error);
bool rollback_oersted_stage_attempt(Context &ctx, std::string &error);

bool configure_oersted_stage_callback(
    Context &ctx,
    const fullmag_fem_stage_oersted_callback_v1 *callback,
    std::string &error);

/*
 * Aggregated include surface and public dispatcher for Oersted realizations.
 *
 * Analytical-cylinder fields are scaled by `oersted_current_scale(ctx, evaluation_time_s)`.
 * Explicit nodal `oersted_field_xyz` inputs are already final H values and are
 * added without current scaling.
 *
 * This compatibility umbrella owns plan-field import and realization dispatch
 * only. It does not sample analytical cylinders or add explicit nodal fields.
 * Those responsibilities stay in oersted_cylinder.* and oersted_explicit.*.
 */
void add_oersted_field(
    const Context &ctx,
    double evaluation_time_s,
    std::vector<double> &h_eff_xyz);

} // namespace fullmag::fem
