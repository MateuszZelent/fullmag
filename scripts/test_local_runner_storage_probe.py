import unittest
import os
import tempfile
import subprocess
from unittest.mock import patch
from pathlib import Path
from probe_docker_storage import command, canonical_mounts
from probe_docker_storage import enable_case_sensitive, CoordinatorError


class StorageProbeCommandTests(unittest.TestCase):
    @unittest.skipUnless(os.name == 'nt', 'Native Windows adapter')
    def test_fsutil_zero_exit_without_attribute_is_not_success(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch('probe_docker_storage.subprocess.run', return_value=subprocess.CompletedProcess([], 0, 'Access denied', '')), \
                 patch('probe_docker_storage.query_case_sensitive', return_value=False):
                with self.assertRaises(CoordinatorError):
                    enable_case_sensitive(Path(directory))

    def test_mount_order_is_not_mount_identity(self):
        first = [{'Destination': '/a', 'RW': False}, {'Destination': '/b', 'RW': True}]
        self.assertEqual(canonical_mounts(first), canonical_mounts(list(reversed(first))))
        self.assertNotEqual(canonical_mounts(first), canonical_mounts([{'Destination': '/a', 'RW': True}, first[1]]))

    def test_probe_is_bounded_offline_and_does_not_mount_docker_socket(self):
        args = command('a' * 32, 'sha256:' + 'b' * 64,
                       Path('C:/storage/probe.py'), Path('C:/storage/build'), Path('C:/storage/evidence'), 'build')
        self.assertNotIn('--rm', args)
        self.assertNotIn('--gpus', args)
        self.assertEqual('none', args[args.index('--network') + 1])
        self.assertEqual('65532:65532', args[args.index('--user') + 1])
        self.assertTrue(any('/probe-script.py,readonly' in arg for arg in args))
        self.assertFalse(any('docker.sock' in arg for arg in args))

    def test_role_is_not_an_arbitrary_command(self):
        with self.assertRaises(ValueError):
            command('a' * 32, 'sha256:' + 'b' * 64, Path('/s'), Path('/b'), Path('/a'), 'sh')

    def test_mutable_image_is_rejected(self):
        with self.assertRaises(ValueError):
            command('a' * 32, 'python:latest', Path('/s'), Path('/b'), Path('/a'), 'build')
