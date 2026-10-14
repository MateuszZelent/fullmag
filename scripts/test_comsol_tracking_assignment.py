"""Assignment algebra verified by independent exhaustive small fixtures."""
import itertools
import unittest

import numpy as np

from comsol_tracking_assignment import maximum_weight_assignment


class AssignmentTests(unittest.TestCase):
    def test_counterexample_to_greedy(self):
        assignment, weight = maximum_weight_assignment([[.9, .8], [.85, .1]])
        self.assertEqual(assignment, [1, 0])
        self.assertAlmostEqual(weight, 1.65)

    def test_small_square_and_rectangular_against_enumeration(self):
        rng = np.random.default_rng(1904)
        for rows in range(1, 6):
            for columns in (rows, rows + 1):
                for _ in range(8):
                    weights = rng.random((rows, columns))
                    assignment, measured = maximum_weight_assignment(weights)
                    expected = max(sum(weights[i, j] for i, j in enumerate(permutation))
                                   for permutation in itertools.permutations(range(columns), rows))
                    with self.subTest(rows=rows, columns=columns):
                        self.assertEqual(len(set(assignment)), rows)
                        self.assertAlmostEqual(measured, expected, places=12)

    def test_tied_optima(self):
        assignment, weight = maximum_weight_assignment(np.full((4, 6), .5))
        self.assertEqual(len(set(assignment)), 4)
        self.assertEqual(weight, 2.)
        self.assertEqual(maximum_weight_assignment(np.zeros((3, 3)))[1], 0.)

    def test_large_permuted_known_optimum(self):
        weights = np.zeros((32, 37))
        permutation = np.random.default_rng(731).permutation(37)[:32]
        weights[np.arange(32), permutation] = 1.
        assignment, weight = maximum_weight_assignment(weights)
        self.assertEqual(assignment, permutation.tolist())
        self.assertEqual(weight, 32.)

    def test_tiny_weights_do_not_cancel(self):
        assignment, weight = maximum_weight_assignment(np.array([[.9, .8], [.85, .1]]) * 1e-300)
        self.assertEqual(assignment, [1, 0])
        self.assertAlmostEqual(weight / 1e-300, 1.65)

    def test_invalid_weights_rejected(self):
        for value in ([], [[1], [1]], [[True, 0], [0, 1]], [[float("nan")]],
                      [[float("inf")]], [[-.1]], [[1.1]], [[".5"]], [[.2, .3], [.4]]):
            with self.subTest(value=value), self.assertRaises(ValueError):
                maximum_weight_assignment(value)


if __name__ == "__main__":
    unittest.main()
