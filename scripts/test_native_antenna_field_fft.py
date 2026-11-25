"""Synthetic wire fixtures only: these tests are not evidence of a native solve."""
import hashlib
import importlib
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

try:
    post = importlib.import_module("native_antenna_field_fft")
except ModuleNotFoundError:
    post = None

PINS = ("prepared_execution_digest", "accepted_charge_field_digest",
        "accepted_source_state_digest", "view_identity_digest", "current_balance_certificate_digest")
PROFILE = dict(expected_count=4, expected_x_first_m=-1.5e-6, expected_step_m=1e-6)


def fixture(root, *, retained=False, parent_change=None, child_change=None, positions=None):
    """Minimal synthetic framing, never an accepted or scientifically qualified source."""
    xyz = np.array(positions if positions is not None else
                   [[-1.5e-6, 0, 0], [-.5e-6, 0, 0], [.5e-6, 0, 0], [1.5e-6, 0, 0]], dtype='<f8')
    h = np.zeros_like(xyz)
    h[2, 0] = -2e6
    payloads = {"cells": b'0'*280, "faces": b'0'*32, "vertex_xyz": b'0'*96,
                "stable_vertex_ids": struct.pack('<4Q', 0, 1, 2, 3),
                "sample_xyz": xyz.tobytes(), "sample_cells": struct.pack('<4I', 0, 1, 2, 3),
                "h_raw": h.tobytes()}
    parent = {"schema_version": "antenna_field_solution.v2", "status": "inspection_only",
              "solution_id": "synthetic", "source_object_id": "antenna", "port_mode_id": "port",
              "current_transport_id": "charge", "cell_count": 1, "vertex_count": 4,
              "target_count": len(xyz), "sample_cell_count": 1, "signed_normalization_a": -2.,
              "scale_per_a": -.5, "requested_intent": {"synthetic_test_fixture": True},
              "source": {**{key: str(i+1)*64 for i,key in enumerate(PINS)}, "source_current_a": -2., "source_current_orientation": "synthetic_signed_orientation"},
              "payloads": {}}
    for key, value in payloads.items():
        parent['payloads'][key] = dict(path=f'antenna/field_solutions/synthetic/{key}.bin',
            byte_length=len(value), sha256=hashlib.sha256(value).hexdigest(),
            unit={'sample_xyz':'m', 'h_raw':'A/m'}.get(key, '1'),
            layout='sample_xyz_f64_le' if key in ('sample_xyz','h_raw') else 'synthetic')
    if parent_change:
        parent_change(parent)
    header = json.dumps(parent).encode()
    raw = b'FMACLB01' + struct.pack('<QI', len(header), len(payloads)) + header
    for key in sorted(payloads):
        name = parent['payloads'][key]['path'].encode()
        raw += struct.pack('<H',len(name))+name+struct.pack('<Q',len(payloads[key]))+payloads[key]
    source = root/'synthetic-source.bundle'; source.write_bytes(raw)
    source_sha = hashlib.sha256(raw).hexdigest()
    args = dict(source_bundle=source, source_sha256=source_sha)
    if retained:
        selected = {key:payloads[key] for key in ('sample_xyz','sample_cells','h_raw')}
        selected['evidence'] = b'explicitly synthetic test evidence'
        child = dict(schema_version='antenna_retained_current_field_solution.v1', status='inspection_only',
                     qualification='not_verified', source_cell_count=1, source_vertex_count=4,
                     target_count=len(xyz), sample_cell_count=1, source_object_id='antenna',
                     current_transport_id='charge', port_mode_id='port',
                     parent={'owner':{'package':{'object_ref':source_sha}},
                             'source':{key:'sha256:'+parent['source'][key] for key in PINS}}, payloads={})
        for key,value in selected.items():
            child['payloads'][key] = dict(byte_count=len(value),sha256=hashlib.sha256(value).hexdigest(),
                unit={'sample_xyz':'m','h_raw':'A/m'}.get(key,'1'),
                layout='sample_xyz_f64_le' if key in ('sample_xyz','h_raw') else 'synthetic')
        if child_change:
            child_change(child)
        header = json.dumps(child).encode()
        raw = b'FMARCF1\0'+struct.pack('<Q',len(header))+header
        for value in selected.values():
            raw += struct.pack('<Q',len(value))+value
        field = root/'synthetic-field.bundle'; field.write_bytes(raw)
        args.update(field_bundle=field,field_sha256=hashlib.sha256(raw).hexdigest())
    return args


class NativeFieldFftTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(post, 'Private native-field postprocessor is not implemented')
        self.temp = tempfile.TemporaryDirectory(prefix='native-field-fft-test-',dir=Path(__file__).parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()

    def run_fixture(self, **kwargs):
        inputs = fixture(self.root, **kwargs)
        return post.run_postprocessor(**inputs,y_m=0.,z_m=0.,output_dir=self.root/'output',**PROFILE)

    def test_saved_signed_field_preserves_origin_phase_and_current_sign(self):
        inputs = fixture(self.root)
        data = post.load_native_field(**inputs)
        # Reordering must reorder H too; a different adaptive layer is irrelevant.
        ids = [2,0,3,1]
        xyz = np.vstack([data['positions_m'][ids], [9e-6, 1e-6, 0]])
        h = np.vstack([data['field_apm'][ids], [123,0,0]])
        x, normalized = post.extract_line(xyz,h,data['signed_current_a'],0.,0.,**PROFILE)
        np.testing.assert_array_equal(normalized, [0.,0.,1e6,0.])
        k,fminus,aplus = post.compute_spectrum(x,normalized)
        q = np.sqrt(.5)
        np.testing.assert_allclose(k, [-np.pi*1e6,-np.pi*.5e6,0,np.pi*.5e6])
        np.testing.assert_allclose(fminus, [1j,q+1j*q,1,q-1j*q],atol=1e-14)
        np.testing.assert_allclose(aplus, [2j,-2*q+2j*q,-2,-2*q-2j*q],atol=1e-14)

    def test_retained_child_success_preserves_inspection_and_writes_no_fake_reference(self):
        report = self.run_fixture(retained=True)
        self.assertEqual(report['verdict'],'FFT_POSTPROCESSING_PASS')
        self.assertEqual(report['source_status'],'inspection_only')
        self.assertEqual(report['publication_agreement'],'NOT_VERIFIED')
        self.assertFalse(report['native_spectrum_executed'])
        self.assertFalse(report['reference_comparison_performed'])
        self.assertEqual(report['requested_profile']['expected_count'],4)
        self.assertEqual(set(p.name for p in (self.root/'output').iterdir()),
                         {'result.json','input-manifest.json','field-profile.csv','spectrum.csv'})
        values = np.genfromtxt(self.root/'output/spectrum.csv',delimiter=',',names=True)
        np.testing.assert_allclose(values['A_plus_re'],[0,-np.sqrt(2),-2,-np.sqrt(2)],atol=1e-14)
        manifest = json.loads((self.root/'output/input-manifest.json').read_text())
        self.assertTrue(manifest['source_bundle']['verified'])
        self.assertTrue(manifest['field_bundle']['verified'])
        self.assertEqual(manifest.get('source_current_orientation'),'synthetic_signed_orientation')
        self.assertEqual(report.get('numpy_version'),np.__version__)

    def test_nonuniform_line_is_rejected_without_spectrum_artifacts(self):
        report = self.run_fixture(positions=[[-1.5e-6,0,0],[-.5e-6,0,0],[.6e-6,0,0],[1.5e-6,0,0]])
        self.assertEqual(report['verdict'],'INPUT_REJECTED')
        self.assertTrue(report['reason'])
        self.assertEqual(set(p.name for p in (self.root/'output').iterdir()),{'result.json','input-manifest.json'})

    def test_duplicate_missing_end_or_subsampled_line_is_rejected(self):
        x = [-1.5e-6,-.5e-6,.5e-6,1.5e-6]
        for values in (x+[x[1]],x[1:],x[:-1],x[::2]):
            with self.subTest(values=values),self.assertRaises(ValueError):
                post.extract_line(np.array([[v,0.,0.] for v in values]),np.zeros((len(values),3)),1.,0.,0.,**PROFILE)

    def test_exact_yz_selection_and_nonfinite_values_fail_closed(self):
        xyz = np.array([[-1.5e-6,0,0],[-.5e-6,0,0],[.5e-6,0,0],[1.5e-6,0,0]])
        for current,y,z in ((0.,0.,0.),(float('nan'),0.,0.),(float('inf'),0.,0.),(1.,1e-30,0.),(1.,0.,float('nan'))):
            with self.subTest(current=current,y=y,z=z),self.assertRaises(ValueError):
                post.extract_line(xyz,np.ones((4,3)),current,y,z,**PROFILE)
        for array in ('xyz','h'):
            p,h=xyz.copy(),np.ones((4,3))
            (p if array=='xyz' else h)[2,0]=float('nan')
            with self.subTest(array=array),self.assertRaises(ValueError):
                post.extract_line(p,h,1.,0.,0.,**PROFILE)

    def test_wrong_hash_source_units_layout_and_zero_current_are_rejected(self):
        changes=[lambda m:m['payloads']['h_raw'].update(unit='T'),
                 lambda m:m['payloads']['sample_xyz'].update(layout='wrong'),
                 lambda m:m['source'].update(source_current_a=0.),
                 lambda m:m.update(target_count=5)]
        for index,change in enumerate(changes):
            folder=self.root/str(index);folder.mkdir()
            with self.subTest(index=index),self.assertRaises(ValueError):
                post.load_native_field(**fixture(folder,parent_change=change))
        inputs=fixture(self.root)
        inputs['source_sha256']='0'*64
        with self.assertRaises(ValueError):post.load_native_field(**inputs)

    def test_each_child_parent_pin_owner_counts_units_and_hash_is_checked(self):
        changes=[lambda m,key=key:m['parent']['source'].__setitem__(key,'sha256:'+'0'*64) for key in PINS]
        changes.extend([lambda m:m['parent']['source'].pop(PINS[0]),
                        lambda m:m['parent']['owner']['package'].update(object_ref='0'*64),
                        lambda m:m.update(source_cell_count=2),lambda m:m.update(source_vertex_count=5),
                        lambda m:m.update(target_count=5),lambda m:m.update(port_mode_id='other'),
                        lambda m:m['payloads']['h_raw'].update(unit='T')])
        for index,change in enumerate(changes):
            folder=self.root/str(index);folder.mkdir()
            with self.subTest(index=index),self.assertRaises(ValueError):
                post.load_native_field(**fixture(folder,retained=True,child_change=change))
        inputs=fixture(self.root,retained=True); inputs['field_sha256']='0'*64
        with self.assertRaises(ValueError):post.load_native_field(**inputs)

    def test_finite_small_current_overflow_produces_refusal_not_infinite_fft(self):
        def tiny_current(parent):
            parent['source']['source_current_a'] = 1e-308
            parent['signed_normalization_a'] = 1e-308
            parent['scale_per_a'] = 1. / 1e-308
        report = self.run_fixture(parent_change=tiny_current)
        self.assertEqual(report['verdict'], 'INPUT_REJECTED')
        self.assertIn('not finite', report['reason'])
        self.assertFalse((self.root/'output/spectrum.csv').exists())
        self.assertEqual(json.loads((self.root/'output/result.json').read_text())['verdict'], 'INPUT_REJECTED')

    def test_reader_code_change_during_fft_refuses_csv_publication(self):
        inputs = fixture(self.root)
        reader_copy = self.root/'source_reader_copy.py'
        reader_copy.write_bytes(post.SOURCE_READER.read_bytes())
        before = hashlib.sha256(reader_copy.read_bytes()).hexdigest()
        original_compute = post.compute_spectrum
        def compute_then_change(*args):
            result = original_compute(*args)
            reader_copy.write_bytes(reader_copy.read_bytes()+b'\n# changed during postprocessing\n')
            return result
        with patch.object(post,'SOURCE_READER',reader_copy), patch.object(post,'compute_spectrum',side_effect=compute_then_change):
            report = post.run_postprocessor(**inputs,y_m=0.,z_m=0.,output_dir=self.root/'output',**PROFILE)
        self.assertEqual(report['verdict'],'INPUT_REJECTED')
        self.assertIn('code',report['reason'].lower())
        self.assertFalse((self.root/'output/spectrum.csv').exists())
        manifest = json.loads((self.root/'output/input-manifest.json').read_text())
        self.assertIn(before,manifest['code_sha256'].values())

    def test_existing_output_and_original_inputs_are_never_replaced(self):
        inputs=fixture(self.root); before=inputs['source_bundle'].read_bytes()
        out=self.root/'output';out.mkdir();(out/'keep').write_text('original')
        with self.assertRaises(FileExistsError):
            post.run_postprocessor(**inputs,y_m=0.,z_m=0.,output_dir=out,**PROFILE)
        self.assertEqual((out/'keep').read_text(),'original')
        self.assertEqual(inputs['source_bundle'].read_bytes(),before)

    def test_cli_requires_explicit_profile_and_reports_denial_with_exit_two(self):
        inputs=fixture(self.root)
        command=[sys.executable,'-B',str(Path(post.__file__)),
                 '--source-bundle',str(inputs['source_bundle']),'--source-sha256',inputs['source_sha256'],
                 '--y-m','0','--z-m','0','--output-dir',str(self.root/'output'),
                 '--expected-count','5','--expected-x-first-m','-1.5e-6','--expected-step-m','1e-6']
        # The equals form is required by argparse for negative scientific literals.
        command[command.index('--expected-x-first-m'):command.index('--expected-x-first-m')+2]=['--expected-x-first-m=-1.5e-6']
        completed=subprocess.run(command,capture_output=True,text=True)
        self.assertEqual(completed.returncode,2,completed.stderr)
        self.assertEqual(json.loads(completed.stdout)['verdict'],'INPUT_REJECTED')
        self.assertFalse((self.root/'output/spectrum.csv').exists())


if __name__ == '__main__':
    unittest.main()
