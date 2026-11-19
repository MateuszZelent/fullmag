"""Interpreted scalar geometry/math regressions, never native antenna qualification."""
from fractions import Fraction
import math
import gc
import weakref
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import mpmath

from antenna_triangle_surface_oracle import (
    Arithmetic, Budget, Refusal, dependency_provenance, evaluate_triangle, mathematical_corpus,
    positive_reference_panels, prepare_geometry, reference_pass, main, ReferenceExactArithmetic, reference_test_identity, reference_scale, reference_triangle, reference_radial_value,
)

TRIANGLE=((0.,0.,0.),(1.,0.,0.),(0.,1.,0.))


class TriangleSurfaceTests(unittest.TestCase):
    def setUp(self):
        self.ctx=mpmath.mp.clone();self.ctx.dps=120

    def close(self,a,b):
        a=self.ctx.mpf(a);b=self.ctx.mpf(b)
        self.assertLessEqual(abs(a-b),self.ctx.mpf('1e-55')*(1+abs(b)))

    def test_main_persists_terminal_time_and_ram_refusal(self):
        # Test output stays in the explicitly configured task verification root.
        temp_root=Path(os.environ["FULLMAG_TEST_TEMP_ROOT"]).resolve(strict=True)
        for reason in ("case wall-time exhausted","actual peak RAM exhausted"):
            with self.subTest(reason=reason),tempfile.TemporaryDirectory(dir=temp_root) as directory:
                output=Path(directory)/"e2"/"triangle-analytic-v2"/"receipt"
                argv=["oracle","--repo-root",str(Path(__file__).parents[1]),"--output-dir",str(output)]
                with patch("sys.argv",argv),patch("fullmag_storage.resolve_layout",return_value={"runs_root":directory}),patch.object(Budget,"guard",side_effect=Refusal(reason)),contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(main(),2)
                evidence=json.loads((output/"math-evidence.json").read_text())
                self.assertEqual(evidence["terminal_status"],"REFUSED / NOT VERIFIED")
                self.assertEqual(evidence["records"][0]["reason"],reason)
                self.assertEqual(len(evidence["unexecuted_corpus_ids"]),53)
                self.assertFalse(evidence["full_preregistered_math_scope_pass"])
                self.assertFalse(evidence["budget"]["terminal_snapshot_rechecks_admission"])
                self.assertIn("counts",evidence["budget"])
                self.assertGreaterEqual(evidence["budget"]["elapsed_seconds"],0)
                self.assertIn("peak_ram_bytes",evidence["budget"])

    def test_literal_partition_actual_comparisons_are_separate(self):
        for target,expected in (((0,0,0),14),((.25,.25,0),16),((2,2,0),11)):
            with self.subTest(target=target):
                budget=Budget();positive_reference_panels(TRIANGLE,target,budget)
                comparisons=sum(v for k,v in budget.counts.items() if k.startswith("reference_comparison_"))
                self.assertEqual(comparisons,expected)
                self.assertEqual(budget.counts["exact_predicates"],0)
                self.assertEqual(budget.counts["reference_comparison_division_nonzero"],3)
                self.assertLessEqual(budget.reference_raw_max_bits,8192)

    def test_raw_intermediate_limit_precedes_cancellation(self):
        budget=Budget();exact=ReferenceExactArithmetic(budget)
        value=Fraction(1,2**5000)
        self.assertEqual(value-value,0)
        with self.assertRaisesRegex(Refusal,"raw intermediate bit-length"):
            exact.binary("sub",value,value)
        self.assertEqual(budget.reference_raw_max_bits,10001)
        self.assertEqual(budget.counts["reference_fraction_sub"],1)

    def test_main_writes_reference_comparison_and_intermediate_refusals(self):
        temp_root=Path(os.environ["FULLMAG_TEST_TEMP_ROOT"]).resolve(strict=True)
        for intermediate in (False,True):
            with self.subTest(intermediate=intermediate),tempfile.TemporaryDirectory(dir=temp_root) as directory:
                output=Path(directory)/"e2"/"triangle-analytic-v2"/"receipt"
                argv=["oracle","--repo-root",str(Path(__file__).parents[1]),"--output-dir",str(output),"--reference","--first-case-only"]
                def overlimit(vertices,target,budget):
                    exact=ReferenceExactArithmetic(budget)
                    exact.binary("sub",Fraction(1,2**5000),Fraction(1,2**5000))
                def exhausted(vertices,target,budget):
                    budget.by_target[budget.target]["reference_comparisons"]=174
                    ReferenceExactArithmetic(budget).compare(1,2,"gt","injected_limit")
                patched=patch("antenna_triangle_surface_oracle.positive_reference_panels",side_effect=overlimit if intermediate else exhausted)
                with patch("sys.argv",argv),patch("fullmag_storage.resolve_layout",return_value={"runs_root":directory}),patched,contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(main(),2)
                evidence=json.loads((output/"math-evidence.json").read_text())
                reason=evidence["records"][0]["reason"]
                self.assertIn("raw intermediate" if intermediate else "target reference comparison limit",reason)
                self.assertFalse(evidence["full_preregistered_math_scope_pass"])
                self.assertEqual(evidence["budget"]["counts"].get("reference_evals",0),0)
                if intermediate: self.assertEqual(evidence["budget"]["reference_raw_max_bits"],10001)

    def test_reference_comparison_guards_before_175_and_9397(self):
        for corpus in (False,True):
            with self.subTest(corpus=corpus):
                budget=Budget();budget.activate("reference:guard")
                if corpus: budget.counts["reference_comparisons"]=9396
                else: budget.by_target[budget.target]["reference_comparisons"]=174
                with self.assertRaisesRegex(Refusal,"case" if corpus else "target"):
                    ReferenceExactArithmetic(budget).compare(1,2,"gt","guard_probe")
                self.assertEqual(budget.counts["reference_comparison_guard_probe"],1)
                self.assertEqual(budget.counts["reference_integer_mul"],0)
                self.assertEqual(budget.counts["reference_comparisons"],9397 if corpus else 1)
                self.assertEqual(budget.by_target[budget.target]["reference_comparisons"],1 if corpus else 175)

    def test_reference_pair_identity_separates_same_xyz_and_accumulates_retries(self):
        point=(0.,0.,0.);other=((0.,0.,0.),(2.,0.,0.),(0.,1.,0.))
        first=reference_test_identity(TRIANGLE,point);second=reference_test_identity(other,point)
        self.assertNotEqual(first,second)
        self.assertNotEqual(first,reference_test_identity(tuple(reversed(TRIANGLE)),point))
        self.assertNotEqual(first,reference_test_identity(TRIANGLE,(-0.,0.,0.)))
        budget=Budget();budget.activate(first);budget.by_target[first]["reference_evals"]=10000000
        budget.activate(second);budget.charge("reference_evals",160)
        self.assertEqual(budget.by_target[second]["reference_evals"],1)
        budget.activate(first)
        with self.assertRaisesRegex(Refusal,"target reference evaluation"):
            budget.charge("reference_evals",200)
        self.assertEqual(budget.by_target[first]["reference_evals"],10000001)
        self.assertEqual(budget.counts["reference_evals"],2)

    def test_reference_scale_is_exact_original_max_with_nine_abs_eight_comparisons(self):
        for case in mathematical_corpus():
            with self.subTest(case=case["id"]):
                v=[tuple(Fraction.from_float(x) for x in p) for p in case["vertices"]]
                r=tuple(Fraction.from_float(x) for x in case["target"])
                expected=max(abs(x-y) for p in v for x,y in zip(p,r))
                budget=Budget();actual=reference_scale(case["vertices"],case["target"],budget)
                self.assertEqual(actual,expected)
                self.assertEqual(budget.counts["reference_fraction_sub"],9)
                self.assertEqual(budget.counts["reference_integer_abs"],9)
                self.assertEqual(budget.counts["reference_comparison_gate_scale_max"],8)

    def test_literal_reference_geometry_schedule_is_174_without_quadrature(self):
        point=(.25,.25,0.);budget=Budget()
        def geometry_only(vertices,target,digits,degree,current):
            panels,r,_=positive_reference_panels(vertices,target,current)
            exact=ReferenceExactArithmetic(current)
            for panel in panels:
                self.assertTrue(all(exact.compare(x,y,"eq","vertex_identity") for x,y in zip(r,panel[0])))
            return {"digits":digits,"maxdegree":degree,"panels_m":["1","1","1"],"value_m":"3"}
        with patch("antenna_triangle_surface_oracle.reference_pass",side_effect=geometry_only):
            reference_triangle(TRIANGLE,point,budget)
        self.assertEqual(budget.counts["reference_comparisons"],174)
        self.assertEqual(budget.counts["reference_evals"],0)
        self.assertEqual(budget.counts["reference_comparison_vertex_identity"],54)
        self.assertEqual(budget.counts["reference_comparison_gate_scale_max"],8)

    def test_dependency_pin_precedes_math(self):
        self.assertEqual(dependency_provenance()["wheel_sha256"], "a0b2b9fe80bbcd81a6647ff13108738cfb482d481d826cc0e02f5b35e5c88d2c")
        with patch("antenna_triangle_surface_oracle.Path.read_bytes",return_value=b"altered"):
            with self.assertRaisesRegex(Refusal,"pin mismatch"): dependency_provenance()

    def test_known_corner_and_exact_branches_before_transcendentals(self):
        budget=Budget();result=evaluate_triangle(TRIANGLE,(0.,0.,0.),budget)
        expected=self.ctx.sqrt(2)*self.ctx.log(1+self.ctx.sqrt(2))
        self.close(result['value_m'],expected)
        for entry in result['passes']:
            self.assertTrue(entry['h_zero'])
            self.assertEqual(entry['d_zero'],[True,False,True])
            self.assertIsNone(entry['omega'])
        self.assertEqual(budget.counts['atan2'],0)
        self.assertEqual(budget.counts['log1p'],3)
        self.assertEqual(budget.counts['pairs'],3)
        self.assertEqual(budget.counts['exact_predicates'],8)

    def test_winding_cyclic_orientation_and_h_sign(self):
        target=(.25,.25,.5)
        baseline=evaluate_triangle(TRIANGLE,target)
        for vertices in (TRIANGLE[1:]+TRIANGLE[:1],tuple(reversed(TRIANGLE))):
            result=evaluate_triangle(vertices,target)
            self.close(result['value_m'],baseline['value_m'])
        reversed_result=evaluate_triangle(tuple(reversed(TRIANGLE)),target)
        self.close(reversed_result['passes'][-1]['omega'],-self.ctx.mpf(baseline['passes'][-1]['omega']))
        below=evaluate_triangle(TRIANGLE,(.25,.25,-.5))
        self.close(below['value_m'],baseline['value_m'])
        self.assertGreater(self.ctx.mpf(baseline['passes'][-1]['omega']),0)
        self.assertLess(self.ctx.mpf(below['passes'][-1]['omega']),0)

    def test_exact_power2_scaling_translation_and_rotation(self):
        target=(.25,.25,.5);baseline=evaluate_triangle(TRIANGLE,target)
        for scale in (2.**-20,2.**20):
            vertices=[tuple(scale*x for x in p) for p in TRIANGLE]
            point=tuple(scale*x for x in target)
            self.close(self.ctx.mpf(evaluate_triangle(vertices,point)['value_m'])/scale,baseline['value_m'])
        for transform in (lambda p:(p[0]+3,p[1]-2,p[2]+1),lambda p:(-p[1],p[0],p[2])):
            self.close(evaluate_triangle([transform(p) for p in TRIANGLE],transform(target))['value_m'],baseline['value_m'])

    def test_corpus_is_fixed_54_and_analytic_full_scalar_passes(self):
        cases=mathematical_corpus()
        self.assertEqual(len(cases),54)
        self.assertEqual([x['id'] for x in cases[:18]],[f'M{i:02}/base' for i in range(1,19)])
        for case in cases:
            with self.subTest(case=case['id']):
                result=evaluate_triangle(case['vertices'],case['target'])
                self.assertGreater(self.ctx.mpf(result['value_m']),0)
                self.close(result['value_m'],result['passes'][-1]['whole_m'])
                self.assertEqual(result['qualification'],'NOT VERIFIED')
                self.assertEqual(result['current_owner_weighted_errors'],'NOT VERIFIED: no current or field input')

    def test_one_ulp_and_subnormal_are_not_zero_predicates(self):
        budget=Budget();point=(.25,.25,math.nextafter(0.,1.))
        geometry=prepare_geometry(TRIANGLE,point,budget)
        self.assertNotEqual(geometry['hnum'],0)
        zero=prepare_geometry(TRIANGLE,(.25,.25,0.),Budget())
        self.assertEqual(zero['hnum'],0)
        near=prepare_geometry(TRIANGLE,(.5,math.nextafter(0.,1.),0.),Budget())
        self.assertNotEqual(near['dnums'][0],0)
        result=evaluate_triangle(TRIANGLE,(.5,0.,math.nextafter(0.,1.)))
        self.assertEqual(result['passes'][0]['status'],'REFUSED')
        self.assertEqual(result['passes'][-1]['status'],'evaluated')
        self.assertFalse(result['passes'][-1]['h_zero'])

    def test_extreme_far_uses_explicit_highprecision_resolution(self):
        result=evaluate_triangle(TRIANGLE,(2.**54,-2.**54,0.))
        self.assertTrue(result['binary64_requires_highprecision'])
        self.assertGreater(self.ctx.mpf(result['value_m']),0)
        self.assertEqual(result['resolved_precision'],'120digits')

    def test_degenerate_and_nonfinite_inputs_are_refused(self):
        for vertices,target in [(((0,0,0),(1,0,0),(2,0,0)),(0,0,0)),
                                (((0,0,0),(0,0,0),(0,1,0)),(0,0,0)),
                                (TRIANGLE,(math.inf,0,0))]:
            with self.assertRaises(Refusal): evaluate_triangle(vertices,target)

    def test_reference_positive_partition_and_exact_skips(self):
        for point,count in [((0,0,0),1),((.5,0,0),2),((.25,.25,0),3),
                            ((.25,.25,.5),3),((2,2,0),1)]:
            panels,_,_=positive_reference_panels(TRIANGLE,point)
            self.assertEqual(len(panels),count)
            self.assertTrue(all(isinstance(x,Fraction) for p in panels for v in p for x in v))

    def test_reference_limit_refuses_before_third_direct_kernel_evaluation(self):
        budget=Budget(soft_reference_evals=2);budget.activate('synthetic-reference-limit')
        def direct_driver(ctx,function,intervals,**kwargs):
            # Exercise callbacks without invoking any numerical quadrature library.
            return function(ctx.mpf(".25"))+function(ctx.mpf(".5"))+function(ctx.mpf(".75")),ctx.mpf(0)
        with patch.object(type(mpmath.mp),"quad",direct_driver):
            with self.assertRaisesRegex(Refusal,'soft execution allocation'):
                reference_pass(TRIANGLE,(0,0,0),160,8,budget)
        self.assertEqual(budget.counts['reference_evals'],3)
        self.assertEqual(budget.counts['log1p'],0)
        self.assertEqual(budget.counts['atan2'],0)

    def test_reference_vertex_collapses_only_exact_radial_constant(self):
        for point,panels,calls,evaluations,mode in [((0,0,0),1,1,2,"exact_vertex"),
                ((.5,0,0),2,2,4,"exact_vertex"),
                ((.25,.25,0),3,3,6,"exact_vertex"),
                ((.25,.25,.5),3,3,6,"exact_projected")]:
            with self.subTest(point=point):
                observed=[];budget=Budget()
                def driver(ctx,function,intervals,**kwargs):
                    observed.append((ctx.dps,kwargs["maxdegree"]))
                    return (function(ctx.mpf(".25"))+function(ctx.mpf(".75")))/2,ctx.mpf(0)
                with patch.object(type(mpmath.mp),"quad",driver):
                    result=reference_pass(TRIANGLE,point,160,8,budget)
                self.assertEqual(len(observed),calls)
                self.assertEqual(observed,[(160,8)]*calls)
                self.assertEqual(budget.counts["reference_evals"],evaluations)
                self.assertEqual(result["radial_integration"],[mode]*panels)
                self.assertEqual(result["outer_error_estimates"],[None]*panels)
                self.assertEqual(result["radial_error_marker"],["exact_algebraic_reduction"]*panels)
                self.assertEqual(result["reference_method"],"GENERAL_RADIAL_1D")
                self.assertEqual(budget.counts["log1p"],0)
                self.assertEqual(budget.counts["atan2"],0)

    def test_reference_six_passes_keep_fresh_contexts_and_shared_budget(self):
        contexts=[];schedule=[];budget=Budget()
        def driver(ctx,function,intervals,**kwargs):
            contexts.append(ctx);schedule.append((ctx.dps,kwargs["maxdegree"]))
            return (function(ctx.mpf(".25"))+function(ctx.mpf(".75")))/2,ctx.mpf(0)
        with patch.object(type(mpmath.mp),"quad",driver):
            result=reference_triangle(TRIANGLE,(0,0,0),budget)
        self.assertEqual(schedule,[(p,d) for p in (160,200) for d in (8,10,12)])
        self.assertEqual(len({id(ctx) for ctx in contexts}),6)
        self.assertEqual(len(result["passes"]),6)
        self.assertEqual(budget.counts["reference_evals"],12)
        self.assertEqual(budget.counts["reference_comparisons"],124)
        self.assertEqual(budget.by_target[reference_test_identity(TRIANGLE,(0,0,0))]["reference_evals"],12)

    def test_reference_both_branches_guard_before_third_kernel(self):
        for point in ((0,0,0),(.25,.25,.5)):
            with self.subTest(point=point):
                budget=Budget(soft_reference_evals=2)
                def driver(ctx,function,intervals,**kwargs):
                    return sum(function(ctx.mpf(v)) for v in (".25",".5",".75")),ctx.mpf(0)
                with patch.object(type(mpmath.mp),"quad",driver):
                    with self.assertRaisesRegex(Refusal,"soft execution allocation"):
                        reference_pass(TRIANGLE,point,160,8,budget)
                self.assertEqual(budget.counts["reference_evals"],3)
                self.assertEqual(budget.counts["reference_sqrt"],3 if point==(0,0,0) else 7)  # Area plus admitted radial kernels.

    def test_private_context_nonempty_cache_cleanup_normal_and_refusal(self):
        for refuse in (False,True):
            with self.subTest(refuse=refuse):
                references=[];cleaned=[];budget=Budget();original_close=Arithmetic.close_reference
                global_dps=mpmath.mp.dps
                def driver(ctx,function,intervals,**kwargs):
                    references.append(weakref.ref(ctx))
                    ctx._tanh_sinh.standard_cache["synthetic"]=[ctx.mpf(1)]
                    ctx._gauss_legendre.transformed_cache["synthetic"]=[ctx.mpf(2)]
                    if refuse: raise Refusal("injected callback refusal")
                    return function(ctx.mpf(".5")),ctx.mpf(0)
                def close(arithmetic):
                    ctx=arithmetic.ctx;originals=dict(arithmetic._original_functions)
                    original_close(arithmetic)
                    cleaned.append((not ctx._tanh_sinh.standard_cache,not ctx._gauss_legendre.transformed_cache,
                                    all(getattr(ctx,n) is f for n,f in originals.items()),arithmetic.ctx is None))
                with patch.object(type(mpmath.mp),"quad",driver),patch.object(Arithmetic,"close_reference",close):
                    if refuse:
                        with self.assertRaisesRegex(Refusal,"injected callback refusal"):
                            reference_pass(TRIANGLE,(0,0,0),160,8,budget)
                    else: reference_pass(TRIANGLE,(0,0,0),160,8,budget)
                gc.collect()
                self.assertTrue(references)
                self.assertTrue(all(r() is None for r in references))
                self.assertEqual(cleaned,[(True,True,True,True)])
                self.assertEqual(mpmath.mp.dps,global_dps)
                self.assertEqual(budget.counts["reference_evals"],0 if refuse else 1)
                self.assertGreaterEqual(budget.report()["elapsed_seconds"],0)

    def test_context_isolation_and_attempted_operation_counters(self):
        original=mpmath.mp.dps
        a=Arithmetic(80,Budget());b=Arithmetic(120,Budget())
        self.assertEqual((a.ctx.dps,b.ctx.dps,mpmath.mp.dps),(80,120,original))
        budget=Budget();budget.activate('counter')
        budget.by_target['counter']['pairs']=100000
        with self.assertRaisesRegex(Refusal,'analytic pair limit'):budget.charge('pairs',80)
        self.assertEqual(budget.counts['pairs'],1)

    def test_radial_projected_height_sign_and_exact_vertex(self):
        budget=Budget();a=Arithmetic(160,budget,reference=True);ctx=a.ctx
        try:
            f1=(ctx.mpf(1),ctx.mpf(0),ctx.mpf(0))
            f2=(ctx.mpf(0),ctx.mpf(1),ctx.mpf(0));v=ctx.mpf(".25")
            values=[]
            for h in (ctx.mpf(".5"),ctx.mpf("-.5")):
                value,mode,condition=reference_radial_value(a,(0,0,h),f1,f2,v,False,True,False)
                values.append(value);self.assertEqual(mode,"exact_projected");self.assertEqual(condition,1)
            self.assertEqual(values[0],values[1])
            value,mode,_=reference_radial_value(a,(0,0,0),f1,f2,v,True,True,False)
            self.assertAlmostEqual(float(value),1/math.sqrt(.625),places=14)
            self.assertEqual(mode,"exact_vertex")
            self.assertEqual(budget.counts["reference_evals"],3)
            self.assertEqual(budget.counts["reference_log1p"],0)
            self.assertGreater(budget.counts["reference_divisions"],0)
            self.assertGreater(budget.counts["reference_dynamic_positive"],0)
        finally: a.close_reference()

    def test_general_radial_matches_independent_asinh_antiderivative(self):
        budget=Budget();a=Arithmetic(160,budget,reference=True);ctx=a.ctx
        try:
            f1=(ctx.mpf(1),ctx.mpf(0),ctx.mpf(0))
            f2=(ctx.mpf(0),ctx.mpf(1),ctx.mpf(0))
            for target in ((2,2,.5),(-1,.25,-.5),(2**20,-2**20,2**20)):
                p=tuple(ctx.mpf(x) for x in target);v=ctx.mpf(".375")
                ray=tuple((1-v)*x+v*y for x,y in zip(f1,f2))
                A=sum(x*x for x in ray);B=sum(x*y for x,y in zip(p,ray));C=sum(x*x for x in p)
                s=ctx.sqrt(A);beta=B/s;delta=ctx.sqrt(C-B*B/A)
                def primitive(u):
                    return (ctx.sqrt(A*u*u-2*B*u+C)+beta*ctx.asinh((s*u-beta)/delta))/A
                value,mode,_=reference_radial_value(a,p,f1,f2,v,False,False,False)
                expected=primitive(ctx.mpf(1))-primitive(ctx.mpf(0))
                self.assertLess(abs(value-expected),ctx.mpf("1e-140")*(1+abs(expected)))
                self.assertEqual(mode,"general_radial_primitive")
                for u in (ctx.mpf(".2"),ctx.mpf(".7")):
                    derivative=ctx.diff(primitive,u)
                    self.assertLess(abs(derivative-u/ctx.sqrt(A*u*u-2*B*u+C)),ctx.mpf("1e-140"))
        finally: a.close_reference()

    def test_radial_zero_is_geometry_certified_or_refused(self):
        a=Arithmetic(160,Budget(),reference=True);ctx=a.ctx
        try:
            f1=(ctx.mpf(1),ctx.mpf(0),ctx.mpf(0))
            f2=(ctx.mpf(0),ctx.mpf(1),ctx.mpf(0));v=ctx.mpf(".5")
            value,_,_=reference_radial_value(a,(2,2,0),f1,f2,v,False,False,True)
            expected=(-1+4*ctx.log(ctx.mpf(4)/3))/ctx.sqrt(ctx.mpf(".5"))
            self.assertLess(abs(value-expected),ctx.mpf("1e-150"))
            negative,_,_=reference_radial_value(a,(-2,-2,0),f1,f2,v,False,False,True)
            expected=(1-4*ctx.log(ctx.mpf(5)/4))/ctx.sqrt(ctx.mpf(".5"))
            self.assertLess(abs(negative-expected),ctx.mpf("1e-150"))
            with self.assertRaisesRegex(Refusal,"unproven rounded"):
                reference_radial_value(a,(2,2,0),f1,f2,v,False,False,False)
            with self.assertRaisesRegex(Refusal,"singular radial"):
                reference_radial_value(a,(ctx.mpf(".25"),ctx.mpf(".25"),0),f1,f2,v,False,False,True)
        finally: a.close_reference()

    def test_general_radial_one_ulp_offplane_stays_positive_branch(self):
        a=Arithmetic(160,Budget(),reference=True);ctx=a.ctx
        try:
            f1=(ctx.mpf(1),ctx.mpf(0),ctx.mpf(0))
            f2=(ctx.mpf(0),ctx.mpf(1),ctx.mpf(0))
            h=ctx.mpf(math.nextafter(0,1))
            value,mode,_=reference_radial_value(a,(2,2,h),f1,f2,ctx.mpf(".5"),False,False,False)
            self.assertGreater(value,0);self.assertEqual(mode,"general_radial_primitive")
        finally:a.close_reference()

    def test_general_reference_one_quad_and_guard_for_outside_panel(self):
        observed=[];budget=Budget(soft_reference_evals=2)
        def driver(ctx,function,intervals,**kwargs):
            observed.append(kwargs["maxdegree"])
            return sum(function(ctx.mpf(x)) for x in (".25",".5",".75")),ctx.mpf(0)
        with patch.object(type(mpmath.mp),"quad",driver):
            with self.assertRaisesRegex(Refusal,"soft execution"):
                reference_pass(TRIANGLE,(2,2,.5),160,8,budget)
        self.assertEqual(observed,[8])
        self.assertEqual(budget.counts["reference_evals"],3)
        self.assertEqual(budget.counts["reference_log1p"],2)
        self.assertGreater(budget.counts["reference_dynamic_nonnegative"],0)

    def test_static_node_bound_and_frozen_panel_count_without_quad(self):
        def nodes(m):return 40*(2**(m+1)-2)+2*m+1
        per_panel=2*sum(nodes(m) for m in (8,10,12))
        self.assertEqual(per_panel,859806)
        panel_count=0
        for case in mathematical_corpus():
            panels,_,_=positive_reference_panels(case["vertices"],case["target"])
            panel_count+=len(panels)
        self.assertLessEqual(panel_count,105)
        self.assertLessEqual(panel_count*per_panel,90279630)
        self.assertLess(3*per_panel,10000000)
        self.assertLess(105*per_panel,100000000)


    def test_projected_reference_rigid_covariance_scale_and_translation(self):
        variants=[
            (TRIANGLE,(.25,.25,.5),1),
            (tuple(reversed(TRIANGLE)),(.25,.25,.5),1),
            (tuple((-p[1],p[0],p[2]) for p in TRIANGLE),(-.25,.25,.5),1),
            (tuple(tuple(2*x for x in p) for p in TRIANGLE),(.5,.5,1),2),
            (tuple(tuple(x+8 for x in p) for p in TRIANGLE),(8.25,8.25,8.5),1)]
        values=[]
        def driver(ctx,function,intervals,**kwargs):
            return (function(ctx.mpf(".25"))+function(ctx.mpf(".75")))/2,ctx.mpf(0)
        with patch.object(type(mpmath.mp),"quad",driver):
            for vertices,target,scale in variants:
                result=reference_pass(vertices,target,160,8,Budget())
                self.assertEqual(result["radial_integration"],["exact_projected"]*3)
                values.append(self.ctx.mpf(result["value_m"])/scale)
        for value in values[1:]:
            self.assertLess(abs(value-values[0]),self.ctx.mpf("1e-140"))



