"""Interpreted budget regressions; never a native GSG solve or qualification."""
from fractions import Fraction
import json
import struct
import unittest
from unittest.mock import patch

import antenna_triangle_surface_oracle as triangle
from antenna_gsg_convergence_reference import (
    GsgSourceConvergenceBudget, PROFILE_ID, PROFILE_LIMITS, SOURCE_IR_SHA256S, TARGETS_M,
)


class GsgConvergenceBudgetTests(unittest.TestCase):
    def test_corner12p5_cell_limit_profile_is_closed_and_preserves_completeness(self):
        from antenna_gsg_convergence_reference import evaluate_retained_field
        from antenna_gsg_current_correction import SOURCE_CELL_LIMITS as correction_limits
        from antenna_gsg_convergence_reference import SOURCE_CELL_LIMITS as reference_limits
        self.assertEqual(dict(correction_limits), dict(reference_limits))
        fine = "gsg_junction_refinement_80k.v1"
        for profile, count in (("legacy72911", 72912), (fine, 80001), ("unknown", 1), (None, 1)):
            with self.subTest(profile=profile, count=count):
                with self.assertRaisesRegex(triangle.Refusal, "profile|cell count"):
                    evaluate_retained_field([], TARGETS_M[0], count, self.active(),
                                            cell_limit_profile=profile)
        for profile, count in (("legacy72911", 72911), (fine, 80000)):
            # No cell reaches arithmetic: isolate admission from the optional
            # high-precision dependency while exercising the real count guard.
            with patch.object(triangle, "Arithmetic") as arithmetic:
                with self.assertRaisesRegex(triangle.Refusal, "incomplete"):
                    evaluate_retained_field([], TARGETS_M[0], count, self.active(),
                                            cell_limit_profile=profile)
                arithmetic.assert_called_once()
        with self.assertRaisesRegex(triangle.Refusal, "cell count"):
            evaluate_retained_field([], TARGETS_M[0], 72912, self.active())

    def active(self):
        budget = GsgSourceConvergenceBudget()
        budget.activate_source(SOURCE_IR_SHA256S[0])
        budget.activate(struct.pack('<3d', *TARGETS_M[0]).hex())
        return budget

    def test_profile_is_exact_immutable_and_default_limits_stay_unchanged(self):
        default = dict(triangle.LIMITS)
        expected = dict(default, pairs_target=1000000, transc_target=25000000,
                        predicates_target=4000000, seconds_target=10800, seconds_case=43200)
        self.assertEqual(dict(PROFILE_LIMITS), expected)
        with self.assertRaises(TypeError):
            PROFILE_LIMITS['ram_bytes'] = 999
        budget = self.active()
        self.assertEqual(budget.report()['profile_id'], PROFILE_ID)
        self.assertEqual(budget.report()['limits'], expected)
        self.assertEqual(triangle.Budget().report()['limits'], default)
        self.assertEqual(triangle.LIMITS, default)
        self.assertNotIn('profile_id', triangle.Budget().report())
        self.assertEqual(triangle.PRECISIONS, ('binary64', 80, 120))

    def test_unknown_source_target_and_unactivated_work_are_refused(self):
        budget = GsgSourceConvergenceBudget()
        with self.assertRaisesRegex(triangle.Refusal, 'source'):
            budget.activate_source('0' * 64)
        with self.assertRaisesRegex(triangle.Refusal, 'source'):
            budget.activate(struct.pack('<3d', *TARGETS_M[0]).hex())
        budget.activate_source(SOURCE_IR_SHA256S[0])
        for target in ['reference:anything', struct.pack('<3d', 0., 0., 0.).hex()]:
            with self.assertRaisesRegex(triangle.Refusal, 'target'):
                budget.activate(target)
        with self.assertRaisesRegex(triangle.Refusal, 'activate'):
            budget.charge('pairs')
        self.assertEqual(dict(budget.counts), {})

    def test_same_xyz_on_three_sources_preserves_global_count_and_clock(self):
        budget = self.active()
        started = budget.started
        for source in SOURCE_IR_SHA256S:
            budget.activate_source(source)
            budget.activate(struct.pack('<3d', *TARGETS_M[0]).hex())
            budget.charge('pairs', 80)
        self.assertEqual(budget.counts['pairs'], 3)
        self.assertEqual(len(budget.by_target), 3)
        self.assertEqual([v['pairs'] for v in budget.by_target.values()], [1, 1, 1])
        self.assertEqual(budget.started, started)
        self.assertEqual(budget.precision['80']['pairs'], 3)

    def test_reactivation_never_resets_local_counts_or_time(self):
        budget = self.active()
        key = budget.target
        start = budget.target_started[key]
        budget.charge('pairs')
        budget.activate(struct.pack('<3d', *TARGETS_M[0]).hex())
        self.assertEqual(budget.target, key)
        self.assertEqual(budget.target_started[key], start)
        self.assertEqual(budget.by_target[key]['pairs'], 1)

    def test_local_refusal_records_attempt_and_remains_serializable(self):
        for kind, limit in [('pairs', 1000000), ('log1p', 25000000),
                            ('exact_predicates', 4000000)]:
            with self.subTest(kind=kind):
                budget = self.active()
                budget.by_target[budget.target][kind] = limit
                budget.counts[kind] = limit
                with self.assertRaises(triangle.Refusal):
                    budget.charge(kind, 120)
                self.assertEqual(budget.counts[kind], limit + 1)
                self.assertEqual(budget.by_target[budget.target][kind], limit + 1)
                self.assertIn('terminal_snapshot_rechecks_admission', json.loads(json.dumps(budget.report())))
        default = triangle.Budget()
        default.activate('default')
        default.by_target['default']['pairs'] = 100000
        with self.assertRaisesRegex(triangle.Refusal, 'pair limit'):
            default.charge('pairs')

    def test_global_refusal_survives_source_switch(self):
        for kind, limit in [('pairs', 5000000), ('sqrt', 100000000),
                            ('exact_predicates', 20000000)]:
            with self.subTest(kind=kind):
                budget = self.active()
                budget.counts[kind] = limit
                budget.activate_source(SOURCE_IR_SHA256S[1])
                budget.activate(struct.pack('<3d', *TARGETS_M[1]).hex())
                with self.assertRaises(triangle.Refusal):
                    budget.charge(kind)
                self.assertEqual(budget.counts[kind], limit + 1)

    def test_time_and_actual_process_ram_limits_still_refuse(self):
        budget = self.active()
        for reason, now in [('case wall-time', budget.started + 43201),
                            ('target wall-time', budget.target_started[budget.target] + 10801)]:
            with self.subTest(reason=reason), patch.object(triangle.time, 'monotonic', return_value=now):
                with self.assertRaisesRegex(triangle.Refusal, reason):
                    budget.guard()
                json.dumps(budget.report())
        with patch.object(triangle, 'peak_ram_bytes', return_value=2147483649):
            with self.assertRaisesRegex(triangle.Refusal, 'actual peak RAM'):
                budget.guard()
        self.assertEqual(budget.report()['peak_ram_bytes'], 2147483649)

    def test_exact_rational_limit_is_unchanged(self):
        budget = self.active()
        with self.assertRaisesRegex(triangle.Refusal, 'bit-length'):
            budget.watch([Fraction(1, 2 ** 8193)])
        self.assertGreater(budget.report()['max_fraction_bits'], 8192)

    def test_existing_rt0_reference_uses_one_namespaced_budget(self):
        from antenna_rt0_surface_oracle import evaluate_retained_rt0
        vertices = ((0., 0., 1e-6), (1e-6, 0., 1e-6),
                    (0., 1e-6, 1e-6), (0., 0., 2e-6))
        budget = GsgSourceConvergenceBudget()
        budget.activate_source(SOURCE_IR_SHA256S[0])
        result = evaluate_retained_rt0(vertices, ((3., -2., 5.),) * 4, TARGETS_M[0], budget)
        self.assertEqual(result['qualification'], 'NOT VERIFIED')
        self.assertEqual([p['precision'] for p in result['passes']], ['binary64', 80, 120])
        self.assertEqual(budget.counts['pairs'], 12)
        self.assertEqual(len(budget.by_target), 1)
        self.assertTrue(budget.target.startswith(SOURCE_IR_SHA256S[0] + ':'))


