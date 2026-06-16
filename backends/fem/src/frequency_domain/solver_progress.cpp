#include "frequency_domain/solver_progress.hpp"

#include <string>

namespace fullmag::fem::frequency_domain {

std::string solver_progress_json(const SolverProgressState &state) noexcept
{
    std::string json =
        "{\"schema_version\":\"fem_frequency_domain_progress.v1\","
        "\"study_product\":\"";
    json += state.study_product != nullptr ? state.study_product : "";
    json += "\",\"solver_phase\":\"";
    json += state.solver_phase != nullptr ? state.solver_phase : "";
    json += "\",\"execution_lane\":\"";
    json += state.execution_lane != nullptr ? state.execution_lane : "";
    json += "\"";
    if (state.contour_point_index >= 0) {
        json += ",\"contour_point_index\":";
        json += std::to_string(state.contour_point_index);
        json += ",\"contour_point_count\":";
        json += std::to_string(state.contour_point_count);
        json += ",\"linear_iteration\":";
        json += std::to_string(state.linear_iteration);
        json += ",\"max_linear_iterations\":";
        json += std::to_string(state.max_linear_iterations);
    }
    json += ",\"stop_reason\":";
    if (state.stop_reason == nullptr) {
        json += "null";
    } else {
        json += "\"";
        json += state.stop_reason;
        json += "\"";
    }
    json += "}";
    return json;
}

} // namespace fullmag::fem::frequency_domain
