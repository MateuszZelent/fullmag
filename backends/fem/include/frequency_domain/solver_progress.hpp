#pragma once

#include <string>

namespace fullmag::fem::frequency_domain {

struct SolverProgressState {
    const char *study_product = "modal_eigen";
    const char *solver_phase = "not_started";
    const char *execution_lane = "production_cpu";
    const char *stop_reason = nullptr;
};

std::string solver_progress_json(const SolverProgressState &state) noexcept;

} // namespace fullmag::fem::frequency_domain
