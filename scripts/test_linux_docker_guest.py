"""Interpreted checks for native Linux Docker storage admission."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch

GUEST = Path(__file__).resolve().parents[1] / 'docker/all-in-one'
sys.path.insert(0, str(GUEST))


def load(name):
    spec = importlib.util.spec_from_file_location(name, GUEST / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@unittest.skipIf(os.name == 'nt', 'Linux guest contract')
class LinuxGuestTest(unittest.TestCase):
    def setUp(self):
        self.entry = load('entrypoint')
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.state = self.root / 'state'
        self.state.mkdir()
        self.host_path = self.root / 'host.json'
        self.owner_path = self.state / '.fullmag-linux-native-owner.json'
        self.image = 'sha256:' + 'a' * 64
        self.owner_token = str(uuid.uuid4())
        self.payload = (self.owner_token + ':' + self.image).encode()
        self.uid, self.gid = os.getuid(), os.getgid()
        self.host = {
            'schema': 'fullmag.linux-native-host-certificate.v1',
            'storage_profile': 'linux-native-v1', 'role': 'session',
            'owner_scope': 'docker-local-unix', 'image_id': self.image,
            'owner_token': self.owner_token, 'engine_id': 'local-engine-1',
            'docker_host': {
                'profile': 'linux-native-v1', 'selection': 'DOCKER_CONTEXT',
                'context_name': 'default', 'endpoint': 'unix:///var/run/docker.sock',
                'daemon_id': 'a' * 64,
            },
            'host_root': '/home/operator/storage/runs/session/state',
            'filesystem': 'ext4', 'device': 1,
            'runtime_uid': self.uid, 'runtime_gid': self.gid,
            'source_commit': 'c' * 40, 'binary_hashes': {'backend': 'd' * 64},
            'artifact_receipt_sha256': 'e' * 64,
            'restart_verified': False,
            'restart_expected_sha256': hashlib.sha256(self.payload).hexdigest(),
            'development_build': {
                'schema': 'fullmag.linux-native-development-build.v1',
                'cargo_profile': 'backend-dev', 'toolchain_image_id': 'sha256:' + 'f' * 64,
                'package_root': '/opt/fullmag/package',
                'provenance_path': '/opt/fullmag/control/backend/runtime-provenance.json',
                'group_identity': 'fullmag-linux-test',
                'source_identity': {
                    'commit': 'c' * 40, 'source_digest': 'd' * 64,
                    'source_snapshot_sha256': 'e' * 64,
                    'native_source_identity_sha256': 'f' * 64,
                },
            },
        }
        self.write_host()
        self.environment = patch.dict(os.environ, FULLMAG_RUNTIME_IMAGE_ID=self.image,
                                      FULLMAG_SESSION_STORAGE_PROFILE='linux-native-v1',
                                      FULLMAG_BACKEND_CARGO_PROFILE='backend-dev',
                                      FULLMAG_COMPOSE_PROJECT='fullmag-linux-test')
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def write_host(self):
        raw = (json.dumps(self.host, ensure_ascii=True, sort_keys=True, indent=2) + '\n').encode()
        self.host_path.write_bytes(raw)
        self.host_path.chmod(0o600)
        self.owner_path.write_bytes(raw)
        self.owner_path.chmod(0o600)

    def probe(self, require_restart=False):
        return self.entry.linux_storage_probe(require_restart, self.state, self.host_path)

    def test_real_storage_operations_and_restart_readback(self):
        first = self.probe()
        self.assertFalse(first['checks']['restart_readback'])
        self.assertTrue(all(value for key, value in first['checks'].items() if key != 'restart_readback'))
        self.assertTrue(all(self.probe()['checks'].values()))
        with self.assertRaisesRegex(RuntimeError, 'restart'):
            self.probe(True)
        self.host['restart_verified'] = True
        self.write_host()
        self.assertTrue(all(self.probe(True)['checks'].values()))
        self.assertEqual(json.loads((self.state / '.fullmag-linux-native-probe.json').read_text())['checks'],
                         self.probe(True)['checks'])

    def test_host_readback_files_are_readable_under_restrictive_umask(self):
        previous = os.umask(0o077)
        try:
            self.probe()
        finally:
            os.umask(previous)
        for name in ('.linux-native-restart', '.fullmag-linux-native-probe.json'):
            self.assertEqual((self.state / name).stat().st_mode & 0o777, 0o600)

    def test_missing_or_corrupt_restart_is_rejected(self):
        self.host['restart_verified'] = True
        self.write_host()
        with self.assertRaisesRegex(RuntimeError, 'missing'):
            self.probe(True)
        self.host['restart_verified'] = False
        self.write_host()
        self.probe()
        self.host['restart_verified'] = True
        self.write_host()
        (self.state / '.linux-native-restart').write_bytes(b'corrupt')
        with self.assertRaisesRegex(RuntimeError, 'restart'):
            self.probe(True)

    def test_mismatched_certificate_and_sentinel_fail_before_publication(self):
        for field, value in [('image_id', 'sha256:' + 'c' * 64),
                             ('owner_token', '../owner'), ('restart_expected_sha256', '0' * 64),
                             ('storage_profile', 'windows-folder-v1')]:
            with self.subTest(field=field):
                previous = self.host[field]
                self.host[field] = value
                self.write_host()
                with self.assertRaises(RuntimeError):
                    self.probe()
                self.assertFalse((self.state / '.linux-native-restart').exists())
                self.assertFalse((self.state / '.linux-native-sentinel').exists())
                self.host[field] = previous
        self.write_host()
        (self.state / '.linux-native-sentinel').write_bytes(b'corrupt')
        with self.assertRaises(RuntimeError):
            self.probe()

    def test_nofollow_and_bounded_certificate(self):
        real = self.root / 'real.json'
        self.host_path.rename(real)
        self.host_path.symlink_to(real)
        with self.assertRaises(OSError):
            self.probe()
        self.host_path.unlink()
        self.host_path.write_bytes(b' ' * (1024 * 1024 + 1))
        with self.assertRaisesRegex(RuntimeError, 'oversized'):
            self.probe()
        self.write_host()
        self.probe()
        sentinel = self.state / '.linux-native-sentinel'
        sentinel.unlink()
        sentinel.symlink_to(real)
        with self.assertRaises(OSError):
            self.probe()

    def test_linux_rejects_non_native_fs_before_cuda_or_writes(self):
        for filesystem in ('1021997', '794c7630', '1021994', 'deadbeef'):
            with self.subTest(filesystem=filesystem), patch.object(self.entry.subprocess, 'check_output', return_value=filesystem), patch.object(self.entry.ctypes, 'CDLL') as cuda:
                with self.assertRaisesRegex(RuntimeError, 'native Linux'):
                    self.entry.preflight()
                cuda.assert_not_called()

    def test_restart_and_parent_symlinks_are_rejected(self):
        self.probe()
        restart = self.state / '.linux-native-restart'
        real = self.root / 'restart-real'
        restart.rename(real)
        restart.symlink_to(real)
        with self.assertRaises(OSError):
            self.probe()
        restart.unlink()
        real.rename(restart)
        held = self.root / 'held-state'
        self.state.rename(held)
        self.state.symlink_to(held, target_is_directory=True)
        with self.assertRaises(OSError):
            self.probe()

    def test_failed_capability_never_publishes_success(self):
        import windows_folder_probe
        with patch.object(windows_folder_probe, '_sqlite_probe', side_effect=RuntimeError('transaction failed')):
            with self.assertRaisesRegex(RuntimeError, 'transaction failed'):
                self.probe()
        self.assertFalse((self.state / '.fullmag-linux-native-probe.json').exists())

    def test_fifo_at_receipt_path_is_rejected_without_blocking(self):
        import stat

        receipt = self.state / '.fullmag-linux-native-probe.json'
        os.mkfifo(receipt)
        real_open = os.open
        observed_nonblocking_write = False

        def guarded_open(path, flags, *args, **kwargs):
            nonlocal observed_nonblocking_write
            if os.fspath(path) == receipt.name and flags & os.O_WRONLY:
                observed_nonblocking_write = bool(flags & os.O_NONBLOCK)
                if not observed_nonblocking_write:
                    raise AssertionError('receipt FIFO write must include O_NONBLOCK')
            return real_open(path, flags, *args, **kwargs)

        with patch.object(self.entry.os, 'open', side_effect=guarded_open), \
             self.assertRaises((OSError, RuntimeError)):
            self.probe()
        self.assertTrue(observed_nonblocking_write)
        self.assertTrue(stat.S_ISFIFO(receipt.lstat().st_mode))

    def test_static_release_certificate_does_not_require_development_delegation(self):
        host = dict(self.host)
        host['development_build'] = None
        with patch.dict(os.environ, FULLMAG_BACKEND_CARGO_PROFILE='release'):
            self.entry._validate_linux_host_certificate(host, self.image)
        with patch.dict(os.environ, FULLMAG_BACKEND_CARGO_PROFILE='backend-dev'):
            with self.assertRaisesRegex(RuntimeError, 'delegation'):
                self.entry._validate_linux_host_certificate(host, self.image)

    def test_native_fs_runs_admission_before_cuda(self):
        for filesystem in ('ef53', '58465342', '9123683e'):
            with self.subTest(filesystem=filesystem), patch.object(self.entry.subprocess, 'check_output', return_value=filesystem), patch.object(self.entry, 'linux_storage_probe') as admission, patch.object(self.entry.ctypes, 'CDLL', side_effect=RuntimeError('CUDA observed')):
                with self.assertRaisesRegex(RuntimeError, 'CUDA observed'):
                    self.entry.preflight()
                admission.assert_called_once_with(require_restart=True)

    def test_runtime_preserves_selected_profile(self):
        runtime = load('runtime_service')
        paths = runtime.canonical_paths()
        self.assertEqual(runtime.api_environment(paths)['FULLMAG_SESSION_STORAGE_PROFILE'], 'linux-native-v1')
        self.assertEqual(str(paths.host_certificate), '/run/fullmag/host-admission/linux-native-host.json')
        with patch.dict(os.environ, FULLMAG_SESSION_STORAGE_PROFILE='windows-folder-v1'):
            self.assertEqual(runtime.api_environment(runtime.canonical_paths())['FULLMAG_SESSION_STORAGE_PROFILE'], 'windows-folder-v1')
        with patch.dict(os.environ, FULLMAG_SESSION_STORAGE_PROFILE='unknown'):
            with self.assertRaises(runtime.RuntimeServiceError):
                runtime.api_environment(paths)


if __name__ == '__main__':
    unittest.main()
