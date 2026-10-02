"""Frequency policy fixtures, independent of modal fields and FEM execution."""
import unittest
from pathlib import Path
import re

from comsol_tracking_clusters import (frequency_clusters, frequency_group_candidates,
    DEGENERACY_ABSOLUTE_HZ, DEGENERACY_RELATIVE, SINGLETON_BOUNDARY_RELATIVE)


class ClusterTests(unittest.TestCase):
    def test_private_policy_constants_match_native_source(self):
        root = Path(__file__).resolve().parents[1] / "crates/fullmag-runner/src/eigen"
        source = (root / "tracking_subspace.rs").read_text(encoding="utf-8")
        for name, expected in (("DEGENERACY_ABSOLUTE_FREQUENCY_TOLERANCE_HZ", DEGENERACY_ABSOLUTE_HZ),
                               ("DEGENERACY_RELATIVE_FREQUENCY_TOLERANCE", DEGENERACY_RELATIVE)):
            match = re.search(r"const " + name + r": f64\s*=\s*([0-9.eE+-]+);", source)
            self.assertIsNotNone(match, name)
            self.assertEqual(float(match.group(1)), expected, name)
        source = (root / "tracking.rs").read_text(encoding="utf-8")
        match = re.search(r"<=\s*([0-9.eE+-]+)\s*\* distance\.abs\(\)\.max\(boundary_distance\.abs\(\)\)", source)
        self.assertIsNotNone(match)
        self.assertEqual(float(match.group(1)), SINGLETON_BOUNDARY_RELATIVE)

    def test_anchor_grouping_does_not_chain_neighbors(self):
        entries = [(9, 1e10, 0.), (2, 1e10 + 9e5, 0.), (7, 1e10 + 18e5, 0.)]
        self.assertEqual(frequency_clusters(entries), [[0, 1], [2]])

    def test_complex_distance_and_sort_order(self):
        entries = [(7, 1e10, 2e6), (9, 1e10, 0.), (2, 1e10, 1.)]
        self.assertEqual(frequency_clusters(entries), [[1, 2], [0]])

    def test_absolute_and_relative_thresholds_are_additive(self):
        self.assertEqual(frequency_clusters([(0, 1., 0.), (1, 1., .0001005)]), [[0, 1]])
        self.assertEqual(frequency_clusters([(0, 1., 0.), (1, 1., .000102)]), [[0], [1]])

    def test_split_and_degenerate_transitions(self):
        split = [(9, 9.99e9, 0.), (8, 10.01e9, 0.)]
        degenerate = [(2, 1e10, 0.), (6, 1e10, 0.)]
        forward = frequency_group_candidates(split, degenerate)
        self.assertEqual(len(forward), 1)
        self.assertEqual(forward[0]["transition"], "split_to_degenerate")
        self.assertEqual(set(forward[0]["previous_ids"]), {9, 8})
        reverse = frequency_group_candidates(degenerate, split)
        self.assertEqual(reverse[0]["transition"], "degenerate_to_split")
        self.assertEqual(len(frequency_group_candidates(degenerate, degenerate)), 1)

    def test_boundary_tie_rejects_guessed_singleton_group(self):
        split = [(9, 1e10 - 2e6, 0.), (8, 1e10 + 2e6, 0.), (7, 1e10, 2e6)]
        degenerate = [(2, 1e10, 0.), (6, 1e10, 0.)]
        self.assertEqual(frequency_group_candidates(split, degenerate), [])

    def test_frequency_window_excludes_boundary_singletons(self):
        split = [(9, 9.99e9, 0.), (8, 10.01e9, 0.)]
        degenerate = [(2, 1e10, 0.), (6, 1e10, 0.)]
        self.assertEqual(frequency_group_candidates(split, degenerate, window=1e7), [])

    def test_invalid_entries_and_window_rejected(self):
        for entries in ([(True, 1., 0.)], [(0, 0., 0.)], [(0, 1., float("nan"))],
                        [(0, 1., 0.), (0, 2., 0.)]):
            with self.subTest(entries=entries), self.assertRaises(ValueError):
                frequency_clusters(entries)
        with self.assertRaises(ValueError):
            frequency_group_candidates([], [], window=True)


if __name__ == "__main__":
    unittest.main()
