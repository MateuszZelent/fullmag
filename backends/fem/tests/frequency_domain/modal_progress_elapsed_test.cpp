#include "frequency_domain/poisson_airbox_modal_eigen.hpp"

#include <cassert>
#include <cmath>
#include <cstring>
#include <limits>
#include <string>

namespace fd = fullmag::fem::frequency_domain;

static void capture(void *data, const char *json)
{
    *static_cast<std::string *>(data) = json;
}

int main()
{
    static_assert(fd::kPoissonAirboxEigenBlockProblemAbiVersion == 6);
    fd::PoissonAirboxEigenBlockProblem original{};
    original.progress_window_phase = "refinement";
    original.progress_current_subwindow = 39;
    original.progress_total_subwindows = 50;
    original.progress_subwindow_elapsed_seconds = 1.25;
    original.progress_window_elapsed_seconds = 925.75;
    std::string json;
    original.progress_callback = capture;
    original.progress_user_data = &json;

    const auto first = fd::poisson_airbox_modal_progress_with_elapsed(original, 2.5);
    const auto second = fd::poisson_airbox_modal_progress_with_elapsed(original, 5.0);
    assert(first.progress_subwindow_elapsed_seconds == 3.75);
    assert(second.progress_subwindow_elapsed_seconds == 6.25);
    assert(second.progress_window_elapsed_seconds == 930.75);
    assert(original.progress_subwindow_elapsed_seconds == 1.25);
    assert(original.progress_window_elapsed_seconds == 925.75);
    assert(second.progress_current_subwindow == 39);
    assert(second.progress_total_subwindows == 50);
    assert(second.progress_callback == original.progress_callback);
    assert(second.progress_user_data == original.progress_user_data);

    const fd::PoissonAirboxModalLinearProgress linear{
        fd::PoissonAirboxModalLinearSolverRole::shift_invert, "fgmres", 3, 0.125};
    fd::poisson_airbox_modal_emit_progress(second, "solving_shift_invert", "production_cpu",
        0, 0, 0, 3, std::numeric_limits<double>::quiet_NaN(), nullptr, &linear);
    assert(json.find("\"subwindow_elapsed_seconds\":6.25") != std::string::npos);
    assert(json.find("\"window_elapsed_seconds\":930.75") != std::string::npos);
    assert(json.find("\"window_phase\":\"refinement\"") != std::string::npos);

    for (double invalid : {-1.0, std::numeric_limits<double>::infinity(),
                           std::numeric_limits<double>::quiet_NaN()}) {
        const auto unchanged = fd::poisson_airbox_modal_progress_with_elapsed(original, invalid);
        assert(unchanged.progress_subwindow_elapsed_seconds == 1.25);
        assert(unchanged.progress_window_elapsed_seconds == 925.75);
    }
    original.progress_subwindow_elapsed_seconds = std::numeric_limits<double>::quiet_NaN();
    const auto unknown = fd::poisson_airbox_modal_progress_with_elapsed(original, 2.5);
    assert(std::isnan(unknown.progress_subwindow_elapsed_seconds));
    original.progress_total_subwindows = 0;
    original.progress_subwindow_elapsed_seconds = 0.0;
    original.progress_window_elapsed_seconds = 0.0;
    const auto nearest = fd::poisson_airbox_modal_progress_with_elapsed(original, 99.0);
    assert(nearest.progress_subwindow_elapsed_seconds == 0.0);
    assert(nearest.progress_window_elapsed_seconds == 0.0);
    return 0;
}
