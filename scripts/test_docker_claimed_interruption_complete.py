from contextlib import contextmanager
from copy import deepcopy
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import docker_claimed_interruption_complete as complete
import docker_claimed_interruption_namespace as namespace
import test_docker_claimed_interruption_namespace as namespace_fixtures


def raw(value):
    return complete.canonical(value)+b'\n'


class Control:
    project = 'fullmag-master'
    volume = 'existing-control'

    def __init__(self, records):
        self.records = records
        self.operation_state = None

    def read_bytes(self, relative, **kwargs):
        return self.records[relative]

    def read(self, relative):
        return json.loads(self.records[relative])

    def path(self, relative):
        return '/control/'+relative

    def write(self, relative, value):
        self.records[relative] = raw(value)

    @contextmanager
    def operation(self, phase, inputs):
        operation = dict(root=phase+'/attempts/'+'1'*32, daemon_pending=False,
                         receipt=dict(attempt='1'*32, state='starting', inputs=inputs))
        self.operation_state = operation
        try:
            yield operation
        except BaseException:
            operation['retained'] = operation['daemon_pending']
            raise
        else:
            operation['retained'] = False


class CompleteTests(unittest.TestCase):
    def setUp(self):
        self.fixture = namespace_fixtures.NamespaceTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.before = deepcopy(self.fixture.target)
        self.before['State'] = deepcopy(self.fixture.fixture.before['State'])
        self.after = deepcopy(self.fixture.target)
        self.native = deepcopy(self.fixture.native)
        self.engine = deepcopy(self.fixture.fixture.engine)
        self.root = 'verification/claimed-interruption/'+self.native['interruption']['request_id'].replace('-', '')
        self.prepared_root = 'claimed-interruption-prepare/attempts/'+'b'*32
        request_raw = raw(self.native)
        sha = complete.pure.canonical_request_sha256(self.native['interruption'])
        self.prepared = dict(schema_version='fullmag.claimed-interruption-prepare-phase.v1',
                             request_sha256=hashlib.sha256(request_raw).hexdigest(), interruption_sha256=sha,
                             backend_container_id=self.before['Id'], backend_started_at=self.before['State']['StartedAt'],
                             runtime_started=False, container_stopped=False, capacity_released=False,
                             state='prepared', native_invoked=True, native_exit_code=0, effects_known=True,
                             native_result=dict(status='prepared', request_sha256=sha, capacity_released=False),
                             storage_probe_path=namespace.PROBE, storage_probe_sha256='c'*64)
        result_raw = raw(self.prepared)
        self.args = SimpleNamespace(source_root=Path('/checkout'), backend_container_id=self.before['Id'],
                                    image_id=self.before['Image'], request_path=self.root+'/request.json',
                                    request_sha256=hashlib.sha256(request_raw).hexdigest(),
                                    candidate_basename='.backend-package-candidate-test', use_installed_package=False, prepared_phase_root=self.prepared_root,
                                    prepared_result_sha256=hashlib.sha256(result_raw).hexdigest())
        receipt = dict(schema='fullmag.docker-build-operation.v1', attempt='b'*32, control_volume='existing-control',
                       state='succeeded', phase='claimed-interruption-prepare', compose_project='fullmag-master',
                       inputs=dict(candidate_basename=self.args.candidate_basename, request_path=self.args.request_path,
                                   request_sha256=self.args.request_sha256), prepare_result=self.prepared)
        self.manifest = deepcopy(self.fixture.fixture.preserved_files)
        self.control = Control({self.args.request_path: request_raw,
                                self.prepared_root+'/result.json': result_raw,
                                self.prepared_root+'/receipt.json': raw(receipt),
                                self.root+'/preserved-files.json': raw(self.manifest)})
        self.ack = dict(status='interrupted-no-final-state', request_sha256=sha, receipt_sha256='d'*64,
                        solve_replayed=False, final_state_available=False)

    def test_guest_preflight_parses(self):
        compile(complete.PREFLIGHT, '<prestop>', 'exec')

    def test_exact_prepared_authority_and_raw_pin(self):
        result = complete.prepared_authority(self.args, self.control)
        self.assertEqual(result['native'], self.native)
        self.assertEqual(result['manifest'], self.manifest)
        self.args.prepared_result_sha256 = '0'*64
        with self.assertRaises(ValueError):
            complete.prepared_authority(self.args, self.control)

    def test_verified_rejection_and_wrong_request_cannot_authorize_stop(self):
        for mutation in [lambda v: v.update(state='verified'),
                         lambda v: v.update(capacity_released=True),
                         lambda v: v.update(backend_container_id='f'*64),
                         lambda v: v.update(native_exit_code=1),
                         lambda v: v.update(effects_known=False)]:
            changed = deepcopy(self.prepared)
            mutation(changed)
            changed_raw = raw(changed)
            self.control.records[self.prepared_root+'/result.json'] = changed_raw
            self.args.prepared_result_sha256 = hashlib.sha256(changed_raw).hexdigest()
            with self.assertRaises((ValueError, complete.BuildControlError)):
                complete.prepared_authority(self.args, self.control)

    def test_exact_engine_private_exit_builds_inline_attestation(self):
        document, attestation = complete.make_attestation(self.native, self.engine, self.engine,
                                                        self.before, self.after, self.manifest)
        self.assertEqual(attestation['namespace']['request_sha256'], self.ack['request_sha256'])
        self.assertEqual(document['after']['descendant_count'], 0)
        self.assertTrue(document['device_release']['mapping_detached'])
        for mutation in [lambda t: t.update(Id='e'*64), lambda t: t['State'].update(Pid=1),
                         lambda t: t['State'].update(StartedAt='2027-01-01T00:00:00Z'),
                         lambda t: t['HostConfig'].update(PidMode='host')]:
            target = deepcopy(self.after)
            mutation(target)
            with self.assertRaises(ValueError):
                complete.make_attestation(self.native, self.engine, self.engine, self.before, target, self.manifest)
        with self.assertRaises(ValueError):
            complete.make_attestation(self.native, self.engine, {'ID': 'f'*64}, self.before, self.after, self.manifest)

    def test_native_ack_requires_exact_status_and_no_solve_or_final_state(self):
        self.assertEqual(complete.validate_native_result(raw(self.ack), self.native), self.ack)
        for mutation in [lambda v: v.update(solve_replayed=True), lambda v: v.update(final_state_available=True),
                         lambda v: v.update(status='prepared'), lambda v: v.update(request_sha256='a'*64),
                         lambda v: v.update(exit_code=0), lambda v: v.update(receipt_sha256='short')]:
            value = deepcopy(self.ack)
            mutation(value)
            with self.assertRaises(ValueError):
                complete.validate_native_result(raw(value), self.native)
        with self.assertRaises((ValueError, complete.BuildControlError)):
            complete.validate_native_result(b'noise\n'+raw(self.ack), self.native)

    def maintenance(self):
        kwargs = deepcopy(self.fixture.kwargs)
        kwargs.update(request_path='/opt/fullmag/control/'+self.args.request_path,
                      attestation_path='/opt/fullmag/control/'+self.root+'/attestation.json',
                      request_sha256=self.args.request_sha256)
        spec = namespace.maintenance_spec(self.after, self.native, **kwargs)
        name, container_id = 'claimed-helper', 'e'*64
        actual = dict(Id=container_id, Name='/'+name, Image=spec['image'],
                      Config=dict(Entrypoint=['/usr/local/bin/python3'],
                                  Cmd=['-B', '-c', namespace.EXECUTOR, json.dumps(spec['context'], sort_keys=True, separators=(',', ':'))],
                                  User=spec['user'], Env=[k+'='+v for k, v in spec['environment'].items()],
                                  Labels={'com.docker.compose.project': spec['project'],
                                          'com.docker.compose.service': 'backend-recovery',
                                          'fullmag.recovery.target_container': self.before['Id']}),
                      HostConfig=dict(Runtime='runc', NetworkMode='none', PidMode='private', IpcMode='private',
                                      Privileged=False, ReadonlyRootfs=True, Init=True, CapDrop=['ALL'],
                                      SecurityOpt=['no-new-privileges:true'], Tmpfs={'/tmp':'rw,nosuid,nodev,size=64m'},
                                      Mounts=[]), Mounts=[], State=dict(Status='created', Running=False, Pid=0))
        for mount in spec['mounts']:
            actual['HostConfig']['Mounts'].append(dict(Type=mount['type'], Source=mount['source'], Target=mount['target'],
                                                      ReadOnly=mount['read_only'], VolumeOptions={'Subpath': mount['subpath']}))
            actual['Mounts'].append(dict(Type=mount['type'], Name=mount['source'], Destination=mount['target'],
                                         RW=not mount['read_only'], Driver='local'))
        return spec, name, container_id, actual

    def test_created_maintenance_must_match_isolation_command_and_subpaths(self):
        spec, name, container_id, original = self.maintenance()
        complete.validate_maintenance(original, spec, name=name, container_id=container_id)
        for change in [lambda t: t['HostConfig'].update(DeviceRequests=[{'Count':-1}]),
                       lambda t: t['HostConfig'].update(NetworkMode='bridge'),
                       lambda t: t['HostConfig']['Mounts'][0]['VolumeOptions'].update(Subpath='other'),
                       lambda t: t['Config'].update(Cmd=['--ensure']),
                       lambda t: t.update(Name='/foreign'), lambda t: t['HostConfig'].update(Privileged=True)]:
            actual = deepcopy(original)
            change(actual)
            with self.assertRaises(ValueError):
                complete.validate_maintenance(actual, spec, name=name, container_id=container_id)

    def test_maintenance_cleanup_requires_exact_exited_native_acknowledgement(self):
        spec, name, container_id, created = self.maintenance()
        exited = deepcopy(created)
        exited['State'].update(Status='exited', ExitCode=0, OOMKilled=False, Error='')
        calls = []
        started = False
        def capture(*args, **kwargs):
            nonlocal started
            calls.append(args)
            if args[0] == 'create':
                return SimpleNamespace(stdout=container_id.encode(), stderr=b'')
            if args[0] == 'start':
                started = True
                return SimpleNamespace(stdout=container_id.encode(), stderr=b'')
            if args[0] == 'logs':
                return SimpleNamespace(stdout=raw(self.ack), stderr=b'')
            if args[0] == 'rm':
                return SimpleNamespace(stdout=container_id.encode(), stderr=b'')
            self.fail('Unexpected maintenance action '+str(args))
        def inspect(kind, target):
            if target == self.before['Id']:
                return self.after
            self.assertEqual(target, container_id)
            return exited if started else created
        operation = dict(root='complete/attempts/'+'1'*32, receipt={})
        with patch.object(complete, 'docker_capture', side_effect=capture), \
             patch.object(complete, '_inspect', side_effect=inspect), \
             patch.object(complete, '_engine', return_value=self.engine), \
             patch.object(complete, '_publish_immutable', side_effect=lambda c,p,r: c.records.__setitem__(p,r)):
            result = complete._maintenance(self.control, operation, spec=spec, name=name, native=self.native, phase='complete')
        self.assertEqual(result, self.ack)
        self.assertEqual(calls[-1], ('rm', container_id))
        self.assertEqual(sum(c[0] == 'start' for c in calls), 1)
        self.assertNotIn('--force', calls[-1])

    def workflow(self, *, stop_error=False, complete_error=False):
        calls = []
        stopped = False
        proof = dict(schema_version='fullmag.claimed-interruption-prestop.v1', request_sha256=self.args.request_sha256,
                     owner_sha256=self.native['interruption']['pins']['owner_sha256'],
                     preserved_files_manifest_sha256=self.native['interruption']['pins']['preserved_files_manifest_sha256'],
                     stub_sha256='c'*64, mutated=False)
        def capture(*args, **kwargs):
            nonlocal stopped
            calls.append(args)
            if args[0] == 'exec':
                return SimpleNamespace(stdout=raw(proof), stderr=b'', returncode=0)
            if args[0] == 'stop':
                if stop_error:
                    raise complete.BuildControlError('daemon observation unknown')
                stopped = True
                return SimpleNamespace(stdout=b'', stderr=b'', returncode=0)
            self.fail('Unexpected Docker mutation: '+str(args))
        def inspect(kind, target):
            if kind == 'volume':
                return {}
            self.assertEqual(target, self.before['Id'])
            return deepcopy(self.after if stopped else self.before)
        def maintenance(*args, **kwargs):
            calls.append(('maintenance', kwargs['phase']))
            if complete_error:
                raise complete.BuildControlError('native outcome unknown')
            if kwargs['phase'] == 'complete':
                return self.ack
            return dict(status='verified_source_protocol', request_sha256=self.ack['request_sha256'], mutated=False)
        with patch.object(complete, 'BuildControl', return_value=self.control), \
             patch.object(complete, 'docker_capture', side_effect=capture), \
             patch.object(complete, '_inspect', side_effect=inspect), \
             patch.object(complete, '_engine', return_value=self.engine), \
             patch.object(complete.repair, 'validate_backend'), \
             patch.object(complete, '_maintenance', side_effect=maintenance), \
             patch.object(complete, '_publish_immutable', side_effect=lambda c,p,r: c.records.__setitem__(p,r)), \
             patch('docker_dev._select_source', return_value=(Path('/checkout'), {})), \
             patch('docker_dev._compose_identity', return_value={}), \
             patch('docker_dev_host.require_host'):
            result = complete.run(self.args)
        return result, calls

    def test_managed_sequence_stops_only_target_verifies_and_never_starts_successor(self):
        result, calls = self.workflow()
        self.assertEqual(result['state'], 'interrupted-no-final-state')
        self.assertEqual([c for c in calls if c[0] == 'stop'], [('stop', '--time', '30', self.before['Id'])])
        self.assertEqual([c for c in calls if c[0] == 'maintenance'], [('maintenance','complete'), ('maintenance','verify')])
        self.assertFalse(self.control.operation_state['daemon_pending'])
        self.assertFalse(self.control.operation_state['retained'])
        self.assertFalse(result['runtime_started'])
        self.assertFalse(result['solve_replayed'])

    def test_unknown_stop_retains_operation_and_does_not_retry(self):
        with self.assertRaises(complete.BuildControlError):
            self.workflow(stop_error=True)
        self.assertTrue(self.control.operation_state['daemon_pending'])
        self.assertTrue(self.control.operation_state['retained'])

    def test_unknown_native_retains_operation_after_backend_stop(self):
        with self.assertRaises(complete.BuildControlError):
            self.workflow(complete_error=True)
        self.assertTrue(self.control.operation_state['daemon_pending'])
        self.assertTrue(self.control.operation_state['retained'])


if __name__ == '__main__':
    unittest.main()
