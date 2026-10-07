"""Independent nodal-Ms P1 quadrature oracle; no native FEM execution."""

from __future__ import annotations

from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
GRADIENTS = ((-0.5, -1.0), (0.5, 0.0), (0.0, 1.0))
NODAL_MS = (1.5, 2.5, 4.0)
FRAMES = (
    ((1.0 / 2.0**0.5), (1.0 / 2.0**0.5), 0.0, 0.0, 0.0, 1.0),
    ((1.0 / 2.0**0.5), (1.0 / 2.0**0.5), 0.0, 0.0, 0.0, 1.0),
    ((1.0 / 2.0**0.5), (1.0 / 2.0**0.5), 0.0, 0.0, 0.0, 1.0),
)
Q = (1.0 + 0.2j, 0.4 - 0.8j, -0.7 + 0.4j, 1.1 + 0.5j, 0.3 - 0.9j, -0.2 + 0.6j)

# Dunavant degree-three rule in barycentric coordinates.  It integrates the
# cubic Ms*N_test*N_source axial term exactly on a triangle of any area.
DEGREE_THREE_POINTS = (
    (1.0 / 3.0, 1.0 / 3.0, 1.0 / 3.0),
    (0.6, 0.2, 0.2),
    (0.2, 0.6, 0.2),
    (0.2, 0.2, 0.6),
)
DEGREE_THREE_WEIGHTS = (-27.0 / 48.0, 25.0 / 48.0, 25.0 / 48.0, 25.0 / 48.0)


def independent_physical_source(k: float, q: tuple[complex, ...], ms_values: tuple[float, ...]) -> list[complex]:
    """Evaluate S_perp + i*k*S_z by independent degree-three quadrature."""

    values = [0j] * 3
    for bary, weight in zip(DEGREE_THREE_POINTS, DEGREE_THREE_WEIGHTS):
        ms = sum(bary[node] * ms_values[node] for node in range(3))
        magnetization = [0j, 0j, 0j]
        for node in range(3):
            e1 = FRAMES[node][:3]
            e2 = FRAMES[node][3:]
            magnetization[0] += bary[node] * (e1[0] * q[2 * node] + e2[0] * q[2 * node + 1])
            magnetization[1] += bary[node] * (e1[1] * q[2 * node] + e2[1] * q[2 * node + 1])
            magnetization[2] += bary[node] * (e1[2] * q[2 * node] + e2[2] * q[2 * node + 1])
        for row, (gradient_x, gradient_y) in enumerate(GRADIENTS):
            values[row] += weight * ms * (
                gradient_x * magnetization[0]
                + gradient_y * magnetization[1]
                + 1j * k * bary[row] * magnetization[2]
            )
    # The fixture triangle has area one square metre.
    return values


def exact_p1_source(k: float, q: tuple[complex, ...], ms_values: tuple[float, ...]) -> list[complex]:
    """Evaluate the requested closed-form P1 coefficient moments."""

    values = [0j] * 3
    for row, (gradient_x, gradient_y) in enumerate(GRADIENTS):
        for source in range(3):
            transverse_moment = sum(
                ms_values[coefficient] * (2.0 if coefficient == source else 1.0)
                for coefficient in range(3)
            ) / 12.0
            axial_moment = 0.0
            for coefficient in range(3):
                equal_pairs = sum(
                    (
                        row == source,
                        row == coefficient,
                        source == coefficient,
                    )
                )
                coefficient_weight = 6.0 if equal_pairs == 3 else 2.0 if equal_pairs == 1 else 1.0
                axial_moment += ms_values[coefficient] * coefficient_weight / 60.0
            e1 = FRAMES[source][:3]
            e2 = FRAMES[source][3:]
            values[row] += q[2 * source] * (
                transverse_moment * -(gradient_x * e1[0] + gradient_y * e1[1])
                + 1j * k * axial_moment * -e1[2]
            )
            values[row] += q[2 * source + 1] * (
                transverse_moment * -(gradient_x * e2[0] + gradient_y * e2[1])
                + 1j * k * axial_moment * -e2[2]
            )
    # The descriptor block is the negative physical weak source.
    return values