if __name__ == '__main__':
    unittest.main()


class GsgJunctionFineBudgetTests(unittest.TestCase):
    def test_86k_work_profile_changes_only_target_pair_budget(self):
        from antenna_gsg_convergence_reference import GsgJunctionFineBudget
        profile = "gsg_junction_fine_reference_86k_v1"
        budget = GsgJunctionFineBudget("a"*64,work_profile=profile)
        self.assertEqual(dict(budget.limits),dict(PROFILE_LIMITS,pairs_target=1032000))
        self.assertEqual(budget.report()["profile_id"],profile)
        self.assertEqual(budget.report()["cell_limit_profile"],"gsg_junction_refinement_86k.v1")
        self.assertEqual(dict(GsgJunctionFineBudget("a"*64).limits),dict(PROFILE_LIMITS))
        with self.assertRaises(TypeError):
            budget.limits["pairs_target"]=1
        for invalid in ("unknown",None,True):
            with self.subTest(invalid=invalid),self.assertRaises(triangle.Refusal):
                GsgJunctionFineBudget("a"*64,work_profile=invalid)

    def test_86k_profile_preserves_three_target_lifetime_and_local_refusal(self):
        from antenna_gsg_convergence_reference import GsgJunctionFineBudget
        budget=GsgJunctionFineBudget("a"*64,work_profile="gsg_junction_fine_reference_86k_v1")
        started=budget.started
        for target in TARGETS_M:
            budget.activate(struct.pack("<3d",*target).hex())
            budget.charge("pairs")
        self.assertEqual(budget.counts["pairs"],3)
        self.assertEqual(budget.started,started)
        self.assertEqual(len(budget.by_target),3)
        budget.by_target[budget.target]["pairs"]=1032000
        with self.assertRaisesRegex(triangle.Refusal,"pair limit"):
            budget.charge("pairs")
        self.assertEqual(budget.by_target[budget.target]["pairs"],1032001)

    def test_86k_cell_profile_keeps_complete_source_and_old_limits(self):
        from antenna_gsg_current_correction import (
            SOURCE_CELL_LIMITS as a,weighted_rt0_h1_correction,
            partitioned_weighted_rt0_h1_correction)
        from antenna_gsg_convergence_reference import SOURCE_CELL_LIMITS as b,evaluate_retained_field,GsgJunctionFineBudget
        fine="gsg_junction_refinement_86k.v1"
        self.assertEqual(dict(a),dict(b))
        self.assertEqual(a[fine],86000)
        from test_antenna_gsg_current_correction import sample
        row,potential=sample(correction=(.1,0.,0.))
        self.assertAlmostEqual(weighted_rt0_h1_correction([row],potential,[2.],1,cell_limit_profile=fine)["eta"],.05)
        self.assertAlmostEqual(partitioned_weighted_rt0_h1_correction(
            [row],potential,[2.],1,{"all":[0]},cell_limit_profile=fine)["eta"],.05)
        for profile,count in ((fine,86001),(fine,True),(fine,86000.),("legacy72911",72912),
                              ("gsg_junction_refinement_80k.v1",80001),("unknown",1)):
            with self.subTest(profile=profile,count=count):
                with self.assertRaisesRegex(ValueError,"profile|cell count"):
                    weighted_rt0_h1_correction([],potential,[],count,cell_limit_profile=profile)
                with self.assertRaisesRegex(ValueError,"profile|cell count"):
                    partitioned_weighted_rt0_h1_correction([],potential,[],count,{"all":[]},cell_limit_profile=profile)
                with self.assertRaisesRegex(triangle.Refusal,"profile|cell count"):
                    evaluate_retained_field([],TARGETS_M[0],count,
                        GsgSourceConvergenceBudget(),cell_limit_profile=profile)
        with self.assertRaisesRegex(ValueError,"incomplete"):
            weighted_rt0_h1_correction([],potential,[],86000,cell_limit_profile=fine)
        with self.assertRaisesRegex(ValueError,"source cell or conductivity count differs"):
            partitioned_weighted_rt0_h1_correction([],potential,[],86000,{"all":[]},cell_limit_profile=fine)
        with patch.object(triangle,"Arithmetic"):
            with self.assertRaisesRegex(triangle.Refusal,"incomplete"):
                evaluate_retained_field([],TARGETS_M[0],86000,GsgJunctionFineBudget(
                    "a"*64,work_profile="gsg_junction_fine_reference_86k_v1"),cell_limit_profile=fine)

    def test_one_source_three_exact_targets_keep_the_existing_limits(self):
        from antenna_gsg_convergence_reference import GsgJunctionFineBudget
        old = dict(PROFILE_LIMITS)
        budget = GsgJunctionFineBudget("a"*64)
        self.assertEqual(dict(budget.limits), old)
        with self.assertRaises(TypeError):
            budget.limits["ram_bytes"] = 1
        for target in TARGETS_M:
            budget.activate(struct.pack("<3d", *target).hex())
            budget.charge("pairs", 120)
        self.assertEqual(budget.counts["pairs"], 3)
        self.assertEqual(len(budget.by_target), 3)
        self.assertEqual(budget.report()["source_ir_sha256"], "a"*64)
        self.assertEqual(dict(PROFILE_LIMITS), old)

    def test_foreign_source_target_and_invalid_digest_are_refused(self):
        from antenna_gsg_convergence_reference import GsgJunctionFineBudget
        for digest in ("a"*63, "A"*64, "../source", None, True):
            with self.assertRaises(triangle.Refusal):
                GsgJunctionFineBudget(digest)
        budget = GsgJunctionFineBudget("a"*64)
        with self.assertRaisesRegex(triangle.Refusal, "source"):
            budget.activate_source("b"*64)
        with self.assertRaisesRegex(triangle.Refusal, "target"):
            budget.activate(struct.pack("<3d", 0., 0., 0.).hex())
        with self.assertRaisesRegex(triangle.Refusal, "activate"):
            budget.charge("pairs")
        self.assertEqual(dict(budget.counts), {})

    def test_switching_targets_never_resets_counts_or_the_case_clock(self):
        from antenna_gsg_convergence_reference import GsgJunctionFineBudget
        budget = GsgJunctionFineBudget("a"*64)
        start = budget.started
        key = struct.pack("<3d", *TARGETS_M[0]).hex()
        budget.activate(key);budget.charge("pairs")
        budget.activate_source("a"*64)
        budget.activate(struct.pack("<3d", *TARGETS_M[1]).hex())
        budget.charge("pairs");budget.activate(key)
        self.assertEqual(budget.started, start)
        self.assertEqual(budget.counts["pairs"],2)
        self.assertEqual(budget.by_target["a"*64+":"+key]["pairs"],1)
        budget.counts["pairs"] = PROFILE_LIMITS["pairs_case"]
        with self.assertRaisesRegex(triangle.Refusal, "pair limit"):
            budget.charge("pairs")
