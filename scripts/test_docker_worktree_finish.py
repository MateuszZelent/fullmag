"""Completion cannot silently bypass Docker ownership and retirement failures."""
from contextlib import nullcontext, redirect_stderr, redirect_stdout
import io
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

import docker_build_control as control
import docker_worktree_finish as finish
import docker_volume_cache_maintenance as maintenance
import fullmag_storage as storage


class WorktreeFinishTests(unittest.TestCase):
    def registry(self, root):
        index = root / 'index'
        index.mkdir()
        record = {'task_id': 'task', 'owner': 'owner', 'state': 'active'}
        (index / 'worktree.json').write_text(json.dumps(record))
        return {'storage_root': str(root), 'worktree_id': 'worktree', 'repo_root': str(root)}

    def test_foreign_owner_cannot_trigger_retirement(self):
        with tempfile.TemporaryDirectory() as tmp:
            layout = self.registry(Path(tmp))
            with patch.object(storage, 'initialize'), patch.object(storage, 'build_lock', return_value=nullcontext()), \
                    patch.object(storage, 'validate_path', side_effect=lambda path, *args: path), \
                    patch.object(finish, 'finish') as cleanup:
                with self.assertRaises(storage.StorageError):
                    storage.register(layout, 'task', 'foreign', 'finished', 'completed')
            cleanup.assert_not_called()

    def test_failed_retirement_preserves_active_registry(self):
        with tempfile.TemporaryDirectory() as tmp:
            layout = self.registry(Path(tmp))
            record = Path(tmp) / 'index/worktree.json'
            before = record.read_bytes()
            with patch.object(storage, 'initialize'), patch.object(storage, 'build_lock', return_value=nullcontext()), \
                    patch.object(storage, 'validate_path', side_effect=lambda path, *args: path), \
                    patch.object(finish, 'finish', side_effect=control.BuildControlError('active consumer')):
                with self.assertRaisesRegex(storage.StorageError, 'active consumer'):
                    storage.register(layout, 'task', 'owner', 'finished', 'completed')
            self.assertEqual(record.read_bytes(), before)

    def test_completion_saves_retirement_receipt_only_after_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            layout = self.registry(Path(tmp))
            proof = {'state': 'succeeded', 'receipt': 'docker-volume://control/cache-retirement/result.json'}
            with patch.object(storage, 'initialize'), patch.object(storage, 'build_lock', return_value=nullcontext()), \
                    patch.object(storage, 'validate_path', side_effect=lambda path, *args: path), \
                    patch.object(storage, 'git', return_value='commit'), patch.object(finish, 'finish', return_value=proof):
                result = storage.register(layout, 'task', 'owner', 'finished', 'completed')
            self.assertEqual(result['state'], 'completed')
            self.assertEqual(result['docker_cache_retirement'], proof)

    def test_completion_never_retires_main_checkout(self):
        with patch.object(finish, 'compose_project_identity', return_value={'checkout_kind':'main-checkout'}), \
                patch.object(finish, 'BuildControl') as create:
            with self.assertRaisesRegex(control.BuildControlError, 'main checkout'):
                finish.finish({}, 'task', 'owner')
            create.assert_not_called()

    def test_explicit_local_helper_retires_source_only_without_compose(self):
        image = 'sha256:' + 'a' * 64
        identity = {'checkout_kind': 'worktree', 'source_root': '/legacy-source'}
        instance = SimpleNamespace(prepare=lambda **kwargs: None, image=image,
                                   project='fullmag-worktree-legacy', volume='control',
                                   subpath=lambda path: path)
        with patch.object(finish, 'compose_project_identity', return_value=identity), \
                patch.object(finish, 'toolchain_configuration', side_effect=AssertionError('legacy has no Compose')), \
                patch.object(finish, '_exact_local_image_id', return_value=True, create=True), \
                patch.object(finish, 'BuildControl', return_value=instance) as create, \
                patch('docker_backend_volume_cache._safe_project_id', return_value='project'), \
                patch('docker_cache_retirement.retire', return_value={'state': 'succeeded'}) as retire:
            result = finish.finish({}, 'task', 'owner', helper_image=image)
        create.assert_called_once_with(identity, image)
        self.assertEqual(retire.call_args.args[:4], (instance, {}, 'task', 'owner'))
        self.assertEqual(result['state'], 'succeeded')
        self.assertEqual(result['control_helper_image'], image)

    def test_explicit_helper_must_be_installed_immutable_image_before_prepare(self):
        for image, installed in [('latest', True), ('sha256:' + 'a' * 64, False)]:
            with self.subTest(image=image, installed=installed), \
                    patch.object(finish, 'compose_project_identity', return_value={'checkout_kind': 'worktree', 'source_root': '/legacy'}), \
                    patch.object(finish, '_exact_local_image_id', return_value=installed, create=True), \
                    patch.object(finish, 'toolchain_configuration') as configure, \
                    patch.object(finish, 'BuildControl') as create:
                with self.assertRaises(control.BuildControlError):
                    finish.finish({}, 'task', 'owner', helper_image=image)
                configure.assert_not_called()
                create.assert_not_called()

    def test_completed_registry_forwards_helper_image_after_owner_check(self):
        with tempfile.TemporaryDirectory() as tmp:
            layout = self.registry(Path(tmp))
            image = 'sha256:' + 'a' * 64
            with patch.object(storage, 'initialize'), patch.object(storage, 'build_lock', return_value=nullcontext()), \
                    patch.object(storage, 'validate_path', side_effect=lambda path, *args: path), \
                    patch.object(storage, 'git', return_value='commit'), \
                    patch.object(finish, 'finish', return_value={'state': 'succeeded'}) as cleanup:
                storage.register(layout, 'task', 'owner', 'finished', 'completed', retirement_helper_image=image)
            self.assertEqual(cleanup.call_args.kwargs['helper_image'], image)

    def test_helper_image_cannot_be_passed_for_noncompletion_state(self):
        with patch.object(storage, 'initialize') as initialize:
            with self.assertRaises(storage.StorageError):
                storage.register({}, 'task', 'owner', 'reason', 'blocked', retirement_helper_image='sha256:'+'a'*64)
        initialize.assert_not_called()

    def test_cli_passes_explicit_helper_only_for_completion(self):
        image = 'sha256:' + 'a' * 64
        arguments = ['finish', '--task-id', 'task', '--owner', 'owner', '--purpose', 'finished',
                     '--state', 'completed', '--retirement-helper-image', image]
        with patch.object(storage, 'resolve_layout', return_value={}), \
                patch.object(storage, 'register', return_value={'state': 'completed'}) as register, \
                redirect_stdout(io.StringIO()):
            self.assertEqual(storage.main(arguments), 0)
        self.assertEqual(register.call_args.kwargs['retirement_helper_image'], image)
        for action, state in [('register', 'completed'), ('resolve', 'completed'), ('finish', 'blocked')]:
            with self.subTest(action=action, state=state), \
                    patch.object(storage, 'resolve_layout') as resolve, redirect_stderr(io.StringIO()):
                self.assertEqual(storage.main([action, '--state', state, '--retirement-helper-image', image]), 2)
                resolve.assert_not_called()

    def test_guest_maintenance_propagates_success_and_failure(self):
        proof = {'schema':'fullmag.package-maintenance.v1', 'state':'succeeded', 'retained':['current','direct-rollback']}
        for code in (0, 1):
            with self.subTest(code=code):
                process = SimpleNamespace(stdout=io.BytesIO(json.dumps(proof).encode()+b'\n'), wait=lambda:code)
                operation = {'receipt':{}, 'logger':SimpleNamespace(stdin=io.BytesIO()), 'daemon_pending':False}
                with patch.object(maintenance.subprocess, 'Popen', return_value=process):
                    if code:
                        with self.assertRaises(control.BuildControlError):
                            maintenance.run_guest_maintenance(operation, 'a'*64)
                    else:
                        self.assertEqual(maintenance.run_guest_maintenance(operation, 'a'*64), proof)
                self.assertFalse(operation['daemon_pending'])


if __name__ == '__main__':
    unittest.main()
