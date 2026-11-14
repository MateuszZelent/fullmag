"""Final registration sequencing and failures; no Docker or native execution."""
from contextlib import contextmanager, ExitStack
from copy import deepcopy
import base64
import hashlib
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest import mock

from scripts import docker_dev_data_volume_register as register
from scripts import fullmag_data_volume_journal as journal
from scripts.test_fullmag_data_volume_pending import GuardFixture


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


class MutablePrepared(dict):
    pass


class RegistrationHarness:
    def __init__(self, test):
        self.test = test
        self.fixture = GuardFixture(test)
        f = self.fixture
        self.source = Path(register.__file__).resolve().parents[1]
        f.repo_root = self.source; f.layout['repo_root'] = str(self.source)
        f.write_marker(); f._write_index(b'', reference=False)
        self.index = f.index_path; self.old_index = self.index.read_bytes()
        self.volume = f.marker()['volume_id']
        self.op = f.storage/'migrations/data-volumes'/self.volume; self.op.mkdir(parents=True)
        roots = {'state': {'canonical_root': str(f.state_root)}, 'user_data': {'canonical_root': str(f.user_data_root)}}
        linux = {'volume_id': self.volume, 'storage_root': str(f.storage), 'mount_root': str(f.mount_root),
                 'source_roots': roots, 'filesystem_uuid': f.registration()['filesystem_uuid']}
        self.plan = {key: f.marker()[key] for key in ('project_id', 'worktree_id', 'compose_project', 'volume_id')}
        self.plan.update(mount_root=str(f.mount_root), provision_request={'backing_file_windows': r'E:\git\storage\fresh.vhdx'},
                         runtime_pins={'image_id': 'sha256:'+'a'*64})
        self.context = {'source': self.source, 'operation_root': self.op, 'linux': linux, 'plan': self.plan,
                        'layout': f.layout, 'identity': {'worktree_id': f.layout['worktree_id'], 'project_name': f.compose_project},
                        'copy_receipt_sha256': 'b'*64, 'plan_sha256': 'c'*64}
        self.bound = {}
        for role, row in roots.items():
            payload = f.mount_root/'payload'/Path(row['canonical_root']).relative_to(f.storage)
            payload.mkdir(parents=True)
            if role == 'state':
                f.case.volume_state = payload
            else:
                f.case.volume_user_data = payload
            backup = f.root/('original-'+role); backup.mkdir()
            self.bound[role] = dict(row, copied_root=str(payload), backup_root=str(backup),
                                    bound_identity={'device': 259, 'inode': 202 if role == 'state' else 101})
        self.prepared = MutablePrepared(context=self.context,
            bound_terminal={'result': {'switch': {'roots': self.bound}}})
        self.evidence = {'development_attempt': 'd'*32, 'config_sha256': 'e'*64,
            'source_commit': 'f'*40, 'source_snapshot_sha256': 'a'*64,
            'backend_build_receipt_sha256': 'b'*64, 'containers': {'backend': '1'*64, 'frontend': '2'*64}}
        self.execution = {'schema': register.RESULT_SCHEMA, 'state': 'terminal', 'outcome': 'completed',
            'status': 'completed', 'exit_code': 0, 'attempt': 'd'*32, 'config_sha256': 'e'*64,
            'request_id': 'fresh-qualification', 'session_id': 'session-fresh', 'run_id': 'run-fresh',
            'api_instance_id': 'fresh-api', 'session_epoch': 'fresh-epoch', 'request_scope_epoch': 'fresh-api:1'}
        self.script = b"study.storage(output_dir='/user-data/fresh.zarr')\n"
        self.execution['source_sha256'] = sha(self.script)
        (f.user_data_root/'fresh.py').write_bytes(self.script)
        self.zarr_result = {'tree_sha256': '3'*64, 'state': 'completed-fem-zarr-qualified'}
        self.record = {'result': {'started_evidence': self.evidence}}
        restart = {key: f.marker()[key] for key in ('volume_id', 'compose_project', 'source_root')}
        restart.update(schema='fullmag.data-volume-restart-result.v1',
                       state='runtime-started-not-scientifically-qualified', namespace_admitted=True)
        self.record['receipt_sha256'] = register._document(self.op, 'restart-result.json', restart)
        state = journal.new_journal(self.volume, 'c'*64)
        for phase in journal.PHASES[:7]:
            state = journal.append_terminal(journal.append_started(state, phase, 'a'*64), 'succeeded', 'b'*64)
        self.journal_path = self.op/'journal.json'; self.journal_path.write_bytes(register._encoded(state))
        self.issued_checks = 0; self.operations = 0; self.probe_drift = False
        self.tree_drift = False; self.source_drift = False; self.document_hook = None
        self.control = SimpleNamespace(_active_operation=None, project=f.compose_project,
            read_bytes=lambda path: b'activation-fixture', operation=self.operation)
        self.started = SimpleNamespace(_prepared=self.prepared, _control=self.control)
        self.issuer = SimpleNamespace(require_started_group=self.require_started)

    def require_started(self, started, prepared):
        self.test.assertIs(started, self.started); self.test.assertIs(prepared, self.prepared)
        self.test.assertIsNone(self.control._active_operation)
        if journal.next_phase(json.loads(self.journal_path.read_bytes())) != 'runtime-qualified':
            raise ValueError('old started capability was consumed')
        self.issued_checks += 1
        return deepcopy(self.record)

    @contextmanager
    def operation(self, phase, inputs):
        self.test.assertEqual(phase, 'data-volume-migration')
        self.test.assertIsNone(self.control._active_operation)
        operation = {'receipt': {}}; self.control._active_operation = operation; self.operations += 1
        try:
            yield operation
        finally:
            self.control._active_operation = None

    def run(self):
        original_raw = register._raw; original_document = register._document

        def raw(path):
            if Path(path) == self.source/'qualification_fixture.py':
                return self.script
            return original_raw(path)

        def document(parent, name, value):
            digest = original_document(parent, name, value)
            if self.document_hook:
                self.document_hook(parent, name, value)
            return digest

        def probe(*args, retained=None, **kwargs):
            if retained is not None and self.probe_drift:
                raise ValueError('nonce changed')
            return {'state': {'proof': {'nonce': '4'*32}}, 'user_data': {'proof': {'nonce': '4'*32}}}

        source_audit = {'files': {name: sha(original_raw(self.source/name)) for name in register.CERTIFICATE_SOURCES}}
        with ExitStack() as stack:
            patches = (
                mock.patch.object(register.startup, 'current_scope', return_value=None),
                mock.patch.object(register.startup, '_resolve_started_issuer', return_value=self.issuer),
                mock.patch.object(register, '_raw', side_effect=raw),
                mock.patch.object(register, '_document', side_effect=document),
                mock.patch.object(register, '_host_roots', return_value=deepcopy(self.bound)),
                mock.patch.object(register, '_pins', side_effect=lambda source: {'fixture': '0'*64 if self.source_drift else '5'*64}),
                mock.patch.object(register, '_activation', return_value=('fixed/activation.json', b'activation-fixture')),
                mock.patch.object(register, '_observe_run', return_value={'state': 'observed', 'run_status': 'completed'}),
                mock.patch.object(register, '_live_containers', return_value={'fixture': 'stable'}),
                mock.patch.object(register, '_native_build', return_value={'sha256': 'b'*64}),
                mock.patch.object(register, '_residual_source_audit', return_value=source_audit),
                mock.patch.object(register, '_write_probe', side_effect=probe),
                mock.patch.object(register, 'qualify_completed_fem_zarr',
                    side_effect=lambda *args, **kwargs: dict(self.zarr_result, tree_sha256='9'*64) if self.tree_drift else deepcopy(self.zarr_result)),
                mock.patch.object(register.guard, '_observe_mount', side_effect=self.fixture.case._mount_probe),
                mock.patch.object(register.guard, '_observe_directory', side_effect=self.fixture.case._directory_probe),
            )
            for patch in patches:
                stack.enter_context(patch)
            return register.register_qualified_group(self.started, self.execution, 'qualification_fixture.py', expected_device='gpu')

    def ordinary_guard(self):
        with mock.patch.object(register.guard, '_observe_mount', side_effect=self.fixture.case._mount_probe), \
                mock.patch.object(register.guard, '_observe_directory', side_effect=self.fixture.case._directory_probe):
            return register.guard.verify_registered_volume(self.fixture.layout, self.fixture.compose_project)


