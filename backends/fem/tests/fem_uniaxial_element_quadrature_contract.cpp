#include "core/fem_element_quadrature_material.hpp"
#include "cpu/mfem/interactions/anisotropy_uniaxial.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <limits>
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

constexpr std::array<double, 4> kGl4Nodes = {
    0.069431844202973712388026755553595,
    0.330009478207571867598667120448377,
    0.669990521792428132401332879551623,
    0.930568155797026287611973244446405,
};
constexpr std::array<double, 4> kGl4Weights = {
    0.173927422568726928686531974610999,
    0.326072577431273071313468025389001,
    0.326072577431273071313468025389001,
    0.173927422568726928686531974610999,
};
constexpr std::array<double, 3> kGl3Nodes = {
    0.112701665379258311482073460021760,
    0.5,
    0.887298334620741688517926539978240,
};
constexpr std::array<double, 3> kGl3Weights = {
    0.277777777777777777777777777777778,
    0.444444444444444444444444444444444,
    0.277777777777777777777777777777778,
};

double nodal_scalar(const std::vector<double> &values, const Element &element,
                    const std::array<double, 4> &shape)
{
    double result = 0.0;
    for (std::size_t local = 0; local < 4u; ++local) {
        result += shape[local] * values[element.nodes[local]];
    }
    return result;
}

double nodal_dot_axis(const std::vector<double> &m_xyz, const std::array<double, 3> &axis,
                      const Element &element, const std::array<double, 4> &shape)
{
    double result = 0.0;
    for (std::size_t local = 0; local < 4u; ++local) {
        const std::size_t base = element.nodes[local] * 3u;
        result += shape[local] * (
            m_xyz[base + 0u] * axis[0u] +
            m_xyz[base + 1u] * axis[1u] +
            m_xyz[base + 2u] * axis[2u]);
    }
    return result;
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
        for (std::size_t ir = 0; ir < kGl4Nodes.size(); ++ir) {
            const double r = kGl4Nodes[ir];
            for (std::size_t is = 0; is < kGl4Nodes.size(); ++is) {
                const double s = kGl4Nodes[is];
                for (std::size_t it = 0; it < kGl3Nodes.size(); ++it) {
                    const double t = kGl3Nodes[it];
                    const std::array<double, 4> shape = {
                        (1.0 - r) * (1.0 - s) * (1.0 - t), r,
                        (1.0 - r) * s, (1.0 - r) * (1.0 - s) * t,
                    };
                    const double weight = element.volume_m3 * 6.0 *
                        kGl4Weights[ir] * kGl4Weights[is] * kGl3Weights[it] *
                        (1.0 - r) * (1.0 - r) * (1.0 - s);
                    const double q = nodal_dot_axis(m_xyz, axis, element, shape);
                    const double density = nodal_scalar(ku1, element, shape) * q * q +
                        nodal_scalar(ku2, element, shape) * q * q * q * q;
                    const double term = -weight * density;
                    result.value += term;
                    result.absolute_terms += std::fabs(term);
                    ++result.terms;
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
        for (std::size_t ir = 0; ir < kGl4Nodes.size(); ++ir) {
            const double r = kGl4Nodes[ir];
            for (std::size_t is = 0; is < kGl4Nodes.size(); ++is) {
                const double s = kGl4Nodes[is];
                for (std::size_t it = 0; it < kGl3Nodes.size(); ++it) {
                    const double t = kGl3Nodes[it];
                    const std::array<double, 4> shape = {
                        (1.0 - r) * (1.0 - s) * (1.0 - t), r,
                        (1.0 - r) * s, (1.0 - r) * (1.0 - s) * t,
                    };
                    const double weight = element.volume_m3 * 6.0 *
                        kGl4Weights[ir] * kGl4Weights[is] * kGl3Weights[it] *
                        (1.0 - r) * (1.0 - r) * (1.0 - s);
                    const double q = nodal_dot_axis(m_xyz, axis, element, shape);
                    const double dp = nodal_dot_axis(p_xyz, axis, element, shape);
                    const double density = 2.0 * nodal_scalar(ku1, element, shape) * q * dp +
                        4.0 * nodal_scalar(ku2, element, shape) * q * q * q * dp;
                    const double term = -weight * density;
                    result.value += term;
                    result.absolute_terms += std::fabs(term);
                    ++result.terms;
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
    const std::vector<double> &p_xyz,
    const std::vector<double> &ku2,
    const std::array<double, 3> &axis,
    double epsilon)
{
    // ((q+eps*d)^4-(q-eps*d)^4)/(2 eps) - 4q^3d = 4 eps^2 d^3.
    double bound = 0.0;
    for (const Element &element : elements) {
        for (std::size_t ir = 0; ir < kGl4Nodes.size(); ++ir) {
            const double r = kGl4Nodes[ir];
            for (std::size_t is = 0; is < kGl4Nodes.size(); ++is) {
                const double s = kGl4Nodes[is];
                for (std::size_t it = 0; it < kGl3Nodes.size(); ++it) {
                    const double t = kGl3Nodes[it];
                    const std::array<double, 4> shape = {
                        (1.0 - r) * (1.0 - s) * (1.0 - t), r,
                        (1.0 - r) * s, (1.0 - r) * (1.0 - s) * t,
                    };
                    const double weight = element.volume_m3 * 6.0 *
                        kGl4Weights[ir] * kGl4Weights[is] * kGl3Weights[it] *
                        (1.0 - r) * (1.0 - r) * (1.0 - s);
                    const double dp = nodal_dot_axis(p_xyz, axis, element, shape);
                    bound += 4.0 * epsilon * epsilon * weight *
                        std::fabs(nodal_scalar(ku2, element, shape)) * std::fabs(dp * dp * dp);
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
        0.2, -0.4, 0.7,  -0.1, 0.6, 0.3,  0.5, 0.1, -0.2,
        0.9, -0.3, 0.4,  -0.7, 0.8, 0.2,
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
                  quartic_central_difference_truncation_bound(elements, p, ku2, axis, epsilon),
          "uniaxial central derivative must use the element quadrature energy contract");
}

} // namespace

int main() {
    two_tetra_sharp_material_uniaxial_energy_and_directional_derivative_contract();
    return 0;
}
