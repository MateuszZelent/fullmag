"""Receipt rejection tests for the narrowly scoped failed-iteration recovery."""
import copy
import hashlib
import unittest
from pathlib import Path
from types import SimpleNamespace
from docker_build_control import BuildControlError, canonical
from docker_volume_stop_startup_iteration import validate_receipts, PROBE, operation_success


class StartupIterationTests(unittest.TestCase):
    def setUp(self):
        self.document = {'name': 'selected-project'}
        self.digest = hashlib.sha256(canonical(self.document)).hexdigest()
        self.args = SimpleNamespace(attempt='a'*32, iteration_attempt='b'*32, config_sha256=self.digest, port=3217)
        self.control = SimpleNamespace(project='selected-project', volume='selected-control', namespace=None)
        self.selected = Path('/selected')
        common = dict(schema='fullmag.docker-build-operation.v1', compose_project=self.control.project, control_volume=self.control.volume)
        self.parent = dict(common, phase='development', attempt=self.args.attempt, state='succeeded', state_root='/retained', backend_container='c'*64,
                           inputs=dict(source_root=str(self.selected), image_id='sha256:'+'d'*64))
        self.iteration = dict(common, phase='iteration', attempt=self.args.iteration_attempt, state='failed-confirmed', state_root='/retained',
                              config_sha256=self.digest, backend_started_at='2026-10-27T03:34:05Z',
                              inputs=dict(self.parent['inputs'], attempt=self.args.attempt, config_sha256=self.digest),
                              worker_cgroup=dict(schema='fullmag.worker-cgroup-ready.v1',state='ready',container_id='c'*64,image_id='sha256:'+'d'*64,compose_project=self.control.project))
        self.failure = dict(path='/opt/fullmag/runtime-control/runtime-service/api-failure-'+'e'*32+'.json',
                            fence=dict(schema='fullmag.api-runtime-failure-fence.v1',stage='runtime_startup',reason='native startup failed\n'))
        self.iteration['error'] = 'Runtime startup failed; services retained: '+self.failure['fence']['reason']

    def validate(self):
        validate_receipts(self.args,self.control,self.selected,self.parent,self.iteration,self.document,self.failure)

    def test_stop_uses_terminal_build_control_state(self):
        result=operation_success(dict(state="stopped-confirmed", backend_container="id"))
        self.assertEqual(result["state"],"succeeded")
        self.assertEqual(result["stop_state"],"stopped-confirmed")
        with self.assertRaises(BuildControlError): operation_success(dict(state="unknown"))

    def test_accepts_exact_failed_iteration(self):
        self.validate()
        compile(PROBE, '<diagnostic-probe>', 'exec')

    def test_rejects_changed_receipt_bindings(self):
        for key, value in [('state','succeeded'), ('attempt','f'*32), ('phase','resume'), ('compose_project','other'),
                           ('control_volume','other'), ('state_root','/other'), ('config_sha256','0'*64), ('backend_started_at',''),
                           ('error','unrelated error'), ('control_namespace','other')]:
            with self.subTest(key=key):
                old=copy.deepcopy(self.iteration)
                self.iteration[key]=value
                with self.assertRaises(BuildControlError): self.validate()
                self.iteration=old

    def test_rejects_foreign_source_parent_image_or_container(self):
        for group,key,value in [('inputs','source_root','/foreign'),('inputs','attempt','f'*32),('inputs','image_id','sha256:'+'f'*64),
                                ('worker_cgroup','container_id','f'*64),('worker_cgroup','state','unknown')]:
            with self.subTest(group=group,key=key):
                old=copy.deepcopy(self.iteration)
                self.iteration[group][key]=value
                with self.assertRaises(BuildControlError): self.validate()
                self.iteration=old

    def test_rejects_supervision_fence(self):
        self.failure['fence']['stage']='runtime_supervision'
        with self.assertRaises(BuildControlError): self.validate()

    def test_rejects_fence_path_escape(self):
        self.failure['path']='/tmp/api-failure-'+'e'*32+'.json'
        with self.assertRaises(BuildControlError): self.validate()

    def test_rejects_compose_mutation(self):
        self.document['changed']=True
        with self.assertRaises(BuildControlError): self.validate()

    def test_rejects_nonterminal_parent(self):
        self.parent['state']='running'
        with self.assertRaises(BuildControlError): self.validate()

if __name__=='__main__': unittest.main()
