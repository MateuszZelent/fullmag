import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import Mock, patch

from local_runner.retention_executor import apply_execution_plan
from local_runner.retention_persistence import (
    INLINE_JSON_BYTES, MANIFEST_SCHEMA, MAX_ENTRY_BYTES, MAX_OPTIONAL_ERROR_JSON_BYTES,
    RetentionPersistenceError, failure_fields, maximum_failure_fields,
    operation_outcome_template,
    read_document, write_document,
)


class _UnusedQueue:
    def __init__(self):
        self.active_calls = 0
        self.get_calls = []

    def active(self):
        self.active_calls += 1
        return []

    def get(self, job_id):
        self.get_calls.append(job_id)
        raise AssertionError('preflight/replay must not inspect jobs')


class RetentionPersistenceTests(unittest.TestCase):
    def _storage(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        (root / 'index').mkdir()
        (root / 'locks').mkdir()
        (root / 'index' / 'retention-plans').mkdir()
        (root / 'index' / 'retention-operations').mkdir()
        return root

    @staticmethod
    def _canonical_bytes(value):
        return json.dumps(
            value, ensure_ascii=False, separators=(',', ':'), sort_keys=True,
        ).encode('utf-8')

    @staticmethod
    def _operation_items():
        return [
            {'job_id': f'job-{index}', 'status': 'partial_error', 'reason': 'x' * 100_000}
            for index in range(45)
        ]

    def _write_large_operation(self, root, plan_id='plan-a1111111'):
        path = root / 'index' / 'retention-operations' / f'{plan_id}.json'
        record = {
            'plan_id': plan_id,
            'scope': 'execution',
            'status': 'partial',
            'applied': False,
            'items': self._operation_items(),
        }
        write_document(root, path, record, kind='operation', scope='execution')
        self.assertGreater(path.stat().st_size, 0)
        self.assertEqual(MANIFEST_SCHEMA, json.loads(path.read_bytes())['storage_schema'])
        return path, record

    def _apply_replay(self, root, plan_id, queue):
        return apply_execution_plan(
            {'storage_root': str(root)}, {'plan_id': plan_id}, queue,
            owner='operator', call=lambda argv: self.fail(f'unexpected Docker call: {argv}'),
            policy={'ttl_success_hours': 24, 'ttl_failure_hours': 168},
        )

    def test_large_plan_roundtrips_as_complete_manifest_document(self):
        root = self._storage()
        plan_id = 'plan-a2222222'
        path = root / 'index' / 'retention-plans' / f'{plan_id}.json'
        record = {
            'plan_id': plan_id,
            'scope': 'execution',
            'status': 'preview',
            'reference_status': 'incomplete',
            'reference_errors': [{'code': 'unreadable_metadata_entry'}],
            'protected_external': [{'resource_id': 'protected'}],
            'candidates': [
                {'job_id': f'job-{index}', 'note': 'λ' * 45_000}
                for index in range(50)
            ],
            'retained': [{'job_id': 'retained-top-level'}],
            'raw_engine_plan': {
                'candidates': [{'job_id': 'engine-candidate'}],
                'retained': [{'job_id': 'engine-retained'}],
            },
            'raw_runtime_plan': {
                'candidates': [{'job_id': 'runtime-candidate'}],
                'retained': [{'job_id': 'runtime-retained'}],
                'protected_external': [{'resource_id': 'protected'}],
                'references': [{'resource_id': 'reference'}],
                'errors': [{'code': 'unreadable_metadata_entry'}],
            },
        }
        from local_runner.retention_service import RetentionService
        service = RetentionService(
            type('_Hub', (), {})(), object(), {'storage_root': str(root)},
            owner='operator', call=lambda _argv: None,
        )
        service._save(record)

        self.assertGreater(path.stat().st_size, 0)
        self.assertLessEqual(path.stat().st_size, INLINE_JSON_BYTES)
        self.assertEqual(MANIFEST_SCHEMA, json.loads(path.read_bytes())['storage_schema'])
        manifest_bytes = path.read_bytes()
        manifest = json.loads(manifest_bytes)
        self.assertEqual(
            {
                ('candidates',), ('retained',),
                ('raw_engine_plan', 'candidates'), ('raw_engine_plan', 'retained'),
                ('raw_runtime_plan', 'candidates'), ('raw_runtime_plan', 'retained'),
                ('raw_runtime_plan', 'protected_external'),
                ('raw_runtime_plan', 'references'), ('raw_runtime_plan', 'errors'),
            },
            {tuple(array['path']) for array in manifest['arrays']},
        )
        self.assertEqual(record, read_document(root, path, plan_id=plan_id, kind='plan'))
        api_record = service.get(plan_id)
        expected_api_record = {
            key: value for key, value in record.items()
            if key not in ('raw_engine_plan', 'raw_runtime_plan')
        }
        self.assertEqual(expected_api_record, api_record)

        wrong_scope = {**record, 'scope': 'runtime'}
        with self.assertRaises(RetentionPersistenceError):
            write_document(root, path, wrong_scope, kind='plan', scope='runtime')
        with self.assertRaises(RetentionPersistenceError):
            write_document(root, path, record, kind='operation', scope='execution')
        self.assertEqual(manifest_bytes, path.read_bytes())

    def test_legacy_inline_read_limit_preserves_oversized_document(self):
        root = self._storage()
        small_id = 'plan-c1111111'
        small_path = root / 'index' / 'retention-plans' / f'{small_id}.json'
        small = {
            'plan_id': small_id, 'scope': 'execution', 'status': 'preview',
            'candidates': [],
        }
        small_path.write_text(json.dumps(small), encoding='utf-8')
        self.assertEqual(small, read_document(root, small_path, plan_id=small_id, kind='plan'))

        large_id = 'plan-c2222222'
        large_path = root / 'index' / 'retention-plans' / f'{large_id}.json'
        large = {
            'plan_id': large_id, 'scope': 'execution', 'status': 'preview',
            'unindexed_payload': 'x' * (INLINE_JSON_BYTES + 64),
        }
        original = json.dumps(large).encode('utf-8')
        large_path.write_bytes(original)
        self.assertGreater(len(original), INLINE_JSON_BYTES)
        for operation in (
            lambda: read_document(root, large_path, plan_id=large_id, kind='plan'),
            lambda: write_document(root, large_path, large, kind='plan', scope='execution'),
        ):
            with self.assertRaises(RetentionPersistenceError) as raised:
                operation()
            self.assertEqual('oversized_legacy_document', raised.exception.code)
            self.assertEqual(original, large_path.read_bytes())

    def test_entry_limit_accepts_exact_utf8_boundary_and_rejects_next_codepoint(self):
        root = self._storage()
        plan_id = 'plan-a3333333'
        path = root / 'index' / 'retention-plans' / f'{plan_id}.json'
        empty = {'text': ''}
        overhead = len(self._canonical_bytes(empty))
        remaining = MAX_ENTRY_BYTES - overhead
        exact_value = 'é' * (remaining // 2) + ('x' if remaining % 2 else '')
        exact = {'text': exact_value}
        self.assertEqual(MAX_ENTRY_BYTES, len(self._canonical_bytes(exact)))
        record = {'plan_id': plan_id, 'scope': 'execution', 'candidates': [exact]}
        write_document(root, path, record, kind='plan', scope='execution')
        self.assertEqual(record, read_document(root, path, plan_id=plan_id, kind='plan'))

        oversized_id = 'plan-a4444444'
        oversized_path = root / 'index' / 'retention-plans' / f'{oversized_id}.json'
        oversized = {
            'plan_id': oversized_id,
            'scope': 'execution',
            'candidates': [{'text': exact_value + 'é'}],
        }
        with self.assertRaises(RetentionPersistenceError):
            write_document(root, oversized_path, oversized, kind='plan', scope='execution')
        self.assertFalse(oversized_path.exists())

    def test_error_descriptor_reservation_covers_unicode_control_and_long_names(self):
        reserved = maximum_failure_fields(summary_key='reason', label='failure')
        names = (
            'A' * 510,
            'A' * 511,
            '\x01' * 85,
            '\x01' * 86,
            'λ' * 256,
            'LongErrorName' * 80,
        )
        codes = ('known_reason', 'C' * 511, '\x01' * 86, 'λ' * 256)
        for index, name in enumerate(names):
            with self.subTest(name_bytes=len(name.encode('utf-8'))):
                error_type = type(name, (Exception,), {'reason_code': codes[index % len(codes)]})
                fields = failure_fields(error_type('detail'), summary_key='reason', label='failure')
                self.assertLessEqual(
                    len(self._canonical_bytes(fields)),
                    len(self._canonical_bytes(reserved)),
                )
                self.assertEqual(
                    len(name.encode('utf-8')),
                    fields['failure_type_bytes'],
                )
                type_is_canonical = re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,509}', name) is not None
                code = codes[index % len(codes)]
                code_is_canonical = re.fullmatch(r'[a-z][a-z0-9_]{0,509}', code) is not None
                self.assertEqual(not type_is_canonical, fields['failure_type_omitted'])
                self.assertEqual(name if type_is_canonical else 'other_exception', fields['failure_type'])
                self.assertEqual(not code_is_canonical, fields['failure_code_omitted'])
                self.assertEqual(code if code_is_canonical else 'retention_operation_error', fields['failure_code'])

    def test_arbitrary_human_message_never_becomes_primary_error_code(self):
        for message in ('x' * 20_000, 'human_prefix: user detail'):
            with self.subTest(message_length=len(message)):
                fields = failure_fields(
                    RuntimeError(message), summary_key='error', label='failure',
                )
                self.assertEqual('RuntimeError', fields['failure_type'])
                self.assertEqual('retention_operation_error', fields['failure_code'])
                self.assertFalse(fields['failure_type_omitted'])
                self.assertFalse(fields['failure_code_omitted'])
                self.assertEqual(len(message) > MAX_OPTIONAL_ERROR_JSON_BYTES, fields['failure_message_omitted'])
                self.assertEqual(len(message.encode('utf-8')), fields['failure_message_bytes'])
                self.assertEqual(
                    hashlib.sha256(message.encode('utf-8')).hexdigest(),
                    fields['failure_message_sha256'],
                )

    def test_runtime_recovery_error_envelope_fits_maximal_dual_summary(self):
        type_name = 'T' * 510
        code = 'c' * 510
        error_type = type(type_name, (Exception,), {'reason_code': code})
        prefix = f'{type_name}: {code}: '
        first_message = 'a' * (MAX_OPTIONAL_ERROR_JSON_BYTES - len(prefix) - 2)
        first = failure_fields(error_type(first_message), summary_key='reason', label='failure')
        second = failure_fields(
            error_type('secondary diagnostic'),
            summary_key='reconciliation_error',
            label='reconciliation',
            optional_bytes_used=first['_optional_error_json_bytes'],
        )
        actual_errors = {**first, **second}
        candidate = {
            'job_id': 'job', 'worktree_id': 'wt', 'size_bytes': 1,
            'package_path': 'C:/storage/runs/wt/job/artifacts/outputs/.fullmag/local',
            'package_tree': {
                'logical_bytes': 1, 'files': 1, 'links': 0,
                'fingerprint': 'f' * 64, 'root_device': 1, 'root_inode': 1,
            },
            'build_receipt_sha256': 'a' * 64,
        }
        template = operation_outcome_template(
            candidate, plan_id='plan-e1111111', scope='runtime', storage_root='C:/storage',
        )

        self.assertEqual(MAX_OPTIONAL_ERROR_JSON_BYTES, first['_optional_error_json_bytes'])
        self.assertTrue(second['reconciliation_message_omitted'])
        self.assertEqual(type_name, second['reconciliation_type'])
        self.assertEqual(code, second['reconciliation_code'])
        reserved_errors = {key: template[key] for key in actual_errors}
        self.assertLessEqual(
            len(self._canonical_bytes(actual_errors)),
            len(self._canonical_bytes(reserved_errors)),
        )

    def test_actual_container_cleanup_envelope_preflights_and_roundtrips(self):
        from local_runner import retention_executor
        if retention_executor._directory_sync_capability() != 'supported':
            self.skipTest('host has no checked run-root directory sync capability')

        from test_local_runner_retention_executor import ExecutionCleanupTests

        fixture = ExecutionCleanupTests(
            'test_complete_available_log_is_durable_before_own_worker_removal',
        )
        fixture.setUp()
        try:
            container_id, inspected = fixture._prepare_attested_worker()
            docker, state = fixture._worker_docker(container_id, inspected)

            def stream_logs(_container_id, emit, *, spool_directory):
                emit('stdout', b'actual producer payload')
                return 'stdout_then_stderr'

            result = fixture.apply(call=docker, stream_logs=stream_logs)

            self.assertTrue(result['applied'], result)
            self.assertTrue(state['removed'])
            cleanup = result['items'][0]['container_cleanup']
            candidate = fixture.plan['raw_engine_plan']['candidates'][0]
            preflight_item = operation_outcome_template(
                candidate,
                plan_id=fixture.plan['plan_id'],
                scope='execution',
                storage_root=str(fixture.root),
            )
            self.assertEqual(set(preflight_item['container_cleanup']), set(cleanup))
            self.assertEqual(container_id, cleanup['removed_worker_container_id'])
            self.assertEqual('supported', cleanup['directory_sync_capability'])
            self.assertIs(True, cleanup['directory_sync_required_for_success'])
            self.assertIs(True, cleanup['directory_entries_synced'])
            self.assertEqual('not_qualified', cleanup['power_loss_qualification'])

            operation_path = (
                fixture.root / 'index' / 'retention-operations'
                / (fixture.plan['plan_id'] + '.json')
            )
            serialized = read_document(
                fixture.root,
                operation_path,
                plan_id=fixture.plan['plan_id'],
                kind='operation',
                scope='execution',
            )
            self.assertEqual(result, serialized)
        finally:
            fixture.doCleanups()

    def test_plan_preview_exception_keeps_code_and_hashes_omitted_message(self):
        class _SourcePlanError(Exception):
            reason_code = 'source_capsule_unreadable'

        message = 'x' * 20_000
        fields = failure_fields(
            _SourcePlanError(message),
            summary_key='why_retained',
            label='retention_failure',
        )

        self.assertEqual(
            '_SourcePlanError: source_capsule_unreadable: diagnostic message omitted',
            fields['why_retained'],
        )
        self.assertEqual('_SourcePlanError', fields['retention_failure_type'])
        self.assertEqual('source_capsule_unreadable', fields['retention_failure_code'])
        self.assertTrue(fields['retention_failure_message_omitted'])
        self.assertEqual(len(message.encode('utf-8')), fields['retention_failure_message_bytes'])
        self.assertEqual(
            hashlib.sha256(message.encode('utf-8')).hexdigest(),
            fields['retention_failure_message_sha256'],
        )

    def test_runtime_preview_keeps_structured_reference_errors_with_bounded_exception(self):
        from local_runner.runtime_retention import plan_runtime_cleanup

        root = self._storage()
        job = {
            'job_id': 'job', 'worktree_id': 'wt', 'owner': 'operator',
            'operation': 'build', 'source_digest': 'a' * 64,
            'state': 'failed', 'payload': {},
        }
        candidate = {
            'job_id': 'job', 'worktree_id': 'wt',
            'package_path': str(root / 'runs' / 'wt' / 'job' / 'package'),
            'source_digest': 'a' * 64,
            'reference_fingerprint': 'f' * 64,
        }
        structured_error = {
            'scope': 'global', 'code': 'unreadable_metadata_entry',
            'path': str(root / 'index' / 'references.json'),
        }
        protected = {'resource_id': 'external-resource', 'reason': 'live_reference'}
        raw = {
            'status': 'incomplete', 'unknown_scope': False,
            'candidates': [candidate], 'retained': [],
            'errors': [structured_error], 'protected_external': [protected],
            'references': [{'resource_id': 'resource-1', 'kind': 'artifact'}],
        }
        error_type = type('_RuntimePlanError', (RuntimeError,), {
            'reason_code': 'runtime_package_unverified',
        })
        error = error_type('diagnostic ' + 'x' * 20_000)
        with patch('local_runner.runtime_retention.complete_jobs', return_value=[job]), \
             patch('local_runner.runtime_retention.container_inventory', return_value=([], None)), \
             patch('local_runner.runtime_retention._reference_roots', return_value=([], True)), \
             patch('local_runner.runtime_retention.plan_runtime_references', return_value=raw), \
             patch('local_runner.runtime_retention._package', side_effect=error):
            preview = plan_runtime_cleanup(
                {'storage_root': str(root)}, object(), owner='operator', call=lambda _argv: None,
                policy={'min_artifacts_to_keep': 0},
            )

        retained = preview['retained'][0]
        self.assertEqual('runtime_package_unverified', retained['retention_failure_code'])
        self.assertTrue(retained['retention_failure_message_omitted'])
        self.assertEqual(candidate['package_path'], retained['package_path'])
        self.assertEqual([structured_error], preview['reference_errors'])
        self.assertEqual([structured_error], preview['raw_runtime_plan']['errors'])
        self.assertEqual([protected], preview['protected_external'])
        self.assertEqual([protected], preview['raw_runtime_plan']['protected_external'])
        self.assertEqual(candidate, preview['raw_runtime_plan']['candidates'][0])

    def test_source_preview_bounds_exception_without_dropping_candidate_identity(self):
        from local_runner.storage_maintenance import plan_source_compaction

        root = self._storage()
        job = {
            'job_id': 'job', 'worktree_id': 'wt', 'owner': 'operator',
            'operation': 'build', 'source_digest': 'a' * 64,
            'state': 'failed',
            'payload': {'capsule_relative': 'runs/wt/capture/source', 'capture_id': 'capture'},
        }
        error_type = type('_SourcePlanError', (RuntimeError,), {
            'reason_code': 'source_capsule_unreadable',
        })
        error = error_type('diagnostic ' + 'x' * 20_000)
        source_path = root / 'runs' / 'wt' / 'capture' / 'source'
        with patch('local_runner.storage_maintenance.complete_jobs', return_value=[job]), \
             patch('local_runner.storage_maintenance._source', return_value=source_path), \
             patch('local_runner.storage_maintenance._guard_source_pins'), \
             patch('local_runner.storage_maintenance._manifest_hash', side_effect=error):
            preview = plan_source_compaction(
                {'storage_root': str(root)}, object(), owner='operator',
            )

        retained = preview['retained'][0]
        self.assertEqual('job', retained['job_id'])
        self.assertEqual('wt', retained['worktree_id'])
        self.assertEqual(str(source_path), retained['path'])
        self.assertEqual('a' * 64, retained['source_digest'])
        self.assertEqual('src-wt-capture', retained['resource_id'])
        self.assertEqual('source_capsule_unreadable', retained['retention_failure_code'])
        self.assertTrue(retained['retention_failure_message_omitted'])
        self.assertEqual(len(str(error).encode('utf-8')), retained['retention_failure_message_bytes'])

    def test_optional_error_text_uses_exact_json_encoded_limit(self):
        error_type = type('E', (Exception,), {'reason_code': 'c'})
        message = 'x' * (MAX_OPTIONAL_ERROR_JSON_BYTES - 8)
        exact = failure_fields(error_type(message), summary_key='reason', label='failure')
        over = failure_fields(error_type(message + 'x'), summary_key='reason', label='failure')

        self.assertFalse(exact['failure_message_omitted'])
        self.assertEqual(MAX_OPTIONAL_ERROR_JSON_BYTES, exact['_optional_error_json_bytes'])
        self.assertTrue(over['failure_message_omitted'])
        self.assertEqual(0, over['_optional_error_json_bytes'])
        self.assertEqual(len(message.encode('utf-8')) + 1, over['failure_message_bytes'])

    def test_error_messages_share_one_bounded_utf8_diagnostic_budget(self):
        class _DiagnosticError(Exception):
            pass

        first_error = _DiagnosticError('a' * 12_000)
        first = failure_fields(first_error, summary_key='reason', label='failure')
        second_error = _DiagnosticError('b' * 10_000)
        second = failure_fields(
            second_error,
            summary_key='reconciliation_error',
            label='reconciliation',
            optional_bytes_used=first['_optional_error_json_bytes'],
        )

        self.assertFalse(first['failure_message_omitted'])
        self.assertTrue(second['reconciliation_message_omitted'])
        self.assertEqual(10_000, second['reconciliation_message_bytes'])
        self.assertLessEqual(
            second['_optional_error_json_bytes'], MAX_OPTIONAL_ERROR_JSON_BYTES,
        )
        self.assertNotIn('b' * 100, second['reconciliation_error'])

    def test_windows_part_opener_requests_open_reparse_point(self):
        from types import SimpleNamespace
        from local_runner import retention_persistence as persistence

        root = self._storage()
        path = root / 'part.bin'
        path.write_bytes(b'part data')
        kernel32 = SimpleNamespace(CreateFileW=Mock(return_value=123),
                                   CloseHandle=Mock())
        real_open = os.open
        fake_msvcrt = SimpleNamespace(
            open_osfhandle=lambda _handle, _flags: real_open(path, os.O_RDONLY),
        )
        with patch('ctypes.WinDLL', return_value=kernel32, create=True), \
             patch.dict('sys.modules', {'msvcrt': fake_msvcrt}):
            descriptor = persistence._open_windows_nofollow_file(path)
        try:
            args = kernel32.CreateFileW.call_args.args
            self.assertEqual(str(path), args[0])
            self.assertTrue(args[5] & 0x00200000)
        finally:
            os.close(descriptor)

    def test_part_reader_rejects_reparse_swap_before_opening_target_stream(self):
        from local_runner import retention_persistence as persistence

        root = self._storage()
        plan_id = 'plan-d2222222'
        parts_dir = root / 'index' / 'retention-parts' / plan_id / 'operation' / 'execution'
        parts_dir.mkdir(parents=True)
        part_path = parts_dir / 'part.bin'
        target_path = root / 'target.bin'
        part_path.write_bytes(b'approved part bytes')
        target_path.write_bytes(b'different target bytes that must never be read')
        probe = root / 'symlink-probe'
        try:
            probe.symlink_to(target_path)
        except (OSError, NotImplementedError) as error:
            self.skipTest(f'symlink fixture unavailable: {error}')
        probe.unlink()

        real_open_nofollow = persistence._open_nofollow_file
        real_fdopen = os.fdopen

        def swap_to_target_before_open(path_arg):
            if Path(path_arg) == part_path:
                part_path.unlink()
                part_path.symlink_to(target_path)
            return real_open_nofollow(path_arg)

        with patch.object(
            persistence, '_open_nofollow_file', side_effect=swap_to_target_before_open,
        ), patch.object(persistence.os, 'fdopen', wraps=real_fdopen) as fdopen_spy:
            with self.assertRaises(RetentionPersistenceError) as raised:
                persistence._read_regular_bytes(
                    root,
                    ('index', 'retention-parts', plan_id, 'operation', 'execution', 'part.bin'),
                    MAX_ENTRY_BYTES,
                )
        self.assertIn(raised.exception.code, ('part_identity_changed', 'part_unreadable'))
        fdopen_spy.assert_not_called()

    def test_posix_fifo_swap_is_rejected_without_blocking_or_fdopen(self):
        if os.name != 'posix' or not hasattr(os, 'mkfifo'):
            self.skipTest('POSIX FIFO fixture is unavailable')

        import subprocess
        import sys

        root = self._storage()
        plan_id = 'plan-d3333333'
        parts_dir = root / 'index' / 'retention-parts' / plan_id / 'operation' / 'execution'
        parts_dir.mkdir(parents=True)
        part_path = parts_dir / 'part.bin'
        part_path.write_bytes(b'approved regular part bytes')
        fifo_probe = root / 'fifo-probe'
        try:
            os.mkfifo(fifo_probe)
            fifo_probe.unlink()
        except OSError as error:
            self.skipTest(f'POSIX FIFO fixture unavailable: {error}')

        child_script = r"""import os
import sys
from pathlib import Path

sys.path.insert(0, sys.argv[1])
from local_runner import retention_persistence as persistence

root = Path(sys.argv[2])
plan_id = sys.argv[3]
relative_parts = (
    'index', 'retention-parts', plan_id, 'operation', 'execution', 'part.bin',
)
real_open = persistence._open_nofollow_file
real_fdopen = persistence.os.fdopen

def swap_regular_part_for_fifo(path):
    Path(path).unlink()
    os.mkfifo(path)
    return real_open(path)

def reject_fifo_stream(*_args, **_kwargs):
    raise AssertionError('fdopen must not be called for a FIFO')

persistence._open_nofollow_file = swap_regular_part_for_fifo
persistence.os.fdopen = reject_fifo_stream
try:
    try:
        persistence._read_regular_bytes(root, relative_parts, persistence.MAX_ENTRY_BYTES)
    except persistence.RetentionPersistenceError as error:
        if error.code not in ('part_identity_changed', 'part_not_regular'):
            raise
    else:
        raise AssertionError('FIFO was accepted as a regular part')
finally:
    persistence.os.fdopen = real_fdopen

print('FIFO rejected before fdopen')
"""

        try:
            completed = subprocess.run(
                [
                    sys.executable,
                    '-c',
                    child_script,
                    str(Path(__file__).resolve().parent),
                    str(root),
                    plan_id,
                ],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
        except subprocess.TimeoutExpired:
            self.fail('reader blocked opening the raced FIFO')
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn('FIFO rejected before fdopen', completed.stdout)
        self.assertTrue(part_path.is_fifo())

    def test_manifest_catalog_rejects_aggregate_budgets_before_opening_parts(self):
        from local_runner import retention_persistence as persistence

        root = self._storage()
        plan_id = 'plan-d1111111'

        def write_manifest(path, array_paths, *, per_part_bytes, declared_part_count):
            payload = {'plan_id': plan_id, 'scope': 'execution'}
            arrays = []
            index = 0
            for array_path in array_paths:
                path_id = persistence._array_id(array_path)
                payload_item = persistence._array_marker(array_path)
                if len(array_path) == 1:
                    payload[array_path[0]] = payload_item
                else:
                    parent = payload.setdefault(array_path[0], {})
                    parent[array_path[1]] = payload_item
                parts = []
                for local_index in range(2):
                    digest = 'a' * 64
                    parts.append({
                        'index': local_index,
                        'name': persistence._part_filename(
                            plan_id, 'plan', 'execution', array_path, local_index, digest,
                        ),
                        'size_bytes': per_part_bytes,
                        'sha256': digest,
                    })
                    index += 1
                arrays.append({
                    'path': list(array_path), 'array_id': path_id, 'count': 2,
                    'has_active_item': False, 'parts': parts,
                })
            manifest = {
                'storage_schema': persistence.MANIFEST_SCHEMA,
                'kind': 'plan', 'plan_id': plan_id, 'scope': 'execution',
                'payload_size_bytes': 200, 'payload_sha256': 'f' * 64,
                'part_count': declared_part_count, 'arrays': arrays, 'payload': payload,
            }
            path.write_text(json.dumps(manifest), encoding='utf-8')

        path = root / 'index' / 'retention-plans' / f'{plan_id}.json'
        write_manifest(path, [('candidates',)], per_part_bytes=120, declared_part_count=2)
        with patch.object(persistence, 'MAX_TOTAL_BYTES', 200), \
             patch.object(persistence, '_read_regular_bytes', side_effect=AssertionError('part opened')) as part_read:
            with self.assertRaises(RetentionPersistenceError) as raised:
                read_document(root, path, plan_id=plan_id, kind='plan', scope='execution')
            self.assertEqual('manifest_part_budget_exceeded', raised.exception.code)
            part_read.assert_not_called()

        write_manifest(path, [('candidates',)], per_part_bytes=1, declared_part_count=2)
        with patch.object(persistence, '_read_regular_bytes', side_effect=AssertionError('part opened')) as part_read:
            with self.assertRaises(RetentionPersistenceError) as raised:
                read_document(root, path, plan_id=plan_id, kind='plan', scope='execution')
            self.assertEqual('manifest_payload_size_mismatch', raised.exception.code)
            part_read.assert_not_called()

        write_manifest(path, [('candidates',), ('retained',)], per_part_bytes=1,
                       declared_part_count=4)
        with patch.object(persistence, 'MAX_PART_COUNT', 3), \
             patch.object(persistence, '_read_regular_bytes', side_effect=AssertionError('part opened')) as part_read:
            with self.assertRaises(RetentionPersistenceError) as raised:
                read_document(root, path, plan_id=plan_id, kind='plan', scope='execution')
            self.assertEqual('manifest_part_budget_exceeded', raised.exception.code)
            part_read.assert_not_called()

    def test_large_partial_receipt_replays_and_corrupt_manifests_fail_before_queue(self):
        root = self._storage()
        plan_id = 'plan-a5555555'
        path, record = self._write_large_operation(root, plan_id)
        manifest_bytes = path.read_bytes()
        manifest = json.loads(manifest_bytes)
        self.assertEqual(record, read_document(root, path, plan_id=plan_id,
                                               kind='operation', scope='execution'))
        queue = _UnusedQueue()
        self.assertEqual(record, self._apply_replay(root, plan_id, queue))
        self.assertEqual([], queue.get_calls)
        self.assertEqual(0, queue.active_calls)

        first = manifest['arrays'][0]['parts'][0]
        second = manifest['arrays'][0]['parts'][1]
        part_path = root / 'index' / 'retention-parts' / plan_id / 'operation' / 'execution' / first['name']
        part_bytes = part_path.read_bytes()

        part_path.unlink()
        with self.assertRaises(RetentionPersistenceError):
            self._apply_replay(root, plan_id, queue)
        self.assertEqual([], queue.get_calls)
        part_path.write_bytes(part_bytes)

        part_path.write_bytes(b'X' + part_bytes[1:])
        with self.assertRaises(RetentionPersistenceError):
            self._apply_replay(root, plan_id, queue)
        self.assertEqual([], queue.get_calls)
        part_path.write_bytes(part_bytes)

        reordered = json.loads(manifest_bytes)
        reordered['arrays'][0]['parts'][0]['index'] = 1
        reordered['arrays'][0]['parts'][1]['index'] = 0
        path.write_text(json.dumps(reordered), encoding='utf-8')
        with self.assertRaises(RetentionPersistenceError):
            self._apply_replay(root, plan_id, queue)
        self.assertEqual([], queue.get_calls)
        path.write_bytes(manifest_bytes)

        unlinked = json.loads(manifest_bytes)
        unlinked['payload']['items'] = {'__fullmag_retention_array__': 'wrong-link'}
        path.write_text(json.dumps(unlinked), encoding='utf-8')
        with self.assertRaises(RetentionPersistenceError):
            self._apply_replay(root, plan_id, queue)
        self.assertEqual([], queue.get_calls)
        self.assertEqual(0, queue.active_calls)

    def test_runtime_dual_error_envelope_capacity_blocks_before_queue_or_docker(self):
        from local_runner import retention_persistence as persistence
        from local_runner.runtime_retention import apply_runtime_cleanup

        root = self._storage()
        plan_id = 'plan-f1111111'
        candidate = {
            'job_id': 'job', 'worktree_id': 'wt', 'size_bytes': 1,
            'package_path': str(root / 'runs' / 'wt' / 'job' / 'package'),
            'package_tree': {
                'logical_bytes': 1, 'files': 1, 'links': 0,
                'fingerprint': 'f' * 64, 'root_device': 1, 'root_inode': 1,
            },
            'build_receipt_sha256': 'a' * 64,
        }
        plan = {
            'plan_id': plan_id, 'scope': 'runtime', 'candidates': [candidate],
            'raw_runtime_plan': {'unknown_scope': False},
        }
        queue = _UnusedQueue()
        with patch.object(persistence, 'MAX_ENTRY_BYTES', 4096):
            result = apply_runtime_cleanup(
                {'storage_root': str(root)}, plan, queue, owner='operator',
                call=lambda argv: self.fail(f'unexpected Docker call: {argv}'), policy={},
            )

        self.assertEqual('blocked', result['status'])
        self.assertEqual('operation_outcome_entry_exceeded', result['capacity_error'])
        self.assertEqual([], queue.get_calls)
        self.assertEqual(1, queue.active_calls)
        saved = read_document(
            root,
            root / 'index' / 'retention-operations' / f'{plan_id}.json',
            plan_id=plan_id, kind='operation', scope='runtime',
        )
        self.assertEqual(result, saved)

    def test_concurrent_part_name_conflict_preserves_old_manifest_and_winner(self):
        from local_runner import retention_persistence as persistence

        root = self._storage()
        plan_id = 'plan-f2222222'
        path, old_record = self._write_large_operation(root, plan_id)
        old_manifest = path.read_bytes()
        changed = {**old_record, 'items': [dict(item) for item in old_record['items']]}
        changed['items'][1]['reason'] = 'new immutable content'
        conflict_bytes = b'concurrent winner must remain untouched'
        conflict_paths = []

        def create_conflicting_winner(_temporary, destination):
            destination = Path(destination)
            self.assertFalse(destination.exists())
            destination.write_bytes(conflict_bytes)
            conflict_paths.append(destination)
            raise FileExistsError('part name was concurrently created')

        with patch.object(persistence.os, 'link', side_effect=create_conflicting_winner) as link_spy:
            with self.assertRaises(RetentionPersistenceError) as raised:
                write_document(
                    root, path, changed, kind='operation', scope='execution',
                )
        self.assertEqual('immutable_part_conflict', raised.exception.code)
        link_spy.assert_called_once()
        self.assertEqual(old_manifest, path.read_bytes())
        self.assertEqual(conflict_bytes, conflict_paths[0].read_bytes())
        parts_dir = conflict_paths[0].parent
        self.assertEqual([], list(parts_dir.glob('.*.tmp')))
        self.assertEqual(
            old_record,
            read_document(root, path, plan_id=plan_id, kind='operation', scope='execution'),
        )

    def test_capacity_failure_publishes_blocked_receipt_before_any_scope_mutation(self):
        from local_runner.runtime_retention import apply_runtime_cleanup
        from local_runner.storage_maintenance import apply_source_compaction

        for scope in ('execution', 'runtime', 'sources'):
            with self.subTest(scope=scope):
                root = self._storage()
                plan_id = 'plan-b' + {'execution': '1111111', 'runtime': '2222222', 'sources': '3333333'}[scope]
                oversized_path = str(root / 'runs' / 'wt' / 'job' / ('x' * (MAX_ENTRY_BYTES + 64)))
                queue = _UnusedQueue()
                if scope == 'execution':
                    candidate = {
                        'job_id': 'job', 'worktree_id': 'wt', 'bytes': 1,
                        'execution': oversized_path,
                        'tree_identity': {
                            'logical_bytes': 1, 'files': 1, 'links': 0,
                            'fingerprint': 'f' * 64, 'root_device': 1, 'root_inode': 1,
                        },
                    }
                    plan = {
                        'plan_id': plan_id,
                        'candidates': [{'job_id': 'job'}],
                        'raw_engine_plan': {'candidates': [candidate]},
                    }
                    apply = lambda: apply_execution_plan(
                        {'storage_root': str(root)}, plan, queue, owner='operator',
                        call=lambda argv: self.fail(f'unexpected Docker call: {argv}'),
                        policy={'ttl_success_hours': 24, 'ttl_failure_hours': 168},
                    )
                elif scope == 'runtime':
                    candidate = {
                        'job_id': 'job', 'worktree_id': 'wt', 'size_bytes': 1,
                        'package_path': oversized_path,
                        'package_tree': {
                            'logical_bytes': 1, 'files': 1, 'links': 0,
                            'fingerprint': 'f' * 64, 'root_device': 1, 'root_inode': 1,
                        },
                        'build_receipt_sha256': 'a' * 64,
                    }
                    plan = {
                        'plan_id': plan_id, 'scope': 'runtime', 'candidates': [candidate],
                        'raw_runtime_plan': {'unknown_scope': False},
                    }
                    apply = lambda: apply_runtime_cleanup(
                        {'storage_root': str(root)}, plan, queue, owner='operator',
                        call=lambda argv: self.fail(f'unexpected Docker call: {argv}'), policy={},
                    )
                else:
                    candidate = {
                        'job_id': 'job', 'worktree_id': 'wt', 'size_bytes': None,
                        'path': oversized_path, 'source_digest': 'a' * 64,
                        'manifest_sha256': 'b' * 64,
                    }
                    plan = {'plan_id': plan_id, 'scope': 'sources', 'candidates': [candidate]}
                    apply = lambda: apply_source_compaction(
                        {'storage_root': str(root)}, plan, queue, owner='operator',
                        call=lambda argv: self.fail(f'unexpected Docker call: {argv}'),
                    )

                result = apply()
                self.assertEqual('blocked', result['status'])
                self.assertEqual('operation_evidence_capacity_exceeded', result['error'])
                self.assertEqual('operation_outcome_entry_exceeded', result['capacity_error'])
                self.assertEqual([], queue.get_calls)
                self.assertEqual(1, queue.active_calls)
                saved = read_document(
                    root,
                    root / 'index' / 'retention-operations' / f'{plan_id}.json',
                    plan_id=plan_id, kind='operation', scope=scope,
                )
                self.assertEqual(result, saved)
