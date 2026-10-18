"""Source regression cases for the Docker-only development build transport."""
import io
import json
import os
from pathlib import Path
import types
import unittest
from unittest.mock import Mock, patch

import docker_build_volume_io as transport


class MemoryStore:
    def __init__(self):
        self.documents = {}

    def uri(self, relative):
        return 'docker-volume://owned-test/' + relative

    def stat(self, relative):
        return object() if relative in self.documents else None

    def write_bytes(self, relative, data):
        self.documents[relative] = bytes(data)

    def write_json(self, relative, value):
        self.write_bytes(relative, json.dumps(value).encode())

    def read_bytes(self, relative):
        return self.documents[relative]


class BuildTransportTests(unittest.TestCase):
    def test_volume_document_is_never_an_os_path(self):
        store = MemoryStore()
        document = transport.BuildDocument(store, 'runs/id/receipt.json')
        self.assertFalse(document.exists())
        document.write_json({'state': 'ready'})
        self.assertTrue(document.exists())
        self.assertEqual(json.loads(document.read_bytes()), {'state': 'ready'})
        with self.assertRaises(TypeError):
            os.fspath(document)
        with self.assertRaises(ValueError):
            transport.BuildDocument(store, 'runs/../foreign')

    def test_compose_is_stdin_and_project_pinned(self):
        result = types.SimpleNamespace(returncode=0, stdout='{}', stderr='')
        with patch.object(transport.subprocess, 'run', return_value=result) as run:
            transport.compose_capture(Path('/selected'), 'fullmag-worktree-owned', {'services': {}}, ['config'])
        argv = run.call_args.args[0]
        self.assertEqual(argv[:4], ['docker', '--context', 'desktop-linux', 'compose'])
        self.assertEqual(argv[argv.index('--project-name') + 1], 'fullmag-worktree-owned')
        self.assertEqual(argv[argv.index('-f') + 1], '-')
        self.assertEqual(json.loads(run.call_args.kwargs['input']), {'services': {}})

    def test_build_logs_are_volume_chunks_and_failure_is_not_retried(self):
        store = MemoryStore()
        log = transport.BuildDocument(store, 'runs/id/build-log.json')
        process = types.SimpleNamespace(stdin=Mock(), stdout=io.BytesIO(b'compiler output\n'), wait=lambda: 2)
        with patch.object(transport.subprocess, 'Popen', return_value=process) as popen:
            with self.assertRaises(transport.VolumeBuildError):
                transport.compose_build(Path('/selected'), 'fullmag-worktree-owned', {'services': {}}, 'backend', log)
        popen.assert_called_once()
        receipt = json.loads(log.read_bytes())
        self.assertEqual(receipt['exit_code'], 2)
        self.assertEqual(receipt['chunks'][0]['path'], 'runs/id/build-log.json.chunks/00000000.log')
        self.assertEqual(store.documents[receipt['chunks'][0]['path']], b'compiler output\n')

    def test_console_encoding_failure_does_not_abandon_the_build(self):
        store = MemoryStore()
        log = transport.BuildDocument(store, 'runs/id/build-log.json')
        waited = Mock(return_value=0)
        process = types.SimpleNamespace(stdin=Mock(), stdout=io.BytesIO('✓ build\n'.encode()), wait=waited)
        def broken_write(_value):
            raise UnicodeEncodeError('cp1250', '✓', 0, 1, 'not encodable')
        console = types.SimpleNamespace(write=broken_write, flush=lambda: None)
        with patch.object(transport.subprocess, 'Popen', return_value=process), patch.object(transport.sys, 'stdout', console):
            transport.compose_build(Path('/selected'), 'fullmag-worktree-owned', {'services': {}}, 'backend', log)
        waited.assert_called_once()
        self.assertEqual(json.loads(log.read_bytes())['exit_code'], 0)


if __name__ == '__main__':
    unittest.main()
