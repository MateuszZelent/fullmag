"""Fail-closed certificates for interpreted checks in an offline group helper."""
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_volume_checks as checks


def valid_result():
    return {
        'exit_code': 0, 'source_inputs_stable': True,
        'source_mount_readonly': True, 'control_mount_writable': True,
        'tmpdir': '/control/verification/offline-check-tmp', 'stdout': '', 'stderr': '',
        'source_files': {'/opt/fullmag/source/scripts/' + name + '.py': 'a' * 64
                         for name in ('test_fixture', 'docker_build_control', 'docker_volume_dev', 'docker_volume_activate',
                                      'docker_volume_stop_failed',
                                      'docker_volume_checks')},
    }


class OfflineCertificateTests(unittest.TestCase):
    def test_accepts_complete_certificate_and_preserves_failed_test_exit(self):
        result = valid_result()
        self.assertIs(checks._validate_offline_result(result, ['test_fixture']), result)
        result['exit_code'] = 1
        self.assertEqual(checks._validate_offline_result(result, ['test_fixture'])['exit_code'], 1)

    def test_selected_optional_implementation_cannot_be_omitted(self):
        for optional in checks.OPTIONAL_IMPLEMENTATIONS:
            result = valid_result()
            required = (*checks.BASE_IMPLEMENTATIONS, optional)
            with self.subTest(implementation=optional):
                with self.assertRaises(checks.BuildControlError):
                    checks._validate_offline_result(result, ['test_fixture'], implementations=required)
                result['source_files']['/opt/fullmag/source/scripts/' + optional + '.py'] = 'b' * 64
                self.assertIs(checks._validate_offline_result(result, ['test_fixture'], implementations=required), result)

    def test_partial_malformed_or_false_certificate_cannot_pass(self):
        variants = [None, [], {'exit_code': 0}]
        for key in valid_result():
            missing = valid_result()
            missing.pop(key)
            variants.append(missing)
        for flag in ('source_inputs_stable', 'source_mount_readonly', 'control_mount_writable'):
            for value in (False, None, 1, 'true'):
                bad = valid_result()
                bad[flag] = value
                variants.append(bad)
        for code in (False, '0', None, 256):
            bad = valid_result()
            bad['exit_code'] = code
            variants.append(bad)
        for value in variants:
            with self.subTest(value=value):
                with self.assertRaises(checks.BuildControlError):
                    checks._validate_offline_result(value, ['test_fixture'])

    def test_unbound_or_malformed_source_map_cannot_pass(self):
        bad_maps = [{}, {'/tmp/test_fixture.py': 'a' * 64},
                    {'/opt/fullmag/source/scripts/../test_fixture.py': 'a' * 64},
                    {'/opt/fullmag/source/scripts/test_fixture.py': 'not-a-digest'}]
        for files in bad_maps:
            bad = valid_result()
            bad['source_files'] = files
            with self.subTest(files=files), self.assertRaises(checks.BuildControlError):
                checks._validate_offline_result(bad, ['test_fixture'])
        for name in valid_result()['source_files']:
            bad = valid_result()
            bad['source_files'].pop(name)
            with self.subTest(missing_source=name), self.assertRaises(checks.BuildControlError):
                checks._validate_offline_result(bad, ['test_fixture'])
        bad = valid_result()
        bad['compose_project'] = 'foreign'
        with self.assertRaises(checks.BuildControlError):
            checks._validate_offline_result(bad, ['test_fixture'])


if __name__ == '__main__':
    unittest.main()
