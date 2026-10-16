import unittest
import struct
from unittest.mock import patch
from local_runner.coordinator import CoordinatorError
from local_runner.unix_docker import create_payload, decode_logs
from local_runner.container_main import desktop_daemon_root


class UnixDockerTests(unittest.TestCase):
    def test_retention_uses_complete_logs_and_exact_nonforced_container_delete(self):
        from local_runner.unix_docker import docker
        identifier = 'a' * 64
        with patch('local_runner.unix_docker.engine') as engine:
            with self.assertRaisesRegex(CoordinatorError, 'require stream_container_logs'):
                docker(['logs', identifier])
            engine.assert_not_called()
        with patch('local_runner.unix_docker.engine', return_value=b'') as engine:
            self.assertEqual(identifier, docker(['rm', identifier]))
            engine.assert_called_once_with('DELETE', '/containers/' + identifier + '?force=false&v=false')
            with self.assertRaises(ValueError):
                docker(['rm', '--force', identifier])

    def test_lossy_decoder_is_separate_from_retention_stream_api(self):
        from local_runner.unix_docker import docker
        frame = b'\x01\0\0\0' + struct.pack('>I', 2) + b'\xff\n'
        with patch('local_runner.unix_docker.engine') as engine:
            with self.assertRaisesRegex(CoordinatorError, 'require stream_container_logs'):
                docker(['logs', 'a' * 64])
            engine.assert_not_called()
        self.assertEqual('\ufffd\n', decode_logs(frame))

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

    def test_coordinator_create_options_map_to_exact_engine_fields(self):
        from local_runner.container_client import CONTAINER_NAME
        from local_runner.unix_docker import create_payload

        name, config = create_payload([
            '--name', CONTAINER_NAME,
            '--hostname', CONTAINER_NAME,
            '--restart', 'unless-stopped',
            '--publish', '127.0.0.1:48765:48765',
            'sha256:' + 'a' * 64,
        ])

        self.assertEqual(CONTAINER_NAME, name)
        self.assertEqual(CONTAINER_NAME, config['Hostname'])
        self.assertEqual({'Name': 'unless-stopped'}, config['HostConfig']['RestartPolicy'])
        self.assertEqual({'48765/tcp': {}}, config['ExposedPorts'])
        self.assertEqual(
            {'48765/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '48765'}]},
            config['HostConfig']['PortBindings'],
        )

    def test_coordinator_create_options_reject_unsafe_values(self):
        from local_runner.unix_docker import create_payload

        invalid_options = (
            ['--hostname', 'bad hostname'],
            ['--hostname', '../runner'],
            ['--restart', 'always'],
            ['--publish', '0.0.0.0:48765:48765'],
            ['--publish', '127.0.0.1:0:48765'],
            ['--publish', '127.0.0.1:48765:65536'],
            ['--publish', '127.0.0.1:048765:48765'],
        )
        for options in invalid_options:
            with self.subTest(options=options):
                with self.assertRaises(ValueError):
                    create_payload([*options, 'sha256:' + 'a' * 64])

    def test_container_client_start_uses_unix_engine_create_contract(self):
        import json
        import tempfile
        from pathlib import Path
        from local_runner import container_client, unix_docker

        image_id = 'sha256:' + 'a' * 64
        container_id = 'b' * 64
        owner = 'managed-modal-test'
        started = False
        create_payloads = []
        engine_calls = []

        with tempfile.TemporaryDirectory() as temporary_directory:
            storage = Path(temporary_directory) / 'storage'
            layout = {'storage_root': str(storage)}
            public = container_client.configure(
                layout, image_id=image_id, owner=owner, enable_slepc_modal=True,
            )
            secret_path = storage / 'index' / 'local-runner-container-secret.json'
            port = public['port']

            def inspected_container():
                return {
                    'Id': container_id,
                    'Name': '/' + container_client.CONTAINER_NAME,
                    'Image': image_id,
                    'Config': {
                        'Hostname': container_client.CONTAINER_NAME,
                        'Labels': container_client._container_labels(owner),
                    },
                    'HostConfig': {
                        'RestartPolicy': {'Name': 'unless-stopped'},
                        'PortBindings': {
                            f'{port}/tcp': [{'HostIp': '127.0.0.1', 'HostPort': str(port)}],
                        },
                    },
                    'Mounts': [
                        {'Type': 'bind', 'Source': str(storage), 'Destination': '/storage', 'RW': True},
                        {
                            'Type': 'bind', 'Source': str(secret_path),
                            'Destination': '/control/config.json', 'RW': False,
                        },
                        {
                            'Type': 'bind', 'Source': '/var/run/docker.sock',
                            'Destination': '/var/run/docker.sock', 'RW': True,
                        },
                    ],
                    'State': {
                        'Status': 'running' if started else 'created',
                        'Running': started,
                        'ExitCode': 0,
                    },
                }

            def fake_engine(method, path, payload=None):
                nonlocal started
                engine_calls.append((method, path))
                if method == 'GET' and path.startswith('/images/') and path.endswith('/json'):
                    return json.dumps({'Id': image_id}).encode('utf-8')
                if method == 'GET' and path.startswith('/containers/json?'):
                    return b'[]'
                if method == 'POST' and path.startswith('/containers/create?'):
                    create_payloads.append(payload)
                    return json.dumps({'Id': container_id}).encode('utf-8')
                if method == 'GET' and path == f'/containers/{container_id}/json':
                    return json.dumps(inspected_container()).encode('utf-8')
                if method == 'POST' and path == f'/containers/{container_id}/start':
                    started = True
                    return b''
                self.fail(f'Unexpected Docker Engine request: {method} {path}')

            with patch('local_runner.unix_docker.engine', side_effect=fake_engine):
                with patch(
                    'local_runner.container_client._verify_startup_profile_activation',
                    return_value=(None, {'status': 'active'}),
                ):
                    status = container_client.start(layout, owner=owner, call=unix_docker.docker)

        self.assertTrue(started)
        self.assertEqual(container_id, status['container_id'])
        self.assertTrue(status['running'])
        self.assertEqual(1, len(create_payloads))
        created = create_payloads[0]
        self.assertEqual(container_client.CONTAINER_NAME, created['Hostname'])
        self.assertEqual({'Name': 'unless-stopped'}, created['HostConfig']['RestartPolicy'])
        self.assertEqual(
            {f'{port}/tcp': [{'HostIp': '127.0.0.1', 'HostPort': str(port)}]},
            created['HostConfig']['PortBindings'],
        )
        self.assertEqual(
            [
                ('POST', f'/containers/create?name={container_client.CONTAINER_NAME}'),
                ('POST', f'/containers/{container_id}/start'),
            ],
            [call for call in engine_calls if call[0] == 'POST'],
        )

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
