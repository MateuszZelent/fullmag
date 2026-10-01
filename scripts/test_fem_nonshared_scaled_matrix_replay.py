"""Algebraic replay must resolve small mass-weighted FEM matrix entries."""
from pathlib import Path
import tempfile
import unittest

from scripts.test_fem_nonshared_operator_replay import _bundle, _rewrite_payload_bundle
from fem_nonshared_operator_replay import NonSharedReplayError, replay_nonshared_operator


def scale_matrix(matrix):
    for key in ("stiffness_field_a_per_m", "stiffness_omega_rad_s", "gyrotropic", "tangent_mass"):
        matrix[key] = [value * 1.0e-24 for value in matrix[key]]


class NonsharedScaledMatrixReplayTests(unittest.TestCase):
    def test_valid_small_matrices_preserve_algebraic_relations(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _bundle(root)
            _rewrite_payload_bundle(root, mutate_matrix=scale_matrix)
            report = replay_nonshared_operator(root, sample_index=3)
            self.assertEqual(report.relation_metrics["gamma_relation"], "verified")
            self.assertEqual(report.scientific_qualification, "NOT_VERIFIED")

    def test_zero_omega_cannot_hide_below_a_unit_absolute_tolerance(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _bundle(root)
            def corrupt(matrix):
                scale_matrix(matrix)
                matrix["stiffness_omega_rad_s"] = [0.0] * 4
            _rewrite_payload_bundle(root, mutate_matrix=corrupt)
            with self.assertRaisesRegex(NonSharedReplayError, "K_omega"):
                replay_nonshared_operator(root, sample_index=3)

    def test_mass_and_gyrotropic_corruption_remain_visible_at_small_scale(self):
        cases = (
            ("gyrotropic", 1, 0.5e-24),
            ("gyrotropic", 0, 0.2e-24),
            ("tangent_mass", 3, 1.2e-24),
            ("tangent_mass", 1, 0.2e-24),
        )
        for key, index, value in cases:
            with self.subTest(key=key, index=index), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                _bundle(root)
                def corrupt(matrix):
                    scale_matrix(matrix)
                    matrix[key][index] = value
                _rewrite_payload_bundle(root, mutate_matrix=corrupt)
                with self.assertRaises(NonSharedReplayError):
                    replay_nonshared_operator(root, sample_index=3)


if __name__ == "__main__":
    unittest.main()
