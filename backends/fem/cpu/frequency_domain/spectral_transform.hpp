#pragma once

namespace fullmag::fem::frequency_domain {

struct ModalShiftSelection {
    const char *target_kind = "";
    const char *selection_policy = "unspecified";
    double shift_frequency_hz = 0.0;
    double shift_omega_rad_s = 0.0;
};

ModalShiftSelection select_modal_shift(
    const char *target_kind,
    double target_frequency_hz,
    double frequency_min_hz,
    double frequency_max_hz) noexcept;

} // namespace fullmag::fem::frequency_domain
