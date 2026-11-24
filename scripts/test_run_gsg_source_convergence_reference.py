"""Input-authentication and single-dispatch checks; never scientific qualification."""
from contextlib import ExitStack
import hashlib
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

import run_gsg_source_convergence_reference as driver
import antenna_gsg_convergence_reference as gsg
import antenna_triangle_surface_oracle as triangle


def frame():
    values = {k: b'\x01\x02' for k in driver.KEPT}
    descriptors = {k: {'path': f'antenna/field_solutions/output/{k}.bin', 'byte_length': len(v),
                        'sha256': hashlib.sha256(v).hexdigest()} for k, v in values.items()}
    manifest = {'schema_version': 'antenna_field_solution.v2', 'status': 'inspection_only',
                'solution_id': 'output', 'payloads': descriptors}
    meta = json.dumps(manifest).encode()
    raw = b'FMACLB01' + struct.pack('<QI', len(meta), len(values)) + meta
    for name in sorted(values):
        path = descriptors[name]['path'].encode()
        raw += struct.pack('<H', len(path)) + path + struct.pack('<Q', len(values[name])) + values[name]
    return raw, manifest, values


def carrier():
    vertices = [(0., 0., 0.), (1., 0., 0.), (0., 1., 0.), (0., 0., 1.)]
    targets = [(-2., 0., -1.)] * 20
    targets[8], targets[16] = (0., 0., -1.), (2., 0., -1.)
    source = {'object_id': 'antenna', 'geometry_id': 'source', 'closure': {'kind': 'closed_geometry'},
              'mesh_digest': 'mesh', 'materials_digest': 'materials', 'authored_input_digest': 'authored',
              'stable_vertex_ids': [11, 12, 13, 14]}
    mesh = {'nodes': vertices, 'cells': {'types': ['tet4'], 'offsets': [0, 4], 'nodes': [0, 1, 2, 3]}}
    domain = {'nodes': targets, 'cells': {'nodes': [0, 1, 2, 3]}}
    ir = {'current_modules': [{'name': 'current', 'conservative_current_source': source,
                              'materials': [{'material': {'sigma_Spm': 35000000.}}]}],
          'geometry_assets': {'fem_mesh_assets': [{'geometry_name': 'source', 'mesh': mesh}],
                              'fem_domain_mesh_asset': {'mesh': domain}}}
    manifest = {'cell_count': 1, 'vertex_count': 4, 'source_object_id': 'antenna',
                'current_transport_id': 'current', 'full_closure': source['closure'],
                'requested_intent': {k: source[k] for k in ('mesh_digest', 'materials_digest', 'authored_input_digest')},
                'target_count': 20, 'source': {'source_current_a': 1., 'accepted_source_state_digest': 'state',
                                             'prepared_execution_digest': 'prepared'}, 'payloads': {k: {} for k in driver.KEPT}}
    current = [(1., 2., 3.)] * 4
    row = (0, 11, 12, 13, 14, *(v for xyz in vertices for v in xyz), *(v for j in current for v in j),
           .25, .25, .25, 1., 2., 3.)
    data = {'cells': struct.pack('<5Q30d', *row), 'vertex_xyz': driver.vector_bytes(vertices),
            'stable_vertex_ids': struct.pack('<4Q', 11, 12, 13, 14), 'conductivity': struct.pack('<d', 35000000.),
            'j_local_raw': driver.vector_bytes(current), 'j_center_raw': struct.pack('<3d', 1., 2., 3.),
            'sample_xyz': driver.vector_bytes(targets), 'sample_cells': struct.pack('<4I', 0, 1, 2, 3)}
    return ir, manifest, data, tuple(targets[i] for i in driver.INDICES)


