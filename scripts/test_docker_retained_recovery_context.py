"""Retained image replacement must preserve the original recovery capability."""
import hashlib
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, call, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_volume_dev as dev
import docker_volume_container_recovery as recovery


class RetainedRecoveryContextTests(unittest.TestCase):
    def setUp(self):
        self.auth = {
            'schema_version': recovery.AUTHORIZATION_SCHEMA,
            'request_id': '1eccf696-733d-4506-bbd7-9fd79ea602fa',
            'source_root': '/checkout', 'compose_project': 'fullmag-worktree-test',
            'backend_container_id': 'b' * 64, 'frontend_container_id': 'f' * 64,
            'old_image_id': 'sha256:' + 'a' * 64,
            **{key: 'd' * 64 for key in (
                'config_sha256', 'owner_sha256', 'launch_sha256',
                'operator_authorization_sha256', 'native_request_sha256',
                'attestation_sha256', 'manifest_sha256', 'prior_stop_journal_sha256')},
            **{key: '/opt/fullmag/control/recovery/' + key + '.json'
               for key in ('native_request_path', 'attestation_path', 'manifest_path')},
        }
        self.raw = recovery._canonical(self.auth)
        digest = hashlib.sha256(self.raw).hexdigest()
        self.env = {
            recovery.AUTHORIZATION_ENV: '/opt/fullmag/control/recovery/authorization.json',
            recovery.AUTHORIZATION_SHA_ENV: digest,
        }
        self.metadata = {
            'schema': 'fullmag.container-recovery.v1', 'request_id': self.auth['request_id'],
            'request_sha256': self.auth['native_request_sha256'],
            'attestation_sha256': self.auth['attestation_sha256'],
            'manifest_sha256': self.auth['manifest_sha256'],
            'authorization_sha256': digest,
            'stop_journal_sha256': self.auth['prior_stop_journal_sha256'],
            'removed_container_ids': [self.auth['backend_container_id'], self.auth['frontend_container_id']],
        }
        self.previous = {'attempt': '3' * 32, 'inputs': {'source_root': '/checkout'},
                         'container_recovery': self.metadata,
                         'container_recovery_environment': sorted(self.env)}
        self.document = {'services': {'backend': {'environment': self.env}}}
        self.control = Mock(project='fullmag-worktree-test')
        self.control.read.return_value = None

    def run_context(self, fresh_state=False):
        def control_bytes(_control, relative, *, optional=False):
            if relative.endswith('/receipt.json'):
                return None
            return self.raw

        with patch.object(recovery, '_control_bytes', side_effect=control_bytes):
            return dev._retained_recovery_context(self.control, self.previous, self.document, fresh_state=fresh_state)

    def test_keeps_exact_capability_and_original_request(self):
        result = self.run_context()
        self.assertEqual(result, {'recovery_environment': self.env, 'recovery_metadata': self.metadata})
        self.control.write.assert_not_called()

    def test_ordinary_recreation_does_not_acquire_recovery(self):
        self.previous.pop('container_recovery')
        self.document['services']['backend']['environment'] = {}
        with patch('docker_volume_pre_ack_retry.storage.resolve_layout') as resolve:
            self.assertEqual(self.run_context(), {})
        resolve.assert_not_called()
        journal_root = 'development/attempts/' + self.previous['attempt'] + '/pre-api-stop/'
        self.assertEqual(self.control.read.call_args_list, [
            call(journal_root + 'receipt.json', optional=True),
            call(journal_root + 'intent.json', optional=True),
        ])
        self.control.write.assert_not_called()

    def test_fresh_state_cannot_retarget_original_recovery(self):
        with self.assertRaisesRegex(dev.BuildControlError, 'original session'):
            self.run_context(fresh_state=True)

    def test_missing_capability_fields_fail_closed(self):
        for field in self.env:
            with self.subTest(field=field):
                original = self.document['services']['backend']['environment']
                self.document['services']['backend']['environment'] = {k: v for k, v in self.env.items() if k != field}
                with self.assertRaisesRegex(dev.BuildControlError, 'incomplete'):
                    self.run_context()
                self.document['services']['backend']['environment'] = original
        self.previous.pop('container_recovery')
        with self.assertRaisesRegex(dev.BuildControlError, 'incomplete'):
            self.run_context()

    def test_changed_authorization_or_metadata_is_rejected(self):
        self.raw += b' '
        with self.assertRaisesRegex(dev.BuildControlError, 'digest differs'):
            self.run_context()
        self.raw = recovery._canonical(self.auth)
        self.metadata['request_id'] = 'different'
        with self.assertRaisesRegex(dev.BuildControlError, 'metadata differs'):
            self.run_context()

    def test_other_source_or_project_is_rejected(self):
        self.previous['inputs']['source_root'] = '/other'
        with self.assertRaisesRegex(dev.BuildControlError, 'source or project'):
            self.run_context()
        self.previous['inputs']['source_root'] = '/checkout'
        self.control.project = 'foreign-group'
        with self.assertRaisesRegex(dev.BuildControlError, 'source or project'):
            self.run_context()

    def test_control_path_traversal_is_rejected(self):
        self.env[recovery.AUTHORIZATION_ENV] = '/opt/fullmag/control/../outside.json'
        with self.assertRaisesRegex(dev.BuildControlError, 'escapes'):
            self.run_context()

    def test_changed_environment_receipt_is_rejected(self):
        self.previous['container_recovery_environment'] = []
        with self.assertRaisesRegex(dev.BuildControlError, 'environment differs'):
            self.run_context()

    def test_completed_recovery_with_failed_successor_drops_old_authority(self):
        native_context = {'previous_config_sha256': 'c' * 64,
                          'native_restart_metadata': {'schema': 'native-stop'}}
        with patch.object(dev, '_validate_completed_recovery_receipt', return_value=True), \
                patch.object(dev, '_native_failed_stop_recovery_context', return_value=native_context):
            result = self.run_context()
        self.assertEqual(result, native_context)
        self.assertNotIn('recovery_environment', result)
        self.assertNotIn('recovery_metadata', result)

    def test_first_completed_recovery_without_successor_stop_keeps_authority(self):
        with patch.object(dev, '_validate_completed_recovery_receipt', return_value=True), \
                patch.object(dev, '_native_failed_stop_recovery_context', return_value=None):
            self.assertEqual(self.run_context(), {
                'recovery_environment': self.env, 'recovery_metadata': self.metadata})

    def test_pending_recovery_receipt_keeps_original_capability(self):
        pending = recovery._canonical({
            'schema_version': 'runtime_service_container_recovery.v1',
            'status': 'pending',
        })
        with patch.object(recovery, '_control_bytes', return_value=pending):
            self.assertFalse(dev._validate_completed_recovery_receipt(
                self.control, self.auth, recovery
            ))

    def test_recovered_receipt_with_wrong_outcome_fails_closed(self):
        recovered = recovery._canonical({
            'schema_version': 'runtime_service_container_recovery.v1',
            'status': 'recovered',
            'outcome': 'failed',
        })
        request_raw = recovery._canonical({'request_id': self.auth['request_id']})
        # The request is bound to the authorization, so the outcome check is
        # the one that must refuse the receipt.
        auth = {**self.auth, 'native_request_sha256': hashlib.sha256(request_raw).hexdigest()}

        def control_bytes(_control, relative, *, optional=False):
            return recovered if relative.endswith('/receipt.json') else request_raw

        with patch.object(recovery, '_control_bytes', side_effect=control_bytes), \
                patch.object(recovery, 'validate_request', side_effect=lambda request: request), \
                patch.object(recovery, 'expected_recovery_outcome', return_value='recovered'):
            with self.assertRaisesRegex(dev.BuildControlError, 'outcome differs from its request scope'):
                dev._validate_completed_recovery_receipt(self.control, auth, recovery)


if __name__ == '__main__':
    unittest.main()
