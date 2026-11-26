"""Preregistered numerical criteria, never evidence of a native GSG solve."""
from copy import deepcopy
import math
import unittest


def positions():
    return [[x, y, z] for x in [-2e-6, -450e-9, 0., 450e-9, 2e-6]
            for y in [-50e-9, 50e-9] for z in [-22.4e-9, -5e-9]]


def evaluate(currents=(1e-5, 1e-5, 1e-5), amplitudes=(1.002, 1.0003, 1.),
             etas=(.02, .01, .004), xyz=None):
    from compare_gsg_source_convergence import compare_source_convergence
    fields = [[[v, 0., 0.] for _ in range(20)] for v in amplitudes]
    return compare_source_convergence(currents, fields, positions() if xyz is None else xyz, etas=etas)


class GsgSourceConvergenceTests(unittest.TestCase):
    def test_converging_fixed_carrier_passes_only_numerical_criteria(self):
        result = evaluate()
        self.assertEqual(result['status'], 'NUMERICAL CRITERIA PASS / NOT QUALIFIED')
        self.assertTrue(result['numerical_criteria_pass'])
        self.assertEqual(len(result['targets']), 20)
        self.assertEqual(result['qualification'], 'NOT VERIFIED')
        self.assertFalse(result['qualified_basis'])
        self.assertAlmostEqual(result['targets'][0]['H']['fine_medium_difference'], .0003)

    def test_no_improvement_above_absolute_floor_fails_even_inside_tolerance(self):
        result = evaluate(amplitudes=(1.001, 1.0009, 1.))
        self.assertTrue(result['targets'][0]['H']['within_tolerance'])
        self.assertFalse(result['targets'][0]['H']['contraction_pass'])
        self.assertFalse(result['numerical_criteria_pass'])

    def test_noise_below_absolute_floor_does_not_require_contraction(self):
        result = evaluate(amplitudes=(1.0004, 1.0003, 1.))
        self.assertTrue(result['numerical_criteria_pass'])
        self.assertTrue(result['targets'][0]['H']['both_below_floor'])

    def test_equal_raw_field_cannot_hide_wrong_per_ampere_field(self):
        result = evaluate(currents=(1.02e-5, 1.009e-5, 1e-5), amplitudes=(1000., 1000., 1000.))
        self.assertTrue(result['current']['within_tolerance'])
        self.assertTrue(result['targets'][0]['H']['within_tolerance'])
        self.assertFalse(result['targets'][0]['H_per_A']['within_tolerance'])
        self.assertFalse(result['numerical_criteria_pass'])

    def test_current_sign_is_never_fitted_to_match_field(self):
        result = evaluate(currents=(1e-5, 1e-5, -1e-5))
        self.assertFalse(result['current']['within_tolerance'])
        self.assertLess(result['currents_A'][-1], 0.)
        self.assertFalse(result['targets'][0]['H_per_A']['within_tolerance'])

    def test_missing_estimator_is_not_zero_or_pass(self):
        result = evaluate(etas=None)
        self.assertEqual(result['status'], 'NOT VERIFIED / MISSING CURRENT ESTIMATOR')
        self.assertIsNone(result['eta']['pass'])
        self.assertIsNone(result['numerical_criteria_pass'])
        self.assertTrue(result['field_and_current_criteria_pass'])

    def test_partial_estimator_is_reported_as_missing(self):
        result = evaluate(etas=(.02, None, .004))
        self.assertEqual(result['eta']['values'], [.02, None, .004])
        self.assertIsNone(result['eta']['pass'])
        self.assertIsNone(result['numerical_criteria_pass'])

    def test_eta_requires_both_contractions_and_fine_threshold(self):
        for values in [(.02, .01, .009), (.011, .01, .004), (.2, .1, .06)]:
            with self.subTest(values=values):
                result = evaluate(etas=values)
                self.assertFalse(result['eta']['pass'])
                self.assertFalse(result['numerical_criteria_pass'])
        self.assertTrue(evaluate(etas=(1e-7, 1e-6, 5e-7))['eta']['pass'])

    def test_reordered_or_modified_carrier_is_refused(self):
        for changed in [list(reversed(positions())), positions()[:-1]]:
            with self.assertRaisesRegex(ValueError, 'carrier'):
                evaluate(xyz=changed)
        changed = positions(); changed[0][0] = math.nextafter(changed[0][0], math.inf)
        with self.assertRaisesRegex(ValueError, 'carrier'):
            evaluate(xyz=changed)

    def test_invalid_current_estimator_or_derived_ratio_is_refused(self):
        for currents in [(0., 1e-5, 1e-5), (math.inf, 1e-5, 1e-5),
                         (True, 1e-5, 1e-5), (1e-5, 1e-5)]:
            with self.subTest(currents=currents), self.assertRaises(ValueError):
                evaluate(currents=currents)
        for values in [(.02, -.01, .004), (.02, math.nan, .004), (.02, .01), (True, .01, .004)]:
            with self.subTest(etas=values), self.assertRaises(ValueError):
                evaluate(etas=values)
        with self.assertRaisesRegex(ValueError, 'H/I'):
            evaluate(currents=(5e-324,) * 3, amplitudes=(1e308,) * 3)

    def test_full_vector_difference_detects_component_errors(self):
        from compare_gsg_source_convergence import compare_source_convergence
        fields = [[[1., 0., 0.] for _ in range(20)] for _ in range(3)]
        fields[1][7] = [1., .002, 0.]
        result = compare_source_convergence((1e-5,) * 3, fields, positions(), etas=(.02, .01, .004))
        self.assertFalse(result['targets'][7]['H']['within_tolerance'])
        self.assertTrue(result['targets'][0]['H']['within_tolerance'])

    def test_nonfinite_or_incomplete_field_is_refused(self):
        from compare_gsg_source_convergence import compare_source_convergence
        original = [[[1., 0., 0.] for _ in range(20)] for _ in range(3)]
        bad = deepcopy(original); bad[0][0][0] = math.nan
        short = deepcopy(original); short[0].pop()
        vector = deepcopy(original); vector[1][3].pop()
        for fields in [bad, short, vector, original[:2]]:
            with self.assertRaises(ValueError):
                compare_source_convergence((1e-5,) * 3, fields, positions())


