#include "cpu/frequency_domain/spectral_transform.hpp"

#include <cstring>

namespace fullmag::fem::frequency_domain {

namespace {

constexpr double kTwoPi = 6.28318530717958647692528676655900576;

} // namespace

ModalShiftSelection select_modal_shift(
    const char *target_kind,
    double target_frequency_hz,
    double frequency_min_hz,
    double frequency_max_hz) noexcept
{
    ModalShiftSelection selection{};
    selection.target_kind = target_kind != nullptr ? target_kind : "";
    if (std::strcmp(selection.target_kind, "nearest_frequency") == 0) {
        selection.selection_policy = "target_frequency";
        selection.shift_frequency_hz = target_frequency_hz;
    } else if (std::strcmp(selection.target_kind, "frequency_window") == 0) {
        selection.selection_policy = "window_midpoint";
        selection.shift_frequency_hz = 0.5 * (frequency_min_hz + frequency_max_hz);
    }
    selection.shift_omega_rad_s = kTwoPi * selection.shift_frequency_hz;
    return selection;
}

} // namespace fullmag::fem::frequency_domain
