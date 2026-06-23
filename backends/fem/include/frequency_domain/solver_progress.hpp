#pragma once

#include <string>

namespace fullmag::fem::frequency_domain {

struct SolverProgressState {
    const char *study_product = "modal_eigen";
    const char *solver_phase = "not_started";
    const char *execution_lane = "production_cpu";
    const char *stop_reason = nullptr;
    int contour_point_index = -1;
    int contour_point_count = 0;
    int linear_iteration = 0;
    int max_linear_iterations = 0;
};

std::string solver_progress_json(const SolverProgressState &state) noexcept;

} // namespace fullmag::fem::frequency_domain