class GsgJunctionConvergenceTests(unittest.TestCase):
    """Local-family metadata and fixed criteria; all fine values are fixtures."""

    def local(self, etas=(.03464604656814306, .02424061426967989, .018)):
        from compare_gsg_source_convergence import compare_junction_source_convergence
        fields = [[[v, 0., 0.] for _ in range(20)] for v in (1.002, 1.0003, 1.)]
        return compare_junction_source_convergence((1.75e-5,) * 3, fields, positions(), etas=etas)

    def test_local_series_has_its_own_identity_and_keeps_global_default(self):
        from pathlib import Path
        import hashlib
        result = self.local()
        plan = Path(__file__).resolve().parents[1] / "docs/superpowers/plans/2026-11-12-gsg-corner12p5-source-qualification-proposal.md"
        self.assertEqual(result["proposal_sha256"], hashlib.sha256(plan.read_bytes()).hexdigest())
        self.assertEqual(result["levels_nm"], [50, 25, 12.5])
        self.assertEqual(result["refinement_family"], "local_junction50_corner25_corner12p5")
        self.assertEqual(result["numerical_criteria_pass"], True)
        self.assertEqual(result["qualification"], "NOT VERIFIED")
        self.assertFalse(result["qualified_basis"])
        old = evaluate()
        from antenna_gsg_convergence_reference import PROPOSAL_SHA256
        self.assertEqual(old["proposal_sha256"], PROPOSAL_SHA256)
        self.assertEqual(old["levels_nm"], [100, 75, 50])
        self.assertNotIn("refinement_family", old)

    def test_lower_eta_without_required_contraction_still_fails(self):
        result = self.local(etas=(.03464604656814306, .02424061426967989, .020))
        self.assertTrue(result["field_and_current_criteria_pass"])
        self.assertFalse(result["eta"]["pass"])
        self.assertFalse(result["numerical_criteria_pass"])
        self.assertEqual(result["status"], "NUMERICAL CRITERIA FAIL / NOT QUALIFIED")

    def test_local_missing_estimator_and_foreign_carrier_are_not_accepted(self):
        from compare_gsg_source_convergence import compare_junction_source_convergence
        result = self.local(etas=None)
        self.assertIsNone(result["numerical_criteria_pass"])
        self.assertEqual(result["qualification"], "NOT VERIFIED")
        fields = [[[1., 0., 0.] for _ in range(20)] for _ in range(3)]
        changed = positions()
        changed[0][0] = math.nextafter(changed[0][0], math.inf)
        with self.assertRaisesRegex(ValueError, "carrier"):
            compare_junction_source_convergence((1.75e-5,) * 3, fields, changed, etas=(.03, .02, .01))


if __name__ == '__main__':
    unittest.main()
