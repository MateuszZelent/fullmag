import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from local_runner import coordinator, unix_docker
from local_runner.coordinator import CoordinatorError


class _SplitResponse:
    status = 200

    def __init__(self, content, max_read=2):
        self.content = bytearray(content)
        self.max_read = max_read

    def read(self, size):
        count = min(size, self.max_read, len(self.content))
        data = bytes(self.content[:count])
        del self.content[:count]
        return data


class _FakeConnection:
    def __init__(self, response):
        self.response = response
        self.requested = None
        self.closed = False

    def request(self, method, path):
        self.requested = (method, path)

    def getresponse(self):
        return self.response

    def close(self):
        self.closed = True


def _frame(stream_id, payload):
    return bytes((stream_id, 0, 0, 0)) + len(payload).to_bytes(4, 'big') + payload


class DockerLogStreamingTests(unittest.TestCase):
    def test_windows_adapter_attests_desktop_and_uses_streaming_process_helper(self):
        context = SimpleNamespace(
            returncode=0,
            stdout=json.dumps([{
                'Endpoints': {'docker': {'Host': 'npipe:////./pipe/dockerDesktopLinuxEngine'}}
            }]),
            stderr='',
        )
        emit = lambda _channel, _payload: None
        with patch('local_runner.coordinator.os.name', 'nt'), \
                patch('local_runner.coordinator.shutil.which', return_value='docker.exe'), \
                patch('local_runner.coordinator.subprocess.run', return_value=context) as run, \
                patch('local_runner.coordinator._stream_process_logs',
                      return_value='stdout_then_stderr') as stream:
            order = coordinator.stream_container_logs(
                'c' * 64,
                emit,
                spool_directory='.',
            )

        self.assertEqual('stdout_then_stderr', order)
        run.assert_called_once_with(
            ['docker.exe', 'context', 'inspect', 'desktop-linux'],
            capture_output=True,
            text=True,
            timeout=30,
            env={key: value for key, value in os.environ.items()
                 if key not in ('DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH')},
        )
        stream.assert_called_once()
        self.assertEqual(
            ['docker.exe', '--context', 'desktop-linux', 'logs', '--tail', 'all', 'c' * 64],
            stream.call_args.args[0],
        )
        self.assertIs(stream.call_args.args[1], emit)
        self.assertEqual('.', stream.call_args.kwargs['spool_directory'])
        self.assertEqual(coordinator._LOG_STREAM_TIMEOUT_SECONDS,
                         stream.call_args.kwargs['timeout_seconds'])

    def test_windows_buffered_full_logs_call_is_refused(self):
        with patch('local_runner.coordinator.os.name', 'nt'), \
                patch('local_runner.coordinator.subprocess.run') as run:
            for arguments in (
                ['logs', 'd' * 64],
                ['logs', '--tail', 'all', 'd' * 64],
                ['logs', '--tail=all', 'd' * 64],
            ):
                with self.subTest(arguments=arguments):
                    with self.assertRaisesRegex(CoordinatorError, 'require stream_container_logs'):
                        coordinator.docker(arguments)
        run.assert_not_called()

    def test_unix_demux_handles_split_headers_payloads_and_preserves_frame_order(self):
        content = _frame(1, b'out') + _frame(2, b'err') + _frame(1, b'put')
        response = _SplitResponse(content, max_read=2)
        connection = _FakeConnection(response)
        events = []

        with patch('local_runner.unix_docker.UnixConnection', return_value=connection):
            order = unix_docker.stream_container_logs(
                'a' * 64,
                lambda channel, payload: events.append((channel, payload)),
                spool_directory=Path('.'),
                chunk_size=2,
            )

        self.assertEqual('engine_frame_arrival', order)
        self.assertEqual(('GET', '/v1.41/containers/' + 'a' * 64 + '/logs?stdout=1&stderr=1&tail=all'),
                         connection.requested)
        self.assertTrue(connection.closed)
        self.assertEqual(
            [('stdout', b'ou'), ('stdout', b't'), ('stderr', b'er'), ('stderr', b'r'),
             ('stdout', b'pu'), ('stdout', b't')],
            events,
        )

    def test_unix_stream_rejects_truncated_header_and_payload(self):
        for content in (
            b'\x01\x00\x00\x00',
            bytes((1, 0, 0, 0)) + (4).to_bytes(4, 'big') + b'ab',
        ):
            with self.subTest(content=content):
                connection = _FakeConnection(_SplitResponse(content))
                with patch('local_runner.unix_docker.UnixConnection', return_value=connection):
                    with self.assertRaisesRegex(CoordinatorError, 'Truncated Docker log frame'):
                        unix_docker.stream_container_logs(
                            'b' * 64,
                            lambda _channel, _payload: None,
                            spool_directory=Path('.'),
                        )
                self.assertTrue(connection.closed)

    def test_actual_cli_child_streams_over_16_mib_and_one_unterminated_line(self):
        size = 16 * 1024**2 + 123
        chunk_size = coordinator._LOG_STREAM_CHUNK_BYTES
        child = (
            'import os\n'
            'size = ' + str(size) + '\n'
            'def write_all(fd, value):\n'
            '    view = memoryview(value)\n'
            '    while view:\n'
            '        count = os.write(fd, view)\n'
            '        view = view[count:]\n'
            'remaining = size\n'
            'while remaining:\n'
            '    amount = min(65536, remaining)\n'
            "    write_all(1, b'o' * amount)\n"
            "    write_all(2, b'e' * amount)\n"
            '    remaining -= amount\n'
        )
        read_requests = []

        class ReadSpy:
            def __init__(self, stream):
                self.stream = stream

            def read(self, size):
                read_requests.append(size)
                return self.stream.read(size)

            def close(self):
                self.stream.close()

        class ProcessSpy:
            def __init__(self, process):
                self.process = process
                self.stdout = ReadSpy(process.stdout)
                self.stderr = ReadSpy(process.stderr)

            def __getattr__(self, name):
                return getattr(self.process, name)

        def popen_factory(command, **kwargs):
            return ProcessSpy(subprocess.Popen(command, **kwargs))

        digest = hashlib.sha256()
        counts = {'stdout': 0, 'stderr': 0}
        channels = []

        def emit(channel, payload):
            self.assertIn(channel, counts)
            self.assertLessEqual(len(payload), chunk_size)
            counts[channel] += len(payload)
            channels.append(channel)
            digest.update(payload)

        with tempfile.TemporaryDirectory() as directory:
            order = coordinator._stream_process_logs(
                [sys.executable, '-c', child],
                emit,
                spool_directory=directory,
                timeout_seconds=120,
                popen_factory=popen_factory,
            )
            self.assertEqual([], list(Path(directory).iterdir()))

        expected = hashlib.sha256()
        for byte, channel in ((b'o', 'stdout'), (b'e', 'stderr')):
            remaining = size
            while remaining:
                amount = min(chunk_size, remaining)
                expected.update(byte * amount)
                remaining -= amount
            self.assertEqual(size, counts[channel])

        first_stderr = channels.index('stderr')
        self.assertNotIn('stdout', channels[first_stderr:])
        self.assertEqual('stdout_then_stderr', order)
        self.assertEqual(expected.hexdigest(), digest.hexdigest())
        self.assertTrue(read_requests)
        self.assertLessEqual(max(read_requests), chunk_size)

    def test_actual_cli_child_nonzero_exit_is_not_emitted_as_complete_logs(self):
        child = (
            "import os\n"
            "os.write(1, b'partial output')\n"
            "os.write(2, b'docker failure')\n"
            "raise SystemExit(7)\n"
        )
        emitted = []
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(CoordinatorError, 'exit code 7'):
                coordinator._stream_process_logs(
                    [sys.executable, '-c', child],
                    lambda channel, payload: emitted.append((channel, payload)),
                    spool_directory=directory,
                    timeout_seconds=30,
                )
            self.assertEqual([], list(Path(directory).iterdir()))
        self.assertEqual([], emitted)

    def test_actual_cli_child_timeout_is_terminated_and_reaped(self):
        child = "import os, time; os.write(1, b'partial'); time.sleep(30)\n"
        processes = []
        emitted = []

        def popen_factory(command, **kwargs):
            process = subprocess.Popen(command, **kwargs)
            processes.append(process)
            return process

        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(CoordinatorError, 'timed out'):
                coordinator._stream_process_logs(
                    [sys.executable, '-c', child],
                    lambda channel, payload: emitted.append((channel, payload)),
                    spool_directory=directory,
                    timeout_seconds=0.2,
                    popen_factory=popen_factory,
                )
            self.assertEqual([], list(Path(directory).iterdir()))

        self.assertEqual(1, len(processes))
        self.assertIsNotNone(processes[0].poll())
        self.assertEqual([], emitted)

    def test_second_reader_start_failure_reaps_child_and_closes_spools(self):
        child = (
            'import os\n'
            'for _ in range(256):\n'
            "    os.write(1, b'o' * 65536)\n"
            "    os.write(2, b'e' * 65536)\n"
        )
        processes = []
        opened_spools = []
        emitted = []
        original_start = threading.Thread.start
        original_fdopen = os.fdopen
        starts = 0

        def popen_factory(command, **kwargs):
            process = subprocess.Popen(command, **kwargs)
            processes.append(process)
            return process

        def tracked_fdopen(descriptor, mode):
            stream = original_fdopen(descriptor, mode)
            opened_spools.append(stream)
            return stream

        def fail_second_start(thread):
            nonlocal starts
            starts += 1
            if starts == 2:
                raise RuntimeError('injected second reader start failure')
            return original_start(thread)

        with tempfile.TemporaryDirectory() as directory:
            with patch('local_runner.coordinator.os.fdopen', side_effect=tracked_fdopen), \
                    patch('local_runner.coordinator.threading.Thread.start', new=fail_second_start):
                with self.assertRaisesRegex(RuntimeError, 'injected second reader start failure'):
                    coordinator._stream_process_logs(
                        [sys.executable, '-c', child],
                        lambda channel, payload: emitted.append((channel, payload)),
                        spool_directory=directory,
                        timeout_seconds=30,
                        popen_factory=popen_factory,
                    )
            self.assertEqual([], list(Path(directory).iterdir()))

        self.assertEqual(2, starts)
        self.assertEqual(1, len(processes))
        self.assertIsNotNone(processes[0].poll())
        self.assertTrue(processes[0].stdout.closed)
        self.assertTrue(processes[0].stderr.closed)
        self.assertTrue(all(stream.closed for stream in opened_spools))
        self.assertEqual([], emitted)

    def test_live_reader_failure_preserves_its_pipe_and_spool(self):
        release_readers = threading.Event()
        started_threads = []
        pipes = []
        opened_spools = []
        original_start = threading.Thread.start
        original_fdopen = os.fdopen

        class BlockingPipe:
            def __init__(self):
                self.closed = False
                pipes.append(self)

            def read(self, _size):
                release_readers.wait()
                return b''

            def close(self):
                self.closed = True

        class Process:
            def __init__(self):
                self.stdout = BlockingPipe()
                self.stderr = BlockingPipe()
                self.returncode = None

            def wait(self, timeout=None):
                self.returncode = 0
                return 0

            def poll(self):
                return self.returncode

            def terminate(self):
                self.returncode = 0

            def kill(self):
                self.returncode = -9

        def capture_start(thread):
            started_threads.append(thread)
            return original_start(thread)

        def tracked_fdopen(descriptor, mode):
            stream = original_fdopen(descriptor, mode)
            opened_spools.append(stream)
            return stream

        with tempfile.TemporaryDirectory() as directory:
            try:
                with patch('local_runner.coordinator._LOG_STREAM_CLEANUP_JOIN_SECONDS', 0.01), \
                        patch('local_runner.coordinator.os.fdopen', side_effect=tracked_fdopen), \
                        patch('local_runner.coordinator.threading.Thread.start', new=capture_start):
                    with self.assertRaises(coordinator._DockerLogSpoolsPreservedError) as raised:
                        coordinator._stream_process_logs(
                            ['unused'],
                            lambda _channel, _payload: None,
                            spool_directory=directory,
                        timeout_seconds=0.01,
                            popen_factory=lambda *_args, **_kwargs: Process(),
                        )

                self.assertTrue(raised.exception.preserve_spools)
                self.assertEqual(directory, raised.exception.spool_directory)
                self.assertEqual(2, len(started_threads))
                self.assertEqual(2, len(list(Path(directory).iterdir())))
                self.assertTrue(all(not pipe.closed for pipe in pipes))
                self.assertTrue(all(not stream.closed for stream in opened_spools))
            finally:
                release_readers.set()
                for thread in started_threads:
                    thread.join(timeout=2)
            self.assertTrue(all(not thread.is_alive() for thread in started_threads))
            self.assertTrue(all(pipe.closed for pipe in pipes))
            self.assertTrue(all(stream.closed for stream in opened_spools))


if __name__ == '__main__':
    unittest.main()
