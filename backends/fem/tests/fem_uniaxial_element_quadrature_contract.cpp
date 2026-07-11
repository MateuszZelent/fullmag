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
    if (!condition) {
        fail(message);
    }
}

double gamma_n(std::size_t operations) {
    const double u = std::numeric_limits<double>::epsilon() / 2.0;
    const double n = static_cast<double>(operations);
    return n * u / (1.0 - n * u);
}

double factorial(std::size_t value) {
    double result = 1.0;
    for (std::size_t i = 2u; i <= value; ++i) {
        result *= static_cast<double>(i);
    }
    return result;
}

// integral_T lambda_0^a0 ... lambda_3^a3 dV = 6 V_T prod(a_i!) / (sum(a_i)+3)!.
double barycentric_monomial_integral(const Element &element, const std::array<unsigned, 4> &powers) {
    unsigned degree = 0u;
    double numerator = 6.0 * element.volume_m3;
    for (unsigned power : powers) {
        degree += power;
        numerator *= factorial(power);
    }
    return numerator / factorial(static_cast<std::size_t>(degree) + 3u);
}

std::array<double, 4> nodal_axis_projection(
    const std::vector<double> &m_xyz,
    const Element &element,
    const std::array<double, 3> &axis)
{
    std::array<double, 4> result = {};
    for (std::size_t local = 0; local < 4u; ++local) {
        const std::size_t base = element.nodes[local] * 3u;
        result[local] =
            m_xyz[base + 0u] * axis[0u] +
            m_xyz[base + 1u] * axis[1u] +
            m_xyz[base + 2u] * axis[2u];
    }
    return result;
}

void add_monomial_term(
    Integral &result,
    const Element &element,
    const std::array<unsigned, 4> &powers,
    double coefficient)
{
    const double term = coefficient * barycentric_monomial_integral(element, powers);
    result.value += term;
    result.absolute_terms += std::fabs(term);
    ++result.terms;
}

Integral independent_energy(
    const std::vector<Element> &elements,
    const std::vector<double> &m_xyz,
    const std::vector<double> &ku1,
    const std::vector<double> &ku2,
    const std::array<double, 3> &axis)
{
    Integral result;
    for (const Element &element : elements) {
        const std::array<double, 4> q = nodal_axis_projection(m_xyz, element, axis);
        for (std::size_t i = 0; i < 4u; ++i) {
            const double ku1_i = ku1[element.nodes[i]];
            const double ku2_i = ku2[element.nodes[i]];
            for (std::size_t j = 0; j < 4u; ++j) {
                for (std::size_t k = 0; k < 4u; ++k) {
                    std::array<unsigned, 4> ku1_powers = {};
                    ++ku1_powers[i];
                    ++ku1_powers[j];
                    ++ku1_powers[k];
                    add_monomial_term(result, element, ku1_powers, -ku1_i * q[j] * q[k]);
                    for (std::size_t l = 0; l < 4u; ++l) {
                        for (std::size_t n = 0; n < 4u; ++n) {
                            std::array<unsigned, 4> ku2_powers = {};
                            ++ku2_powers[i];
                            ++ku2_powers[j];
                            ++ku2_powers[k];
                            ++ku2_powers[l];
                            ++ku2_powers[n];
                            add_monomial_term(
                                result, element, ku2_powers,
                                -ku2_i * q[j] * q[k] * q[l] * q[n]);
                        }
                    }
                }
            }
        }
    }
    return result;
}

Integral independent_directional_derivative(
    const std::vector<Element> &elements,
    const std::vector<double> &m_xyz,
    const std::vector<double> &p_xyz,
    const std::vector<double> &ku1,
    const std::vector<double> &ku2,
    const std::array<double, 3> &axis)
{
    Integral result;
    for (const Element &element : elements) {
        const std::array<double, 4> q = nodal_axis_projection(m_xyz, element, axis);
        const std::array<double, 4> d = nodal_axis_projection(p_xyz, element, axis);
        for (std::size_t i = 0; i < 4u; ++i) {
            const double ku1_i = ku1[element.nodes[i]];
            const double ku2_i = ku2[element.nodes[i]];
            for (std::size_t j = 0; j < 4u; ++j) {
                for (std::size_t k = 0; k < 4u; ++k) {
                    std::array<unsigned, 4> ku1_powers = {};
                    ++ku1_powers[i];
                    ++ku1_powers[j];
                    ++ku1_powers[k];
                    add_monomial_term(result, element, ku1_powers, -2.0 * ku1_i * q[j] * d[k]);
                    for (std::size_t l = 0; l < 4u; ++l) {
                        for (std::size_t n = 0; n < 4u; ++n) {
                            std::array<unsigned, 4> ku2_powers = {};
                            ++ku2_powers[i];
                            ++ku2_powers[j];
                            ++ku2_powers[k];
                            ++ku2_powers[l];
                            ++ku2_powers[n];
                            add_monomial_term(
                                result, element, ku2_powers,
                                -4.0 * ku2_i * q[j] * q[k] * q[l] * d[n]);
                        }
                    }
                }
            }
        }
    }
    return result;
}

