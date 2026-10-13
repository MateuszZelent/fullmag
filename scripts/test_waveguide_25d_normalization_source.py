"""Independent source-only checks for the proposed S09 2.5D normalization.

This module deliberately uses only Python standard-library arithmetic. It does
not import the native FEM backend and does not qualify a solver or runtime.
"""

import math
import unittest


def triangle_area(coords):
    (x0, y0), (x1, y1), (x2, y2) = coords
    return abs((x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)) / 2.0


def degree_three_barycentric_quadrature():
    """Return an independent degree-three rule normalized to unit area."""
    return [
        ((1.0 / 3.0, 1.0 / 3.0, 1.0 / 3.0), -27.0 / 48.0),
        ((0.6, 0.2, 0.2), 25.0 / 48.0),
        ((0.2, 0.6, 0.2), 25.0 / 48.0),
        ((0.2, 0.2, 0.6), 25.0 / 48.0),
    ]


def frame(angle):
    c = math.cos(angle)
    s = math.sin(angle)
    return ((c, -s), (s, c), (0.0, 0.0))


def de_tangent_frame():
    """Return columns y/z tangent to an equilibrium m0 parallel to x."""
    return ((0.0, 0.0), (1.0, 0.0), (0.0, 1.0))


def local_rotation(angle):
    c = math.cos(angle)
    s = math.sin(angle)
    return ((c, -s), (s, c))


def mat2_transpose_vector(matrix, vector):
    return tuple(
        sum(matrix[row][column] * vector[row] for row in range(2))
        for column in range(2)
    )


def mat2_vector(matrix, vector):
    return tuple(
        sum(matrix[row][column] * vector[column] for column in range(2))
        for row in range(2)
    )


def mat3x2_vector(matrix, vector):
    return tuple(
        sum(matrix[row][column] * vector[column] for column in range(2))
        for row in range(3)
    )


def mat3x2_mat2(left, right):
    return tuple(
        tuple(
            sum(left[row][middle] * right[middle][column] for middle in range(2))
            for column in range(2)
        )
        for row in range(3)
    )


def mat2_transpose_mat3x2(left, right):
    return tuple(
        tuple(
            sum(left[middle][row] * right[middle][column] for middle in range(3))
            for column in range(2)
        )
        for row in range(2)
    )


def complex_dot(left, right):
    return sum(a.conjugate() * b for a, b in zip(left, right))


def p1_geometric_mass(area, frames):
    matrix = [[0j for _ in range(2 * len(frames))] for _ in range(2 * len(frames))]
    for i, left in enumerate(frames):
        for j, right in enumerate(frames):
            frame_dot = mat2_transpose_mat3x2(left, right)
            factor = area * (2.0 if i == j else 1.0) / 12.0
            for row in range(2):
                for column in range(2):
                    matrix[2 * i + row][2 * j + column] = factor * frame_dot[row][column]
    return matrix


def flatten_q(q):
    return [value for node in q for value in node]


def quadratic_form(matrix, values):
    return sum(
        values[row].conjugate() * matrix[row][column] * values[column]
        for row in range(len(values))
        for column in range(len(values))
    )


def barycentric_field(barycentric, frames, q):
    return tuple(
        sum(
            barycentric[node] * value
            for node in range(len(frames))
            for value in [mat3x2_vector(frames[node], q[node])[component]]
        )
        for component in range(3)
    )


def integrated_norm(coords, frames, q):
    area = triangle_area(coords)
    total = 0j
    for barycentric, weight in degree_three_barycentric_quadrature():
        field = barycentric_field(barycentric, frames, q)
        total += area * weight * complex_dot(field, field)
    return total


def scale_q(q, scalar):
    return [tuple(value / scalar for value in node) for node in q]


def physical_nodes(q, frames):
    return [mat3x2_vector(frames[node], q[node]) for node in range(len(q))]