def legacy_uniform_source(k: float, q: tuple[complex, ...], ms: float) -> list[complex]:
    """Evaluate the pre-existing uniform-Ms source weights independently."""

    values = [0j] * 3
    for row, (gradient_x, gradient_y) in enumerate(GRADIENTS):
        for source in range(3):
            transverse_weight = ms / 3.0
            axial_weight = ms * (1.0 / 6.0 if row == source else 1.0 / 12.0)
            e1 = FRAMES[source][:3]
            e2 = FRAMES[source][3:]
            values[row] += q[2 * source] * (
                transverse_weight * -(gradient_x * e1[0] + gradient_y * e1[1])
                + 1j * k * axial_weight * -e1[2]
            )
            values[row] += q[2 * source + 1] * (
                transverse_weight * -(gradient_x * e2[0] + gradient_y * e2[1])
                + 1j * k * axial_weight * -e2[2]
            )
    return values


def source_node_ms_mass_source(
    k: float, q: tuple[complex, ...], ms_values: tuple[float, ...]
) -> list[complex]:
    """Evaluate the historical, incorrect source-node Ms times mass rule."""

    values = [0j] * 3
    for row, (gradient_x, gradient_y) in enumerate(GRADIENTS):
        for source in range(3):
            source_ms = ms_values[source]
            transverse_weight = source_ms / 3.0
            axial_weight = source_ms * (1.0 / 6.0 if row == source else 1.0 / 12.0)
            e1 = FRAMES[source][:3]
            e2 = FRAMES[source][3:]
            values[row] += q[2 * source] * (
                transverse_weight * -(gradient_x * e1[0] + gradient_y * e1[1])
                + 1j * k * axial_weight * -e1[2]
            )
            values[row] += q[2 * source + 1] * (
                transverse_weight * -(gradient_x * e2[0] + gradient_y * e2[1])
                + 1j * k * axial_weight * -e2[2]
            )
    return values


class WaveguideNodalMsQuadratureTests(unittest.TestCase):
    def test_degree_three_quadrature_matches_exact_p1_moments_for_signed_k(self):
        for k in (-3.0, 0.0, 3.0):
            physical = independent_physical_source(k, Q, NODAL_MS)
            descriptor = exact_p1_source(k, Q, NODAL_MS)
            for actual, expected in zip(descriptor, physical):
                self.assertAlmostEqual(abs(actual + expected), 0.0, places=13)

    def test_uniform_nodal_field_recovers_uniform_branch(self):
        uniform = (2.0, 2.0, 2.0)
        for k in (-3.0, 0.0, 3.0):
            descriptor = exact_p1_source(k, Q, uniform)
            legacy = legacy_uniform_source(k, Q, 2.0)
            for actual, expected in zip(descriptor, legacy):
                self.assertAlmostEqual(abs(actual - expected), 0.0, places=14)

    def test_source_node_ms_mass_rule_differs_for_variable_ms(self):
        corrected = exact_p1_source(3.0, Q, NODAL_MS)
        historical = source_node_ms_mass_source(3.0, Q, NODAL_MS)
        maximum_difference = max(
            abs(actual - expected) for actual, expected in zip(corrected, historical)
        )
        self.assertGreater(maximum_difference, 1.0e-6)

    def test_signed_k_conjugacy_for_real_mixed_source(self):
        real_q = tuple(value.real for value in Q)
        plus = independent_physical_source(3.0, real_q, NODAL_MS)
        minus = independent_physical_source(-3.0, real_q, NODAL_MS)
        for positive, negative in zip(plus, minus):
            self.assertAlmostEqual(abs(negative - positive.conjugate()), 0.0, places=13)

    def test_cpp_contains_nodal_p1_branch_and_legacy_uniform_branch(self):
        source = (ROOT / "backends/fem/cpu/frequency_domain/floquet_waveguide_cross_section.cpp").read_text(
            encoding="utf-8"
        )
        code = re.sub(r"//[^\n]*|/\*.*?\*/", "", source, flags=re.S)
        self.assertIn("const bool has_nodal_ms", code)
        self.assertIn("local_ms_sum + local_ms[local_source]", code)
        self.assertIn("axial_moment / 60.0", code)
        self.assertIn("area * ms / 3.0", code)
        self.assertIn("area * ms *", code)


if __name__ == "__main__":
    unittest.main()
