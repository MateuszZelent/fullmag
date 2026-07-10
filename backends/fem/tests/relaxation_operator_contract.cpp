/* Manufactured SI-unit contract for native FEM relaxation operators. */

#include "src/relaxation_numerics.hpp"
#include "src/relaxation_operator_units.hpp"
#include "cpu/mfem/relaxation/relaxation_math.hpp"

#include <mfem.hpp>

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <array>
#include <algorithm>
#include <limits>

namespace {

constexpr double kMu0 = 1.25663706212e-6;

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

bool close(double actual, double expected)
{
    const double scale = std::max(std::abs(actual), std::abs(expected));
    return std::abs(actual - expected) <= 32.0 * std::numeric_limits<double>::epsilon() * scale;
}

void exchange_hessian_uses_si_field_scale()
{
    const double step_m_per_a = 2.5e-8;
    const double expected_exchange_scale = step_m_per_a * (2.0 / kMu0);
    const double production_exchange_scale =
        fullmag::fem::relaxation::exchange_hessian_scale_from_step_m_per_a(
            step_m_per_a);
    check(close(production_exchange_scale, expected_exchange_scale),
          "FEM relaxation exchange Hessian must use lambda*(2/mu0)*K_A");

    // Two-node manufactured action.  M_Ms deliberately has unequal diagonal
    // entries so replacing the heterogeneous Ms mass by a volume-only mass
    // cannot satisfy this oracle.
    const std::array<std::array<double, 2>, 2> mass_ms_entries = {{
        {{4.0e5 * 2.0e-25, 0.0}},
        {{0.0, 9.0e5 * 3.0e-25}},
    }};
    const std::array<std::array<double, 2>, 2> stiffness_a_entries = {{
        {{1.4e-19, -1.4e-19}},
        {{-1.4e-19, 1.4e-19}},
    }};
    const std::array<double, 2> tangent = {{0.6, -0.8}};
    mfem::SparseMatrix mass_ms(2, 2);
    mfem::SparseMatrix stiffness_a(2, 2);
    for (int row = 0; row < 2; ++row) {
        for (int col = 0; col < 2; ++col) {
            mass_ms.Add(row, col, mass_ms_entries[row][col]);
            stiffness_a.Add(row, col, stiffness_a_entries[row][col]);
        }
    }
    mass_ms.Finalize();
    stiffness_a.Finalize();
    const auto production_operator =
        fullmag::fem::relaxation::assemble_exchange_mass_preconditioner_for_step(
            mass_ms, stiffness_a, step_m_per_a);
    mfem::Vector tangent_vector(2);
    tangent_vector[0] = tangent[0];
    tangent_vector[1] = tangent[1];
    mfem::Vector production_action(2);
    production_operator->Mult(tangent_vector, production_action);
    for (std::size_t row = 0; row < 2; ++row) {
        double expected_action = 0.0;
        for (std::size_t col = 0; col < 2; ++col) {
            expected_action +=
                (mass_ms_entries[row][col] +
                 expected_exchange_scale * stiffness_a_entries[row][col]) *
                tangent[col];
        }
        check(close(production_action[static_cast<int>(row)], expected_action),
              "production FEM minimizer operator action must equal M_Ms + lambda*(2/mu0)*K_A");
    }
}

void local_field_curvature_uses_heterogeneous_ms_weight()
{
    const double step_m_per_a = 1.25e-8;
    const double ms_a_per_m = 4.0e5;
    const double nodal_volume_m3 = 3.0e-25;
    const double field_curvature_a_per_m = 7.0e4;
    const double expected = step_m_per_a * kMu0 * ms_a_per_m *
        nodal_volume_m3 * field_curvature_a_per_m;
    const double actual =
        fullmag::fem::relaxation::local_field_curvature_operator_entry(
            step_m_per_a,
            ms_a_per_m,
            nodal_volume_m3,
            field_curvature_a_per_m);
    check(close(actual, expected),
          "local FEM relaxation curvature must use lambda*mu0*Ms_i*V_i*dH/dm");

    const double second_ms_a_per_m = 9.0e5;
    const double second =
        fullmag::fem::relaxation::local_field_curvature_operator_entry(
            step_m_per_a,
            second_ms_a_per_m,
            nodal_volume_m3,
            field_curvature_a_per_m);
    check(close(second / actual, second_ms_a_per_m / ms_a_per_m),
          "local FEM relaxation curvature must preserve heterogeneous Ms");
}

} // namespace

int main()
{
    exchange_hessian_uses_si_field_scale();
    local_field_curvature_uses_heterogeneous_ms_weight();
    return 0;
}
