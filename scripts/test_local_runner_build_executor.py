import tempfile
import unittest
from unittest.mock import Mock, patch
from contextlib import nullcontext
from pathlib import Path

from local_runner import build_executor as executor


class BuildExecutorTests(unittest.TestCase):
    def test_mutable_caches_do_not_reuse_legacy_root_owned_trees(self):
        root = Path('/storage')
        paths = executor.dependency_cache_paths(root, 'fem-cpu-release')
        legacy = root / 'cache' / 'windows' / 'fem-cpu'
        self.assertEqual(legacy / 'runner-uid-65532' / 'cargo', paths['cargo'])
        self.assertEqual(legacy / 'runner-uid-65532' / 'pnpm', paths['pnpm'])
        self.assertEqual(legacy / 'rustup', paths['rustup'])
        self.assertNotEqual(paths, executor.dependency_cache_paths(root, 'fem-gpu-release'))
        with self.assertRaises(ValueError):
            executor.dependency_cache_paths(root, '../untrusted')

    def test_new_cache_is_worker_owned_but_existing_cache_is_untouched(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            cache = root / 'cache'
            with patch.object(executor.os, 'chown', create=True) as chown:
                executor.prepare_cache_directory(cache, root)
                chown.assert_called_once_with(cache, 65532, 65532, follow_symlinks=False)
                chown.reset_mock()
                (cache / 'keep').write_text('existing')
                executor.prepare_cache_directory(cache, root)
                chown.assert_not_called()
                self.assertEqual('existing', (cache / 'keep').read_text())

    def test_empty_private_mount_is_assigned_to_worker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            target = root / 'execution'
            target.mkdir()
            with patch.object(executor.os, 'chown', create=True) as chown:
                executor.prepare_worker_directory(target, root)
            chown.assert_called_once_with(target, 65532, 65532, follow_symlinks=False)

    def test_existing_foreign_content_is_not_reowned(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            target = root / 'execution'
            target.mkdir()
            (target / 'keep').write_text('preserve')
            with patch.object(executor.os, 'chown', create=True) as chown:
                with self.assertRaisesRegex(ValueError, 'nonempty'):
                    executor.prepare_worker_directory(target, root)
            chown.assert_not_called()
            self.assertEqual('preserve', (target / 'keep').read_text())

    def test_disk_pressure_preserves_queued_job(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            queue = Mock()
            queue.active.return_value = []
            queue.next_queued.return_value = {'job_id': 'a' * 32}
            with patch.object(executor, 'JobQueue', return_value=queue), \
                 patch.object(executor, 'file_lock', return_value=nullcontext()), \
                 patch.object(executor.shutil, 'disk_usage', return_value=Mock(free=1024)):
                result = executor.execute_build({'storage_root': str(root), 'container_coordinator': True}, owner='test')
            self.assertEqual('waiting_for_disk', result['state'])
            queue.claim.assert_not_called()

    def test_profiles_are_closed(self):
        with self.assertRaises(ValueError):
            executor.profile_lane('shell-command')

    def test_build_command_has_only_scoped_mounts_and_no_socket(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            paths = {}
            for name in ('source', 'workspace', 'build', 'artifacts', 'trusted', 'cargo', 'rustup', 'pnpm'):
                paths[name] = root / name
                paths[name].mkdir()
            command = executor.build_command('a' * 32, 'b' * 64, 'fem-cpu-release',
                {'image_digest': 'sha256:' + 'c' * 64, 'cpus': 2, 'memory_bytes': 8 * 1024**3}, paths, root)
            self.assertEqual('create', command[0])
            self.assertNotIn('--privileged', command)
            self.assertNotIn('--gpus', command)
            self.assertNotIn('docker.sock', ' '.join(command))
            self.assertIn('type=bind,source=' + str(paths['source']) + ',target=/source,readonly', command)
            self.assertEqual(8, command.count('--mount'))

    def test_reject_mount_escape(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            paths = {name: root for name in ('source', 'workspace', 'build', 'artifacts', 'trusted', 'cargo', 'rustup', 'pnpm')}
            with self.assertRaises(ValueError):
                executor.build_command('a' * 32, 'b' * 64, 'fem-cpu-release',
                    {'image_digest': 'sha256:' + 'c' * 64, 'cpus': 2, 'memory_bytes': 8 * 1024**3}, paths, root)

    def test_mount_order_does_not_change_identity(self):
        mounts = [{'Type': 'bind', 'Source': 'C:/a', 'Destination': '/source', 'RW': False},
                  {'Type': 'bind', 'Source': 'C:/b', 'Destination': '/build', 'RW': True}]
        self.assertEqual(executor.mount_identity(mounts), executor.mount_identity(list(reversed(mounts))))

    def test_changed_mount_is_rejected(self):
        with self.assertRaises(executor.CoordinatorError):
            executor.attest_build_container({'Image': 'image', 'Mounts': []},
                {'image_digest': 'image', 'mounts': [('bind', 'unexpected', '/source', False)]})

    def test_missing_artifacts_cannot_be_success(self):
        import json
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            job = dict(job_id='a' * 32, source_digest='b' * 64, profile='fem-cpu-release')
            (root / 'build-receipt.json').write_text(json.dumps({**job, 'state': 'succeeded', 'qualification': 'NOT VERIFIED', 'artifacts': []}))
            with self.assertRaises(ValueError):
                executor.validate_build_receipt(root, job, {})

    def test_worker_isolation_is_attested(self):
        inspected = {'Image': 'image', 'Mounts': [], 'Config': {'User': '65532:65532'},
                     'HostConfig': {'Privileged': False, 'ReadonlyRootfs': True,
                                    'CapDrop': ['ALL'], 'SecurityOpt': ['no-new-privileges:true'],
                                    'NetworkMode': 'bridge'}}
        journal = {'image_digest': 'image', 'mounts': []}
        executor.attest_build_container(inspected, journal)
        inspected['HostConfig']['Privileged'] = True
        with self.assertRaises(executor.CoordinatorError):
            executor.attest_build_container(inspected, journal)


if __name__ == '__main__':
    unittest.main()
