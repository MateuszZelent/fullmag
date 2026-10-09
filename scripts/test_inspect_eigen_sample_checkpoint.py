"""Interpreted integrity/disposition checks, not native checkpoint proof."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import inspect_eigen_sample_checkpoint as inspector
from inspect_eigen_sample_checkpoint import inspect_checkpoint, portable_parts


class CheckpointInspectionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='fullmag-checkpoint-inspection-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'sample-0003'
        self.root.mkdir()
        spectrum = json.dumps({'modes': [{'index': 7, 'frequency_real_hz': 9.7e9}]}).encode()
        self.spectrum = self.root / 'artifacts/eigen/spectrum.json'
        self.spectrum.parent.mkdir(parents=True)
        self.spectrum.write_bytes(spectrum)
        plan = self.root / 'point-plan.json'
        plan.write_bytes(b'{"k_sampling":{"kind":"single","k_vector":[0,-10000000,0]}}')
        def ref(path, relative):
            data = path.read_bytes()
            return {'relative_path': relative, 'size_bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
        self.manifest = {
            'schema': 'fullmag.single_k_checkpoint.internal.v1',
            'sample_index': 3, 'requested_global_k_rad_per_m': [0, -10e6, 0],
            'point_plan': ref(plan, 'point-plan.json'),
            'artifacts': [{**ref(self.spectrum, 'artifacts/eigen/spectrum.json'), 'source_relative_path': 'eigen/spectrum.json'}],
            'result_disposition': 'raw_native_returned', 'requires_postsolve': True,
            'campaign_complete': False, 'branch_tracking_complete': False,
            'scientific_qualification': 'NOT VERIFIED',
        }
        self.save()

    def save(self):
        (self.root / 'manifest.json').write_text(json.dumps(self.manifest), encoding='utf-8')

    def test_exact_bytes_inspected_without_acceptance(self):
        result = inspect_checkpoint(self.root)
        self.assertEqual(result['raw_modes'], [{'raw_mode_index': 7, 'frequency_real_hz': 9.7e9}])
        self.assertEqual(result['requested_global_k_rad_per_m'][1], -10e6)
        self.assertTrue(result['requires_postsolve'])
        self.assertFalse(result['campaign_complete'])
        self.assertEqual(result['scientific_qualification'], 'NOT VERIFIED')

    def test_legacy_manifest_reports_durability_as_unreported(self):
        result = inspect_checkpoint(self.root)
        self.assertEqual(result['integrity'], 'PASS')
        self.assertEqual(result['durability'], {
            'directory_sync_capability': 'unreported',
            'directory_sync_required_for_success': None,
            'directory_sync_policy': 'unreported',
            'directory_entries_synced': None,
            'power_loss_qualification': 'unreported',
        })

    def test_explicit_null_durability_is_not_treated_as_legacy(self):
        self.manifest['durability'] = None
        self.save()
        with self.assertRaisesRegex(ValueError, 'descriptor must be an object'):
            inspect_checkpoint(self.root)

    def test_supported_directory_sync_policy_does_not_preclaim_final_barrier(self):
        self.manifest['durability'] = {
            'directory_sync_capability': 'supported',
            'directory_sync_required_for_success': True,
            'directory_sync_policy': 'file_and_directory_entries_required_before_success',
            'directory_entries_synced': None,
            'power_loss_qualification': 'NOT VERIFIED',
        }
        self.save()
        result = inspect_checkpoint(self.root)
        self.assertEqual(result['durability']['directory_sync_capability'], 'supported')
        self.assertTrue(result['durability']['directory_sync_required_for_success'])
        self.assertIsNone(result['durability']['directory_entries_synced'])
        self.assertEqual(result['durability']['power_loss_qualification'], 'NOT VERIFIED')

    def test_windows_directory_names_are_explicitly_unverified(self):
        self.manifest['durability'] = {
            'directory_sync_capability': 'unavailable',
            'directory_sync_required_for_success': False,
            'directory_sync_policy': 'file_contents_only_directory_entries_unverified',
            'directory_entries_synced': False,
            'power_loss_qualification': 'NOT VERIFIED',
        }
        self.save()
        result = inspect_checkpoint(self.root)
        self.assertEqual(result['integrity'], 'PASS')
        self.assertEqual(result['durability']['directory_sync_capability'], 'unavailable')
        self.assertFalse(result['durability']['directory_sync_required_for_success'])
        self.assertIs(result['durability']['directory_entries_synced'], False)
        self.assertEqual(result['durability']['power_loss_qualification'], 'NOT VERIFIED')

    def test_reader_rejects_preclaimed_directory_sync_or_power_loss(self):
        self.manifest['durability'] = {
            'directory_sync_capability': 'supported',
            'directory_sync_required_for_success': True,
            'directory_sync_policy': 'file_and_directory_entries_required_before_success',
            'directory_entries_synced': True,
            'power_loss_qualification': 'NOT VERIFIED',
        }
        self.save()
        with self.assertRaisesRegex(ValueError, 'directory-sync observation'):
            inspect_checkpoint(self.root)
        self.manifest['durability']['directory_entries_synced'] = None
        self.manifest['durability']['power_loss_qualification'] = 'PASS'
        self.save()
        with self.assertRaisesRegex(ValueError, 'power-loss qualification'):
            inspect_checkpoint(self.root)

    def test_mutation_size_and_digest(self):
        for update in ({'size_bytes': 0}, {'sha256': '0' * 64}, {'size_bytes': True}):
            with self.subTest(update=update):
                original = dict(self.manifest['artifacts'][0])
                self.manifest['artifacts'][0].update(update)
                self.save()
                with self.assertRaises(ValueError):
                    inspect_checkpoint(self.root)
                self.manifest['artifacts'][0] = original
        self.save()
        self.spectrum.write_bytes(b'changed')
        with self.assertRaises(ValueError):
            inspect_checkpoint(self.root)

    def test_no_promotion(self):
        for key, value in [('campaign_complete', True), ('branch_tracking_complete', True),
                           ('requires_postsolve', False), ('scientific_qualification', 'PASS'),
                           ('result_disposition', 'accepted')]:
            with self.subTest(key=key):
                original = self.manifest[key]
                self.manifest[key] = value
                self.save()
                with self.assertRaises(ValueError):
                    inspect_checkpoint(self.root)
                self.manifest[key] = original

    def test_missing_commit_marker(self):
        (self.root / 'manifest.json').rename(self.root / 'incomplete-manifest.json')
        with self.assertRaises(ValueError):
            inspect_checkpoint(self.root)

    def test_unsafe_portable_paths(self):
        for value in ['', '/x', '../x', 'a/../b', 'a//b', './x', 'C:/x', 'a\\b',
                      'a.', 'a ', 'con.json', 'CON .json', 'a/LPT1', 'a/COM9.data', 'a/nuL/x', 'a\0b', 'a?b']:
            with self.subTest(path=value), self.assertRaises(ValueError):
                portable_parts(value)

    def test_aliases_and_mapping(self):
        self.manifest['artifacts'].append(dict(self.manifest['artifacts'][0]))
        self.save()
        with self.assertRaises(ValueError):
            inspect_checkpoint(self.root)

    def test_directory_case_alias(self):
        data = b'{}'
        self.manifest['artifacts'].append({'relative_path': 'artifacts/Eigen/diagnostics.json',
            'source_relative_path': 'Eigen/diagnostics.json', 'size_bytes': len(data),
            'sha256': hashlib.sha256(data).hexdigest()})
        self.save()
        with self.assertRaisesRegex(ValueError, 'case alias'):
            inspect_checkpoint(self.root)
        self.manifest['artifacts'] = self.manifest['artifacts'][:1]
        self.manifest['artifacts'][0]['source_relative_path'] = 'other.json'
        self.save()
        with self.assertRaises(ValueError):
            inspect_checkpoint(self.root)

    def test_nonfinite_or_bool_descriptor(self):
        for k in ([0, True, 0], [0, float('nan'), 0], [0, 10**1000, 0]):
            with self.subTest(k_type=type(k[1]).__name__):
                self.manifest['requested_global_k_rad_per_m'] = k
                self.save()
                with self.assertRaises(ValueError):
                    inspect_checkpoint(self.root)

    def test_size_limit(self):
        with self.assertRaises(ValueError):
            inspect_checkpoint(self.root, max_json_bytes=10)

    def test_duplicate_json_key(self):
        with (self.root / 'manifest.json').open('w', encoding='utf-8') as stream:
            stream.write('{"schema":"a","schema":"b"}')
        with self.assertRaises(ValueError):
            inspect_checkpoint(self.root)

    def test_closure_limits(self):
        for kwargs in ({'max_total_bytes': 10}, {'max_artifact_bytes': 1}, {'max_artifacts': 0}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                inspect_checkpoint(self.root, **kwargs)
        self.manifest['artifacts'].append(dict(self.manifest['artifacts'][0]))
        self.save()
        with self.assertRaises(ValueError):
            inspect_checkpoint(self.root, max_artifacts=1)

    def test_deep_json_is_controlled_error(self):
        (self.root / 'manifest.json').write_bytes(b'{"nested":' + b'[' * 1500 + b'0' + b']' * 1500 + b'}')
        with self.assertRaises(ValueError):
            inspect_checkpoint(self.root)

    def test_changed_open_file_identity_is_rejected(self):
        original = inspector.os.fstat
        def changed(fd):
            info = original(fd)
            return SimpleNamespace(st_dev=info.st_dev, st_ino=info.st_ino + 1, st_size=info.st_size,
                                   st_mode=info.st_mode, st_mtime_ns=info.st_mtime_ns, st_ctime_ns=info.st_ctime_ns)
        with patch.object(inspector.os, 'fstat', side_effect=changed), self.assertRaises(ValueError):
            inspect_checkpoint(self.root)

    def test_generic_reparse_is_rejected(self):
        original = Path.lstat
        def reparse(path):
            info = original(path)
            if path.name == 'manifest.json':
                return SimpleNamespace(st_mode=info.st_mode, st_file_attributes=0x400)
            return info
        with patch.object(Path, 'lstat', reparse), self.assertRaises(ValueError):
            inspect_checkpoint(self.root)

    def test_point_plan_and_namespace_binding(self):
        self.manifest['requested_global_k_rad_per_m'] = [0, 10e6, 0]
        self.save()
        with self.assertRaises(ValueError):
            inspect_checkpoint(self.root)
        self.manifest['requested_global_k_rad_per_m'] = [0, -10e6, 0]
        self.manifest['sample_index'] = 4
        self.save()
        with self.assertRaises(ValueError):
            inspect_checkpoint(self.root)

    def test_reparse_swap_after_open_prevents_read(self):
        original_open, original_fdopen, original_lstat = inspector.os.open, inspector.os.fdopen, Path.lstat
        state = {'opened': False, 'reads': 0}
        class SpyStream:
            def __init__(self, stream): self.stream = stream
            def __enter__(self): return self
            def __exit__(self, *args): self.stream.close()
            def fileno(self): return self.stream.fileno()
            def read(self, count):
                state['reads'] += 1
                return self.stream.read(count)
        def open_spy(*args, **kwargs):
            descriptor = original_open(*args, **kwargs)
            state['opened'] = True
            return descriptor
        def stat_spy(path):
            info = original_lstat(path)
            if state['opened'] and path.name == 'manifest.json':
                return SimpleNamespace(st_mode=info.st_mode, st_file_attributes=0x400)
            return info
        with patch.object(inspector.os, 'open', side_effect=open_spy), \
             patch.object(inspector.os, 'fdopen', side_effect=lambda *args: SpyStream(original_fdopen(*args))), \
             patch.object(Path, 'lstat', stat_spy), self.assertRaises(ValueError):
            inspect_checkpoint(self.root)
        self.assertEqual(state['reads'], 0)


if __name__ == '__main__':
    unittest.main()
