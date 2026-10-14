"""Synthetic same-mesh cross-run field matcher regressions."""
import unittest

import numpy as np

from comsol_tracking_metric import Tet4TrackingMetric
from comsol_cross_run_matching import match_cross_run_modes


_FINGERPRINT = "sha256:" + "a" * 64


def _metric(nodes=None):
    if nodes is None:
        nodes = [[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]]
    return Tet4TrackingMetric(nodes, [[0, 1, 2, 3]], [0])


def _field(vector):
    return np.tile(np.asarray(vector, dtype=np.complex128), (4, 1))


def _context(entries, *, metric=None, fingerprint=_FINGERPRINT, run="run"):
    metric = metric or _metric()
    modes = {}
    hashes = []
    for index, (sample, raw, field, real, imag, k) in enumerate(entries):
        modes[(sample, raw)] = {
            "envelope": np.asarray(field, dtype=np.complex128),
            "k_vector_rad_per_m": list(k),
            "frequency_real_hz": real,
            "frequency_imag_hz": imag,
        }
        hashes.append({
            "path": f"{run}/sample-{sample}/mode-{raw}.json",
            "sha256": "sha256:" + format(index + 1, "064x"),
        })
    return {
        "metric": metric,
        "modes": modes,
        "file_hashes": hashes,
        "source_mesh_topology_sha256": fingerprint,
    }


def _match(left, right, left_clusters, right_clusters, **kwargs):
    parameters = {
        "overlap_floor": 0.9,
        "ambiguity_tolerance": 1e-12,
        "degeneration_relative_tolerance": 0.0,
    }
    parameters.update(kwargs)
    return match_cross_run_modes(
        left,
        right,
        left_clusters=left_clusters,
        right_clusters=right_clusters,
        **parameters,
    )