class RegistrationPublicationTests(unittest.TestCase):
    def test_publication_is_readable_by_real_completion_guard_and_preserves_foreign_index(self):
        h = RegistrationHarness(self)
        result = h.run()
        self.assertEqual(result['state'], 'registered-originals-retained')
        self.assertEqual(h.operations, 1); self.assertGreaterEqual(h.issued_checks, 3)
        self.assertEqual(json.loads(h.index.read_bytes())['unrelated'], json.loads(h.old_index)['unrelated'])
        self.assertEqual(journal.next_phase(json.loads(h.journal_path.read_bytes())), 'originals-retired')
        self.assertIsNotNone(h.ordinary_guard())
        self.assertFalse((h.op/'registration-failed.json').exists())
        self.assertEqual(result['registration']['backing_file_wsl'], '/mnt/e/git/storage/fresh.vhdx')

    def test_first_final_append_consumes_started_checks_without_reusing_them(self):
        h = RegistrationHarness(self); h.run()
        self.assertEqual(h.issued_checks, 3)
        with self.assertRaises(ValueError):
            h.run()

    def test_nonce_or_zarr_drift_before_or_after_final_witness_refuses_success(self):
        for phase in ('volume-registered.json', 'registration-committed.json'):
            for drift in ('probe_drift', 'tree_drift', 'source_drift'):
                with self.subTest(phase=phase, drift=drift):
                    h = RegistrationHarness(self)
                    h.document_hook = lambda parent, name, value, h=h: setattr(h, drift, True) if name == phase else None
                    with self.assertRaises(ValueError):
                        h.run()
                    self.assertTrue((h.op/'registration-failed.json').is_file())
                    with self.assertRaisesRegex(ValueError, 'failure artifact'):
                        h.ordinary_guard()

    def test_foreign_index_change_is_retained_and_no_final_commit_is_published(self):
        h = RegistrationHarness(self)
        def changed(parent, name, value):
            if name == 'migration-qualified.json':
                document = json.loads(h.index.read_bytes()); document['foreign-update'] = True
                h.index.write_text(json.dumps(document))
        h.document_hook = changed
        with self.assertRaisesRegex(ValueError, 'index changed'):
            h.run()
        self.assertTrue(json.loads(h.index.read_bytes())['foreign-update'])
        self.assertNotIn('data_volume_registration', json.loads(h.index.read_bytes()))
        self.assertFalse((h.op/'registration-committed.json').exists())

    def test_spoofed_or_expired_started_group_is_refused_before_writes(self):
        with mock.patch.object(register, '_document') as write:
            with self.assertRaises(ValueError):
                register.register_qualified_group(SimpleNamespace(), {}, 'fixture.py', expected_device='gpu')
        write.assert_not_called()

    def test_qualification_scope_must_close_before_registration(self):
        with mock.patch.object(register.startup, 'current_scope', return_value=object()), \
                mock.patch.object(register, '_document') as write:
            with self.assertRaisesRegex(ValueError, 'Close qualification scope'):
                register.register_qualified_group(object(), {}, 'fixture.py', expected_device='gpu')
        write.assert_not_called()


