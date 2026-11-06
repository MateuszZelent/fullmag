"""Aggregation checks on small mathematical inputs, not full GSG qualification."""
import math
import struct
import unittest
from unittest.mock import patch

import antenna_gsg_convergence_reference as gsg
import antenna_rt0_surface_oracle as rt0
import antenna_triangle_surface_oracle as triangle

VERTICES = ((0., 0., 1e-6), (1e-6, 0., 1e-6),
            (0., 1e-6, 1e-6), (0., 0., 2e-6))
CURRENT = ((3., -2., 5.),) * 4


def cell(index, sign=1.):
    center = tuple(sum(v[k] for v in VERTICES) / 4 for k in range(3))
    return (index, 10, 11, 12, 13, *(v for point in VERTICES for v in point),
            *(sign * v for row in CURRENT for v in row), *center, *(sign * v for v in CURRENT[0]))


def budget():
    b = gsg.GsgSourceConvergenceBudget()
    b.activate_source(gsg.SOURCE_IR_SHA256S[0])
    return b


class GsgFieldReferenceSumTests(unittest.TestCase):
    def test_sum_matches_two_individually_evaluated_contributions(self):
        b = budget(); target = gsg.TARGETS_M[0]
        one = rt0.evaluate_retained_rt0(VERTICES, CURRENT, target, b)
        result = gsg.evaluate_retained_field(iter([cell(0), cell(1)]), target, 2, b)
        context = triangle.Arithmetic(120, b).ctx
        for actual, single in zip(result['h_xyz_apm'], one['h_xyz_apm']):
            self.assertLess(abs(context.mpf(actual) - 2 * context.mpf(single)), context.mpf('1e-100'))
        self.assertEqual(result['cells_completed'], 2)
        self.assertEqual(b.counts['pairs'], 36)
        self.assertEqual(result['qualification'], 'NOT VERIFIED')
        self.assertFalse(result['qualified_basis'])
        self.assertIsNone(result['native_comparison'])

    def test_signed_superposition_cancels_without_absolute_value_fit(self):
        b = budget()
        result = gsg.evaluate_retained_field([cell(0), cell(1, -1.)], gsg.TARGETS_M[0], 2, b)
        self.assertEqual([float(v) for v in result['h_xyz_apm']], [0., 0., 0.])
        self.assertGreater(float(result['sum_local_norm_apm']), 0.)
        self.assertEqual(b.counts['pairs'], 24)

    def test_partial_or_extra_source_never_returns_a_complete_field(self):
        for rows, count in [([], 1), ([cell(0)], 2), ([cell(0), cell(1)], 1)]:
            b = budget()
            with self.subTest(count=count, actual=len(rows)), self.assertRaisesRegex(triangle.Refusal, 'cell count'):
                gsg.evaluate_retained_field(rows, gsg.TARGETS_M[0], count, b)
            self.assertLessEqual(b.counts['pairs'], 12)

    def test_reordered_or_nonfinite_cell_is_refused_before_work(self):
        invalid = list(cell(0)); invalid[17] = math.nan
        for row in [cell(1), tuple(invalid), cell(0)[:-1]]:
            b = budget()
            with self.assertRaises(triangle.Refusal):
                gsg.evaluate_retained_field([row], gsg.TARGETS_M[0], 1, b)
            self.assertEqual(b.counts['pairs'], 0)

    def test_global_precision_budget_cannot_hide_local_error_sum(self):
        original = rt0.evaluate_retained_rt0
        def perturbed(*args, **kwargs):
            value = original(*args, **kwargs)
            value['local_precision_error_apm'] = '0.0000007'
            return value
        b = budget()
        with patch.object(rt0, 'evaluate_retained_rt0', side_effect=perturbed):
            with self.assertRaisesRegex(triangle.Refusal, 'global precision'):
                gsg.evaluate_retained_field([cell(0), cell(1)], gsg.TARGETS_M[0], 2, b)
        self.assertEqual(b.counts['pairs'], 24)

    def test_global_formula_error_sum_is_also_guarded(self):
        original = rt0.evaluate_retained_rt0
        def perturbed(*args, **kwargs):
            value = original(*args, **kwargs)
            value['local_formula_error_apm'] = '0.0000007'
            return value
        with patch.object(rt0, 'evaluate_retained_rt0', side_effect=perturbed):
            with self.assertRaisesRegex(triangle.Refusal, 'whole-face/fan'):
                gsg.evaluate_retained_field([cell(0), cell(1)], gsg.TARGETS_M[0], 2, budget())

    def test_global_cancellation_is_guarded_after_signed_sum(self):
        rows = [list(cell(0)), list(cell(1, -1.))]
        for row in rows:
            for i in list(range(17, 29)) + list(range(32, 35)):
                row[i] *= 1e45
        with self.assertRaisesRegex(triangle.Refusal, 'global highprecision cancellation'):
            gsg.evaluate_retained_field(rows, gsg.TARGETS_M[0], 2, budget())

    def test_invalid_native_input_and_count_refuse_before_kernel_work(self):
        b = budget()
        for count in [0, True, 72912]:
            with self.assertRaisesRegex(triangle.Refusal, 'cell count'):
                gsg.evaluate_retained_field([cell(0)], gsg.TARGETS_M[0], count, b)
        with self.assertRaisesRegex(triangle.Refusal, 'finite vector3'):
            gsg.evaluate_retained_field([cell(0)], gsg.TARGETS_M[0], 1, b, native_h_apm=(math.inf, 0., 0.))
        self.assertEqual(b.counts['pairs'], 0)

    def test_many_cells_emit_bounded_progress_without_resetting_budget(self):
        b = budget(); sample = rt0.evaluate_retained_rt0(VERTICES, CURRENT, gsg.TARGETS_M[0], budget())
        def counted_reference(vertices, current, target, shared):
            shared.activate(struct.pack('<3d', *target).hex())
            for _ in range(4):
                for precision in triangle.PRECISIONS:
                    shared.charge('pairs', precision)
            return sample
        events = []
        with patch.object(rt0, 'evaluate_retained_rt0', side_effect=counted_reference):
            value = gsg.evaluate_retained_field((cell(i) for i in range(257)), gsg.TARGETS_M[0], 257, b,
                                                progress=lambda done, total: events.append((done, total)))
        self.assertEqual(value['cells_completed'], 257)
        self.assertEqual(events, [(256, 257), (257, 257)])
        self.assertEqual(b.counts['pairs'], 257 * 12)

    def test_same_budget_is_preserved_between_targets_and_progress_is_bounded(self):
        b = budget(); started = b.started; progress = []
        for target in gsg.TARGETS_M[:2]:
            gsg.evaluate_retained_field([cell(0)], target, 1, b,
                                       progress=lambda complete, total: progress.append((complete, total)))
        self.assertEqual(b.counts['pairs'], 24)
        self.assertEqual(b.started, started)
        self.assertEqual(len(b.by_target), 2)
        self.assertEqual(progress, [(1, 1), (1, 1)])

    def test_native_comparison_uses_separate_preregistered_gate(self):
        target = gsg.TARGETS_M[0]
        one = rt0.evaluate_retained_rt0(VERTICES, CURRENT, target, budget())
        high = [float(v) for v in one['h_xyz_apm']]
        for offset, expected in [(5e-4, True), (2e-3, False)]:
            native = [high[0] + offset, high[1], high[2]]
            result = gsg.evaluate_retained_field([cell(0)], target, 1, budget(), native_h_apm=native)
            self.assertEqual(result['native_comparison']['within_gate'], expected)
            self.assertEqual(result['qualification'], 'NOT VERIFIED')


if __name__ == '__main__':
    unittest.main()
