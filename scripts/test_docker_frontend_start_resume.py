"""An explicitly pinned metadata-only failure may continue a completed recreation."""
from __future__ import annotations
import copy
import hashlib
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parent))
from docker_build_control import BuildControlError, canonical
from test_docker_volume_recovery_handoff import MemoryControl
import docker_volume_frontend_start_resume as resume

class FailedFrontendStartTests(unittest.TestCase):
    def setUp(self):
        self.c = MemoryControl()
        self.previous = {'attempt': 'a'*32, 'state_root': '/state-own', 'backend_volumes': {'build': self.c.volume}, 'frontend_volume': self.c.volume, 'private_group_storage': 'group-volume-v1', 'inputs': {'source_root': '/checkout', 'gpu_access_requested': 'required', 'device_access': 'gpu', 'gpu_preflight': 'PASS'}}
        self.identity = {'project_id': 'own', 'worktree_id': 'wt', 'checkout_kind': 'worktree'}
        self.operator = {'operator_probe_environment': {}, 'operator_probe_environment_schema': 'own', 'operator_probe_environment_sha256': 'b'*64}
        self.capability = {'recovery_metadata': {'schema': 'fullmag.container-recovery.v1'}, 'recovery_environment': {'FULLMAG_CONTAINER_RECOVERY_AUTHORIZATION': '/opt/fullmag/control/auth.json', 'FULLMAG_CONTAINER_RECOVERY_AUTHORIZATION_SHA256': 'c'*64}}
        self.operation = {'attempt': 'd'*32, 'finished_at': 1.0}
        self.current = {'schema': 'fullmag.docker-build-operation.v1', 'phase': 'development', 'state': 'failed-confirmed', 'attempt': 'e'*32, 'compose_project': self.c.project, 'control_volume': self.c.volume, 'state_root': '/state-own', 'private_group_storage': 'group-volume-v1', 'backend_volumes': self.previous['backend_volumes'], 'frontend_volume': self.c.volume, 'ui_mode': 'gui', 'started_at': 2.0, 'finished_at': 3.0, 'error': 'Traceback (most recent call last):\n  File "<string>", line 95, in <module>\nRuntimeError: Frontend metadata has unknown changes; all state retained\n', 'container_recovery': self.capability['recovery_metadata'], 'container_recovery_environment': sorted(self.capability['recovery_environment']), **self.operator}
        self.current['inputs'] = {'source_root': '/checkout', 'source_project_id': 'own', 'source_worktree_id': 'wt', 'source_checkout_kind': 'worktree', 'image_id': 'sha256:'+'f'*64, 'ui_mode': 'gui', 'gpu_access_requested': 'required', 'device_access': 'gpu', 'gpu_preflight': 'PASS', **self.operator}
        self.args = SimpleNamespace(failed_frontend_start=self.current['attempt'], failed_frontend_start_sha256=None, resume_recreation=self.operation['attempt'], fresh_state=False, script=None, headless=False)
        self.publish()
    def publish(self):
        self.raw = canonical(self.current) + b'\n'; self.args.failed_frontend_start_sha256 = hashlib.sha256(self.raw).hexdigest()
        self.previous_raw = canonical(self.previous) + b'\n'; self.operation_raw = canonical(self.operation) + b'\n'
        for p in ('development/current.json', 'development/attempts/'+self.current['attempt']+'/receipt.json', 'development/attempts/'+self.current['attempt']+'/terminal.json'): self.c.records[p] = self.raw
        self.c.records['development/verified.json'] = self.previous_raw
        for p in ('recreate-services/current.json', 'recreate-services/verified.json'): self.c.records[p] = self.operation_raw
    def run_validation(self):
        return resume.validate_failed_start(self.args, self.c, Path('/checkout'), self.identity, current_raw=self.raw, current=self.current, previous_raw=self.previous_raw, previous=self.previous, operation_raw=self.operation_raw, operation_terminal=self.operation, operator_probe_record=self.operator, capability=self.capability)
    def test_exact_pins_admit_without_modifying_history(self):
        before = copy.deepcopy(self.c.records); self.run_validation(); self.assertEqual(before, self.c.records)
    def test_pair_is_required_and_requires_resume_without_startup_solve(self):
        for key, value in (('failed_frontend_start_sha256', None), ('resume_recreation', None), ('script', 'solve.py'), ('fresh_state', True)):
            with self.subTest(key=key):
                self.setUp(); setattr(self.args, key, value)
                with self.assertRaises(BuildControlError): resume.validate_options(self.args)
    def test_wrong_pin_or_current_verified_and_recreation_cas_refuses(self):
        self.args.failed_frontend_start_sha256 = '1'*64
        with self.assertRaises(BuildControlError): self.run_validation()
        for path in ('development/current.json', 'development/verified.json', 'recreate-services/current.json', 'recreate-services/verified.json'):
            with self.subTest(path=path):
                self.setUp(); self.c.records[path] = b'{}\n'
                with self.assertRaises(BuildControlError): self.run_validation()
    def test_other_error_service_publication_or_foreign_intent_refuses(self):
        for key, value in (('error', 'another failure'), ('backend_container', '1'*64), ('state_root', '/foreign'), ('container_recovery', {})):
            with self.subTest(key=key):
                self.setUp(); self.current[key] = value; self.publish()
                with self.assertRaises(BuildControlError): self.run_validation()
        self.setUp(); self.current['inputs']['source_project_id'] = 'foreign'; self.publish()
        with self.assertRaises(BuildControlError): self.run_validation()
    def test_generation_aware_failures_are_outside_legacy_lost_generation_repair(self):
        for where, key, value in (
                ('receipt', 'frontend_generation_id', 'a' * 32),
                ('receipt', 'frontend_generation_subpath', 'private/frontend/generations/' + 'a' * 32),
                ('inputs', 'frontend_start_handoff', {'schema': 'fullmag.frontend-start-handoff.v1'})):
            with self.subTest(key=key):
                self.setUp()
                target = self.current if where == 'receipt' else self.current['inputs']
                target[key] = value
                self.publish()
                with self.assertRaisesRegex(BuildControlError, 'Legacy lost-generation'):
                    self.run_validation()

    def test_compose_seed_or_native_publication_refuses(self):
        for name in ('compose.json', 'frontend-seed.json', 'provenance.json', 'process-failure.json'):
            with self.subTest(name=name):
                self.setUp(); self.c.records['development/attempts/'+self.current['attempt']+'/'+name] = b'{}\n'
                with self.assertRaises(BuildControlError): self.run_validation()
    def test_time_order_and_malformed_timestamp_refuse(self):
        for key, value in (('started_at', 0.0), ('finished_at', 1.5), ('started_at', True), ('finished_at', float('inf'))):
            with self.subTest(key=key):
                self.setUp(); self.current[key] = value; self.publish()
                with self.assertRaises(BuildControlError): self.run_validation()

if __name__ == '__main__': unittest.main()