double central_difference_tolerance(
    const Integral &plus,
    const Integral &minus,
    const Integral &directional,
    double epsilon)
{
    constexpr std::size_t kTermOperations = 18u;
    const double plus_roundoff = gamma_n(kTermOperations + plus.terms) * plus.absolute_terms;
    const double minus_roundoff = gamma_n(kTermOperations + minus.terms) * minus.absolute_terms;
    const double derivative_roundoff =
        gamma_n(kTermOperations + directional.terms) * directional.absolute_terms;
    const double subtraction_roundoff = gamma_n(2u) *
        (std::fabs(plus.value) + std::fabs(minus.value) + plus_roundoff + minus_roundoff) /
        (2.0 * epsilon);
    return (plus_roundoff + minus_roundoff) / (2.0 * epsilon) +
        subtraction_roundoff + derivative_roundoff;
}

double quartic_central_difference_truncation_bound(
    const std::vector<Element> &elements,
    const std::vector<double> &m_xyz,
    const std::vector<double> &p_xyz,
    const std::vector<double> &ku2,
    const std::array<double, 3> &axis,
    double epsilon)
{
    // ((q+eps*d)^4-(q-eps*d)^4)/(2 eps) - 4q^3d = 4 eps^2 q d^3.
    double bound = 0.0;
    for (const Element &element : elements) {
        const std::array<double, 4> q = nodal_axis_projection(m_xyz, element, axis);
        const std::array<double, 4> d = nodal_axis_projection(p_xyz, element, axis);
        for (std::size_t i = 0; i < 4u; ++i) {
            for (std::size_t j = 0; j < 4u; ++j) {
                for (std::size_t k = 0; k < 4u; ++k) {
                    for (std::size_t l = 0; l < 4u; ++l) {
                        for (std::size_t n = 0; n < 4u; ++n) {
                            std::array<unsigned, 4> powers = {};
                            ++powers[i];
                            ++powers[j];
                            ++powers[k];
                            ++powers[l];
                            ++powers[n];
                            bound += 4.0 * epsilon * epsilon *
                                std::fabs(ku2[element.nodes[i]] * q[j] * d[k] * d[l] * d[n]) *
                                barycentric_monomial_integral(element, powers);
                        }
                    }
                }
            }
        }
    }
    return bound;
}

void two_tetra_sharp_material_uniaxial_energy_and_directional_derivative_contract() {
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
    const std::vector<double> ku1 = {1.1e5, 2.3e5, 0.8e5, 3.1e5, 1.7e5};
    const std::vector<double> ku2 = {0.4e5, -0.2e5, 0.7e5, 0.1e5, 0.5e5};
    const std::array<double, 3> axis = {0.0, 0.0, 1.0};

    const Integral expected = independent_energy(elements, m, ku1, ku2, axis);
    const double actual = fullmag::fem::uniaxial_anisotropy_energy_from_element_quadrature_material(
        material, m, ku1, ku2, axis);
    const double direct_bound = gamma_n(18u + expected.terms) * expected.absolute_terms;
    check(std::fabs(actual - expected.value) <= direct_bound,
          "two-tetra uniaxial energy must integrate P1 Ku through the sharp material topology");

    constexpr double epsilon = 1.0e-5;
    std::vector<double> plus = m;
    std::vector<double> minus = m;
    for (std::size_t i = 0; i < p.size(); ++i) {
        plus[i] += epsilon * p[i];
        minus[i] -= epsilon * p[i];
    }
    const double energy_plus = fullmag::fem::uniaxial_anisotropy_energy_from_element_quadrature_material(
        material, plus, ku1, ku2, axis);
    const double energy_minus = fullmag::fem::uniaxial_anisotropy_energy_from_element_quadrature_material(
        material, minus, ku1, ku2, axis);
    const Integral plus_oracle = independent_energy(elements, plus, ku1, ku2, axis);
    const Integral minus_oracle = independent_energy(elements, minus, ku1, ku2, axis);
    const Integral directional = independent_directional_derivative(elements, m, p, ku1, ku2, axis);
    const double finite_difference = (energy_plus - energy_minus) / (2.0 * epsilon);
    check(std::fabs(finite_difference - directional.value) <=
              central_difference_tolerance(plus_oracle, minus_oracle, directional, epsilon) +
                  quartic_central_difference_truncation_bound(elements, m, p, ku2, axis, epsilon),
          "uniaxial central derivative must use the element quadrature energy contract");
}

void rejects_nonunit_axis_contract() {
    const std::vector<fullmag::fem::P1TetrahedronMaterialTopology> topology = {
        {{{0u, 1u, 2u, 3u}}, 1.0 / 6.0},
    };
    const fullmag::fem::ElementQuadratureMaterial material(4u, topology, {0.7e6}, {8e-12});
    const std::vector<double> m = {0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0};
    const std::vector<double> ku1 = {1.0, 1.0, 1.0, 1.0};
    const std::vector<double> ku2 = {0.0, 0.0, 0.0, 0.0};
    bool rejected = false;
    try {
        static_cast<void>(fullmag::fem::uniaxial_anisotropy_energy_from_element_quadrature_material(
            material, m, ku1, ku2, {0.0, 0.0, 2.0}));
    } catch (const std::invalid_argument &) {
        rejected = true;
    }
    check(rejected, "element-quadrature uniaxial helper must reject nonunit easy axis");
}

} // namespace

int main() {
    two_tetra_sharp_material_uniaxial_energy_and_directional_derivative_contract();
    rejects_nonunit_axis_contract();
    return 0;
}
