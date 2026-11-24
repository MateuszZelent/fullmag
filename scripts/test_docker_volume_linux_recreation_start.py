"""Exercise the real Linux recreation dispatch and leased start branch without Docker."""
import ast
import copy
import inspect
import unittest
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import patch

import docker_volume_dev as dev
import docker_volume_linux_supervision_stop as linux


class LinuxRecreationStartTests(unittest.TestCase):
    def test_native_dispatch_carries_exact_snapshot_and_completed_proof(self):
        snapshot, proof = {'backend': {'Id': 'b' * 64}}, {'retained': 'pinned'}
        context = linux.LinuxSupervisionContext(previous_config_sha256='a' * 64)
        raw = dev.canonical({'failure_kind': linux.KIND}) + b'\n'
        with patch('docker_volume_stop_unadmitted._control_bytes', return_value=raw), \
             patch.object(linux, 'retained_context', return_value=context) as validator:
            result = dev._native_failed_stop_recovery_context(
                object(), {}, backend_id='b' * 64, fresh_state=False,
                removed_container_proof=proof, actual=snapshot)
        self.assertIs(result, context)
        self.assertIs(validator.call_args.kwargs['actual'], snapshot)
        self.assertIs(validator.call_args.kwargs['removed_container_proof'], proof)

    def test_authority_free_context_forwards_exact_snapshot(self):
        snapshot, proof = {'backend': {'Id': 'b' * 64}}, {'retained': 'pinned'}
        context = linux.LinuxSupervisionContext(previous_config_sha256='a' * 64)
        document = {'services': {'backend': {'environment': {}}}}
        with patch.object(dev, '_native_failed_stop_recovery_context', return_value=context) as validator:
            result = dev._retained_recovery_context(
                object(), {}, document, fresh_state=False, backend_id='b' * 64,
                removed_container_proof=proof, actual=snapshot)
        self.assertIs(result, context)
        self.assertIs(validator.call_args.kwargs['actual'], snapshot)
        self.assertIs(validator.call_args.kwargs['removed_container_proof'], proof)

    def leased_branch(self, mutate=None, *, enabled=True, has_proof=True, failure=None):
        function = ast.parse(inspect.getsource(dev.start)).body[0]
        leased = next(node for node in ast.walk(function) if isinstance(node, ast.With)
            and isinstance(node.items[0].context_expr, ast.Name)
            and node.items[0].context_expr.id == 'operation_context')
        branch = next(node for node in leased.body if isinstance(node, ast.If)
            and any(isinstance(value, ast.Constant) and value.value == linux.KIND for value in ast.walk(node.test)))
        wrapper = ast.With(items=leased.items, body=[branch, ast.Expr(value=ast.Call(
            func=ast.Name(id='after_gate', ctx=ast.Load()), args=[], keywords=[]))], type_comment=None)
        module = ast.fix_missing_locations(ast.Module(body=[wrapper], type_ignores=[]))
        operation, proof = {}, {'proof': 'pinned'} if has_proof else None
        metadata = {'failure_kind': linux.KIND if enabled else 'native-after-ready-failure'}
        expected = {'previous_config_sha256': 'c' * 64, 'native_restart_metadata': metadata}
        observed = copy.deepcopy(expected)
        if mutate:
            mutate(observed)
        calls, after = [], []
        def validate(*args, **kwargs):
            calls.append(kwargs)
            self.assertIs(kwargs['current_operation'], operation)
            self.assertIs(kwargs['expected_proof'], proof)
            if failure:
                raise failure
            return {'native_recovery_context': observed}
        scope = {'operation_context': nullcontext(operation), 'recreation_resume_proof': proof,
            'validated_native_restart_metadata': metadata, 'previous_config_sha256': expected['previous_config_sha256'],
            '_validate_recreation_resume_records': validate, 'args': None, 'control': None,
            'selected': None, 'identity': None, 'helper_source_binding': None,
            'BuildControlError': dev.BuildControlError, 'after_gate': lambda: after.append(True)}
        try:
            exec(compile(module, dev.__file__, 'exec'), scope)
        except Exception:
            self.assertEqual(after, [])
            raise
        return calls, after

    def test_start_revalidates_exact_proof_under_its_owned_lease(self):
        calls, after = self.leased_branch()
        self.assertEqual(len(calls), 1)
        self.assertEqual(after, [True])

    def test_context_drift_stops_before_admission(self):
        mutations = [lambda value: value.update(previous_config_sha256='d' * 64),
            lambda value: value['native_restart_metadata'].update(journal_sha256='e' * 64),
            lambda value: value.update(unexpected_authority=True)]
        for mutate in mutations:
            with self.subTest(mutate=mutate), self.assertRaisesRegex(dev.BuildControlError, 'changed under start lease'):
                self.leased_branch(mutate)

    def test_unknown_validator_outcome_stops_before_admission(self):
        with self.assertRaisesRegex(RuntimeError, 'observation unknown'):
            self.leased_branch(failure=RuntimeError('observation unknown'))

    def test_other_routes_keep_their_existing_lease_checks(self):
        for options in ({'enabled': False}, {'has_proof': False}):
            calls, after = self.leased_branch(**options)
            self.assertEqual(calls, [])
            self.assertEqual(after, [True])


if __name__ == '__main__':
    unittest.main()
