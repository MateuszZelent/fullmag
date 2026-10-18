"""Operator-intent transport tests; native transaction tests live in Rust."""
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_host_readiness_migration as migration
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'docker/all-in-one'))
import runtime_service


def request():
    return dict(schema_version=migration.SCHEMA, expected_host_id='docker-all-host',
        expected_inventory_sha256='1'*64, expected_ledger_sha256='2'*64,
        expected_readiness_sha256='3'*64, expected_previous_capabilities_sha256='4'*64,
        expected_next_capabilities_sha256='5'*64)


class Document:
    def __init__(self, values, relative='runs/one'):
        self.values = values
        self.relative = relative
    def __truediv__(self, child):
        return Document(self.values, self.relative+'/'+child)
    def write_bytes(self, raw):
        self.values[self.relative] = raw
    def read_bytes(self, relative=None):
        return self.values[self.relative if relative is None else relative]


class MigrationIntentTests(unittest.TestCase):
    def test_exact_operator_bytes_are_staged_and_pinned_to_the_control_run(self):
        raw = (json.dumps(request(), indent=2)+'\n').encode()
        with tempfile.TemporaryDirectory() as scratch:
            source = Path(scratch)/'intent.json'
            source.write_bytes(raw)
            documents = {}
            admitted = migration.stage_request(source, Document(documents))
            self.assertEqual(documents['runs/one/host-readiness-migration.json'], raw)
            self.assertEqual(admitted['sha256'], hashlib.sha256(raw).hexdigest())
            inputs = dict(build_control=dict(run_relative='runs/one'), host_readiness_migration=admitted)
            environment = migration.migration_environment(inputs, Document(documents))
            with patch.dict(os.environ, environment, clear=True), patch.object(
                runtime_service, '_bounded_regular', return_value=raw
            ) as read:
                self.assertEqual(runtime_service._host_readiness_migration_arguments(),
                    ['--host-readiness-migration', admitted['path']])
                self.assertEqual(read.call_args.args[0], Path(admitted['path']))
            documents['runs/one/host-readiness-migration.json'] += b' '
            with self.assertRaisesRegex(ValueError, 'differs from its pin'):
                migration.migration_environment(inputs, Document(documents))
            with patch.dict(os.environ, environment, clear=True), patch.object(
                runtime_service, '_bounded_regular', return_value=raw+b' '
            ), self.assertRaisesRegex(runtime_service.RuntimeServiceError, 'pinned bytes'):
                runtime_service._host_readiness_migration_arguments()

    def test_migration_is_absent_by_default_and_cross_run_or_unpinned_intent_is_rejected(self):
        self.assertEqual(migration.migration_environment({}), {})
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(runtime_service._host_readiness_migration_arguments(), [])
        for path, digest in [
            ('/run/fullmag/control/runs/other/host-readiness-migration.json', '6'*64),
            ('/tmp/host-readiness-migration.json', '6'*64),
            ('/run/fullmag/control/runs/one/host-readiness-migration.json', None),
        ]:
            inputs = dict(build_control=dict(run_relative='runs/one'),
                host_readiness_migration=dict(path=path, sha256=digest))
            with self.subTest(path=path, digest=digest), self.assertRaises(ValueError):
                migration.migration_environment(inputs)
        with patch.dict(os.environ, {'FULLMAG_HOST_READINESS_MIGRATION_REQUEST': '/tmp/intent.json'}, clear=True), \
                patch.object(runtime_service, '_bounded_regular') as read, \
                self.assertRaises(runtime_service.RuntimeServiceError):
            runtime_service._host_readiness_migration_arguments()
        read.assert_not_called()

    def test_request_rejects_unknown_duplicate_malformed_and_noop_fields(self):
        valid = request()
        for bad in [dict(valid, bypass=True), dict(valid, expected_host_id=''),
                    dict(valid, expected_ledger_sha256='wrong'),
                    dict(valid, expected_next_capabilities_sha256=valid['expected_previous_capabilities_sha256'])]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                migration.parse_request(json.dumps(bad).encode())
        raw = json.dumps(valid).encode()
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            migration.parse_request(raw[:-1]+b',"expected_host_id":"other"}')
        with self.assertRaises(ValueError):
            migration.parse_request(b' '*65537)

    @unittest.skipUnless(hasattr(os, 'mkfifo'), 'POSIX file kind admission')
    def test_fifo_and_link_are_rejected_without_publication(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            fifo = root/'fifo'
            os.mkfifo(fifo)
            values = {}
            with self.assertRaisesRegex(ValueError, 'bounded regular file'):
                migration.stage_request(fifo, Document(values))
            source = root/'operator.json'
            source.write_text(json.dumps(request()), encoding='utf-8')
            link = root/'link.json'
            link.symlink_to(source)
            with self.assertRaisesRegex(ValueError, 'link or junction'):
                migration.stage_request(link, Document(values))
            self.assertEqual(values, {})


if __name__ == '__main__':
    unittest.main()
