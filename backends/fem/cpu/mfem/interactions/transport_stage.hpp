#pragma once

#include "fullmag_fem.h"

#include <cstdint>
#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Reciprocal transport-stage interaction owner. This module owns callback
 * materialization and attempt bookkeeping. It does not own the charge/spin
 * transport solve, effective-field composition, or RK transaction lifecycle.
 */

/* Runtime owner for the public reciprocal transport torque callback.  The
 * callback returns a direct LLG RHS contribution in 1/s for every magnetic
 * node at the exact RK stage; attempt hooks are kept here so reject/commit
 * semantics are independent of the charge--spin solver implementation. */
struct TransportStageRuntimeState {
    bool has_stage_callback = false;
    fullmag_fem_stage_transport_callback_v1 stage_callback{};
    std::vector<double> torque_xyz_per_s;
    uint64_t stage_identity = 0;
    uint64_t stage_source_state_revision = 0;
    bool stage_attempt_active = false;
    uint64_t stage_attempt_target_step = 0;
    uint64_t stage_attempt_identity = 0;
    double stage_attempt_time_start_s = 0.0;
    double stage_attempt_dt_seconds = 0.0;
};

bool materialize_transport_stage_rhs(
    Context &ctx,
    const std::vector<double> &m_xyz,
    double evaluation_time_s,
    uint64_t stage_identity,
    std::string &error);

void add_transport_stage_rhs(
    const Context &ctx,
    std::vector<double> &rhs_xyz,
    double &max_rhs);

bool begin_transport_stage_attempt(
    Context &ctx,
    uint64_t target_step,
    uint64_t attempt_identity,
    double time_start_s,
    double dt_seconds,
    std::string &error);

bool commit_transport_stage_attempt(Context &ctx, std::string &error);
bool rollback_transport_stage_attempt(Context &ctx, std::string &error);

bool configure_transport_stage_callback(
    Context &ctx,
    const fullmag_fem_stage_transport_callback_v1 *callback,
    std::string &error);

} // namespace fullmag::fem
