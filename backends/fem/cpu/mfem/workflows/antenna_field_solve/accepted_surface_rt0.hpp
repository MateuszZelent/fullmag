#pragma once
#include "fullmag_fem.h"
#include "cpu/mfem/interactions/oersted/surface_rt0.hpp"
#include "cpu/mfem/transport/conservative_current_view.hpp"

namespace fullmag::fem::antenna_field_solve {
// Validate caller policy and mandatory lower work bounds before the charge solve.
void validate_surface_rt0_request(
    const fullmag_fem_prepared_closed_loop_rt0_surface_request_v1 &request);
void evaluate_accepted_surface_rt0(
    const transport::ConservativeCurrentView &view,
    const char *accepted_source_state_digest,
    const fullmag_fem_prepared_closed_loop_rt0_surface_request_v1 &request,
    fullmag_fem_prepared_closed_loop_rt0_surface_result_v1 &result,
    oersted::SurfaceRt0PhaseReport *phase_report = nullptr,
    const oersted::SurfaceRt0ProgressObserver *observer = nullptr);
} // namespace fullmag::fem::antenna_field_solve
