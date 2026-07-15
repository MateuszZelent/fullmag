/* Canonical prescribed-SOT algebra contract (host oracle). */

#include "spin_torque.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>

namespace {

void check(bool condition, const char *message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

void check_close(double actual, double expected, double relative_tolerance, const char *message) {
    const double scale = std::fmax(1.0, std::fabs(expected));
    check(std::fabs(actual - expected) <= relative_tolerance * scale, message);
}

}  // namespace

int main() {
    using fullmag::fdm::PrescribedSotVector;

    constexpr double gamma0 = 2.211e5;
    constexpr double current_density = -1.0e12;
    constexpr double saturation_magnetisation = 8.0e5;
    constexpr double thickness = 1.0e-9;
    constexpr double hbar = 1.054571817e-34;
    constexpr double elementary_charge = 1.602176634e-19;
    constexpr double mu0 = 1.25663706212e-6;

    const double expected_prefactor =
        (gamma0 / mu0) * hbar * current_density /
        (2.0 * elementary_charge * saturation_magnetisation * thickness);
    const double prefactor = fullmag::fdm::prescribed_sot_rate_prefactor(
        gamma0, current_density, saturation_magnetisation, thickness);
    check_close(prefactor, expected_prefactor, 5.0e-13,
                "SOT prefactor must include gamma_e=gamma0/mu0 and signed current");
    check(fullmag::fdm::prescribed_sot_rate_prefactor(
              gamma0, -current_density, saturation_magnetisation, thickness) == -prefactor,
          "reversing conventional current must reverse the SOT rate");

    const PrescribedSotVector<double> m{1.0, 0.0, 0.0};
    const PrescribedSotVector<double> sigma{0.0, 0.0, 1.0};
    constexpr double alpha = 0.3;
    constexpr double xi_dl = 0.2;
    constexpr double xi_fl = -0.1;
    const auto explicit_rhs = fullmag::fdm::prescribed_sot_explicit_rhs(
        m, sigma, prefactor, xi_dl, xi_fl, alpha);
    const double denominator = 1.0 + alpha * alpha;
    // The fp64 algebra gate is stricter than the M0 1e-12 scaled-vector target.
    check_close(explicit_rhs.x, 0.0, 5.0e-13, "oracle x component");
    check_close(explicit_rhs.y, prefactor * (0.1 - alpha * 0.2) / denominator,
                5.0e-13, "Gilbert-transformed y component");
    check_close(explicit_rhs.z, prefactor * (0.2 + alpha * 0.1) / denominator,
                5.0e-13, "Gilbert-transformed z component");

    const auto reversed = fullmag::fdm::prescribed_sot_explicit_rhs(
        m, sigma, -prefactor, xi_dl, xi_fl, alpha);
    check_close(reversed.x, -explicit_rhs.x, 5.0e-13, "reversed x component");
    check_close(reversed.y, -explicit_rhs.y, 5.0e-13, "reversed y component");
    check_close(reversed.z, -explicit_rhs.z, 5.0e-13, "reversed z component");

    std::printf("prescribed SOT algebra contract: PASS\n");
    return 0;
}
