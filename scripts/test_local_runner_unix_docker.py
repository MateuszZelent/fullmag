import unittest
import struct
from local_runner.unix_docker import create_payload, decode_logs
from local_runner.container_main import desktop_daemon_root


class UnixDockerTests(unittest.TestCase):
    def test_closed_create_options(self):
        with self.assertRaises(ValueError):
            create_payload(['--privileged', '--name', 'unsafe', 'image'])

    def test_readonly_source_and_bounded_worker(self):
        name, config = create_payload(['--name', 'worker', '--read-only', '--cpus', '2',
            '--memory', '1024', '--mount', 'type=bind,source=/approved/source,target=/source,readonly',
            '--entrypoint', 'python3', 'sha256:' + 'a' * 64, '/runner/main.py'])
        self.assertEqual('worker', name)
        self.assertEqual(2 * 10**9, config['HostConfig']['NanoCpus'])
        self.assertTrue(config['HostConfig']['ReadonlyRootfs'])
        self.assertTrue(config['HostConfig']['Mounts'][0]['ReadOnly'])

    def test_log_frames(self):
        self.assertEqual('hello', decode_logs(b'\x01\0\0\0' + struct.pack('>I', 5) + b'hello'))
        with self.assertRaises(ValueError):
            desktop_daemon_root('relative/path')

    def test_desktop_mapping_keeps_scope(self):
        self.assertEqual('/run/desktop/mnt/host/c/project/storage', desktop_daemon_root('C:\\project\\storage'))
        with self.assertRaises(ValueError):
            desktop_daemon_root('C:\\project,readonly\\storage')


if __name__ == '__main__':
    unittest.main()
