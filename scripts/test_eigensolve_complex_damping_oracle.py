"""Independent small-pencil algebra oracle; not a native FEM qualification.

Contract: R2 plan sections 4.4 and 7, 0831 energy-mass sign.
Uses complex QZ on the original pencil and a separate doubled-real solve.
No production adapter is imported or capability enabled by these tests.
"""
from __future__ import annotations

import unittest

import numpy as np
from scipy.linalg import block_diag, eig, qz
from scipy.optimize import linear_sum_assignment


def realification(matrix: np.ndarray) -> np.ndarray:
    return np.block([[matrix.real, -matrix.imag], [matrix.imag, matrix.real]])


def original_complex_qz_values(k: np.ndarray, b: np.ndarray) -> np.ndarray:
    aa, bb, left, right = qz(k.astype(complex), b.astype(complex), output="complex")
    np.testing.assert_allclose(left @ aa @ right.conj().T, k, atol=2e-12, rtol=2e-12)
    np.testing.assert_allclose(left @ bb @ right.conj().T, b, atol=2e-12, rtol=2e-12)
    denominator = np.diag(bb)
    if np.any(np.abs(denominator) < 1e-12):
        raise AssertionError("this finite oracle does not admit singular descriptor mass")
    return np.diag(aa) / denominator


def original_residual(k: np.ndarray, b: np.ndarray, omega: complex, q: np.ndarray) -> float:
    scale = (np.linalg.norm(k, 2) + abs(omega) * np.linalg.norm(b, 2)) * np.linalg.norm(q)
    if not np.isfinite(scale) or scale <= 0:
        return float("inf")
    return float(np.linalg.norm(k @ q - 1j * omega * (b @ q)) / scale)


def physical_doubled_spectrum(k: np.ndarray, b: np.ndarray) -> tuple[np.ndarray, int]:
    omega, vectors = eig(realification(k), realification(1j * b))
    n = len(k)
    groups: list[tuple[complex, list[np.ndarray]]] = []
    rejected = 0
    for value, vector in zip(omega, vectors.T):
        q = vector[:n] + 1j * vector[n:]
        q_norm = np.linalg.norm(q)
        if (not np.isfinite(value) or q_norm <= 1e-9 * np.linalg.norm(vector)
                or original_residual(k, b, value, q) > 1e-10):
            rejected += 1
            continue
        q = q / q_norm
        for representative, basis in groups:
            if abs(value - representative) <= 1e-9 * max(1.0, abs(value), abs(representative)):
                basis.append(q)
                break
        else:
            groups.append((complex(value), [q]))
    physical_values = []
    for representative, basis in groups:
        singular_values = np.linalg.svd(np.column_stack(basis), compute_uv=False)
        rank = int(np.count_nonzero(singular_values > 1e-8 * singular_values[0]))
        physical_values.extend([representative] * rank)
    return np.asarray(physical_values, dtype=complex), rejected


def macrospin_pencil(a: float, b: float, alpha: float) -> tuple[np.ndarray, np.ndarray]:
    cross = np.array([[0.0, -1.0], [1.0, 0.0]])
    return np.diag([a, b]).astype(complex), (-cross - alpha * np.eye(2)).astype(complex)


