"""Interpreted fail-closed completion checks; no Docker or compiled targets."""
import copy
import json
import subprocess
try:
    import fcntl
except ImportError:
    fcntl = None
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest import mock
sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_volume_frontend_refresh_reconcile as recovery
from docker_build_control import BuildControlError, canonical
from docker_volume_reconcile import digest


class CompletionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.source = Path(self.temp.name)
        self.document = {'name': 'own', 'services': {
            'backend': {'volumes': [{'type': 'bind', 'source': str(self.source),
                'target': '/opt/fullmag/source', 'read_only': True}],
                'environment': {}, 'x-fullmag-daemon-binds': {'/opt/fullmag/source': '/run/desktop/mnt/host/wsl/own'}},
            'frontend': {'volumes': [{'type': 'bind', 'source': str(self.source),
                'target': '/opt/fullmag/source', 'read_only': True}],
                'x-fullmag-daemon-binds': {'/opt/fullmag/source': str(self.source)}}}}
        self.actual = {name: {'Id': name, 'Mounts': [{'Destination': '/opt/fullmag/source',
            'Source': '/run/desktop/mnt/host/wsl/own', 'Type': 'bind', 'RW': False}]}
            for name in ('backend', 'frontend')}
        self.identity = {'device': 2096, 'inode': 4317021}
        self.control = types.SimpleNamespace(project='own', volume='own-control', path=lambda p: '/control/' + p)
        self.original = {'schema': 'fullmag.docker-build-operation.v1', 'phase': 'development',
            'state': 'outcome-unknown-resources-retained', 'error': recovery.ERROR,
            'attempt': 'a'*32, 'compose_project': 'own', 'control_volume': 'own-control',
            'helper_container': 'fullmag-control-'+'a'*32, 'state_root': '/own/state',
            'backend_volumes': {}, 'previous_frontend_volume': 'old-front',
            'inputs': {'frontend_refresh_from_attempt': 'b'*32, 'source_root': str(self.source),
                'native_build_requested': False, 'frontend_refresh_from_config_sha256': 'c'*64}}
        self.previous = {'state': 'succeeded', 'attempt': 'b'*32, 'compose_project': 'own',
            'state_root': '/own/state', 'backend_volumes': {}, 'frontend_volume': 'old-front', 'config_sha256': 'c'*64}

    def derive(self):
        return recovery.derive_document(self.document, self.actual, self.source,
            identity=lambda p: self.identity, guest=lambda c, p: self.identity)

    def test_repins_only_independently_proven_namespace_preserving_original(self):
        original = copy.deepcopy(self.document)
        result, witness = self.derive()
        self.assertEqual(self.document, original)
        self.assertEqual(result['services']['backend'], original['services']['backend'])
        self.assertEqual(result['services']['frontend']['x-fullmag-daemon-binds']['/opt/fullmag/source'],
                         '/run/desktop/mnt/host/wsl/own')
        self.assertEqual(len(witness['/opt/fullmag/source']['files']), 4)

    def test_opaque_descendant_alias_requires_independent_file_identity(self):
        child = self.source / 'apps/control-room/app'
        child.mkdir(parents=True)
        (child / 'layout.tsx').write_bytes(b'marker')
        target = '/workspace/apps/control-room/app'
        self.document['services']['frontend']['volumes'].append({'type': 'bind',
            'source': str(child), 'target': target, 'read_only': True})
        self.document['services']['frontend']['x-fullmag-daemon-binds'][target] = str(child)
        self.actual['frontend']['Mounts'].append({'Destination': target,
            'Source': '/run/desktop/mnt/host/wsl/opaque-child', 'Type': 'bind', 'RW': False})
        result, witness = self.derive()
        self.assertEqual(result['services']['frontend']['x-fullmag-daemon-binds'][target],
                         '/run/desktop/mnt/host/wsl/opaque-child')
        self.assertEqual(len(witness[target]['files']), 2)
        self.assertTrue(witness[target]['files'][1]['backend'].endswith('/apps/control-room/app/layout.tsx'))

    def test_foreign_backend_pin_refused(self):
        self.document['services']['backend']['x-fullmag-daemon-binds']['/opt/fullmag/source'] += '-foreign'
        with self.assertRaises(BuildControlError): self.derive()

    def test_foreign_frontend_mount_refused(self):
        self.actual['frontend']['Mounts'][0]['Source'] += '-foreign'
        with self.assertRaises(BuildControlError): self.derive()

    def test_writable_frontend_mount_refused(self):
        self.actual['frontend']['Mounts'][0]['RW'] = True
        with self.assertRaises(BuildControlError): self.derive()

    def test_missing_or_mismatching_marked_file_proof_refused(self):
        def guest(container, path):
            return self.identity if path.endswith('/source') else {**self.identity, 'sha256': 'foreign'}
        with self.assertRaises(BuildControlError):
            recovery.derive_document(self.document, self.actual, self.source,
                identity=lambda p: self.identity, guest=guest)

    def test_child_src_failure_requires_declared_readonly_source_and_verified_witness(self):
        target = '/state/development/workspace/apps/control-room/src'
        self.document['services']['frontend']['volumes'].append({
            'type': 'bind', 'read_only': True, 'source': str(self.source / 'apps/control-room/src'),
            'target': target})
        self.original['error'] = 'Retained source/runtime bind differs: ' + target
        recovery.validate_unknown(self.original, self.previous, self.document, self.control,
                                  self.source, 'a'*32, 'b'*32)
        self.assertEqual(recovery.require_failed_source_witness(
            self.original, self.document, self.source, {target: {'files': ['verified']}}), target)
        for witness in (None, {}, {'/opt/fullmag/source': {'files': ['verified']}}):
            with self.subTest(witness=witness), self.assertRaises(BuildControlError):
                recovery.require_failed_source_witness(self.original, self.document, self.source, witness)
        mount = self.document['services']['frontend']['volumes'][-1]
        for key, value in (('read_only', False), ('type', 'volume'), ('source', '/foreign/src')):
            changed = copy.deepcopy(self.document)
            changed['services']['frontend']['volumes'][-1][key] = value
            with self.subTest(key=key), self.assertRaises(BuildControlError):
                recovery.validate_unknown(self.original, self.previous, changed, self.control,
                                          self.source, 'a'*32, 'b'*32)
        self.document['services']['frontend']['volumes'].pop()
        with self.assertRaises(BuildControlError):
            recovery.validate_unknown(self.original, self.previous, self.document, self.control,
                                      self.source, 'a'*32, 'b'*32)

    def test_failure_scope_rejects_arbitrary_targets_even_if_readonly_declared(self):
        for target in ('/state/development/workspace/apps/control-room/src/foreign',
                       '/state/development/workspace/apps/control-room/node_modules', '/foreign'):
            changed = copy.deepcopy(self.document)
            changed['services']['frontend']['volumes'].append({'type': 'bind', 'read_only': True,
                'source': str(self.source), 'target': target})
            original = {**self.original, 'error': 'Retained source/runtime bind differs: ' + target}
            with self.subTest(target=target), self.assertRaises(BuildControlError):
                recovery.validate_unknown(original, self.previous, changed, self.control,
                                          self.source, 'a'*32, 'b'*32)

    def test_wrong_unknown_class_refused(self):
        recovery.validate_unknown(self.original, self.previous, self.document, self.control,
                                  self.source, 'a'*32, 'b'*32)
        for key, value in [('error', 'timeout'), ('phase', 'iteration'), ('control_volume', 'foreign'),
                           ('state', 'succeeded'), ('attempt', 'd'*32)]:
            changed = {**self.original, key: value}
            with self.subTest(key=key), self.assertRaises(BuildControlError):
                recovery.validate_unknown(changed, self.previous, self.document, self.control,
                                          self.source, 'a'*32, 'b'*32)

    def test_failed_base_with_null_config_uses_explicit_refresh_input_pin(self):
        self.previous.update(state='failed-confirmed', config_sha256=None,
                             backend_container=None, frontend_container=None)
        recovery.validate_unknown(self.original, self.previous, self.document, self.control,
                                  self.source, 'a'*32, 'b'*32)
        self.original['inputs']['frontend_refresh_from_config_sha256'] = None
        with self.assertRaises(BuildControlError):
            recovery.validate_unknown(self.original, self.previous, self.document, self.control,
                                      self.source, 'a'*32, 'b'*32)

    def test_native_build_or_helper_transition_refused(self):
        for key, value in [('native_build_requested', True), ('helper_transition', {'fake': True})]:
            changed = copy.deepcopy(self.original); changed['inputs'][key] = value
            with self.subTest(key=key), self.assertRaises(BuildControlError):
                recovery.validate_unknown(changed, self.previous, self.document, self.control,
                                          self.source, 'a'*32, 'b'*32)

    def test_transaction_uses_exact_lease_cas_and_never_removes_active(self):
        request = {'attempt': 'a'*32, 'evidence': {'frontend_source_view': 'view', 'documents': {
            'active': digest(('a'*32+'\n').encode()), 'development/current.json': 'b'*64}}}
        script = recovery.transaction_script(self.control, request, 'c'*64, 'd'*64, 'e'*64)
        self.assertIn('flock -n 9', script)
        self.assertIn('if flock -n 8; then exit 72', script)
        self.assertIn('= BEGIN', script)
        self.assertIn('!= COMMIT', script)
        self.assertIn('retain_unknown', script)
        self.assertNotIn('rm ', script)
        self.assertNotIn('docker ', script)
        self.assertLess(script.index('/compose.json &&'), script.index('/terminal.json &&'))

    def test_replay_requires_all_terminal_pointers(self):
        request_sha = 'd'*64
        raw = canonical({'state': 'succeeded', 'frontend_refresh_completion': {'request_sha256': request_sha}})
        root = 'development/attempts/' + 'a'*32
        r = {'attempt': 'a'*32, 'evidence': {'derived_compose_sha256': digest(b'compose'),
            'documents': {root + '/compose.json': digest(b'original-compose'), root + '/receipt.json': digest(b'unknown')}}}
        def read(control, path, optional=False):
            if path.endswith('/original-compose.json'): return b'original-compose'
            if path.endswith('/unknown-receipt.json'): return b'unknown'
            return b'compose' if path.endswith('/compose.json') else raw
        with mock.patch.object(recovery, 'read_raw', side_effect=read):
            self.assertTrue(recovery.completed(self.control, r, request_sha))
        def partial(control, path, optional=False):
            return b'{}' if path == 'development/verified.json' else read(control, path, optional)
        with mock.patch.object(recovery, 'read_raw', side_effect=partial), self.assertRaises(BuildControlError):
            recovery.completed(self.control, r, request_sha)
        with mock.patch.object(recovery, 'read_raw', side_effect=read), self.assertRaises(BuildControlError):
            recovery.completed(self.control, r, 'f'*64)

    @unittest.skipIf(fcntl is None, "Local flock protocol requires a POSIX host")
    def test_shell_protocol_publishes_only_pinned_request_and_keeps_original_lease(self):
        root = self.source / 'development/attempts' / ('a'*32)
        journal = root / 'completion' / ('b'*64)
        journal.mkdir(parents=True)
        (self.source / 'development/current.json').write_bytes(b'base')
        (self.source / 'active').write_text('a'*32 + '\n')
        (root / 'receipt.json').write_bytes(b'unknown')
        (root / 'compose.json').write_bytes(b'original')
        (root / 'unknown-receipt.json').write_bytes(b'unknown')
        (journal / 'result.json').write_bytes(b'result')
        (journal / 'compose.json').write_bytes(b'derived')
        (journal / 'frontend-source-view.json').write_bytes(canonical('view'))
        request = {'attempt': 'a'*32, 'evidence': {'frontend_source_view': 'view', 'documents': {
            'active': digest(('a'*32+'\n').encode()),
            'development/current.json': digest(b'base'),
            'development/attempts/' + 'a'*32 + '/receipt.json': digest(b'unknown')}}}
        script = recovery.transaction_script(self.control, request, 'b'*64, digest(b'result'), digest(b'derived'))
        script = script.replace('/control/', str(self.source) + '/')
        with (self.source / 'operation.lock').open('w') as lease:
            fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
            child = subprocess.Popen(['bash', '-euo', 'pipefail', '-c', script],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.assertEqual(child.stdout.readline(), b'READY\n')
            child.stdin.write(b'BEGIN\n'); child.stdin.flush()
            self.assertEqual(child.stdout.readline(), b'OBSERVING\n')
            child.stdin.write(('COMMIT ' + digest(b'result') + '\n').encode()); child.stdin.flush()
            child.stdin.close()
            self.assertEqual(child.stdout.readline(), b'COMMITTED\n')
            self.assertEqual(child.wait(timeout=5), 0, child.stderr.read())
            child.stdout.close(); child.stderr.close()
        self.assertEqual((root / 'terminal.json').read_bytes(), b'result')
        self.assertEqual((root / 'compose.json').read_bytes(), b'derived')
        self.assertEqual((root / 'unknown-receipt.json').read_bytes(), b'unknown')
        self.assertTrue((self.source / 'active').exists())

    def test_actual_marked_file_identity_contains_hash(self):
        p = self.source / 'marked'; p.write_bytes(b'exact')
        self.assertEqual(recovery.file_identity(p)['sha256'], digest(b'exact'))


if __name__ == '__main__':
    unittest.main()
