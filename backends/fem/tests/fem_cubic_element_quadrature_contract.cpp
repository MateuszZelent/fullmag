#include "core/fem_element_quadrature_material.hpp"
#include "cpu/mfem/interactions/anisotropy_cubic.hpp"

#include <array>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <limits>
#include <map>
#include <stdexcept>
#include <vector>

namespace {

using Powers = std::array<unsigned, 4>;
using Polynomial = std::map<Powers, double>;

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
    if (!condition) {
        fail(message);
    }
}

double gamma_n(std::size_t operations) {
    const double unit_roundoff = std::numeric_limits<double>::epsilon() / 2.0;
    const double n = static_cast<double>(operations);
    return n * unit_roundoff / (1.0 - n * unit_roundoff);
}

double factorial(std::size_t value) {
    double result = 1.0;
    for (std::size_t i = 2u; i <= value; ++i) {
        result *= static_cast<double>(i);
    }
    return result;
}

double integrate_monomial(const Element &element, const Powers &powers) {
    unsigned degree = 0u;
    double numerator = 6.0 * element.volume_m3;
    for (unsigned power : powers) {
        degree += power;
        numerator *= factorial(power);
    }
    return numerator / factorial(static_cast<std::size_t>(degree) + 3u);
}

Polynomial linear(const std::array<double, 4> &nodal) {
    Polynomial result;
    for (std::size_t local = 0; local < 4u; ++local) {
        Powers power{};
        ++power[local];
        result.emplace(power, nodal[local]);
    }
    return result;
}

Polynomial add(const Polynomial &left, const Polynomial &right) {
    Polynomial result = left;
    for (const auto &[powers, coefficient] : right) {
        result[powers] += coefficient;
    }
    return result;
}

Polynomial scale(const Polynomial &input, double factor) {
    Polynomial result;
    for (const auto &[powers, coefficient] : input) {
        result.emplace(powers, factor * coefficient);
    }
    return result;
}

Polynomial multiply(const Polynomial &left, const Polynomial &right) {
    Polynomial result;
    for (const auto &[left_powers, left_coefficient] : left) {
        for (const auto &[right_powers, right_coefficient] : right) {
            Powers powers{};
            for (std::size_t local = 0; local < 4u; ++local) {
                powers[local] = left_powers[local] + right_powers[local];
            }
            result[powers] += left_coefficient * right_coefficient;
        }
    }
    return result;
}

Polynomial square(const Polynomial &input) {
    return multiply(input, input);
}

Integral integrate(const Element &element, const Polynomial &polynomial) {
    Integral result;
    for (const auto &[powers, coefficient] : polynomial) {
        const double term = coefficient * integrate_monomial(element, powers);
        result.value += term;
        result.absolute_terms += std::fabs(term);
        ++result.terms;
    }
    return result;
}

std::array<double, 4> nodal_projection(
    const std::vector<double> &values,
    const Element &element,
    const std::array<double, 3> &axis)
{
    std::array<double, 4> projection{};
    for (std::size_t local = 0; local < 4u; ++local) {
        const std::size_t base = element.nodes[local] * 3u;
        projection[local] =
            values[base] * axis[0u] + values[base + 1u] * axis[1u] + values[base + 2u] * axis[2u];
    }
    return projection;
}

std::array<double, 4> nodal_scalar(
    const std::vector<double> &values,
    const Element &element)
{
    std::array<double, 4> result{};
    for (std::size_t local = 0; local < 4u; ++local) {
        result[local] = values[element.nodes[local]];
    }
    return result;
}

Polynomial sigma(const Polynomial &m1, const Polynomial &m2, const Polynomial &m3) {
    return add(
        add(multiply(square(m1), square(m2)), multiply(square(m2), square(m3))),
        multiply(square(m1), square(m3)));
}

Polynomial sigma_directional(
    const Polynomial &m1,
    const Polynomial &m2,
    const Polynomial &m3,
    const Polynomial &d1,
    const Polynomial &d2,
    const Polynomial &d3)
{
    return scale(add(
        add(
            add(multiply(multiply(m1, d1), square(m2)), multiply(square(m1), multiply(m2, d2))),
            add(multiply(multiply(m2, d2), square(m3)), multiply(square(m2), multiply(m3, d3)))),
        add(multiply(multiply(m1, d1), square(m3)), multiply(square(m1), multiply(m3, d3)))),
        2.0);
}