class FixedCtypesLifecycleTests(unittest.TestCase):
    def test_measurement_only_preserves_existing_math_and_budget_ast(self):
        import ast,hashlib
        import antenna_triangle_surface_oracle as oracle
        tree=ast.parse(Path(oracle.__file__).read_text(encoding="utf8"))
        nodes=[n for n in tree.body if isinstance(n,(ast.FunctionDef,ast.ClassDef,ast.Assign))
               and not (isinstance(n,ast.FunctionDef) and n.name=="peak_ram_bytes")]
        module=ast.Module(body=nodes,type_ignores=[])
        # Python 3.12 adds empty type_params fields; they do not change the math.
        for node in ast.walk(module):
            if hasattr(node,"type_params") and not node.type_params:
                node._fields=tuple(name for name in node._fields if name!="type_params")
        actual=hashlib.sha256(ast.dump(module,include_attributes=False).encode()).hexdigest()
        self.assertEqual(actual,"f3c8c471502739cc6e2ee92ee453c9cbd026feebe30f39060e1f9f43666bc15f")

    @unittest.skipUnless(os.name=="nt","Windows ABI regression")
    def test_windows_memory_abi_local_buffers_and_failclosed(self):
        import ctypes
        from ctypes import wintypes
        import antenna_triangle_surface_oracle as oracle
        self.assertEqual(ctypes.sizeof(oracle._MemoryCounters),72)
        names=[name for name,_ in oracle._MemoryCounters._fields_]
        self.assertEqual([getattr(oracle._MemoryCounters,n).offset for n in names],
                         [0,4,8,16,24,32,40,48,56,64])
        self.assertEqual(oracle._get_current_process.argtypes,[])
        self.assertIs(oracle._get_current_process.restype,wintypes.HANDLE)
        self.assertEqual(oracle._get_process_memory_info.argtypes,
                         [wintypes.HANDLE,ctypes.POINTER(oracle._MemoryCounters),wintypes.DWORD])
        self.assertIs(oracle._get_process_memory_info.restype,wintypes.BOOL)
        seen=[]
        def measure(handle,pointer,size):
            value=pointer._obj;seen.append(value)
            self.assertEqual(size,72);self.assertEqual(value.cb,72)
            value.WorkingSetSize=1;value.PeakWorkingSetSize=11;value.PeakPagefileUsage=19
            return 1
        with patch.object(oracle,"_get_process_memory_info",side_effect=measure):
            self.assertEqual(oracle.peak_ram_bytes(),19);self.assertEqual(oracle.peak_ram_bytes(),19)
        self.assertIsNot(seen[0],seen[1])
        with patch.object(oracle,"_get_process_memory_info",return_value=0):
            with self.assertRaisesRegex(Refusal,"peak RAM measurement unavailable"):oracle.peak_ram_bytes()

    @unittest.skipUnless(os.name=="nt","Windows pointer cache regression")
    def test_128_real_measurements_keep_one_pointer_type(self):
        import ctypes
        import antenna_triangle_surface_oracle as oracle
        oracle.peak_ram_bytes();gc.collect()
        before=set(ctypes._pointer_type_cache)
        identity=(oracle._MemoryCounters,oracle._get_process_memory_info,oracle._get_current_process)
        for _ in range(128):self.assertGreater(oracle.peak_ram_bytes(),0)
        gc.collect()
        self.assertEqual(set(ctypes._pointer_type_cache),before)
        self.assertEqual(identity,(oracle._MemoryCounters,oracle._get_process_memory_info,oracle._get_current_process))

    def test_peak_and_guard_cadence_never_reset_budget(self):
        import antenna_triangle_surface_oracle as oracle
        budget=Budget();budget.counts["reference_evals"]=17
        budget.counts["reference_comparisons"]=13;started=budget.started
        with patch.object(oracle,"peak_ram_bytes",side_effect=[200,150,2147483649]):
            budget.guard();budget.guard()
            self.assertEqual(budget.peak_ram,200)
            with self.assertRaisesRegex(Refusal,"actual peak RAM exhausted"):budget.guard()
        self.assertEqual(budget.started,started)
        self.assertEqual(budget.counts["reference_evals"],17)
        self.assertEqual(budget.counts["reference_comparisons"],13)
        self.assertEqual(budget.peak_ram,2147483649)
        budget=Budget();budget.counts["diagnostic_existing"]=250
        with patch.object(budget,"guard") as guard:
            for _ in range(6):budget.charge("diagnostic_existing")
            self.assertEqual(guard.call_count,1)
        self.assertEqual(sum(budget.counts.values()),256)

if __name__=='__main__':
    unittest.main()
