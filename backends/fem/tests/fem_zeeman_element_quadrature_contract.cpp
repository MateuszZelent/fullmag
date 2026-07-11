#include "core/fem_element_quadrature_material.hpp"
#include "cpu/mfem/interactions/zeeman_energy.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <limits>
#include <vector>

namespace {

constexpr double kMu0 = 4.0e-7 * 3.141592653589793238462643383279502884;

struct Element {
    std::array<std::size_t, 4> nodes;
    double volume_m3;
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

bool close_enough(double actual, double expected) {
    const double scale = std::max({1.0, std::fabs(actual), std::fabs(expected)});
    return std::fabs(actual - expected) <= 128.0 * std::numeric_limits<double>::epsilon() * scale;
}

double rounding_gamma(std::size_t operation_count) {
    const double unit_roundoff = std::numeric_limits<double>::epsilon() / 2.0;
    const double count = static_cast<double>(operation_count);
    return (count * unit_roundoff) / (1.0 - count * unit_roundoff);
}

struct IndependentZeemanEnergyOracle {
    double energy_j = 0.0;
    // Sum |Ms_e V_e M_ab m_a.H_b| before the final mu0 factor.
    double absolute_pre_mu0_terms = 0.0;
    std::size_t contribution_count = 0u;
};

double zeeman_central_difference_tolerance(
    double energy_plus,
    double energy_minus,
    double analytic_directional,
    double step)
{
    /*
     * Each tetrahedron evaluates 16 P1 mass entries.  One entry has a
     * three-component dot product (5 operations), the mass multiplier and
     * local accumulation (2), then each element has Ms*V*local/20 and a
     * global accumulation (4).  For this two-tetra oracle that is
     *
     *   2 * (16 * (5 + 2) + 4) + 1 = 233
     *
     * rounded operations per energy, including the final mu0 multiplier.
     * E_Z is linear in m, so the central difference has no O(step^2)
     * truncation term.  Its dominant numerical error is subtraction of the
     * two independently rounded energies, amplified by 1/(2*step).  The
     * independent analytic directional oracle has its own accumulation
     * error.  This bound is consequently scale-aware rather than an
     * arbitrary multiple of epsilon times the derivative.
     */
    constexpr std::size_t kEnergyEvaluationOperations = 233u;
    const double energy_roundoff =
        rounding_gamma(2u * kEnergyEvaluationOperations + 2u) *
        (std::fabs(energy_plus) + std::fabs(energy_minus)) / (2.0 * step);
    const double analytic_roundoff =
        rounding_gamma(kEnergyEvaluationOperations) * std::fabs(analytic_directional);
    return energy_roundoff + analytic_roundoff;
}

IndependentZeemanEnergyOracle independent_zeeman_energy_oracle(
    const std::vector<Element> &elements,
    const std::vector<double> &ms,
    const std::vector<double> &m_xyz,
    const std::vector<double> &h_xyz)
{
    IndependentZeemanEnergyOracle oracle;
    for (std::size_t e = 0; e < elements.size(); ++e) {
        for (std::size_t a = 0; a < 4; ++a) {
            const std::size_t m_base = elements[e].nodes[a] * 3u;
            for (std::size_t b = 0; b < 4; ++b) {
                const std::size_t h_base = elements[e].nodes[b] * 3u;
                const double dot =
                    m_xyz[m_base + 0u] * h_xyz[h_base + 0u] +
                    m_xyz[m_base + 1u] * h_xyz[h_base + 1u] +
                    m_xyz[m_base + 2u] * h_xyz[h_base + 2u];
                const double contribution = ms[e] * elements[e].volume_m3 *
                    ((a == b ? 2.0 : 1.0) / 20.0) * dot;
                oracle.energy_j -= kMu0 * contribution;
                oracle.absolute_pre_mu0_terms += std::fabs(contribution);
                ++oracle.contribution_count;
            }
        }
    }
    return oracle;
}

double zeeman_energy_roundoff_envelope(const IndependentZeemanEnergyOracle &oracle) {
    /*
     * A direct P1 contribution has five dot-product operations and three
     * multiplications by Ms_e, V_e, and M_ab.  The 16 contributions per
     * tetrahedron are accumulated independently, then multiplied by mu0.
     * Bound the individual rounding and their accumulation against the sum of
     * absolute terms, not the assembled energy: the latter can cancel.
     */
    constexpr std::size_t kContributionOperations = 8u;
    const double term_roundoff = rounding_gamma(kContributionOperations) *
        oracle.absolute_pre_mu0_terms;
    const double accumulated_pre_mu0 = oracle.absolute_pre_mu0_terms + term_roundoff;
    const double accumulation_roundoff = rounding_gamma(oracle.contribution_count - 1u) *
        accumulated_pre_mu0;
    return rounding_gamma(1u) * kMu0 *
        (accumulated_pre_mu0 + accumulation_roundoff);
}

double zeeman_central_difference_tolerance_from_termwise_envelopes(
    const std::vector<Element> &elements,
    const std::vector<double> &ms,
    const std::vector<double> &plus,
    const std::vector<double> &minus,
    const std::vector<double> &p_xyz,
    const std::vector<double> &h_xyz,
    double energy_plus,
    double energy_minus,
    double step)
{
    const IndependentZeemanEnergyOracle plus_oracle =
        independent_zeeman_energy_oracle(elements, ms, plus, h_xyz);
    const IndependentZeemanEnergyOracle minus_oracle =
        independent_zeeman_energy_oracle(elements, ms, minus, h_xyz);
    const IndependentZeemanEnergyOracle directional_oracle =
        independent_zeeman_energy_oracle(elements, ms, p_xyz, h_xyz);
    const double plus_roundoff = zeeman_energy_roundoff_envelope(plus_oracle);
    const double minus_roundoff = zeeman_energy_roundoff_envelope(minus_oracle);
    const double central_subtraction_roundoff = rounding_gamma(2u) *
        (std::fabs(energy_plus) + std::fabs(energy_minus) + plus_roundoff + minus_roundoff) /
        (2.0 * step);
    return (plus_roundoff + minus_roundoff) / (2.0 * step) +
        central_subtraction_roundoff + zeeman_energy_roundoff_envelope(directional_oracle);
}

double nodal_fallback_energy(
    const std::vector<double> &ms_nodal,
    const std::vector<double> &lumped_volume,
    const std::vector<double> &m_xyz,
    const std::vector<double> &h_xyz)
{
    double energy = 0.0;
    for (std::size_t node = 0; node < ms_nodal.size(); ++node) {
        const std::size_t base = node * 3u;
        const double dot =
            m_xyz[base + 0u] * h_xyz[base + 0u] +
            m_xyz[base + 1u] * h_xyz[base + 1u] +
            m_xyz[base + 2u] * h_xyz[base + 2u];
        energy -= kMu0 * ms_nodal[node] * lumped_volume[node] * dot;
    }
    return energy;
}

void two_tetra_sharp_ms_zeeman_energy_and_directional_derivative_contract() {
    const std::vector<Element> elements = {
        {{{0u, 1u, 2u, 3u}}, 1.0 / 6.0},
        {{{0u, 1u, 2u, 4u}}, 1.0 / 3.0},
    };
    const std::vector<fullmag::fem::P1TetrahedronMaterialTopology> topology = {
        {{{0u, 1u, 2u, 3u}}, 1.0 / 6.0},
        {{{0u, 1u, 2u, 4u}}, 1.0 / 3.0},
    };
    const std::vector<double> ms = {0.7e6, 1.1e6};
    const std::vector<double> a = {0.0, 0.0};
    const fullmag::fem::ElementQuadratureMaterial material(5u, topology, ms, a);

    const std::vector<double> m_xyz = {
        0.2, -0.4, 0.7,  -0.1, 0.6, 0.3,  0.5, 0.1, -0.2,
        0.9, -0.3, 0.4,  -0.7, 0.8, 0.2,
    };
    const std::vector<double> h_xyz = {
        11.0, -7.0, 3.0,  -5.0, 13.0, 2.0,  17.0, 19.0, -23.0,
        29.0, -31.0, 37.0,  -41.0, 43.0, 47.0,
    };
    const std::vector<double> p_xyz = {
        -0.3, 0.1, 0.2,  0.4, -0.6, 0.5,  -0.2, 0.7, -0.1,
        0.8, 0.3, -0.4,  0.6, -0.5, 0.9,
    };

    const double expected = independent_zeeman_energy_oracle(elements, ms, m_xyz, h_xyz).energy_j;
    const double actual = fullmag::fem::zeeman_energy_from_element_quadrature_material(
        material, m_xyz, h_xyz);
    check(close_enough(actual, expected),
          "two-tetra Zeeman energy must use exact DG0-Ms P1 mass integration");

    const double epsilon = 1.0e-6;
    std::vector<double> plus = m_xyz;
    std::vector<double> minus = m_xyz;
    for (std::size_t i = 0; i < p_xyz.size(); ++i) {
        plus[i] += epsilon * p_xyz[i];
        minus[i] -= epsilon * p_xyz[i];
    }
    const double energy_plus =
        fullmag::fem::zeeman_energy_from_element_quadrature_material(material, plus, h_xyz);
    const double energy_minus =
        fullmag::fem::zeeman_energy_from_element_quadrature_material(material, minus, h_xyz);
    const double finite_difference = (energy_plus - energy_minus) / (2.0 * epsilon);
    const double directional = independent_zeeman_energy_oracle(elements, ms, p_xyz, h_xyz).energy_j;
    check(std::fabs(finite_difference - directional) <=
              zeeman_central_difference_tolerance_from_termwise_envelopes(
                  elements, ms, plus, minus, p_xyz, h_xyz, energy_plus, energy_minus, epsilon),
          "Zeeman directional derivative must use the same DG0-Ms mass operator as energy");

    const std::vector<double> shared_node_average_ms = {0.9e6, 0.9e6, 0.9e6, 0.7e6, 1.1e6};
    const std::vector<double> lumped_volume = {0.125, 0.125, 0.125, 1.0 / 24.0, 1.0 / 12.0};
    const double nodal_energy = nodal_fallback_energy(
        shared_node_average_ms, lumped_volume, m_xyz, h_xyz);
    check(std::fabs(actual - nodal_energy) > 1.0e-12 * std::max(std::fabs(actual), std::fabs(nodal_energy)),
          "two-tetra sharp Ms oracle must not collapse to shared-node Ms fallback");
}

void zeeman_directional_tolerance_must_bound_cancelled_energy_terms() {
    const std::vector<Element> elements = {
        {{{0u, 1u, 2u, 3u}}, 1.0 / 6.0},
        {{{0u, 1u, 2u, 4u}}, 1.0 / 3.0},
    };
    const std::vector<double> ms = {0.7e6, 1.1e6};
    const std::vector<double> a = {0.0, 0.0};
    const std::vector<fullmag::fem::P1TetrahedronMaterialTopology> topology = {
        {{{0u, 1u, 2u, 3u}}, 1.0 / 6.0},
        {{{0u, 1u, 2u, 4u}}, 1.0 / 3.0},
    };
    const fullmag::fem::ElementQuadratureMaterial material(5u, topology, ms, a);

    // Unit P1 nodal magnetizations give opposing element contributions.  The
    // common-node x component is chosen so the exact signed element sum is
    // zero: (7/240) * (3 * 3/29 + 3/5) +
    //       (11/120) * (3 * 3/29 - 3/5) = 0.
    const std::vector<double> m_xyz = {
        3.0 / 29.0, std::sqrt(1.0 - 9.0 / (29.0 * 29.0)), 0.0,
        3.0 / 29.0, std::sqrt(1.0 - 9.0 / (29.0 * 29.0)), 0.0,
        3.0 / 29.0, std::sqrt(1.0 - 9.0 / (29.0 * 29.0)), 0.0,
        3.0 / 5.0, 4.0 / 5.0, 0.0,
        -3.0 / 5.0, 4.0 / 5.0, 0.0,
    };
    const std::vector<double> h_xyz = {
        1.0, 0.0, 0.0,  1.0, 0.0, 0.0,  1.0, 0.0, 0.0,
        1.0, 0.0, 0.0,  1.0, 0.0, 0.0,
    };
    const std::vector<double> p_xyz = {
        0.0, 0.0, 0.0,  0.0, 0.0, 0.0,  0.0, 0.0, 0.0,
        4.0 / 5.0, -3.0 / 5.0, 0.0,
        -2.0 / 5.0, -3.0 / 10.0, 0.0,
    };
    constexpr double epsilon = 1.0e-6;

    for (std::size_t node = 0u; node < 5u; ++node) {
        const std::size_t base = 3u * node;
        const double norm_sq =
            m_xyz[base + 0u] * m_xyz[base + 0u] +
            m_xyz[base + 1u] * m_xyz[base + 1u] +
            m_xyz[base + 2u] * m_xyz[base + 2u];
        const double tangent_dot =
            m_xyz[base + 0u] * p_xyz[base + 0u] +
            m_xyz[base + 1u] * p_xyz[base + 1u] +
            m_xyz[base + 2u] * p_xyz[base + 2u];
        check(
            std::fabs(norm_sq - 1.0) <= 8.0 * std::numeric_limits<double>::epsilon(),
            "Zeeman cancellation reproducer must use unit P1 nodal magnetization");
        check(
            std::fabs(tangent_dot) <= 8.0 * std::numeric_limits<double>::epsilon(),
            "Zeeman cancellation reproducer direction must be tangent at every P1 node");
    }

    const IndependentZeemanEnergyOracle initial_oracle =
        independent_zeeman_energy_oracle(elements, ms, m_xyz, h_xyz);
    const double initial_energy =
        fullmag::fem::zeeman_energy_from_element_quadrature_material(material, m_xyz, h_xyz);
    check(
        std::fabs(initial_energy) <= 2.0 * zeeman_energy_roundoff_envelope(initial_oracle),
        "Zeeman cancellation reproducer must cancel the signed P1 element energy to its termwise roundoff envelope");

    std::vector<double> plus = m_xyz;
    std::vector<double> minus = m_xyz;
    for (std::size_t i = 0; i < p_xyz.size(); ++i) {
        plus[i] += epsilon * p_xyz[i];
        minus[i] -= epsilon * p_xyz[i];
    }
    const double energy_plus =
        fullmag::fem::zeeman_energy_from_element_quadrature_material(material, plus, h_xyz);
    const double energy_minus =
        fullmag::fem::zeeman_energy_from_element_quadrature_material(material, minus, h_xyz);
    const double directional = independent_zeeman_energy_oracle(elements, ms, p_xyz, h_xyz).energy_j;
    const double finite_difference = (energy_plus - energy_minus) / (2.0 * epsilon);
    const double error = std::fabs(finite_difference - directional);

    const double cancellation_safe = zeeman_central_difference_tolerance_from_termwise_envelopes(
        elements, ms, plus, minus, p_xyz, h_xyz, energy_plus, energy_minus, epsilon);
    const double legacy = zeeman_central_difference_tolerance(
        energy_plus, energy_minus, directional, epsilon);

    // All nonzero directions are tangent to their unit nodal states.  The
    // representable plus/minus states retain the P1 cancellation, so an
    // assembled-energy tolerance loses the scale of individual contributions.
    check(plus != m_xyz && minus != m_xyz && plus != minus,
          "Zeeman cancellation reproducer must retain distinct representable plus/minus P1 states");
    check(std::fabs(directional) > 0.0,
          "Zeeman cancellation reproducer must retain a nonzero directional oracle");
    check(error > legacy,
          "legacy assembled-energy tolerance must fail to bound the cancelled Zeeman directional error");
    check(error <= cancellation_safe,
          "termwise Zeeman tolerance must bound the cancelled directional error");
}

} // namespace

int main() {
    two_tetra_sharp_ms_zeeman_energy_and_directional_derivative_contract();
    zeeman_directional_tolerance_must_bound_cancelled_energy_terms();
    std::cout << "fem_zeeman_element_quadrature_contract: PASS\n";
    return 0;
}
