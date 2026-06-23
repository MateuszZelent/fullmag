#include "cpu/frequency_domain/mode_deduplication.hpp"
#include "cpu/frequency_domain/mode_filter.hpp"

#include <complex>
#include <cstdio>
#include <cstdlib>
#include <vector>

namespace fd = fullmag::fem::frequency_domain;

namespace {

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

fd::ModalCandidate candidate(
    double frequency_hz,
    double residual,
    std::complex<double> u0,
    std::complex<double> u1)
{
    fd::ModalCandidate value{};
    value.frequency_hz = frequency_hz;
    value.relative_residual = residual;
    value.mode = {u0, u1};
    return value;
}

void mode_filter_keeps_boundary_modes_inclusive()
{
    const std::vector<fd::ModalCandidate> candidates{
        candidate(99.0, 1.0e-12, {1.0, 0.0}, {0.0, 0.0}),
        candidate(100.0, 1.0e-12, {1.0, 0.0}, {0.0, 0.0}),
        candidate(200.0, 1.0e-12, {0.0, 0.0}, {1.0, 0.0}),
        candidate(201.0, 1.0e-12, {0.0, 0.0}, {1.0, 0.0}),
    };

    const std::vector<fd::ModalCandidate> filtered =
        fd::filter_modes_for_window(candidates, 100.0, 200.0, 1.0e-8);

    check(filtered.size() == 2, "window filter must keep both inclusive boundaries");
    check(filtered[0].frequency_hz == 100.0, "lower boundary mode is retained");
    check(filtered[1].frequency_hz == 200.0, "upper boundary mode is retained");
}

void mode_deduplication_keeps_lower_residual_duplicate()
{
    const double identity_mass[] = {
        1.0, 0.0,
        0.0, 1.0,
    };
    const std::vector<fd::ModalCandidate> candidates{
        candidate(1.0e9, 1.0e-8, {1.0, 0.0}, {0.0, 0.0}),
        candidate(1.0e9 + 10.0, 1.0e-10, {1.0, 0.0}, {0.0, 0.0}),
        candidate(1.2e9, 1.0e-9, {0.0, 0.0}, {1.0, 0.0}),
    };

    const std::vector<fd::ModalCandidate> deduplicated =
        fd::deduplicate_modes_by_frequency_and_overlap(
            candidates,
            identity_mass,
            2,
            1.0e-6,
            1.0e3,
            0.90);

    check(deduplicated.size() == 2, "duplicate mode must be removed");
    check(deduplicated[0].relative_residual == 1.0e-10,
          "lower residual duplicate must be retained");
    check(deduplicated[1].frequency_hz == 1.2e9,
          "independent mode must remain");
}

} // namespace

int main()
{
    mode_filter_keeps_boundary_modes_inclusive();
    mode_deduplication_keeps_lower_residual_duplicate();
    return 0;
}