class RegistrationPrimitiveTests(unittest.TestCase):
    def test_execution_rejects_old_pins_unknown_status_and_boolean_exit(self):
        h = RegistrationHarness(self)
        self.assertEqual(register._execution(h.execution, h.evidence), h.execution)
        for changes in ({'attempt': '0'*32}, {'status': 'failed'}, {'exit_code': False}, {'extra': True}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                register._execution(dict(h.execution, **changes), h.evidence)

    def test_absence_distinguishes_missing_existing_symlink_and_permission_error(self):
        h = RegistrationHarness(self); root = h.fixture.root/'absence'; root.mkdir()
        self.assertTrue(register._absent_below(root, 'new.zarr'))
        (root/'present.zarr').mkdir()
        self.assertFalse(register._absent_below(root, 'present.zarr'))
        (root/'alias').symlink_to(root/'present.zarr')
        with self.assertRaises(OSError):
            register._absent_below(root, 'alias/new.zarr')
        with mock.patch.object(register.os, 'stat', side_effect=PermissionError('unreadable')):
            with self.assertRaises(PermissionError):
                register._absent_below(root, 'new.zarr')

    def test_index_cas_refuses_existing_reference_and_keeps_other_fields(self):
        h = RegistrationHarness(self)
        registration = h.fixture.registration_path
        register._index_cas(h.index, h.old_index, registration, 'a'*64, h.volume)
        current = h.index.read_bytes()
        self.assertEqual(json.loads(current)['unrelated'], json.loads(h.old_index)['unrelated'])
        with self.assertRaisesRegex(ValueError, 'already contains'):
            register._index_cas(h.index, current, registration, 'a'*64, h.volume)

    def test_native_build_export_requires_actual_bytes_identity_and_poisson_gate(self):
        h = RegistrationHarness(self)
        receipt = {'state': 'succeeded', 'source': {'resolved_commit': h.evidence['source_commit'],
            'source_snapshot_sha256': h.evidence['source_snapshot_sha256']},
            'native_contracts': {'contracts': {'fem-demag-poisson': {'state': 'passed', 'test': {'exit_code': 0}}}}}
        raw = register._encoded(receipt)
        value = {'receipt': receipt, 'sha256': sha(raw), 'raw_base64': base64.b64encode(raw).decode()}
        evidence = dict(h.evidence, backend_build_receipt_sha256=value['sha256'])
        with mock.patch.object(register, 'docker_capture', return_value=SimpleNamespace(
                returncode=0, stdout=json.dumps(value).encode())):
            self.assertEqual(register._native_build(evidence), value)
        value['raw_base64'] = base64.b64encode(raw+b'changed').decode()
        with mock.patch.object(register, 'docker_capture', return_value=SimpleNamespace(
                returncode=0, stdout=json.dumps(value).encode())), self.assertRaises(ValueError):
            register._native_build(evidence)

    def test_prepare_operator_owned_registration_parent_before_root_pending_creation(self):
        f = GuardFixture(self); f._write_index(b'', reference=False)
        context = {'layout': f.layout}

        @contextmanager
        def lock(layout):
            self.assertEqual(layout, f.layout)
            yield

        with mock.patch('docker_dev_data_volume_copy._load_source', return_value=context), \
                mock.patch.object(register.storage, 'build_lock', side_effect=lock):
            result = register.prepare_registration_directory(f.repo_root, 'a'*32)
            self.assertEqual(result['path'], str(f.storage/'index/data-volumes'))
            directory = Path(result['path'])
            self.assertEqual(directory.stat().st_uid, os.geteuid())
            existing = directory/'other-group.json'; existing.write_bytes(b'foreign payload')
            self.assertEqual(register.prepare_registration_directory(f.repo_root, 'a'*32), result)
            self.assertEqual(existing.read_bytes(), b'foreign payload')

    def test_guest_write_is_exclusive_and_later_read_never_writes(self):
        h = RegistrationHarness(self); root = h.fixture.root/'guest'; root.mkdir()
        for role in ('state', 'user-data'):
            (root/role).mkdir()
        values = {'token': '6'*32, 'volume_id': h.volume, 'nonce': '7'*32,
                  'backend': '1'*64, 'run_id': 'run-fresh'}
        original_open = os.open

        def execute(mode):
            def opened(path, flags, *args, **kwargs):
                if path == '/':
                    path = root
                if mode == 'read':
                    self.assertFalse(flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT))
                return original_open(path, flags, *args, **kwargs)

            def ioctl(fd, request, buffer, mutate):
                buffer[:] = bytes([16])+bytes.fromhex('123e4567e89b12d3a456426614174000')
                return 0

            with mock.patch.object(register.os, 'open', side_effect=opened), \
                    mock.patch('fcntl.ioctl', side_effect=ioctl), \
                    mock.patch.object(sys, 'argv', ['probe', json.dumps(dict(values, mode=mode))]), \
                    mock.patch('builtins.print') as output:
                exec(compile(register._WRITE_PROBE, '<new-volume-probe>', 'exec'), {})
                return json.loads(output.call_args.args[0])

        written = execute('write')
        self.assertEqual(set(written), {'state', 'user_data'})
        observed = execute('read')
        for role in written:
            self.assertEqual({k: v for k, v in observed[role].items() if k != 'available_bytes'},
                             {k: v for k, v in written[role].items() if k != 'available_bytes'})
        before = {str(p): p.read_bytes() for p in root.rglob('*.json')}
        with self.assertRaises(FileExistsError):
            execute('write')
        self.assertEqual(before, {str(p): p.read_bytes() for p in root.rglob('*.json')})


if __name__ == '__main__':
    unittest.main()
