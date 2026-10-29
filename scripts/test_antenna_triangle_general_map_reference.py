"""Algebra and mocked-quadrature contracts; never execute the 24-case experiment."""
import ast
from dataclasses import FrozenInstanceError
from fractions import Fraction
import gc
import math
from pathlib import Path
import random
import unittest
import weakref
from unittest.mock import patch

import mpmath
import antenna_triangle_general_map_reference as gm
from antenna_triangle_surface_oracle import Arithmetic, Budget, Refusal, dot

TRIANGLE=((0.,0.,0.),(1.,0.,0.),(0.,1.,0.))


class GeneralMapReferenceTests(unittest.TestCase):
    def arithmetic(self):
        value=gm.MapArithmetic(160,Budget());self.addCleanup(value.close_reference)
        return value

    def test_all_24_exact_plans_keep_original_order_and_bounded_exact_work(self):
        cases=gm.frozen_cases24();self.assertEqual(len(cases),24)
        self.assertEqual([c['id'] for c in cases],
            [f'M{i:02}/base' for i in range(1,19)]+
            [f'M{i:02}/{name}' for name in ('shear','rotate90') for i in (8,10,16)])
        shared=Budget();maximum=0
        for case in cases:
            before=shared.counts['reference_comparisons']
            plan=gm.prepare_case(case['vertices'],case['target'],shared)
            maximum=max(maximum,shared.counts['reference_comparisons']-before)
            self.assertLessEqual(shared.counts['reference_comparisons']-before,174)
            self.assertLessEqual(len(plan.panels),3)
            self.assertLessEqual(sum(len(p.pieces) for p in plan.panels),6)
            self.assertTrue(all(isinstance(x,Fraction) for p in plan.panels for x in p.p))
            with self.assertRaises(FrozenInstanceError):plan.projected=False
            if case['id']=='M16/shear':
                self.assertFalse(plan.projected);self.assertEqual(len(plan.panels),1)
                self.assertEqual(plan.panels[0].v0,0)
                self.assertGreater(plan.panels[0].c1,0)
                self.assertEqual(plan.panels[0].angular_mode,'graded')
        self.assertLessEqual(shared.counts['reference_comparisons'],9396)
        self.assertLessEqual(shared.max_fraction_bits,8192)
        self.assertLessEqual(shared.reference_raw_max_bits,8192)
        self.assertGreater(shared.counts['map_exact_operations'],0)
        self.assertGreater(shared.counts['map_exact_predicates'],0)
        self.assertGreater(maximum,0)

    def test_map_kernel_times_jacobian_matches_original_kernel_at_deterministic_points(self):
        rng=random.Random(340119)
        for target in ((.25,.25,.5),(2.,2.,.5),(-1.,.25,-.5),(.5,0.,2.**-40)):
            for scale in (2.**-20,1.,2.**20):
                vertices=tuple(tuple(scale*x for x in p) for p in TRIANGLE)
                point=tuple(scale*x for x in target)
                plan=gm.prepare_case(vertices,point,Budget());a=self.arithmetic();ctx=a.ctx
                for panel in plan.panels:
                    if panel.vertex:continue
                    for piece in panel.pieces:
                        for _ in range(2):
                            w=ctx.mpf(rng.randrange(1,31))/32;z=ctx.mpf(rng.randrange(1,31))/32
                            mapped,u,v,ju,jv=gm.mapped_sample(a,panel,piece,w,z)
                            p=tuple(a.number(x) for x in panel.p)
                            ray=tuple((1-v)*a.number(x)+v*a.number(y) for x,y in zip(panel.e1,panel.e2))
                            distance=ctx.sqrt(sum((x-u*y)**2 for x,y in zip(p,ray)))
                            J=ctx.sqrt(sum(a.number(x)**2 for x in panel.normal))
                            original=J*u/distance*ju*jv
                            self.assertLess(abs(mapped-original),ctx.mpf('1e-130')*abs(original))
                            self.assertGreater(ju,0);self.assertGreater(jv,0)

    def test_zero_C_certification_both_radial_limits_and_endpoints(self):
        for target,mode in (((2.,2.,0.),'zero_after'),((-2.,-2.,0.),'zero_before')):
            plan=gm.prepare_case(TRIANGLE,target,Budget());panel=plan.panels[0]
            self.assertTrue(panel.zero_minimum);self.assertEqual(panel.v0,Fraction(1,2))
            a=self.arithmetic();ctx=a.ctx
            for piece in panel.pieces:
                v,jv,C,zero=gm.angular_point(a,panel,piece,ctx.mpf(0))
                self.assertEqual(C,0);self.assertTrue(zero)
                pars=gm.radial_parameters(a,panel,v,C,zero);self.assertEqual(pars[-1],mode)
                for w in (ctx.mpf(0),ctx.mpf('.375'),ctx.mpf(1)):
                    mapped,u,v,ju,jv=gm.mapped_radial_sample(a,panel,w,v,jv,pars)
                    self.assertEqual(u,0 if w==0 else 1 if w==1 else u)
                    ray=tuple((1-v)*a.number(x)+v*a.number(y) for x,y in zip(panel.e1,panel.e2))
                    R=ctx.sqrt(sum((a.number(x)-u*y)**2 for x,y in zip(panel.p,ray)))
                    J=ctx.sqrt(sum(a.number(x)**2 for x in panel.normal))
                    self.assertLess(abs(mapped-J*u*ju*jv/R),ctx.mpf('1e-140'))
                with self.assertRaisesRegex(Refusal,'uncertified zero'):
                    gm.radial_parameters(a,panel,v,ctx.mpf(0),False)

    def test_one_ulp_off_plane_does_not_take_zero_C_branch(self):
        plan=gm.prepare_case(TRIANGLE,(2.,2.,math.nextafter(0.,1.)),Budget())
        panel=plan.panels[0];self.assertFalse(panel.zero_minimum)
        self.assertGreater(panel.epsilon2,0)
        a=self.arithmetic();ctx=a.ctx
        v,jv,C,zero=gm.angular_point(a,panel,panel.pieces[0],ctx.mpf(0))
        self.assertGreater(C,0);self.assertFalse(zero)
        pars=gm.radial_parameters(a,panel,v,C,zero)
        self.assertEqual(pars[-1],'positive')
        self.assertGreater(gm.mapped_radial_sample(a,panel,ctx.mpf('.5'),v,jv,pars)[0],0)

    def test_direct_source_does_not_call_radial_or_primary_analytic_formula(self):
        tree=ast.parse(Path(gm.__file__).read_text())
        forbidden={'reference_radial_value','analytic_pass','evaluate_triangle','reference_pass','reference_triangle','solid_angle'}
        functions={n.name:n for n in tree.body if isinstance(n,ast.FunctionDef)}
        pending=['direct_pass'];seen=set()
        while pending:
            name=pending.pop()
            if name in seen:continue
            seen.add(name)
            for node in ast.walk(functions[name]):
                if isinstance(node,ast.Call) and isinstance(node.func,ast.Name):
                    self.assertNotIn(node.func.id,forbidden)
                    if node.func.id in functions:pending.append(node.func.id)
        self.assertIn('mapped_radial_sample',seen)

    def test_mocked_pair_uses_12_fresh_contexts_and_original_panels(self):
        contexts=[];schedule=[];completed=[];budget=Budget()
        def driver(ctx,function,intervals,**kwargs):
            if not contexts or contexts[-1] is not ctx:
                contexts.append(ctx);schedule.append((ctx.dps,kwargs['maxdegree'],kwargs['method']))
            # This is a callback driver, not numerical quadrature or convergence evidence.
            return function(ctx.mpf('.375')),ctx.mpf(0)
        with patch.object(type(mpmath.mp),'quad',driver),patch.object(gm,'check_gates',return_value={'mock':True}) as gates:
            report=gm.reference_pair(TRIANGLE,(.25,.25,.5),budget,
                completed=lambda method,record:completed.append((method,record)))
        self.assertEqual(len({id(x) for x in contexts}),12)
        self.assertEqual(schedule,[(p,d,m) for m in ('gauss-legendre','tanh-sinh') for p in (160,200) for d in (8,10,12)])
        self.assertEqual(len(completed),12);self.assertEqual(gates.call_count,1)
        self.assertTrue(all(len(p['panels_m'])==3 for p in report['direct_passes']+report['radial_passes']))
        self.assertEqual(report['qualification'],'NOT VERIFIED')
        self.assertEqual(budget.counts['reference_evals'],54)
        self.assertEqual(budget.counts['direct2d_evals'],36)
        self.assertLessEqual(budget.counts['reference_comparisons'],174)

    def test_exact_vertex_uses_1d_only_and_no_radial_formula(self):
        observed=[];budget=Budget();plan=gm.prepare_case(TRIANGLE,(0,0,0),budget)
        a=self.arithmetic()
        def driver(ctx,function,intervals,**kwargs):
            observed.append(kwargs['method']);return function(ctx.mpf('.5')),ctx.mpf(0)
        with patch.object(type(mpmath.mp),'quad',driver),patch.object(gm,'reference_radial_value',side_effect=AssertionError('forbidden')):
            record=gm.direct_pass(plan,160,8,budget,a)
        self.assertEqual(observed,['gauss-legendre'])
        self.assertEqual(record['radial_integration'],['exact_vertex_1d'])
        self.assertEqual(budget.counts['reference_evals'],1)

    def test_budget_refuses_before_third_mapped_kernel_and_context_cleanup(self):
        budget=Budget(soft_reference_evals=2);refs=[];closed=[]
        original_close=Arithmetic.close_reference
        def driver(ctx,function,intervals,**kwargs):
            refs.append(weakref.ref(ctx));ctx._gauss_legendre.standard_cache['synthetic']=[ctx.mpf(1)]
            return sum(function(ctx.mpf(x)) for x in ('.25','.5','.75')),ctx.mpf(0)
        def close(a):
            ctx=a.ctx;original_close(a)
            closed.append((not ctx._gauss_legendre.standard_cache,a.ctx is None))
        with patch.object(type(mpmath.mp),'quad',driver),patch.object(Arithmetic,'close_reference',close),patch.object(gm,'mapped_radial_sample',wraps=gm.mapped_radial_sample) as kernel:
            with self.assertRaisesRegex(Refusal,'soft execution allocation'):
                gm.reference_pair(TRIANGLE,(.25,.25,.5),budget)
        kernel_calls=kernel.call_count
        kernel.reset_mock()
        gc.collect()
        self.assertEqual(budget.counts['reference_evals'],3)
        self.assertEqual(budget.counts['direct2d_evals'],3)
        self.assertEqual(budget.counts['map_radial_evaluations'],3)
        self.assertEqual(kernel_calls,2)
        self.assertEqual(closed,[(True,True)])
        self.assertTrue(all(r() is None for r in refs))

    def test_negative_parameter_and_nonfinite_are_refused_without_clipping(self):
        plan=gm.prepare_case(TRIANGLE,(2.,2.,.5),Budget());panel=plan.panels[0]
        a=self.arithmetic();ctx=a.ctx
        for z in (ctx.mpf('-.001'),ctx.mpf('1.001'),ctx.inf):
            with self.assertRaises(Refusal):gm.angular_point(a,panel,panel.pieces[0],z)
        for w in (ctx.mpf('-.001'),ctx.mpf('1.001'),ctx.inf):
            with self.assertRaises(Refusal):gm.mapped_sample(a,panel,panel.pieces[0],w,ctx.mpf('.5'))
        with self.assertRaises(Refusal):gm.prepare_case(TRIANGLE,(math.inf,0.,0.),Budget())

    def test_cleanup_admission_preserves_original_refusal(self):
        budget=Budget();original=budget.guard;injected=False
        def guard():
            if injected:raise Refusal('cleanup peak refusal')
            return original()
        def driver(ctx,function,intervals,**kwargs):
            nonlocal injected
            injected=True
            raise Refusal('original callback refusal')
        with patch.object(type(mpmath.mp),'quad',driver),patch.object(budget,'guard',guard):
            with self.assertRaisesRegex(Refusal,'original callback refusal; cleanup admission also failed: cleanup peak refusal'):
                gm.reference_pair(TRIANGLE,(0,0,0),budget)

    def test_all_24_plan_maps_agree_with_original_kernel_without_quad(self):
        for case in gm.frozen_cases24():
            plan=gm.prepare_case(case['vertices'],case['target'],Budget())
            a=self.arithmetic();ctx=a.ctx
            for panel in plan.panels:
                for piece in panel.pieces:
                    value,u,v,ju,jv=gm.mapped_sample(a,panel,piece,ctx.mpf('.375'),ctx.mpf('.625'))
                    ray=tuple((1-v)*a.number(x)+v*a.number(y) for x,y in zip(panel.e1,panel.e2))
                    R=ctx.sqrt(sum((a.number(x)-u*y)**2 for x,y in zip(panel.p,ray)))
                    J=ctx.sqrt(sum(a.number(x)**2 for x in panel.normal))
                    original=J*u*ju*jv/R
                    self.assertLess(abs(value-original),ctx.mpf('1e-130')*abs(original),case['id'])

    def test_exact_raw_limit_and_comparison_limit_refuse_before_quad(self):
        budget=Budget();exact=gm.MapExactArithmetic(budget)
        with self.assertRaisesRegex(Refusal,'raw intermediate bit-length'):
            exact.binary('mul',Fraction(2**5000),Fraction(2**5000))
        self.assertGreater(budget.reference_raw_max_bits,8192)
        budget=Budget();identity=gm.reference_test_identity(TRIANGLE,(0,0,0))
        budget.by_target[identity]['reference_comparisons']=174
        with patch.object(type(mpmath.mp),'quad',side_effect=AssertionError('not admitted')) as quad:
            with self.assertRaisesRegex(Refusal,'target reference comparison limit'):
                gm.reference_pair(TRIANGLE,(0,0,0),budget)
        self.assertEqual(quad.call_count,0)
        self.assertEqual(budget.by_target[identity]['reference_comparisons'],175)

    def test_gate_does_not_add_degree8_or_nonfinal_cross_conditions(self):
        plan=gm.prepare_case(TRIANGLE,(0,0,0),Budget());a=self.arithmetic();ctx=a.ctx
        direct=[{'value_m':'1','panels_m':['1']} for _ in range(6)]
        radial=[{'value_m':'1','panels_m':['1']} for _ in range(6)]
        direct[0]={'value_m':'10','panels_m':['10']}
        radial[0]={'value_m':'20','panels_m':['20']}
        result=gm.check_gates(plan,direct,radial,ctx)
        self.assertEqual(len(result['comparisons']),7)
        self.assertEqual(result['comparisons'][-1]['pass'],5)

    def test_local_gate_catches_panel_cancellation_even_when_total_matches(self):
        plan=gm.prepare_case(TRIANGLE,(.25,.25,.5),Budget());a=self.arithmetic();ctx=a.ctx
        record={'value_m':'3','panels_m':['1','1','1']}
        direct=[dict(record) for _ in range(6)];radial=[dict(record) for _ in range(6)]
        direct[1]={'value_m':'3','panels_m':['1.1','.9','1']}
        with self.assertRaisesRegex(Refusal,'direct total/local'):gm.check_gates(plan,direct,radial,ctx)
        direct=[dict(record) for _ in range(6)]
        self.assertEqual(len(gm.check_gates(plan,direct,radial,ctx)['comparisons']),7)


if __name__=='__main__':unittest.main()
