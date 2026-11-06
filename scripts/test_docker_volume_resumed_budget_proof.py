"""Failed-resume authority must never be substituted for its parent receipt."""
import copy
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import patch

from docker_build_control import BuildControlError, canonical
import docker_volume_preowner_drained as base
import docker_volume_resumed_budget_proof as proof
import docker_volume_cold_budget_restore as restore
import test_docker_volume_cold_budget_restore as legacy


class StartupProofTests(unittest.TestCase):
    def setUp(self):
        self.control = SimpleNamespace(project='group', volume='control', namespace='')
        self.document = {'name': 'group', 'services': {'backend': {'image': 'sha256:' + 'a' * 64}}}
        self.config = base._sha(canonical(self.document))
        common = dict(schema='fullmag.docker-build-operation.v1', state='failed-confirmed',
                      compose_project='group', control_volume='control', state_root='/state',
                      backend_container='b' * 64, frontend_container='f' * 64,
                      frontend_started_at='2026-11-06T00:00:00Z',
                      inputs=dict(source_root='/source', image_id='sha256:' + 'a' * 64))
        self.parent = dict(copy.deepcopy(common), phase='development', attempt='1' * 32,
                           backend_started_at='2026-11-06T00:00:00Z', ledger_profile='group-ledger-v1')
        self.resume = dict(copy.deepcopy(common), phase='resume', attempt='2' * 32,
                           backend_started_at='2026-11-06T01:00:00Z', config_sha256=self.config,
                           error='Runtime startup failed; diagnostic API retained: ' + base.REFUSAL,
                           worker_cgroup=dict(schema='fullmag.worker-cgroup-ready.v1', state='ready',
                                             container_id='b' * 64, image_id='sha256:' + 'a' * 64,
                                             compose_project='group'))
        self.resume['inputs'].update(attempt=self.parent['attempt'], config_sha256=self.config)

    def validate(self):
        proof.validate_startup(self.control, self.parent, self.resume, self.document,
                               source_root='/source', resume_attempt='2' * 32)

    def test_failed_build_parent_and_failed_runtime_resume_are_separate(self):
        before = copy.deepcopy(self.parent)
        self.validate()
        self.assertEqual(self.parent, before)
        self.assertNotIn('worker_cgroup', self.parent)
        self.assertNotIn('config_sha256', self.parent)

    def test_changed_resume_or_parent_identity_is_rejected(self):
        cases = [('phase', 'development'), ('state', 'succeeded'), ('attempt', '3' * 32),
                 ('backend_container', 'c' * 64), ('frontend_container', 'e' * 64),
                 ('state_root', '/foreign'), ('config_sha256', 'a' * 64),
                 ('backend_started_at', self.parent['backend_started_at']), ('error', 'another failure')]
        for key, value in cases:
            with self.subTest(key=key):
                old = copy.deepcopy(self.resume)
                self.resume[key] = value
                with self.assertRaises(BuildControlError): self.validate()
                self.resume = old
        for key, value in [('source_root', '/other'), ('attempt', '4' * 32),
                           ('image_id', 'sha256:' + 'e' * 64), ('config_sha256', 'f' * 64)]:
            with self.subTest(input=key):
                old = copy.deepcopy(self.resume)
                self.resume['inputs'][key] = value
                with self.assertRaises(BuildControlError): self.validate()
                self.resume = old

    def test_worker_cgroup_must_bind_current_container_and_image(self):
        for key, value in [('state', 'pending'), ('container_id', 'c' * 64), ('image_id', 'sha256:' + 'e' * 64)]:
            old = copy.deepcopy(self.resume)
            self.resume['worker_cgroup'][key] = value
            with self.subTest(key=key), self.assertRaises(BuildControlError): self.validate()
            self.resume = old

    def test_current_pointer_required_for_stop_but_archives_survive_later_startup(self):
        records = {}
        for phase, doc in [('development', self.parent), ('resume', self.resume)]:
            root = phase + '/attempts/' + doc['attempt']
            for path in (root + '/terminal.json', root + '/receipt.json', phase + '/current.json'):
                records[path] = canonical(doc) + b'\n'
            if phase == 'development':
                records[root + '/compose.json'] = canonical(self.document) + b'\n'
        self.control.read_bytes = lambda p, **kw: records[p]
        kwargs = dict(source_root='/source', resume_attempt=self.resume['attempt'])
        current = proof.load_startup(self.control, self.parent, self.document, **kwargs)
        records['resume/current.json'] = b'{}\n'
        with self.assertRaises(BuildControlError):
            proof.load_startup(self.control, self.parent, self.document, **kwargs)
        archived = proof.load_startup(self.control, self.parent, self.document, current=False, **kwargs)
        self.assertEqual(current, archived)
        root = 'resume/attempts/' + self.resume['attempt']
        records[root + '/receipt.json'] = b'{}\n'
        with self.assertRaises(BuildControlError):
            proof.load_startup(self.control, self.parent, self.document, current=False, **kwargs)


