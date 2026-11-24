"""Unapplied completed Linux recreation bridge; synthetic managed records only."""
import copy
from contextlib import ExitStack
import hashlib
import json
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import docker_volume_linux_supervision_stop as subject
from docker_volume_reconcile import fingerprint
from docker_build_control import MAX_DOCUMENT_BYTES, BuildControlError, control_read_script


class FakeControl:
    project = 'fullmag-test-group'
    volume = 'fullmag-test-control'
    def __init__(self):
        self.records = {}
        self.read_limits = []
    def put(self, path, value): self.records[path] = subject.canonical(value) + b'\n'
    def read_bytes(self, path, *, maximum=MAX_DOCUMENT_BYTES, **kwargs):
        control_read_script('/control/' + path, maximum)
        self.read_limits.append(maximum)
        raw = self.records[path]
        if len(raw) > maximum:
            raise BuildControlError('Control document exceeds its byte budget')
        return raw
    def read(self, path, **kwargs): return json.loads(self.read_bytes(path))


class CompletedLinuxTests(unittest.TestCase):
    def setUp(self):
        self.contexts = ExitStack()
        self.addCleanup(self.contexts.close)
        self.c = FakeControl()
        self.backend, self.frontend = 'b' * 64, 'f' * 64
        self.token, self.attempt = '1' * 32, '2' * 32
        self.image = 'sha256:' + '3' * 64
        self.doc = {'name': self.c.project, 'services': {'backend': {}, 'frontend': {}}}
        self.previous = {'attempt': self.attempt, 'config_sha256': subject.sha(subject.canonical(self.doc)),
                         'state_root': '/state-test', 'backend_container': self.backend, 'frontend_container': self.frontend,
                         'backend_volumes': {'control': self.c.volume, 'build': self.c.volume, 'package': 'shared-test'},
                         'frontend_volume': self.c.volume, 'inputs': {'image_id': self.image, 'source_root': '/source-test'}}
        self.actual = {}
        for name, identifier in [('backend', self.backend), ('frontend', self.frontend)]:
            self.actual[name] = {'Id': identifier, 'Image': self.image,
                'Config': {'Labels': {'com.docker.compose.project': self.c.project}},
                'HostConfig': {'Mounts': [{'Type': 'volume', 'Source': self.c.volume, 'Target': '/host-ledger',
                                         'VolumeOptions': {'Subpath': 'private/ledger'}}]},
                'Mounts': [{'Type': 'volume', 'Name': self.c.volume, 'Destination': '/host-ledger'}],
                'State': {'Running': False, 'Pid': 0, 'OOMKilled': False,
                          'ExitCode': 1 if name == 'backend' else 0, 'StartedAt': 'start-' + name, 'FinishedAt': 'stop-' + name}}
        self.after = {'schema': subject.SCHEMA_V2, 'preservation_profile': subject.profile_pin(subject.PROFILE_V2),
                      'process_receipt_sha256': 'terminal-process', 'config_raw_sha256': 'config-raw', 'owner_sha256': 'owner',
                      'retained_test_inventory': {'result': 'unchanged'}}
        self.journal = {'failure_kind': subject.KIND, 'schema': 'fullmag.stop-failed-admission.v1', 'state': 'stopped-confirmed',
                        'container_id': self.backend, 'image_id': self.image, 'source_root': '/source-test',
                        'development_attempt': self.attempt, 'compose_config_sha256': self.previous['config_sha256'],
                        'namespace_processes_absent': True, 'preservation_profile': subject.profile_pin(subject.PROFILE_V2),
                        'supervision_probe': dict(copy.deepcopy(self.after), process_receipt_sha256='original-process'),
                        'terminal_process_receipt_sha256': 'terminal-process', 'previous_config_sha256': 'config-raw',
                        'scope': {'test': 'scope'}, 'cancellation': {'test': 'cancelled'},
                        'exit_code': 1, 'stopped_started_at': 'start-backend',
                        'service_pins': {name: [value['State']['StartedAt'], fingerprint(value)] for name,value in self.actual.items()}}
        self.terminal = {'schema': 'fullmag.docker-build-operation.v1', 'phase': 'recreate-services', 'state': 'succeeded',
                         'attempt': self.token, 'compose_project': self.c.project, 'control_volume': self.c.volume,
                         'fresh_state': False, 'removed_containers': [self.backend, self.frontend],
                         'previous_state_root': '/state-test', 'retained_volumes': self.previous['backend_volumes'],
                         'retained_frontend_volume': self.c.volume,
                         'inputs': {'attempt': self.attempt, 'config_sha256': self.previous['config_sha256']}}
        self.op = 'recreate-services/attempts/' + self.token
        self.prior = 'development/attempts/' + self.attempt
        self.journal_path = 'verification/stop-failed-' + self.backend + '.json'
        for path, value in [(self.op+'/terminal.json',self.terminal),(self.op+'/receipt.json',self.terminal),
                            (self.op+'/retained-containers.json',self.actual),(self.prior+'/terminal.json',self.previous),
                            (self.prior+'/compose.json',self.doc),('development/current.json',self.previous),
                            ('development/verified.json',self.previous),(self.journal_path,self.journal)]: self.c.put(path,value)
        self.journal_raw = self.c.read_bytes(self.journal_path)
        self.proof = {'schema':'fullmag.docker-removed-recreation-container.v1', 'recreation_operation_id': self.token,
                      'container_id':self.backend, 'frontend_container':self.frontend, 'image_id':self.image,
                      'container_state': {'id':self.backend,'image':self.image,'started_at':'start-backend',
                                          'finished_at':'stop-backend','exit_code':1}}
        for field,path in [('recreation_terminal_sha256',self.op+'/terminal.json'),('retained_snapshot_sha256',self.op+'/retained-containers.json'),
                           ('prior_terminal_sha256',self.prior+'/terminal.json'),('prior_compose_sha256',self.prior+'/compose.json')]:
            self.proof[field] = subject.sha(self.c.read_bytes(path))
        self.daemon = self.contexts.enter_context(patch('docker_build_control.docker_capture',return_value=SimpleNamespace(returncode=0,stdout=b'',stderr=b'')))
        self.network = self.contexts.enter_context(patch('docker_volume_dev._assert_private_restart_network'))
        self.contexts.enter_context(patch('docker_volume_dev._retained_certificate'))
        self.probe = self.contexts.enter_context(patch.object(subject,'_probe',side_effect=lambda *a,**kw:copy.deepcopy(self.after)))
        self.cancel = self.contexts.enter_context(patch.object(subject,'cancellation',return_value=self.journal['cancellation']))

    def run_context(self):
        return subject.retained_context(self.c,self.previous,self.journal,self.journal_raw,self.backend,False,
                                        removed_container_proof=self.proof,actual=self.actual)

    def test_valid_completed_v2_rechecks_every_record_and_both_absences_after_full_probe(self):
        result=self.run_context()
        self.assertIsInstance(result,subject.LinuxSupervisionContext)
        self.assertEqual(result['previous_config_sha256'],'config-raw')
        self.assertEqual(self.daemon.call_count,4)
        self.assertEqual(self.network.call_count,1)
        self.probe.assert_called_once()
        self.assertEqual(self.probe.call_args.kwargs,{'stopped':True,'profile':subject.PROFILE_V2})
        self.assertEqual(self.probe.call_args.args[1],self.actual['backend'])
        for call in self.daemon.call_args_list:
            self.assertEqual(call.args[:5],('ps','--all','--quiet','--no-trunc','--filter'))
            self.assertIn(call.args[5],['id='+self.backend,'id='+self.frontend])

    def test_control_record_reads_preserve_the_canonical_eight_mib_limit(self):
        self.run_context()
        self.assertTrue(self.c.read_limits)
        self.assertTrue(all(value == MAX_DOCUMENT_BYTES for value in self.c.read_limits))

    def test_missing_or_wrong_record_digests_never_reach_full_probe(self):
        for field in ['recreation_terminal_sha256','retained_snapshot_sha256','prior_terminal_sha256','prior_compose_sha256']:
            for value in [None,'0'*64]:
                with self.subTest(field=field,value=value):
                    saved=self.proof[field]; self.proof[field]=value
                    with self.assertRaises(ValueError): self.run_context()
                    self.proof[field]=saved
        self.probe.assert_not_called()

    def test_foreign_or_uncompleted_terminal_refuses_even_if_rehashed(self):
        for field,value in [('state','failed-confirmed'),('phase','development'),('attempt','9'*32),
                            ('compose_project','other'),('control_volume','other'),('fresh_state',True),
                            ('removed_containers',[self.frontend,self.backend]),('previous_state_root','other'),
                            ('retained_volumes',{}),('retained_frontend_volume','other')]:
            with self.subTest(field=field):
                terminal=dict(self.terminal,**{field:value})
                self.c.put(self.op+'/terminal.json',terminal); self.c.put(self.op+'/receipt.json',terminal)
                self.proof['recreation_terminal_sha256']=subject.sha(self.c.read_bytes(self.op+'/terminal.json'))
                with self.assertRaises(ValueError): self.run_context()
        self.probe.assert_not_called()

    def test_terminal_receipt_disagreement_refuses(self):
        self.c.put(self.op+'/receipt.json',dict(self.terminal,state='failed'))
        with self.assertRaisesRegex(ValueError,'receipt changed'): self.run_context()

    def test_snapshot_must_equal_entire_supplied_pair(self):
        self.actual['frontend']['Config']['unexpected']='drift'
        with self.assertRaisesRegex(ValueError,'frozen snapshots differ'): self.run_context()

    def test_changed_mount_subpath_is_rejected_by_stopped_fingerprint(self):
        self.actual['backend']['HostConfig']['Mounts'][0]['VolumeOptions']['Subpath']='other-ledger'
        self.c.put(self.op+'/retained-containers.json',self.actual)
        self.proof['retained_snapshot_sha256']=subject.sha(self.c.read_bytes(self.op+'/retained-containers.json'))
        with self.assertRaisesRegex(ValueError,'service pin differs'): self.run_context()

    def test_each_stopped_namespace_state_and_incarnation_is_required(self):
        for name in ['backend','frontend']:
            for field,value in [('Running',True),('Pid',17),('OOMKilled',True),('ExitCode',None),('StartedAt','new-start')]:
                with self.subTest(name=name,field=field):
                    saved=copy.deepcopy(self.actual)
                    self.actual[name]['State'][field]=value
                    self.c.put(self.op+'/retained-containers.json',self.actual)
                    self.proof['retained_snapshot_sha256']=subject.sha(self.c.read_bytes(self.op+'/retained-containers.json'))
                    with self.assertRaises(ValueError): self.run_context()
                    self.actual=saved
        self.probe.assert_not_called()

    def test_container_state_summary_and_stop_exit_must_agree(self):
        self.proof['container_state']['exit_code']=0
        with self.assertRaisesRegex(ValueError,'backend stop state differs'): self.run_context()

    def test_daemon_failure_or_any_remaining_full_id_refuses(self):
        for value in [SimpleNamespace(returncode=1,stdout=b'',stderr=b'cannot connect'),
                      SimpleNamespace(returncode=0,stdout=(self.backend+'\n').encode(),stderr=b'')]:
            self.daemon.return_value=value
            with self.assertRaisesRegex(ValueError,'absence is unconfirmed'): self.run_context()
        self.probe.assert_not_called()

    def test_unknown_bridge_endpoint_is_not_suppressed(self):
        self.network.side_effect=RuntimeError('unknown endpoint')
        with self.assertRaisesRegex(RuntimeError,'unknown endpoint'): self.run_context()
        self.probe.assert_not_called()

    def test_full_preserved_inventory_drift_refuses(self):
        self.after['retained_test_inventory']['result']='changed'
        with self.assertRaisesRegex(ValueError,'retained evidence/store changed'): self.run_context()

    def test_record_changes_during_probe_are_detected(self):
        for path in [self.op+'/terminal.json',self.op+'/receipt.json',self.op+'/retained-containers.json',
                     self.prior+'/terminal.json',self.prior+'/compose.json',self.journal_path,
                     'development/current.json','development/verified.json']:
            with self.subTest(path=path):
                saved=self.c.records[path]
                def changed(*args,**kwargs):
                    self.c.put(path,dict(self.c.read(path),unexpected='drift'))
                    return copy.deepcopy(self.after)
                self.probe.side_effect=changed
                with self.assertRaises(ValueError): self.run_context()
                self.c.records[path]=saved

    def test_app_reappearance_after_probe_refuses(self):
        self.daemon.side_effect=[SimpleNamespace(returncode=0,stdout=b'',stderr=b'')]*2+[
            SimpleNamespace(returncode=0,stdout=(self.backend+'\n').encode(),stderr=b'')]
        with self.assertRaisesRegex(ValueError,'absence is unconfirmed'): self.run_context()

    def test_fresh_namespace_and_v1_removed_proofs_still_refuse(self):
        with self.assertRaisesRegex(ValueError,'exact stopped retained namespace'):
            subject.retained_context(self.c,self.previous,self.journal,self.journal_raw,self.backend,True,
                                     removed_container_proof=self.proof,actual=self.actual)
        self.journal.pop('preservation_profile')
        self.journal['supervision_probe']={'schema':subject.SCHEMA}
        with self.assertRaisesRegex(ValueError,'exact stopped retained namespace'): self.run_context()

if __name__ == '__main__': unittest.main()
