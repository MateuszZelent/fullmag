"""Completion cannot silently bypass Docker ownership and retirement failures."""
from contextlib import nullcontext
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