class ResumedHistoryTests(unittest.TestCase):
    write = legacy.HistoryTests.write

    def setUp(self):
        legacy.HistoryTests.setUp(self)
        self.control.namespace = ''
        self.recreate = '2' * 32
        self.previous.update(started_at=30, backend_container='b' * 64, frontend_container='f' * 64)
        self.terminal.update(state='failed-confirmed', error='Backend exited during build; native test failed',
                             frontend_container='e' * 64, backend_started_at='then', finished_at=10)
        self.terminal.pop('idle_backend_stopped')
        self.terminal['inputs'].update(attempt='3' * 32, config_sha256=self.terminal.pop('config_sha256'))
        self.write(self.old_root + '/terminal.json', self.terminal)
        self.write(self.old_root + '/receipt.json', self.terminal)
        self.recreate_root = 'recreate-services/attempts/' + self.recreate
        receipt = dict(schema='fullmag.docker-build-operation.v1', phase='recreate-services', state='succeeded',
                       attempt=self.recreate, compose_project='project', control_volume='volume',
                       fresh_state=False, previous_state_root='/state', started_at=20, finished_at=25,
                       inputs={k: self.terminal['inputs'][k] for k in ('attempt', 'config_sha256')},
                       removed_containers=['c' * 64, 'e' * 64])
        self.write(self.recreate_root + '/terminal.json', receipt)
        self.write(self.recreate_root + '/receipt.json', receipt)
        retained = {'backend': dict(Id='c' * 64, Image='sha256:' + 'b' * 64,
                    State=dict(StartedAt='then', Running=False, Status='exited', Pid=0, ExitCode=2, OOMKilled=False)),
                    'frontend': dict(Id='e' * 64)}
        self.write(self.recreate_root + '/retained-containers.json', retained)

    def observe(self):
        return restore._history(self.control, self.previous, self.iteration, self.fence, recreate_attempt=self.recreate)

    def test_completed_drain_then_failed_rebuild_then_completed_recreate(self):
        with patch.object(proof, 'docker_capture', return_value=SimpleNamespace(returncode=0, stdout=b'')):
            observed = self.observe()
            self.assertEqual(observed['recreate_attempt'], self.recreate)
            self.assertIn(self.recreate_root + '/terminal.json', observed['control_hashes'])
            with self.assertRaises(BuildControlError):
                restore._history(self.control, self.previous, self.iteration, self.fence)

    def test_wrong_recreate_or_unfinished_drain_or_still_present_pair_rejected(self):
        original = copy.deepcopy(self.records)
        changes = [(self.recreate_root + '/terminal.json', 'fresh_state', True),
                   (self.recreate_root + '/terminal.json', 'previous_state_root', '/foreign'),
                   (self.recreate_root + '/terminal.json', 'state', 'running'),
                   (self.recreate_root + '/terminal.json', 'removed_containers', ['c' * 64]),
                   (self.old_root + '/backend-drain.json', 'backend_container_id', 'a' * 64)]
        for path, key, value in changes:
            self.records = copy.deepcopy(original)
            changed = json.loads(self.records[path]); changed[key] = value; self.write(path, changed)
            if path.endswith('/terminal.json'): self.write(path.replace('/terminal.json', '/receipt.json'), changed)
            with self.subTest(key=key), patch.object(proof, 'docker_capture', return_value=SimpleNamespace(returncode=0, stdout=b'')):
                with self.assertRaises(BuildControlError): self.observe()
        self.records = original
        with patch.object(proof, 'docker_capture', return_value=SimpleNamespace(returncode=0, stdout=('c' * 64).encode())):
            with self.assertRaises(BuildControlError): self.observe()

    def test_future_budget_consumer_uses_immutable_drain_after_owner_changes(self):
        with patch.object(proof, 'docker_capture', return_value=SimpleNamespace(returncode=0, stdout=b'')):
            history = self.observe()
            observed = {'history': history, 'cold_api': {'process_tree_sha256':
                base._sha(self.records['runtime-control/runtime-service/process-tree.json'])}}
            self.write('runtime-control/runtime-services/OWNER.json', {'state': 'ready', 'new_owner': True})
            self.write('runtime-control/runtime-service/process-tree.json', {'state': 'ready'})
            proof.authenticate_archived_history(self.control, self.previous, observed)
            # A live stop must still reject these changed native owners.
            with self.assertRaises(BuildControlError): self.observe()
            self.write(self.old_root + '/backend-drain.json', {'state': 'drained'})
            with self.assertRaises(BuildControlError):
                proof.authenticate_archived_history(self.control, self.previous, observed)