Polynomial energy_polynomial(
    const Element &element,
    const std::vector<double> &m,
    const std::vector<double> &kc1,
    const std::vector<double> &kc2,
    const std::vector<double> &kc3,
    const std::array<double, 3> &axis1,
    const std::array<double, 3> &axis2)
{
    const std::array<double, 3> axis3 = {
        axis1[1u] * axis2[2u] - axis1[2u] * axis2[1u],
        axis1[2u] * axis2[0u] - axis1[0u] * axis2[2u],
        axis1[0u] * axis2[1u] - axis1[1u] * axis2[0u],
    };
    const Polynomial m1 = linear(nodal_projection(m, element, axis1));
    const Polynomial m2 = linear(nodal_projection(m, element, axis2));
    const Polynomial m3 = linear(nodal_projection(m, element, axis3));
    const Polynomial s = sigma(m1, m2, m3);
    return add(
        add(multiply(linear(nodal_scalar(kc1, element)), s),
            multiply(linear(nodal_scalar(kc2, element)), multiply(multiply(square(m1), square(m2)), square(m3)))),
        multiply(linear(nodal_scalar(kc3, element)), square(s)));
}

Polynomial directional_polynomial(
    const Element &element,
    const std::vector<double> &m,
    const std::vector<double> &p,
    const std::vector<double> &kc1,
    const std::vector<double> &kc2,
    const std::vector<double> &kc3,
    const std::array<double, 3> &axis1,
    const std::array<double, 3> &axis2)
{
    const std::array<double, 3> axis3 = {
        axis1[1u] * axis2[2u] - axis1[2u] * axis2[1u],
        axis1[2u] * axis2[0u] - axis1[0u] * axis2[2u],
        axis1[0u] * axis2[1u] - axis1[1u] * axis2[0u],
    };
    const Polynomial m1 = linear(nodal_projection(m, element, axis1));
    const Polynomial m2 = linear(nodal_projection(m, element, axis2));
    const Polynomial m3 = linear(nodal_projection(m, element, axis3));
    const Polynomial d1 = linear(nodal_projection(p, element, axis1));
    const Polynomial d2 = linear(nodal_projection(p, element, axis2));
    const Polynomial d3 = linear(nodal_projection(p, element, axis3));
    const Polynomial s = sigma(m1, m2, m3);
    const Polynomial ds = sigma_directional(m1, m2, m3, d1, d2, d3);
    const Polynomial kc1_poly = linear(nodal_scalar(kc1, element));
    const Polynomial kc2_poly = linear(nodal_scalar(kc2, element));
    const Polynomial kc3_poly = linear(nodal_scalar(kc3, element));
    const Polynomial sixth_derivative = scale(add(
        add(multiply(multiply(d1, m1), multiply(square(m2), square(m3))),
            multiply(multiply(d2, m2), multiply(square(m1), square(m3)))),
        multiply(multiply(d3, m3), multiply(square(m1), square(m2)))), 2.0);
    return add(add(multiply(kc1_poly, ds), multiply(kc2_poly, sixth_derivative)),
               multiply(kc3_poly, scale(multiply(s, ds), 2.0)));
}

Integral independent_energy(
    const std::vector<Element> &elements,
    const std::vector<double> &m,
    const std::vector<double> &kc1,
    const std::vector<double> &kc2,
    const std::vector<double> &kc3,
    const std::array<double, 3> &axis1,
    const std::array<double, 3> &axis2)
{
    Integral result;
    for (const Element &element : elements) {
        const Integral part = integrate(element, energy_polynomial(element, m, kc1, kc2, kc3, axis1, axis2));
        result.value += part.value;
        result.absolute_terms += part.absolute_terms;
        result.terms += part.terms;
    }
    return result;
}

Integral independent_directional_derivative(
    const std::vector<Element> &elements,
    const std::vector<double> &m,
    const std::vector<double> &p,
    const std::vector<double> &kc1,
    const std::vector<double> &kc2,
    const std::vector<double> &kc3,
    const std::array<double, 3> &axis1,
    const std::array<double, 3> &axis2)
{
    Integral result;
    for (const Element &element : elements) {
        const Integral part = integrate(element, directional_polynomial(element, m, p, kc1, kc2, kc3, axis1, axis2));
        result.value += part.value;
        result.absolute_terms += part.absolute_terms;
        result.terms += part.terms;
    }
    return result;
}

double production_roundoff_bound(const Integral &integral, std::size_t elements) {
    // The Duffy rule evaluates 6*6*5 points/tetra.  Each point executes at
    // most 120 rounded scalar operations (interpolation, frame projections,
    // polynomial density, Jacobian weight, and accumulation); the remaining
    // operations cover the per-element and global sums.
    constexpr std::size_t kDuffyPoints = 6u * 6u * 5u;
    constexpr std::size_t kOperationsPerPoint = 120u;
    return gamma_n(elements * kDuffyPoints * kOperationsPerPoint + elements + 8u) * integral.absolute_terms;
}