class CrossRunMatchingTests(unittest.TestCase):
    def test_same_raw_id_and_frequency_do_not_match_orthogonal_fields(self):
        left = _context([(0, 7, _field([1, 0, 0]), 1e9, 0., [0., 0., 0.])])
        right = _context([(0, 7, _field([0, 1, 0]), 1e9, 0., [0., 0., 0.])], run="other")
        result = _match(left, right, {0: [[7]]}, {0: [[7]]})
        self.assertEqual(result["status"], "not_verified")
        self.assertEqual(result["qualification"], "NOT VERIFIED")
        self.assertEqual(result["samples"][0]["pair_scores"][0]["score"], 0.0)
        self.assertIn("below overlap_floor", result["samples"][0]["reasons"][0])

    def test_swapped_raw_slots_and_global_phase_match_by_field(self):
        x, y = _field([1, 0, 0]), _field([0, 1, 0])
        phase = np.exp(0.73j)
        left = _context([
            (0, 11, x, 1e9, 0., [2., 0., 0.]),
            (0, 4, y, 2e9, 0., [2., 0., 0.]),
        ])
        right = _context([
            (0, 91, phase * y, 1e9, 0., [2., 0., 0.]),
            (0, 3, phase * x, 2e9, 0., [2., 0., 0.]),
        ], run="other")
        result = _match(
            left, right, {0: [[11], [4]]}, {0: [[91], [3]]},
            overlap_floor=0.99,
        )
        self.assertEqual(result["status"], "pass")
        pairs = result["samples"][0]["assignment"]["assigned_pairs"]
        self.assertEqual([pair["right_raw_mode_indices"] for pair in pairs], [[3], [91]])
        self.assertTrue(all(abs(pair["score"] - 1.0) < 1e-12 for pair in pairs))
        self.assertEqual(result["raw_mode_indices"], "audit_labels_only_not_matching_identity")

    def test_floor_valid_full_assignment_beats_unconstrained_invalid_optimum(self):
        x, y, z = (_field([1, 0, 0]), _field([0, 1, 0]), _field([0, 0, 1]))
        left_b = 0.6 * x + 0.8 * y
        right_a = 0.49 * x + 0.3825 * y + np.sqrt(1.0 - 0.49**2 - 0.3825**2) * z
        left = _context([
            (0, 10, x, 1e9, 0., [0., 0., 0.]),
            (0, 20, left_b, 2e9, 0., [0., 0., 0.]),
        ])
        right = _context([
            (0, 1, right_a, 1e9, 0., [0., 0., 0.]),
            (0, 2, left_b, 2e9, 0., [0., 0., 0.]),
        ], run="other")
        result = _match(
            left, right, {0: [[10], [20]]}, {0: [[1], [2]]},
            overlap_floor=0.5,
        )
        sample = result["samples"][0]
        self.assertEqual(result["status"], "pass")
        self.assertEqual(sample["assignment"]["left_to_right_cluster_indices"], [1, 0])
        self.assertGreaterEqual(
            sample["assignment"]["assigned_pairs"][0]["score"], 0.5
        )
        self.assertGreaterEqual(
            sample["assignment"]["assigned_pairs"][1]["score"], 0.5
        )

    def test_exact_degenerate_subspace_is_invariant_to_basis_rotation(self):
        x, y = _field([1, 0, 0]), _field([0, 1, 0])
        right_a = (x + 1j * y) / np.sqrt(2)
        right_b = (1j * x + y) / np.sqrt(2)
        left = _context([
            (0, 42, x, 4e9, -2e5, [0., 3., 0.]),
            (0, 2, y, 4e9, -2e5, [0., 3., 0.]),
        ])
        right = _context([
            (0, 88, right_a, 4e9, -2e5, [0., 3., 0.]),
            (0, 5, right_b, 4e9, -2e5, [0., 3., 0.]),
        ], run="other")
        result = _match(
            left, right, {0: [[42, 2]]}, {0: [[5, 88]]},
            overlap_floor=0.99,
        )
        pair = result["samples"][0]["pair_scores"][0]
        self.assertEqual(result["status"], "pass")
        self.assertEqual(pair["left_rank"], 2)
        self.assertEqual(pair["right_rank"], 2)
        self.assertEqual(len(pair["principal_cosines"]), 2)
        self.assertTrue(all(abs(value - 1.0) < 1e-12 for value in pair["principal_cosines"]))

    def test_duplicate_candidate_fields_make_global_assignment_ambiguous(self):
        x = _field([1, 0, 0])
        left = _context([(0, 30, x, 1e9, 0., [0., 0., 0.])])
        right = _context([
            (0, 71, np.exp(.2j) * x, 1e9, 0., [0., 0., 0.]),
            (0, 6, np.exp(-.5j) * x, 1e9, 0., [0., 0., 0.]),
        ], run="other")
        result = _match(left, right, {0: [[30]]}, {0: [[71], [6]]})
        assignment = result["samples"][0]["assignment"]
        self.assertEqual(result["status"], "not_verified")
        self.assertEqual(assignment["best_admissible_alternative_total_score"], 1.0)
        self.assertEqual(assignment["assignment_gap"], 0.0)
        self.assertIn("ambiguity_tolerance", result["samples"][0]["reasons"][0]
                      if len(result["samples"][0]["reasons"]) == 1
                      else " ".join(result["samples"][0]["reasons"]))

    def test_rank_mismatch_for_split_cluster_is_not_verified(self):
        x, y = _field([1, 0, 0]), _field([0, 1, 0])
        left = _context([
            (0, 1, x, 7e9, 0., [0., 0., 0.]),
            (0, 2, y, 7e9, 0., [0., 0., 0.]),
        ])
        right = _context([
            (0, 4, x, 7e9, 0., [0., 0., 0.]),
            (0, 9, y, 7e9, 0., [0., 0., 0.]),
        ], run="other")
        result = _match(left, right, {0: [[1, 2]]}, {0: [[4], [9]]})
        pair = result["samples"][0]["pair_scores"][0]
        self.assertFalse(pair["rank_compatible"])
        self.assertEqual(pair["score"], 0.0)
        self.assertEqual(result["status"], "not_verified")

    def test_extra_right_state_is_left_unmatched_when_left_mapping_is_unique(self):
        x, y = _field([1, 0, 0]), _field([0, 1, 0])
        left = _context([(0, 55, x, 2e9, 0., [0., 0., 0.])])
        right = _context([
            (0, 81, y, 99e9, 0., [0., 0., 0.]),
            (0, 3, x, 1e9, 0., [0., 0., 0.]),
        ], run="other")
        result = _match(left, right, {0: [[55]]}, {0: [[81], [3]]})
        sample = result["samples"][0]
        self.assertEqual(result["status"], "pass")
        self.assertEqual(sample["assignment"]["left_to_right_cluster_indices"], [1])
        self.assertEqual(sample["candidate_inventory"]["unmatched_right_cluster_indices"], [0])

    def test_incomplete_cluster_partition_rejected(self):
        x, y = _field([1, 0, 0]), _field([0, 1, 0])
        left = _context([
            (0, 1, x, 1e9, 0., [0., 0., 0.]),
            (0, 2, y, 2e9, 0., [0., 0., 0.]),
        ])
        right = _context([
            (0, 1, x, 1e9, 0., [0., 0., 0.]),
            (0, 2, y, 2e9, 0., [0., 0., 0.]),
        ], run="other")
        with self.assertRaisesRegex(ValueError, "do not cover candidate inventory"):
            _match(left, right, {0: [[1]]}, {0: [[1], [2]]})

    def test_rank_deficient_cluster_rejected(self):
        x = _field([1, 0, 0])
        left = _context([
            (0, 1, x, 1e9, 0., [0., 0., 0.]),
            (0, 2, 1j * x, 1e9, 0., [0., 0., 0.]),
        ])
        right = _context([
            (0, 1, x, 1e9, 0., [0., 0., 0.]),
            (0, 2, 1j * x, 1e9, 0., [0., 0., 0.]),
        ], run="other")
        with self.assertRaisesRegex(ValueError, "rank deficient"):
            _match(left, right, {0: [[1, 2]]}, {0: [[1, 2]]})

    def test_wrong_signed_k_and_mesh_mismatch_rejected(self):
        x = _field([1, 0, 0])
        left = _context([(0, 1, x, 1e9, 0., [1., 0., 0.])])
        wrong_k = _context([(0, 1, x, 1e9, 0., [-1., 0., 0.])], run="other")
        with self.assertRaisesRegex(ValueError, "different signed k"):
            _match(left, wrong_k, {0: [[1]]}, {0: [[1]]})

        shifted = [[0., 0., 0.], [1.1, 0., 0.], [0., 1., 0.], [0., 0., 1.]]
        wrong_mesh = _context(
            [(0, 1, x, 1e9, 0., [1., 0., 0.])],
            metric=_metric(shifted),
            run="other",
        )
        with self.assertRaisesRegex(ValueError, "fingerprints differ|metric nodes differ"):
            _match(left, wrong_mesh, {0: [[1]]}, {0: [[1]]})

    def test_degeneracy_tolerance_and_hash_context_are_required(self):
        x, y = _field([1, 0, 0]), _field([0, 1, 0])
        left = _context([
            (0, 1, x, 1e9, 0., [0., 0., 0.]),
            (0, 2, y, 2e9, 0., [0., 0., 0.]),
        ])
        right = _context([
            (0, 1, x, 1e9, 0., [0., 0., 0.]),
            (0, 2, y, 2e9, 0., [0., 0., 0.]),
        ], run="other")
        with self.assertRaisesRegex(ValueError, "frequencies are not degenerate"):
            _match(left, right, {0: [[1, 2]]}, {0: [[1], [2]]})

        missing_hashes = dict(left, file_hashes=[])
        with self.assertRaisesRegex(ValueError, "file_hashes must be a non-empty"):
            _match(missing_hashes, right, {0: [[1], [2]]}, {0: [[1], [2]]})

    def test_thresholds_are_explicit_and_validated(self):
        x = _field([1, 0, 0])
        left = _context([(0, 1, x, 1e9, 0., [0., 0., 0.])])
        right = _context([(0, 1, x, 1e9, 0., [0., 0., 0.])], run="other")
        for kwargs in (
            {"overlap_floor": 0.0},
            {"overlap_floor": 1.1},
            {"ambiguity_tolerance": -1.0},
            {"degeneration_relative_tolerance": float("nan")},
        ):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                _match(left, right, {0: [[1]]}, {0: [[1]]}, **kwargs)


if __name__ == "__main__":
    unittest.main()