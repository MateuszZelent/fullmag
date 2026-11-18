"""Source-only checks: never contact Docker or start runtime/build work."""
import ast
import copy
import contextlib
import json
import os
from types import SimpleNamespace
from unittest.mock import patch
import tempfile
from pathlib import Path
import unittest

from docker_build_control import BuildControlError
import docker_claimed_runtime_checks as checks
import docker_claimed_checks_reconcile as reconcile


class ReconcileTests(unittest.TestCase):
    def test_controller_definitions_have_no_original_entrypoint(self):
        code = reconcile.inside_code()
        ast.parse(code)
        self.assertNotIn('raise SystemExit(run_claimed_runtime_checks(', code)
        self.assertIn('with runtime_locks() as paths, claimed_build_locks(', code)
        self.assertIn('current_candidate_workspace_matches(', code)

    def test_original_controller_digest_is_required(self):
        inputs = {'controller_sha256': '0' * 64}
        with self.assertRaises(BuildControlError):
            reconcile.check_controller(inputs)

    def test_host_process_match_absolute_and_relative(self):
        source = Path('/selected')
        self.assertTrue(reconcile.is_manager([b'python', b'/selected/scripts/docker_claimed_runtime_checks.py'], Path('/other'), source))
        self.assertTrue(reconcile.is_manager([b'python', b'scripts/docker_claimed_runtime_checks.py'], source, source))
        self.assertFalse(reconcile.is_manager([b'python', b'-c', b"print('docker_claimed_runtime_checks.py')"], source, source))

    def test_new_manager_denies_finalization(self):
        with tempfile.TemporaryDirectory() as directory:
            proc = Path(directory)
            row = proc / '998'; row.mkdir()
            (row / 'cmdline').write_bytes(b'python\0/selected/scripts/docker_claimed_runtime_checks.py\0')
            (row / 'cwd').symlink_to('/selected')
            with self.assertRaisesRegex(BuildControlError, 'manager'):
                reconcile.host_inactive(Path('/selected'), proc=proc)

    def test_permission_failure_is_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            proc = Path(directory)
            row = proc / '998'; row.mkdir()
            (row / 'cmdline').mkdir()
            with self.assertRaises(BuildControlError):
                reconcile.host_inactive(Path('/selected'), proc=proc)

    def test_runtime_and_workspace_drift_rejected(self):
        base = {'runtime_evidence_before_sha256':'a', 'runtime_evidence_after_sha256':'a',
                'workspace_source_before_sha256':'b', 'workspace_source_after_sha256':'b'}
        for name in base:
            drift = copy.deepcopy(base); drift[name] = 'changed'
            with self.assertRaises(BuildControlError):
                reconcile.require_stable_result(drift)

    def test_request_strict_pins(self):
        with self.assertRaises(BuildControlError):
            reconcile.validate_request_shape({'schema':reconcile.SCHEMA, 'attempt':'../other'})

    def test_current_runtime_and_workspace_drift_deny_guest_finalization(self):
        for runtime_drift, workspace_drift in ((True, False), (False, True)):
            with self.subTest(runtime_drift=runtime_drift, workspace_drift=workspace_drift):
                with tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)/'claimed-runtime-checks'/'attempts'/('a'*32)
                    root.mkdir(parents=True)
                    result = {'state':'tests-failed-known', 'commands':[],
                              'runtime_evidence_before_sha256':'original',
                              'runtime_evidence_after_sha256':'original'}
                    originals = {'receipt.json':b'{}', 'result.json':json.dumps(result).encode(),
                                 'build.log':b'completed'}
                    for name, raw in originals.items():
                        (root/name).write_bytes(raw)
                    inputs = {'operation_root':str(root), 'compose_project':'selected', 'source_root':'/selected'}
                    request = {'attempt':'a'*32, 'inputs':inputs,
                               'receipt_sha256':reconcile.digest(originals['receipt.json']),
                               'result_sha256':reconcile.digest(originals['result.json']),
                               'log_sha256':reconcile.digest(originals['build.log'])}
                    namespace = {'Path':Path, 'os':os, 'json':json,
                                 'require':checks.require, 'sha_bytes':reconcile.digest,
                                 'read_bounded_regular':lambda path, *_: (path.read_bytes(), None),
                                 'runtime_locks':lambda:contextlib.nullcontext(None),
                                 'claimed_build_locks':lambda *_:contextlib.nullcontext(),
                                 'pinned_evidence':lambda *_: {},
                                 'canonical_sha':lambda _: 'changed' if runtime_drift else 'original',
                                 'backend':SimpleNamespace(PACKAGE_ROOT=Path('/package')),
                                 'package_snapshot':lambda *_args, **_kwargs: {},
                                 'candidate_and_workspace':lambda *_: {},
                                 'result_record':lambda *_args, **_kwargs: dict(result, changed=True) if workspace_drift else result}
                    exec(reconcile.RECONCILE_RUNTIME, namespace)
                    namespace['reconciliation_processes'] = lambda _:None
                    with patch.dict(os.environ, {'FULLMAG_COMPOSE_PROJECT':'selected', 'FULLMAG_SOURCE_HOST_ROOT':'/selected'}):
                        with self.assertRaises(BuildControlError):
                            namespace['reconcile_completed_checks'](request, True)
                    self.assertEqual({path.name for path in root.iterdir()}, set(originals))

    def test_guest_has_no_kill_remove_or_test_execution_entrypoint(self):
        tree = ast.parse(reconcile.RECONCILE_RUNTIME)
        attributes = {node.func.attr for node in ast.walk(tree)
                      if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)}
        self.assertFalse({'kill','unlink','rmdir','Popen','run'} & attributes)
        self.assertNotIn('run_claimed_runtime_checks(', reconcile.RECONCILE_RUNTIME)


if __name__ == '__main__':
    unittest.main()