void two_tetra_cubic_energy_and_directional_derivative_contract() {
    const std::vector<Element> elements = {
        {{{0u, 1u, 2u, 3u}}, 1.0 / 6.0},
        {{{0u, 1u, 2u, 4u}}, 1.0 / 3.0},
    };
    const std::vector<fullmag::fem::P1TetrahedronMaterialTopology> topology = {
        {{{0u, 1u, 2u, 3u}}, 1.0 / 6.0},
        {{{0u, 1u, 2u, 4u}}, 1.0 / 3.0},
    };
    const fullmag::fem::ElementQuadratureMaterial material(
        5u, topology, {0.7e6, 1.1e6}, {8e-12, 13e-12});
    const std::vector<double> m = {
        0.2, -0.4, 1.7,  -0.1, 0.6, 1.3,  0.5, 0.1, -1.2,
        0.9, -0.3, 1.4,  -0.7, 0.8, 1.2,
    };
    const std::vector<double> p = {
        -0.3, 0.1, 0.2,  0.4, -0.6, 0.5,  -0.2, 0.7, -0.1,
        0.8, 0.3, -0.4,  0.6, -0.5, 0.9,
    };
    const std::vector<double> kc1 = {1.1e5, 2.3e5, -0.8e5, 3.1e5, 1.7e5};
    const std::vector<double> kc2 = {0.4e5, -0.2e5, 0.7e5, 0.1e5, -0.5e5};
    const std::vector<double> kc3 = {-0.3e5, 0.6e5, 0.2e5, -0.7e5, 0.4e5};
    const std::array<double, 3> axis1 = {1.0, 0.0, 0.0};
    const std::array<double, 3> axis2 = {0.0, 1.0, 0.0};

    const Integral expected = independent_energy(elements, m, kc1, kc2, kc3, axis1, axis2);
    const double actual = fullmag::fem::cubic_anisotropy_energy_from_element_quadrature_material(
        material, m, kc1, kc2, kc3, axis1, axis2);
    check(std::fabs(actual - expected.value) <= production_roundoff_bound(expected, elements.size()),
          "two-tetra cubic energy must integrate P1 Kc1/Kc2/Kc3 through the sharp material topology");

    constexpr double epsilon = 1.0e-4;
    std::vector<double> plus = m;
    std::vector<double> minus = m;
    for (std::size_t index = 0; index < p.size(); ++index) {
        plus[index] += epsilon * p[index];
        minus[index] -= epsilon * p[index];
    }
    const double energy_plus = fullmag::fem::cubic_anisotropy_energy_from_element_quadrature_material(
        material, plus, kc1, kc2, kc3, axis1, axis2);
    const double energy_minus = fullmag::fem::cubic_anisotropy_energy_from_element_quadrature_material(
        material, minus, kc1, kc2, kc3, axis1, axis2);
    const Integral plus_oracle = independent_energy(elements, plus, kc1, kc2, kc3, axis1, axis2);
    const Integral minus_oracle = independent_energy(elements, minus, kc1, kc2, kc3, axis1, axis2);
    const Integral derivative = independent_directional_derivative(elements, m, p, kc1, kc2, kc3, axis1, axis2);
    const double actual_central = (energy_plus - energy_minus) / (2.0 * epsilon);
    const double oracle_central = (plus_oracle.value - minus_oracle.value) / (2.0 * epsilon);
    const double central_roundoff =
        (production_roundoff_bound(plus_oracle, elements.size()) +
         production_roundoff_bound(minus_oracle, elements.size())) / (2.0 * epsilon) +
        gamma_n(2u) * (std::fabs(energy_plus) + std::fabs(energy_minus)) / (2.0 * epsilon);
    check(std::fabs(actual_central - derivative.value) <=
              std::fabs(oracle_central - derivative.value) + central_roundoff,
          "cubic central derivative must use the degree-nine element quadrature energy contract");
}

void rejects_nonorthonormal_axes_contract() {
    const std::vector<fullmag::fem::P1TetrahedronMaterialTopology> topology = {
        {{{0u, 1u, 2u, 3u}}, 1.0 / 6.0},
    };
    const fullmag::fem::ElementQuadratureMaterial material(4u, topology, {0.7e6}, {8e-12});
    const std::vector<double> m = {1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0};
    const std::vector<double> kc = {1.0, 1.0, 1.0, 1.0};
    bool rejected = false;
    try {
        static_cast<void>(fullmag::fem::cubic_anisotropy_energy_from_element_quadrature_material(
            material, m, kc, kc, kc, {1.0, 0.0, 0.0}, {0.5, 0.5, 0.0}));
    } catch (const std::invalid_argument &) {
        rejected = true;
    }
    check(rejected, "element-quadrature cubic helper must reject nonorthonormal crystal axes");
}

} // namespace

int main() {
    two_tetra_cubic_energy_and_directional_derivative_contract();
    rejects_nonorthonormal_axes_contract();
    return 0;
}