class ComplexDampingOracleTests(unittest.TestCase):
    def assert_spectrum_matches(self, actual: np.ndarray, expected: np.ndarray) -> None:
        self.assertEqual(len(actual), len(expected))
        costs = np.abs(actual[:, None] - expected[None, :])
        rows, columns = linear_sum_assignment(costs)
        scale = np.maximum(1.0, np.abs(expected[columns]))
        self.assertLess(float(np.max(costs[rows, columns] / scale)), 1e-10)

    def assert_original_and_doubled(self, k: np.ndarray, b: np.ndarray) -> np.ndarray:
        original = original_complex_qz_values(k, b)
        physical, _ = physical_doubled_spectrum(k, b)
        self.assert_spectrum_matches(1j * physical, original)
        return original

    def test_circular_macrospin_frequency_and_signed_decay(self) -> None:
        for alpha in (0.0, 0.02, 0.3, 2.0):
            with self.subTest(alpha=alpha):
                a = 3.0
                k, b = macrospin_pencil(a, a, alpha)
                expected = np.array([-alpha * a + 1j * a, -alpha * a - 1j * a]) / (1 + alpha**2)
                actual = self.assert_original_and_doubled(k, b)
                self.assert_spectrum_matches(actual, expected)
                self.assertTrue(np.all((-1j * actual).imag >= -1e-12))

    def test_elliptic_macrospin_is_not_scalar_linewidth_postprocessing(self) -> None:
        a, b, alpha = 1.0, 9.0, 0.2
        k, mass = macrospin_pencil(a, b, alpha)
        root = np.lib.scimath.sqrt(alpha**2 * (a - b)**2 - 4 * a * b)
        expected = np.array([-alpha * (a + b) + root, -alpha * (a + b) - root]) / (2 * (1 + alpha**2))
        actual = self.assert_original_and_doubled(k, mass)
        self.assert_spectrum_matches(actual, expected)
        naive_decay = alpha * np.sqrt(a * b) / (1 + alpha**2)
        self.assertGreater(abs(-actual[0].real - naive_decay), 0.1)

    def test_overdamped_retains_two_distinct_nonoscillating_modes(self) -> None:
        k, b = macrospin_pencil(1.0, 9.0, 2.0)
        actual = self.assert_original_and_doubled(k, b)
        self.assertTrue(np.all(actual.real < 0))
        self.assertLess(float(np.max(np.abs(actual.imag))), 1e-12)
        self.assertGreater(abs(actual[0] - actual[1]), 1.0)

    def test_nonzero_k_complex_hessian_rejects_mirror_growth(self) -> None:
        _, b = macrospin_pencil(2.0, 5.0, 0.15)
        k = np.array([[2.0, 0.4j], [-0.4j, 5.0]])
        original = self.assert_original_and_doubled(k, b)
        physical, rejected = physical_doubled_spectrum(k, b)
        self.assertTrue(np.all(original.real < 0))
        self.assertTrue(np.all(physical.imag > 0))
        self.assertGreaterEqual(rejected, 2)
        raw, _ = eig(realification(k), realification(1j * b))
        self.assertTrue(np.any(raw.imag < 0), "unprojected mirror sector would fabricate growth")

    def test_degenerate_undamped_subspace_uses_physical_rank(self) -> None:
        k0, b0 = macrospin_pencil(3.0, 3.0, 0.0)
        k, b = block_diag(k0, k0), block_diag(b0, b0)
        physical, _ = physical_doubled_spectrum(k, b)
        self.assertEqual(len(physical), 4)
        self.assertEqual(int(np.count_nonzero(physical.real > 0)), 2)
        self.assert_original_and_doubled(k, b)

    def test_frame_rotation_preserves_complex_damped_spectrum(self) -> None:
        k, b = macrospin_pencil(1.0, 7.0, 0.4)
        angle = 0.63
        rotation = np.array([[np.cos(angle), -np.sin(angle)], [np.sin(angle), np.cos(angle)]])
        transformed = self.assert_original_and_doubled(rotation.T @ k @ rotation, rotation.T @ b @ rotation)
        self.assert_spectrum_matches(transformed, original_complex_qz_values(k, b))

    def test_energy_balance_and_opposite_sign_produces_growth(self) -> None:
        k, b = macrospin_pencil(1.0, 9.0, 0.2)
        q = np.array([0.3, -0.7])
        qdot = np.linalg.solve(b, k @ q)
        measured = float(np.real(np.vdot(qdot, k @ q)))
        dissipated = -0.2 * float(np.real(np.vdot(qdot, qdot)))
        self.assertAlmostEqual(measured, dissipated, delta=2e-12)
        self.assertLess(measured, 0)
        _, anti_mass = macrospin_pencil(1.0, 9.0, -0.2)
        growing = original_complex_qz_values(k, anti_mass)
        self.assertTrue(np.all(growing.real > 0))


if __name__ == "__main__":
    unittest.main(verbosity=2)
