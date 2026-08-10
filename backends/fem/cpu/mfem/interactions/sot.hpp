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
 * thickness, the immutable stage-time envelope descriptor, and the realized
 * FEM node mask.
 */
struct SotRuntimeState {
    bool enabled = false;
    uint32_t formula_version = FULLMAG_FEM_SOT_FORMULA_NONE;
    double current_density_am2 = 0.0;
    double xi_dl = 0.0;
    double xi_fl = 0.0;
    double thickness = 0.0;
    double envelope_value = 1.0;
    uint32_t envelope_kind = FULLMAG_FEM_TIME_CONSTANT;
    uint32_t envelope_time_origin = FULLMAG_FEM_TIME_ABSOLUTE;
    double envelope_amplitude = 1.0;
    double envelope_frequency_hz = 0.0;
    double envelope_phase_rad = 0.0;
    double envelope_offset = 0.0;
    double envelope_t_on_s = 0.0;
    double envelope_t_off_s = 0.0;
    double envelope_center_s = 0.0;
    double envelope_bandwidth_hz = 0.0;
    std::vector<double> envelope_point_times_s{};
    std::vector<double> envelope_point_values{};
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
    double &max_rhs,
    double evaluation_time_s,
    double stage_start_time_s);

/* Evaluate the immutable dimensionless source multiplier at an RK stage. */
double evaluate_sot_envelope(
    const SotRuntimeState &sot,
    double evaluation_time_s,
    double stage_start_time_s);

/*
 * Find the first discontinuity knot strictly after the accepted time and
 * inside the requested trial interval. The returned time is absolute even
 * when the envelope descriptor is stage-local. Smooth envelopes have no
 * event knots and return false.
 */
bool next_sot_envelope_event_time(
    const SotRuntimeState &sot,
    double current_time_s,
    double requested_dt_s,
    double stage_start_time_s,
    double &event_time_s);

} // namespace fullmag::fem