class Waveguide25DNormalizationTests(unittest.TestCase):
    def setUp(self):
        self.coords = ((0.0, 0.0), (2.0, 0.0), (0.0, 1.0))
        self.frames = (
            frame(0.0),
            frame(0.37),
            frame(-0.61),
        )
        self.q = (
            (1.0 + 2.0j, -0.5 + 0.25j),
            (-0.75 + 0.5j, 1.2 - 0.3j),
            (0.2 - 0.8j, 0.6 + 0.1j),
        )

    def assert_complex_close(self, left, right, places=12):
        self.assertAlmostEqual(left.real, right.real, places=places)
        self.assertAlmostEqual(left.imag, right.imag, places=places)

    def test_degree_three_integral_matches_geometric_p1_mass(self):
        area = triangle_area(self.coords)
        matrix = p1_geometric_mass(area, self.frames)
        direct = integrated_norm(self.coords, self.frames, self.q)
        assembled = quadratic_form(matrix, flatten_q(self.q))
        self.assert_complex_close(direct, assembled)

    def test_constant_cartesian_field_recovers_area_norm(self):
        field = (0.7 + 0.2j, -0.3 + 0.4j, 0.0j)
        q = tuple(
            mat2_transpose_vector(
                self.frames[node],
                field,
            )
            for node in range(3)
        )
        expected = triangle_area(self.coords) * complex_dot(field, field)
        self.assert_complex_close(integrated_norm(self.coords, self.frames, q), expected)

    def test_local_tangent_basis_rotation_preserves_field_and_mass(self):
        rotations = (0.21, -0.43, 0.67)
        rotated_frames = tuple(
            mat3x2_mat2(self.frames[node], local_rotation(rotations[node]))
            for node in range(3)
        )
        rotated_q = tuple(
            mat2_transpose_vector(local_rotation(rotations[node]), self.q[node])
            for node in range(3)
        )
        original_nodes = physical_nodes(self.q, self.frames)
        rotated_nodes = physical_nodes(rotated_q, rotated_frames)
        for original, rotated in zip(original_nodes, rotated_nodes):
            for left, right in zip(original, rotated):
                self.assertAlmostEqual(left.real, right.real, places=12)
                self.assertAlmostEqual(left.imag, right.imag, places=12)
        original = integrated_norm(self.coords, self.frames, self.q)
        rotated = integrated_norm(self.coords, rotated_frames, rotated_q)
        self.assert_complex_close(original, rotated)

    def test_de_tangency_is_relative_to_m0_and_allows_axial_component(self):
        m0 = (1.0, 0.0, 0.0)
        propagation_axis = (0.0, 0.0, 1.0)
        tangent = de_tangent_frame()
        q = (0.4 + 0.2j, -0.7 + 0.1j)
        field = mat3x2_vector(tangent, q)
        equilibrium_dot = sum(m0[index] * field[index] for index in range(3))
        axial_component = sum(
            propagation_axis[index] * field[index] for index in range(3)
        )
        self.assertAlmostEqual(abs(equilibrium_dot), 0.0, places=12)
        self.assertGreater(abs(axial_component), 0.0)
        self.assertAlmostEqual(field[0], 0.0, places=12)

    def test_unit_max_uses_nodal_cartesian_complex_norm(self):
        q = (
            (3.0 + 0.0j, 4.0j),
            (1.0 + 0.0j, 1.0j),
            (0.5 + 0.0j, 0.5j),
        )
        nodal_norms = [
            math.sqrt(sum(abs(value) ** 2 for value in node))
            for node in physical_nodes(q, self.frames)
        ]
        scalar_component_max = max(abs(value) for node in q for value in node)
        self.assertAlmostEqual(max(nodal_norms), 5.0, places=12)
        self.assertAlmostEqual(scalar_component_max, 4.0, places=12)
        self.assertNotAlmostEqual(max(nodal_norms), scalar_component_max, places=6)

    def test_extruded_l2_and_energy_per_length_scaling(self):
        area_norm = integrated_norm(self.coords, self.frames, self.q).real
        self.assertGreater(area_norm, 0.0)
        unit_2d = scale_q(self.q, math.sqrt(area_norm))
        ell = 7.5
        unit_3d = scale_q(unit_2d, math.sqrt(ell))
        volume_norm = ell * integrated_norm(self.coords, self.frames, unit_3d).real
        self.assertAlmostEqual(volume_norm, 1.0, places=12)
        a_2d = 2.0e-9
        a_3d = a_2d * math.sqrt(ell)
        for left, right in zip(
            physical_nodes(unit_2d, self.frames),
            physical_nodes(unit_3d, self.frames),
        ):
            for value_2d, value_3d in zip(left, right):
                self.assertAlmostEqual(a_2d * value_2d, a_3d * value_3d, places=20)
        coefficient_l2 = 3.2e12
        energy_per_length_2d = abs(a_2d) ** 2 * coefficient_l2
        total_energy_3d = ell * energy_per_length_2d
        self.assertAlmostEqual(total_energy_3d / ell, energy_per_length_2d, places=18)

    def test_full_residual_is_invariant_under_common_q_phi_gauge_scale(self):
        state = (
            (1.0 + 0.5j, -0.2j),
            0.75 - 0.3j,
            -0.4 + 0.9j,
        )

        def residual(x):
            q, phi, gauge = x
            return (
                tuple(2.0 * value + phi for value in q),
                q[0] - 3.0 * phi + gauge,
                phi - gauge,
            )

        def norm(x):
            q, phi, gauge = x
            return math.sqrt(
                sum(abs(value) ** 2 for value in q)
                + abs(phi) ** 2
                + abs(gauge) ** 2
            )

        alpha = -0.7 + 1.3j
        scaled_state = (
            tuple(alpha * value for value in state[0]),
            alpha * state[1],
            alpha * state[2],
        )
        base_residual = residual(state)
        scaled_residual = residual(scaled_state)
        self.assertAlmostEqual(
            norm(scaled_residual) / abs(alpha),
            norm(base_residual),
            places=12,
        )


if __name__ == "__main__":
    unittest.main()
