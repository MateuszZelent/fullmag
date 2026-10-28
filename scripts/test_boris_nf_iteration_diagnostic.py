"""Pure input/source and mocked refusal regressions; no native or Docker."""
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
import ast
import unittest
from unittest.mock import patch
import boris_nf_iteration_diagnostic as diagnostic
import boris_nf_common_case_v3 as common
import run_managed_boris_nf as legacy

class IterationDiagnosticContract(unittest.TestCase):
    def fields(self, multiplier=0.0):
        result = {}
        for domain in ("normal", "ferromagnet"):
            result[domain] = {}
            for ordinal, name in enumerate(("V", "S", "Jc", "Jsx", "Jsy", "Jsz")):
                width = 1 if name == "V" else 3
                values = [[0.0] * width, [multiplier * (ordinal * 3 + a + 1) for a in range(width)]]
                result[domain][name] = SimpleNamespace(shape=(2,1,1), origin_m=(0.0,0.0,0.0),
                    step_m=(1e-9,1e-9,1e-9), valuedim=width, values=values,
                    sha256=("a" if multiplier == 0 else "b") * 64)
        return result

    def test_absolute_changes_all_nine_tensor_components_units_indices_hashes(self):
        before, after = self.fields(), self.fields(1.0)
        report = diagnostic.absolute_field_changes(before, after, 1, 2)
        kappa = common.case_descriptor("r0")["conventions"]["kappa_m2_per_s"]
        for domain in ("normal", "ferromagnet"):
            quantities = report["by_domain"][domain]["quantities"]
            self.assertEqual([quantities[q]["unit"] for q in ("V","S","Jc","Q")], ["V","A/m","A/m^2","A/m^2"])
            for component, row in enumerate(quantities["Q"]["components"]):
                self.assertEqual(row["maximum_absolute_delta"], (component + 10) / kappa)
                self.assertEqual((row["flow_axis"],row["spin_axis"]), divmod(component,3))
                self.assertEqual(row["cell_index"],1)
                self.assertEqual(row["cell_ijk"],[1,0,0])
                self.assertEqual(row["before_raw_sha256"],"a"*64)
                self.assertEqual(row["after_raw_sha256"],"b"*64)
            self.assertEqual(len({row["maximum_absolute_delta"] for row in quantities["Q"]["components"]}),9)
            for name, expected in (("V",[1.0]),("S",[4.0,5.0,6.0]),("Jc",[7.0,8.0,9.0])):
                self.assertEqual([row["maximum_absolute_delta"] for row in quantities[name]["components"]],expected)

    def test_absolute_changes_exact_pairs_and_reordered_capture_refused(self):
        for pair in ((2,1),(1,4),(4,2),(2,8),(True,2)):
            with self.subTest(pair=pair), self.assertRaises(ValueError):
                diagnostic.absolute_field_changes(self.fields(), self.fields(), *pair)
        for pair in diagnostic.CHANGE_PAIRS:
            result = diagnostic.absolute_field_changes(self.fields(), self.fields(), *pair)
            self.assertEqual(result["by_domain"]["normal"]["quantities"]["V"]["components"][0]["cell_index"],0)
            self.assertIn("zero is not convergence",result["interpretation"])

    def test_absolute_changes_carrier_count_and_component_mismatch_refused(self):
        mutations = (("shape",(1,2,1)),("origin_m",(1e-9,0.0,0.0)),
            ("step_m",(2e-9,1e-9,1e-9)),("valuedim",2),("values",[[0.0,0.0,0.0]]))
        for attribute, value in mutations:
            after = self.fields()
            setattr(after["normal"]["Jsy"], attribute, value)
            with self.subTest(attribute=attribute), self.assertRaises(ValueError):
                diagnostic.absolute_field_changes(self.fields(), after, 1, 2)

    def test_absolute_changes_input_and_derived_nonfinite_refused(self):
        for value in (float("nan"),float("inf"),float("-inf")):
            after = self.fields(); after["ferromagnet"]["Jsx"].values[1][2] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                diagnostic.absolute_field_changes(self.fields(),after,1,2)
        before, after = self.fields(), self.fields()
        before["normal"]["V"].values[0][0] = -1e308
        after["normal"]["V"].values[0][0] = 1e308
        with self.assertRaises(ValueError):diagnostic.absolute_field_changes(before,after,1,2)
        after = self.fields();after["normal"]["Jsz"].values[0][0] = 1e308
        with self.assertRaises(ValueError):diagnostic.absolute_field_changes(self.fields(),after,1,2)

    def test_reordered_native_snapshots_refused_before_reading_fields(self):
        case=diagnostic.descriptor();proof=self.proof()
        reads=dict(dataprecision=17,normal=deepcopy(common.PARAMETERS['boris_normal']),ferromagnet=deepcopy(common.PARAMETERS['boris_ferromagnet']),
            transport_config=[1e-5,200],spin_config=[1e-5,200],potential_v=common.VOLTAGE_V)
        native=dict(schema=diagnostic.SCHEMA+'.native',scenario=case,readbacks=reads,
            snapshots=[dict(command_count=n,native_counters=dict(v_iter=2,s_iter=2,ts_err=0.0)) for n in (2,1,4,8)])
        probe=dict(solver_exit_protocol=diagnostic.EXIT_PROTOCOL,solver_exit_code=0,binary_sha256=proof['binary_sha256'],embedded_python_version='python')
        with patch.object(diagnostic,'output_closure',return_value=[]),patch.object(legacy,'read_json',side_effect=[native,probe]), \
             patch.object(Path,'read_text',return_value='BORIS_EMBEDDED_IDENTITY:{"python_version":"python"}\n'+diagnostic.MARKER), \
             patch.object(common,'read_fields') as fields:
            with self.assertRaisesRegex(ValueError,'snapshot order'):
                diagnostic.validate_outputs(Path('/not-read'),case,proof,{})
            fields.assert_not_called()

    def proof(self):
        return dict(binary_sha256="a"*64,original_source=dict(upstream_commit="048503d2ca6475e91b073eb1762ecf9d3634c3e1",
            files=[dict(path=k,sha256=v) for k,v in {**common.SOURCE_PINS,**diagnostic.SOURCE_PINS}.items()]))

    def test_generated_program_is_fixed_one_process_eight_requests(self):
        case,source,_=diagnostic.fixed_inputs();program=source.decode();tree=ast.parse(program)
        self.assertEqual(case['command_counts'],[1,2,4,8])
        self.assertEqual(case['base_case'],common.case_descriptor('r0'))
        calls=[n for n in ast.walk(tree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute) and n.func.attr=='computefields']
        self.assertEqual(len(calls),1)
        loop=next(n for n in tree.body if isinstance(n,ast.For) and isinstance(n.target,ast.Name) and n.target.id=='command_count')
        self.assertEqual([ast.literal_eval(n) for n in loop.iter.args],[1,9])
        self.assertIn('ns.showdata("conductor", key)',program)
        self.assertNotIn(common.MARKER,program)
        self.assertEqual(case['text_payload_precision'],6)
        self.assertIsNone(case['coupled_residual']['value'])
        self.assertFalse(case['physics_qualified'])
        self.assertNotEqual(case['schema'],common.CASE_SCHEMA)
        compile(program,'diagnostic-scenario.py','exec')

    def test_other_case_and_changed_generation_anchor_refused(self):
        for key in ('r1','r2','../r0',''):
            with self.subTest(case=key),self.assertRaises(ValueError):diagnostic.fixed_inputs(key)
        with patch.object(common,'render_script',return_value='changed rendering'):
            with self.assertRaisesRegex(ValueError,'anchor'):diagnostic.fixed_inputs()

    def test_counter_source_drift_refused(self):
        proof=self.proof();diagnostic.verify_source_contract(proof)
        for member in diagnostic.SOURCE_PINS:
            changed=deepcopy(proof)
            next(v for v in changed['original_source']['files'] if v['path']==member)['sha256']='0'*64
            with self.subTest(member=member),self.assertRaises(ValueError):diagnostic.verify_source_contract(changed)

    def test_missing_snapshots_and_legacy_case_refused(self):
        with self.assertRaisesRegex(ValueError,'missing'):diagnostic.output_closure(SimpleNamespace(rglob=lambda pattern:[]))
        with self.assertRaisesRegex(ValueError,'case differs'):diagnostic.validate_outputs(Path('/not-read'),common.case_descriptor('r0'),{}, {})

    def test_invalid_counters_refused_before_field_read(self):
        case=diagnostic.descriptor();proof=self.proof()
        reads=dict(dataprecision=17,normal=deepcopy(common.PARAMETERS['boris_normal']),ferromagnet=deepcopy(common.PARAMETERS['boris_ferromagnet']),
            transport_config=[1e-5,200],spin_config=[1e-5,200],potential_v=common.VOLTAGE_V)
        for bad in (0,201,'200',True,float('nan')):
            native=dict(schema=diagnostic.SCHEMA+'.native',scenario=case,readbacks=reads,
                snapshots=[dict(command_count=n,native_counters=dict(v_iter=bad,s_iter=2,ts_err=0.0)) for n in diagnostic.COUNTS])
            probe=dict(solver_exit_protocol=diagnostic.EXIT_PROTOCOL,solver_exit_code=0,binary_sha256=proof['binary_sha256'],embedded_python_version='python')
            with self.subTest(counter=bad),patch.object(diagnostic,'output_closure',return_value=[]),patch.object(legacy,'read_json',side_effect=[native,probe]), \
                 patch.object(Path,'read_text',return_value='BORIS_EMBEDDED_IDENTITY:{"python_version":"python"}\n'+diagnostic.MARKER),patch.object(common,'read_fields') as fields:
                with self.assertRaises(ValueError):diagnostic.validate_outputs(Path('/not-read'),case,proof,{})
                fields.assert_not_called()

    def test_complete_mock_report_keeps_scope_refusal_and_unavailable_residual(self):
        import hashlib
        case=diagnostic.descriptor();proof=self.proof();binding={'actual_native':'binding'}
        reads=dict(dataprecision=17,normal=deepcopy(common.PARAMETERS['boris_normal']),ferromagnet=deepcopy(common.PARAMETERS['boris_ferromagnet']),
            transport_config=[1e-5,200],spin_config=[1e-5,200],potential_v=common.VOLTAGE_V)
        native=dict(schema=diagnostic.SCHEMA+'.native',scenario=case,readbacks=reads,
            snapshots=[dict(command_count=n,native_counters=dict(v_iter=200,s_iter=2,ts_err=1e-5)) for n in diagnostic.COUNTS])
        probe=dict(solver_exit_protocol=diagnostic.EXIT_PROTOCOL,solver_exit_code=0,binary_sha256=proof['binary_sha256'],embedded_python_version='python')
        m=SimpleNamespace(sha256=hashlib.sha256(b'before').hexdigest(),values=[[8e5,0.0,0.0]])
        fields=self.fields()
        fields['ferromagnet'].update(M_before=m,M_after=m)
        with patch.object(diagnostic,'output_closure',return_value=[]),patch.object(legacy,'read_json',side_effect=[native,probe]), \
             patch.object(Path,'read_text',return_value='BORIS_EMBEDDED_IDENTITY:{"python_version":"python"}\n'+diagnostic.MARKER), \
             patch.object(Path,'read_bytes',return_value=b'before'),patch.object(Path,'exists',return_value=False), \
             patch.object(common,'read_fields',return_value=fields) as parsed, \
             patch.object(common,'check_affine_x_invariance',side_effect=ValueError('actual retained refusal')):
            _,_,report=diagnostic.validate_outputs(Path('/not-read'),case,proof,binding)
        self.assertEqual(parsed.call_count,4)
        self.assertEqual([(v['before_command_count'],v['after_command_count']) for v in report['absolute_field_changes']],[(1,2),(2,4),(4,8)])
        self.assertEqual(report['native'],binding)
        self.assertEqual(report['status'],'diagnostic_complete_unqualified')
        self.assertFalse(report['physics_qualified']);self.assertFalse(report['comparison_v3'])
        self.assertIsNone(report['coupled_residual']['value'])
        self.assertEqual([v['command_count'] for v in report['snapshots']],[1,2,4,8])
        self.assertTrue(all(v['cap_hit']['v_iter'] for v in report['snapshots']))
        self.assertTrue(all(v['existing_scope_gate']=='refused: actual retained refusal' for v in report['snapshots']))

if __name__ == '__main__':unittest.main()
