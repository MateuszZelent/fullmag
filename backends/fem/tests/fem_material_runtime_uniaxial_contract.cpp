#include "core/fem_element_quadrature_material.hpp"
#include "cpu/mfem/interactions/anisotropy_uniaxial.hpp"

#include <array>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <vector>

namespace {

struct Element {
    std::array<std::size_t, 4> nodes;
    double volume_m3;
};

struct Integral {
    double value = 0.0;
    double absolute_terms = 0.0;
    std::size_t terms = 0u;
};

[[noreturn]] void fail(const char *message) {
    std::cerr << "FAIL: " << message << '\n';
    std::exit(1);
}

void check(bool condition, const char *message) {
    if (!condition) fail(message);
}

double gamma_n(std::size_t operations) {
    const double u = std::numeric_limits<double>::epsilon() / 2.0;
    const double n = static_cast<double>(operations);
    return n * u / (1.0 - n * u);
}

double factorial(std::size_t value) {
    double result = 1.0;
    for (std::size_t i = 2u; i <= value; ++i) result *= static_cast<double>(i);
    return result;
}

double monomial_integral(const Element &element, const std::array<unsigned, 4> &powers) {
    unsigned degree = 0u;
    double numerator = 6.0 * element.volume_m3;
    for (unsigned power : powers) {
        degree += power;
        numerator *= factorial(power);
    }
    return numerator / factorial(static_cast<std::size_t>(degree) + 3u);
}

void add_term(Integral &result, const Element &element, const std::array<unsigned, 4> &powers, double coefficient) {
    const double term = coefficient * monomial_integral(element, powers);
    result.value += term;
    result.absolute_terms += std::fabs(term);
    ++result.terms;
}

std::array<double, 4> projection(
    const std::vector<double> &field,
    const Element &element,
    const std::array<double, 3> &axis)
{
    std::array<double, 4> result = {};
    for (std::size_t local = 0; local < 4u; ++local) {
        const std::size_t base = element.nodes[local] * 3u;
        result[local] = field[base] * axis[0] + field[base + 1u] * axis[1] + field[base + 2u] * axis[2];
    }
    return result;
}

Integral independent_energy(
    const std::vector<Element> &elements,
    const std::vector<double> &m,
    const std::vector<double> &ku1,
    const std::vector<double> &ku2,
    const std::array<double, 3> &axis)
{
    Integral result;
    for (const Element &element : elements) {
        const auto q = projection(m, element, axis);
        for (std::size_t i = 0; i < 4u; ++i) for (std::size_t j = 0; j < 4u; ++j) for (std::size_t k = 0; k < 4u; ++k) {
            std::array<unsigned, 4> powers = {};
            ++powers[i]; ++powers[j]; ++powers[k];
            add_term(result, element, powers, -ku1[element.nodes[i]] * q[j] * q[k]);
            for (std::size_t l = 0; l < 4u; ++l) for (std::size_t n = 0; n < 4u; ++n) {
                std::array<unsigned, 4> quartic_powers = {};
                ++quartic_powers[i]; ++quartic_powers[j]; ++quartic_powers[k]; ++quartic_powers[l]; ++quartic_powers[n];
                add_term(result, element, quartic_powers, -ku2[element.nodes[i]] * q[j] * q[k] * q[l] * q[n]);
            }
        }
    }
    return result;
}

Integral independent_derivative(
    const std::vector<Element> &elements,
    const std::vector<double> &m,
    const std::vector<double> &p,
    const std::vector<double> &ku1,
    const std::vector<double> &ku2,
    const std::array<double, 3> &axis)
{
    Integral result;
    for (const Element &element : elements) {
        const auto q = projection(m, element, axis);
        const auto d = projection(p, element, axis);
        for (std::size_t i = 0; i < 4u; ++i) for (std::size_t j = 0; j < 4u; ++j) for (std::size_t k = 0; k < 4u; ++k) {
            std::array<unsigned, 4> powers = {};
            ++powers[i]; ++powers[j]; ++powers[k];
            add_term(result, element, powers, -2.0 * ku1[element.nodes[i]] * q[j] * d[k]);
            for (std::size_t l = 0; l < 4u; ++l) for (std::size_t n = 0; n < 4u; ++n) {
                std::array<unsigned, 4> quartic_powers = {};
                ++quartic_powers[i]; ++quartic_powers[j]; ++quartic_powers[k]; ++quartic_powers[l]; ++quartic_powers[n];
                add_term(result, element, quartic_powers, -4.0 * ku2[element.nodes[i]] * q[j] * q[k] * q[l] * d[n]);
            }
        }
    }
    return result;
}

double central_tolerance(const Integral &plus, const Integral &minus, const Integral &derivative, double epsilon) {
    constexpr std::size_t kOperations = 18u;
    const double plus_roundoff = gamma_n(kOperations + plus.terms) * plus.absolute_terms;
    const double minus_roundoff = gamma_n(kOperations + minus.terms) * minus.absolute_terms;
    return (plus_roundoff + minus_roundoff) / (2.0 * epsilon) +
        gamma_n(2u) * (std::fabs(plus.value) + std::fabs(minus.value) + plus_roundoff + minus_roundoff) / (2.0 * epsilon) +
        gamma_n(kOperations + derivative.terms) * derivative.absolute_terms;
}

double quartic_remainder(
    const std::vector<Element> &elements, const std::vector<double> &m, const std::vector<double> &p,
    const std::vector<double> &ku2, const std::array<double, 3> &axis, double epsilon)
{
    double bound = 0.0;
    for (const Element &element : elements) {
        const auto q = projection(m, element, axis);
        const auto d = projection(p, element, axis);
        for (std::size_t i = 0; i < 4u; ++i) for (std::size_t j = 0; j < 4u; ++j) for (std::size_t k = 0; k < 4u; ++k) for (std::size_t l = 0; l < 4u; ++l) for (std::size_t n = 0; n < 4u; ++n) {
            std::array<unsigned, 4> powers = {};
            ++powers[i]; ++powers[j]; ++powers[k]; ++powers[l]; ++powers[n];
            bound += 4.0 * epsilon * epsilon * std::fabs(ku2[element.nodes[i]] * q[j] * d[k] * d[l] * d[n]) * monomial_integral(element, powers);
        }
    }
    return bound;
}

fullmag::fem::P1TetrahedralMaterialRealization sharp_realization() {
    return {6u,
        {{{{0u, 1u, 2u, 3u}}, 1.0 / 6.0}, {{{0u, 1u, 2u, 4u}}, 1.0 / 3.0}, {{{0u, 1u, 2u, 5u}}, 1.0 / 2.0}},
        {0u, 1u},
        {fullmag::fem::MaterialCoefficientLocation::element_dg0, {0.7e6, 1.1e6, 9.0e6}},
        {fullmag::fem::MaterialCoefficientLocation::element_dg0, {8e-12, 13e-12, 0.0}}};
}

void active_scope_energy_and_derivative_contract() {
    const auto realization = sharp_realization();
    const std::vector<Element> active = {{{{0u, 1u, 2u, 3u}}, 1.0 / 6.0}, {{{0u, 1u, 2u, 4u}}, 1.0 / 3.0}};
    const std::vector<Element> with_air = {active[0], active[1], {{{0u, 1u, 2u, 5u}}, 1.0 / 2.0}};
    const std::vector<double> m = {0.2,-0.4,1.7, -0.1,0.6,1.3, 0.5,0.1,-1.2, 0.9,-0.3,1.4, -0.7,0.8,1.2, 2.0,-1.0,0.5};
    const std::vector<double> p = {-0.3,0.1,0.2, 0.4,-0.6,0.5, -0.2,0.7,-0.1, 0.8,0.3,-0.4, 0.6,-0.5,0.9, -0.4,0.6,-0.8};
    const std::vector<double> ku1 = {1.1e5,2.3e5,0.8e5,3.1e5,1.7e5,9.7e5};
    const std::vector<double> ku2 = {0.4e5,-0.2e5,0.7e5,0.1e5,0.5e5,6.2e5};
    const std::array<double, 3> axis = {0.0, 0.0, 1.0};
    const Integral expected = independent_energy(active, m, ku1, ku2, axis);
    const Integral wrong_air = independent_energy(with_air, m, ku1, ku2, axis);
    const double actual = fullmag::fem::uniaxial_anisotropy_energy_from_material_realization(realization, m, ku1, ku2, axis);
    check(std::fabs(actual - expected.value) <= gamma_n(18u + expected.terms) * expected.absolute_terms,
          "sharp uniaxial energy must use only active realization ordinals");
    check(std::fabs(actual - wrong_air.value) > 1.0e-6 * std::fabs(wrong_air.value - expected.value),
          "including the air tetrahedron must be observably wrong");
    constexpr double epsilon = 1.0e-5;
    std::vector<double> plus = m, minus = m;
    for (std::size_t i = 0; i < p.size(); ++i) { plus[i] += epsilon * p[i]; minus[i] -= epsilon * p[i]; }
    const Integral derivative = independent_derivative(active, m, p, ku1, ku2, axis);
    const double analytic = fullmag::fem::uniaxial_anisotropy_directional_derivative_from_material_realization(realization, m, p, ku1, ku2, axis);
    check(std::fabs(analytic - derivative.value) <= gamma_n(18u + derivative.terms) * derivative.absolute_terms,
          "sharp uniaxial derivative must match active-only barycentric oracle");
    const double finite_difference = (fullmag::fem::uniaxial_anisotropy_energy_from_material_realization(realization, plus, ku1, ku2, axis) -
        fullmag::fem::uniaxial_anisotropy_energy_from_material_realization(realization, minus, ku1, ku2, axis)) / (2.0 * epsilon);
    check(std::fabs(finite_difference - analytic) <= central_tolerance(independent_energy(active, plus, ku1, ku2, axis), independent_energy(active, minus, ku1, ku2, axis), derivative, epsilon) + quartic_remainder(active, m, p, ku2, axis, epsilon),
          "central difference must satisfy termwise envelope and quartic remainder");
}

void rejects_invalid_contracts() {
    const auto realization = sharp_realization();
    const std::vector<double> m(18u, 1.0), p(18u, 0.5), ku(6u, 1.0);
    bool axis_rejected = false;
    try { static_cast<void>(fullmag::fem::uniaxial_anisotropy_energy_from_material_realization(realization, m, ku, ku, {0.0, 0.0, 2.0})); }
    catch (const std::invalid_argument &) { axis_rejected = true; }
    check(axis_rejected, "sharp uniaxial helper must reject nonunit axis");
    const fullmag::fem::P1TetrahedralMaterialRealization nodal_ms(
        4u, {{{{0u,1u,2u,3u}}, 1.0/6.0}}, {0u},
        {fullmag::fem::MaterialCoefficientLocation::nodal_p1, {1e6,1e6,1e6,1e6}},
        {fullmag::fem::MaterialCoefficientLocation::element_dg0, {0.0}});
    bool ms_rejected = false;
    try { static_cast<void>(fullmag::fem::uniaxial_anisotropy_energy_from_material_realization(nodal_ms, std::vector<double>(12u, 1.0), std::vector<double>(4u, 1.0), std::vector<double>(4u, 1.0), {0.0,0.0,1.0})); }
    catch (const std::invalid_argument &) { ms_rejected = true; }
    check(ms_rejected, "sharp uniaxial helper must reject non-DG0 Ms realization");
}

} // namespace

int main() {
    active_scope_energy_and_derivative_contract();
    rejects_invalid_contracts();
    return 0;
}