class ReferenceInputTests(unittest.TestCase):
    def test_existing_bundle_frame_closure_is_verified(self):
        raw, manifest, values = frame()
        self.assertEqual(driver.decode_bundle(raw), (manifest, values))

    def test_mutated_payload_truncation_trailer_and_count_are_refused(self):
        raw, _, _ = frame()
        changed = bytearray(raw); changed[-1] ^= 1
        count = bytearray(raw); struct.pack_into('<I', count, 16, 0)
        for value in (raw[:19], raw[:-1], raw + b'0', bytes(changed), bytes(count)):
            with self.subTest(length=len(value)), self.assertRaises(ValueError):
                driver.decode_bundle(value)

    def test_full_carrier_and_current_are_authenticated(self):
        ir, meta, data, targets = carrier()
        result = driver.verify_carriers(ir, meta, data, 1, targets)
        self.assertEqual(result['cells'], 1)
        self.assertEqual(result['source_state_sha256'], 'state')

    def test_wrong_source_mesh_material_current_sampling_or_owner_refuses(self):
        for change in ('mesh', 'material', 'current', 'sample', 'owner', 'ordinal', 'local_xyz'):
            ir, meta, data, targets = carrier()
            if change == 'mesh': ir['geometry_assets']['fem_mesh_assets'][0]['mesh']['cells']['nodes'][0] = 1
            if change == 'material': data['conductivity'] = struct.pack('<d', 1.)
            if change == 'current': data['j_local_raw'] = b'\0' * 96
            if change == 'sample': targets = ((1., 2., 3.), *targets[1:])
            if change == 'owner': meta['current_transport_id'] = 'other'
            if change in ('ordinal', 'local_xyz'):
                values = list(struct.unpack('<5Q30d', data['cells']))
                values[0 if change == 'ordinal' else 5] = 1
                data['cells'] = struct.pack('<5Q30d', *values)
            with self.subTest(change=change), self.assertRaises(ValueError):
                driver.verify_carriers(ir, meta, data, 1, targets)

    def test_input_hash_and_symlink_are_checked(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory) / 'input'; p.write_bytes(b'abc')
            sha = hashlib.sha256(b'abc').hexdigest()
            self.assertEqual(driver.checked(p, sha, 3), b'abc')
            for digest, bound in (('0' * 64, 3), (sha, 2)):
                with self.assertRaises(ValueError): driver.checked(p, digest, bound)
            link = p.with_name('link'); link.symlink_to(p)
            with self.assertRaises(ValueError): driver.checked(link, sha, 3)

    def test_start_syncs_the_directory_after_the_file(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(driver, 'ATTEMPT', Path(directory)):
            with patch.object(driver, 'sync_directory', wraps=driver.sync_directory) as synced:
                driver.claim_once('a' * 64)
                synced.assert_called_once_with(Path(directory))
            self.assertTrue((Path(directory) / 'started.json').is_file())

    def test_first_start_is_durable_and_second_start_cannot_replace_it(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(driver, 'ATTEMPT', Path(directory)):
            driver.claim_once('a' * 64)
            raw = (Path(directory) / 'started.json').read_bytes()
            with self.assertRaises(FileExistsError): driver.claim_once('b' * 64)
            self.assertEqual((Path(directory) / 'started.json').read_bytes(), raw)
            self.assertEqual(json.loads(raw)['request_sha256'], 'a' * 64)


class ReferenceDispatchTests(unittest.TestCase):
    def run_main(self, failure_at=None, preflight=False):
        request = {'schema': 'fullmag.gsg-source-convergence-reference-request.v1', 'reference_checks': 9,
                   'automatic_retries': 0, 'tools': {name: 'a' * 64 for name in
                   ('antenna_gsg_convergence_reference.py', 'antenna_rt0_surface_oracle.py',
                    'antenna_triangle_surface_oracle.py', 'verify_archived_solution_http.py')},
                   'driver_sha256': 'b' * 64, 'wheel': str(driver.CONTROL / 'verification/mpmath-1.3.0-py3-none-any.whl'),
                   'proposal_sha256': gsg.PROPOSAL_SHA256}
        authorization = {'proposal_document_sha256': gsg.PROPOSAL_SHA256, 'independent_h_checks': 9,
                         'maximum_reference_seconds': 43200, 'maximum_reference_ram_bytes': 2147483648}
        def checked(path, digest, maximum):
            value = request if path.name == 'request.json' else authorization if path.name == 'user-authorization.json' else {}
            return json.dumps(value).encode()
        def load(number, *_args):
            data = {'cells': b'', 'h_raw': struct.pack('<60d', *([1.] * 60))}
            return data, {'case': number}
        calls, reports = [], {}
        def evaluate(_cells, target, count, shared, **kwargs):
            calls.append((target, count, shared))
            if failure_at == len(calls):
                raise triangle.Refusal('injected first-error refusal')
            return {'native_comparison': {'within_gate': True}, 'qualified_basis': False}
        budget = gsg.GsgSourceConvergenceBudget()
        with ExitStack() as stack:
            for owner, name, value in [(driver, 'checked', checked), (driver, 'Client', None),
                                      (driver, 'load_case', load), (driver, 'claim_once', None),
                                      (driver, 'write', lambda n, v: reports.update({n: dict(v)})),
                                      (driver.resource, 'setrlimit', None), (driver.os, 'sched_setaffinity', None),
                                      (driver.signal, 'signal', None), (driver.signal, 'alarm', None),
                                      (triangle, 'dependency_provenance', lambda: {}),
                                      (gsg, 'GsgSourceConvergenceBudget', lambda: budget),
                                      (gsg, 'evaluate_retained_field', evaluate)]:
                mock = stack.enter_context(patch.object(owner, name, **({'side_effect': value} if value else {})))
                if owner is driver and name == 'Client':
                    mock.return_value.json.return_value = {'run': None, 'session': 'same'}
            stack.enter_context(patch.object(sys, 'argv', ['driver', '--request-sha256', 'a' * 64] +
                                            (['--preflight'] if preflight else [])))
            result = driver.main()
        return result, calls, reports, budget

    def test_exact_nine_targets_share_one_budget_in_registered_order(self):
        code, calls, reports, budget = self.run_main()
        self.assertEqual(code, 0)
        self.assertEqual([(target, count) for target, count, _ in calls],
                         [(target, count) for _, count, _ in driver.CASES for target in gsg.TARGETS_M])
        self.assertTrue(all(shared is budget for _, _, shared in calls))
        self.assertEqual(reports['result.json']['checks_passed'], 9)
        self.assertFalse(reports['result.json']['qualified_basis'])

    def test_first_refusal_stops_series_without_next_point_or_retry(self):
        code, calls, reports, _ = self.run_main(failure_at=2)
        self.assertEqual(code, 2)
        self.assertEqual(len(calls), 2)
        self.assertEqual(reports['result.json']['checks_completed'], 1)
        self.assertEqual(reports['result.json']['failed_case'], '100nm')
        self.assertEqual(reports['result.json']['failed_target_index'], 8)

    def test_preflight_never_calls_reference_kernel(self):
        code, calls, reports, _ = self.run_main(preflight=True)
        self.assertEqual(code, 0)
        self.assertEqual(calls, [])
        self.assertEqual(reports, {})


if __name__ == '__main__':
    unittest.main()
