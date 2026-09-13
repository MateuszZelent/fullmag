import unittest
import struct
from unittest.mock import patch
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

    def test_stats_operation(self):
        import json
        from unittest.mock import patch
        from local_runner.unix_docker import docker

        fake_stats = {
            "memory_stats": {"usage": 52428800, "limit": 1073741824},
            "cpu_stats": {
                "cpu_usage": {"total_usage": 200000000, "percpu_usage": [100000000, 100000000]},
                "system_cpu_usage": 1000000000,
                "online_cpus": 2,
            },
            "precpu_stats": {
                "cpu_usage": {"total_usage": 100000000},
                "system_cpu_usage": 500000000,
            },
            "blkio_stats": {
                "io_service_bytes_recursive": [
                    {"op": "Read", "value": 1048576},
                    {"op": "Write", "value": 2097152},
                ]
            },
        }

        with patch("local_runner.unix_docker.engine", return_value=json.dumps(fake_stats).encode()) as mock_engine:
            result = docker(["stats", "--no-stream", "container-123"])
            self.assertIn("52428800B / 1073741824B", result)
            self.assertIn("40.0%", result)
            self.assertIn("1048576B / 2097152B", result)

            # Test argument position variation
            result_rev = docker(["stats", "container-123", "--no-stream"])
            self.assertEqual(result, result_rev)

            # The format value is not a container ID, regardless of flag order.
            result_with_format = docker([
                "stats", "container-123", "--format", "{{.MemUsage}}", "--no-stream"
            ])
            self.assertEqual(result, result_with_format)
            self.assertEqual(
                "/containers/container-123/stats?stream=false",
                mock_engine.call_args_list[-1][0][1],
            )

    def test_stats_operation_preserves_real_zero_counters(self):
        import json
        from unittest.mock import patch
        from local_runner.unix_docker import docker

        zero_stats = {
            "memory_stats": {"usage": 0, "limit": 0},
            "cpu_stats": {
                "cpu_usage": {"total_usage": 100},
                "system_cpu_usage": 1000,
                "online_cpus": 2,
            },
            "precpu_stats": {
                "cpu_usage": {"total_usage": 100},
                "system_cpu_usage": 500,
            },
            "blkio_stats": {
                "io_service_bytes_recursive": [
                    {"op": "Read", "value": 0},
                    {"op": "Write", "value": 0},
                ]
            },
        }

        with patch("local_runner.unix_docker.engine", return_value=json.dumps(zero_stats).encode()):
            self.assertEqual("0B / 0B|0.0%|0B / 0B", docker(["stats", "container-zero"]))

    def test_stats_operation_with_null_and_empty_metrics(self):
        import json
        from unittest.mock import patch
        from local_runner.unix_docker import docker

        empty_stats = {
            "memory_stats": None,
            "cpu_stats": None,
            "precpu_stats": None,
        }
        with patch("local_runner.unix_docker.engine", return_value=json.dumps(empty_stats).encode()):
            result = docker(["stats", "--no-stream", "container-empty"])
            self.assertEqual("N/A / N/A|N/A|N/A / N/A", result)

    def test_stats_operation_rejects_unsupported_or_ambiguous_arguments(self):
        from local_runner.unix_docker import docker

        with patch("local_runner.unix_docker.engine", return_value=b"{}"):
            with self.assertRaises(ValueError):
                docker(["stats", "--format"])
            with self.assertRaises(ValueError):
                docker(["stats", "container-a", "--format", "{{.ID}}", "container-b"])
            with self.assertRaises(ValueError):
                docker(["stats", "--all", "container-a"])


if __name__ == '__main__':
    unittest.main()