class ResumedProducerTests(legacy.ProducerJournalTests):
    def setUp(self):
        legacy.ProducerJournalTests.setUp(self)
        self.args.variant = proof.VARIANT
        self.args.resume_attempt = '1' * 32
        self.args.recreate_attempt = '2' * 32
        self.previous['backend_container'] = self.args.backend_container_id
        self.previous.pop('config_sha256')
        self.previous.pop('worker_cgroup')
        path = 'development/attempts/' + self.previous['attempt'] + '/terminal.json'
        self.control.write(path, self.previous)
        self.observation['parent_terminal_sha256'] = base._sha(self.control.records[path])
        self.observation['resumed_authority'] = dict(resume_attempt=self.args.resume_attempt,
            recreate_attempt=self.args.recreate_attempt, control_hashes={})
        self.observation['history']['recreate_attempt'] = self.args.recreate_attempt

    @contextmanager
    def patched(self, **kwargs):
        startup = dict(backend_started_at='then', backend_container=self.args.backend_container_id)
        with legacy.ProducerJournalTests.patched(self, **kwargs), patch.object(proof, 'load_startup', return_value=(startup, {}, b'', b'')), \
             patch.object(proof, 'projected_budget', return_value=self.observation['budget']), \
             patch.object(proof, 'authenticate_archived_history'):
            yield

    def test_recovery_pins_are_not_accepted_for_the_legacy_variant(self):
        self.args.variant = restore.VARIANT
        with self.patched(), self.assertRaises(BuildControlError): restore.stop(self.args)

    def test_missing_resume_or_recreate_pin_refuses_before_operation(self):
        for key in ('resume_attempt', 'recreate_attempt'):
            old = getattr(self.args, key); setattr(self.args, key, None)
            with self.patched(), self.assertRaises(BuildControlError): restore.stop(self.args)
            setattr(self.args, key, old)

    def test_cli_preserves_both_resume_authority_pins(self):
        import docker_dev
        argv = ['stop-preowner-policy-volume', '--variant', proof.VARIANT,
                '--source-root', '/source', '--attempt', 'a' * 32, '--config-sha256', 'b' * 64,
                '--backend-container-id', 'c' * 64, '--image-id', 'sha256:' + 'd' * 64,
                '--drain-attempt', 'e' * 32, '--resume-attempt', '1' * 32, '--recreate-attempt', '2' * 32]
        with patch.object(restore, 'stop') as stop:
            self.assertEqual(docker_dev.main(argv), 0)
            args = stop.call_args.args[0]
            self.assertEqual(restore._recovery_args(args), {'resume_attempt': '1' * 32, 'recreate_attempt': '2' * 32})
            self.assertFalse(args.apply)


class ResumedContinuationTests(legacy.ContinuationTests):
    setUp = ResumedProducerTests.setUp
    patched = ResumedProducerTests.patched


class LimitsProbeTests(unittest.TestCase):
    def test_cpu_only_delegation_inherits_memory_at_the_visible_root(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp); cg = root / 'cg'; leaf = cg / 'workers' / 'control'
            leaf.mkdir(parents=True)
            for path in (cg, cg / 'workers', leaf):
                (path / 'cpu.max').write_text('800000 100000' if path == cg else 'max 100000')
                (path / 'cgroup.controllers').write_text('cpu memory' if path == cg else 'cpu')
                (path / 'cgroup.subtree_control').write_text('cpu')
            (cg / 'memory.max').write_text(str(64 * 1024 ** 3))
            mountinfo = root / 'mountinfo'; membership = root / 'cgroup'
            mountinfo.write_text(f'1 0 0:25 / {cg} ro - cgroup2 cgroup rw\n')
            membership.write_text('0::/workers/control\n')
            script = proof.LIMITS_PROBE.replace('/proc/self/mountinfo', str(mountinfo)).replace('/proc/self/cgroup', str(membership))
            result = subprocess.run([sys.executable, '-I', '-B', '-c', script], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            value = json.loads(result.stdout)
            self.assertEqual(value['limits']['cpu_millis'], 8000)
            self.assertEqual(value['limits']['memory_bytes'], 64 * 1024 ** 3)
            (cg / 'workers' / 'cgroup.subtree_control').write_text('cpu memory')
            invalid = subprocess.run([sys.executable, '-I', '-B', '-c', script], capture_output=True)
            self.assertNotEqual(invalid.returncode, 0)


if __name__ == '__main__':
    unittest.main()
