"""Regression contract for a memory-only cold DEV budget restore."""
import copy
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from contextlib import contextmanager, ExitStack, redirect_stdout
import io
import tempfile
import subprocess
import sys
import json
import hashlib
import fcntl

from docker_build_control import BuildControlError
import docker_volume_cold_budget_restore as restore
import docker_volume_preowner_drained as preowner

GIB = 1024 ** 3


class BudgetContractTests(unittest.TestCase):
    def setUp(self):
        self.stored = {
            'schema_version': 'host_resource_ledger_policy.v2', 'host_id': 'a' * 64,
            'topology_sha256': 'a' * 64, 'revision': 1, 'owner_epoch': 1,
            'allowed_cpu_ids': [0, 1], 'gpu_vram_bytes_by_uuid': {'GPU-x': 17 * GIB},
            'total_budget': {'cpu_millis': 8000, 'memory_bytes': 31 * GIB,
                             'storage_bytes': 7 * GIB, 'gpu_memory_bytes': 0},
        }
        self.requested = copy.deepcopy(self.stored)
        self.requested['total_budget']['memory_bytes'] = 63 * GIB
        self.document = {'services': {'backend': {
            'cpus': 8, 'mem_limit': 64 * GIB,
            'environment': {'FULLMAG_DOCKER_CPU_MILLIS': '8000',
                            'FULLMAG_DOCKER_MEMORY_BYTES': str(64 * GIB)},
        }}}

    def test_only_memory_increase_restores_stored_budget(self):
        self.assertEqual(restore.restore_budget(self.requested, self.stored, self.document),
                         {'cpus': 8, 'memory_bytes': 32 * GIB})

    def test_every_other_policy_change_is_rejected(self):
        for key, value in [('owner_epoch', 2), ('revision', 2), ('host_id', 'other'),
                           ('topology_sha256', 'b' * 64), ('allowed_cpu_ids', [0]),
                           ('gpu_vram_bytes_by_uuid', {'GPU-y': 17 * GIB})]:
            with self.subTest(key=key):
                changed = copy.deepcopy(self.requested); changed[key] = value
                with self.assertRaises(BuildControlError):
                    restore.restore_budget(changed, self.stored, self.document)
        for key in ('cpu_millis', 'storage_bytes', 'gpu_memory_bytes'):
            changed = copy.deepcopy(self.requested); changed['total_budget'][key] += 1
            with self.subTest(key=key), self.assertRaises(BuildControlError):
                restore.restore_budget(changed, self.stored, self.document)

    def test_decrease_equal_fractional_or_small_budget_rejected(self):
        for memory in (30 * GIB, 31 * GIB):
            changed = copy.deepcopy(self.requested); changed['total_budget']['memory_bytes'] = memory
            with self.assertRaises(BuildControlError):
                restore.restore_budget(changed, self.stored, self.document)
        for cpu, memory in ((8001, 31 * GIB), (1000, 31 * GIB), (8000, 2 * GIB), (8000, 31 * GIB + 1)):
            old = copy.deepcopy(self.stored); new = copy.deepcopy(self.requested)
            old['total_budget'].update(cpu_millis=cpu, memory_bytes=memory)
            new['total_budget']['cpu_millis'] = cpu
            with self.assertRaises(BuildControlError):
                restore.restore_budget(new, old, self.document)

    def test_overlay_updates_native_and_cargo_limits(self):
        restore.overlay_budget(self.document, {'cpus': 8, 'memory_bytes': 32 * GIB})
        backend = self.document['services']['backend']
        self.assertEqual((backend['cpus'], backend['mem_limit']), (8, 32 * GIB))
        self.assertEqual(backend['environment']['FULLMAG_DOCKER_MEMORY_BYTES'], str(32 * GIB))
        self.assertEqual(backend['environment']['FULLMAG_DOCKER_CPU_MILLIS'], '8000')
        self.assertEqual(backend['environment']['CARGO_BUILD_JOBS'], '8')


class IntegrationTests(unittest.TestCase):
    setUp = BudgetContractTests.setUp
    def test_parser_dispatches_new_variant_without_observation_proof(self):
        import docker_dev
        argv = ['stop-preowner-policy-volume', '--attempt', 'a' * 32,
                '--config-sha256', 'b' * 64, '--source-root', '/source',
                '--backend-container-id', 'c' * 64, '--image-id', 'sha256:' + 'd' * 64,
                '--variant', restore.VARIANT, '--drain-attempt', 'e' * 32]
        with patch.object(restore, 'stop') as producer:
            self.assertEqual(docker_dev.main(argv), 0)
            parsed = producer.call_args.args[0]
            self.assertEqual(parsed.variant, restore.VARIANT)
            self.assertEqual(parsed.drain_attempt, 'e' * 32)
            self.assertIsNone(parsed.proof_path)
            self.assertFalse(parsed.apply)

    def test_authentic_consumer_overlays_after_env_and_saved_budget(self):
        import docker_volume_resources as resources
        self.document.update(name='project')
        self.document['services']['frontend'] = {}
        self.document['services']['backend']['command'] = ['start', '--native-contract', 'fem-demag-poisson']
        self.document['services']['backend']['environment']['FULLMAG_DEV_INCLUDE_UNTRACKED'] = '["exact.py"]'
        metadata = {'journal_relative': 'pinned', 'journal_sha256': 'a' * 64}
        calls = []
        def saved(control, document, *, superseded=False):
            self.assertTrue(superseded)
            calls.append(document['services']['backend']['mem_limit'])
            document['services']['backend']['mem_limit'] = 96 * GIB
        with patch.object(resources, 'apply_saved_budget', side_effect=saved), patch.object(
            restore, 'authenticate_journal', return_value={'observation': {
                'budget': {'cpus': 8, 'memory_bytes': 32 * GIB}, 'source_root': '/source'}}) as authenticate:
            resources.apply_development_budget(SimpleNamespace(project='project'), self.document,
                {'FULLMAG_DEV_BACKEND_CPUS': 8, 'FULLMAG_DEV_BACKEND_MEMORY_GIB': 64},
                cold_budget_restore=metadata, source_root='/source',
                capacity={'NCPU': 40, 'MemTotal': 256 * GIB})
            authenticate.assert_called_once()
        self.assertEqual(calls, [32 * GIB])
        rendered = json.loads(json.dumps(self.document))
        backend = rendered['services']['backend']
        self.assertEqual(backend['mem_limit'], 32 * GIB)
        self.assertEqual(backend['environment']['FULLMAG_DOCKER_MEMORY_BYTES'], str(32 * GIB))
        self.assertEqual(backend['environment']['CARGO_BUILD_JOBS'], '8')
        self.assertEqual(backend['command'], ['start', '--native-contract', 'fem-demag-poisson'])
        self.assertEqual(backend['environment']['FULLMAG_DEV_INCLUDE_UNTRACKED'], '["exact.py"]')
        self.assertNotEqual(backend['environment'].get('FULLMAG_STARTUP_ENABLED'), '1')

    def test_effective_restore_budget_admission_ignores_superseded_global_limit(self):
        import docker_volume_resources as resources
        document = copy.deepcopy(self.document); document['name'] = 'project'
        document['services']['frontend'] = {}
        pin = {'journal_relative': 'exact', 'journal_sha256': 'a' * 64}
        control = SimpleNamespace(project='project', read=lambda *args, **kwargs: None)
        with patch.object(restore, 'authenticate_journal', return_value={'observation': {
            'source_root': '/source', 'budget': {'cpus': 8, 'memory_bytes': 32 * GIB}}}):
            resources.apply_development_budget(control, document, {'FULLMAG_DEV_BACKEND_MEMORY_GIB': 64},
                cold_budget_restore=pin, source_root='/source', capacity={'NCPU': 40, 'MemTotal': 48 * GIB})
        self.assertEqual(document['services']['backend']['mem_limit'], 32 * GIB)
        with patch.object(restore, 'authenticate_journal', side_effect=BuildControlError('forged restore pin')):
            with self.assertRaises(BuildControlError):
                resources.apply_development_budget(control, document, {'FULLMAG_DEV_BACKEND_MEMORY_GIB': 64},
                    cold_budget_restore=pin, source_root='/source', capacity={'NCPU': 40, 'MemTotal': 48 * GIB})
        with patch.object(restore, 'authenticate_journal', return_value={'observation': {
            'source_root': '/source', 'budget': {'cpus': 8, 'memory_bytes': 32 * GIB}}}):
            with self.assertRaises(BuildControlError):
                resources.apply_development_budget(control, document, {'FULLMAG_DEV_FRONTEND_MEMORY_GIB': 64},
                    cold_budget_restore=pin, source_root='/source', capacity={'NCPU': 40, 'MemTotal': 48 * GIB})

    def test_consumer_rejects_changed_journal_and_foreign_source(self):
        metadata = {'journal_relative': 'pinned', 'journal_sha256': 'a' * 64}
        with patch.object(restore, 'authenticate_journal', side_effect=BuildControlError('CAS differs')):
            with self.assertRaises(BuildControlError):
                restore.apply_restored_budget(None, self.document, metadata, source_root='/source')
        with patch.object(restore, 'authenticate_journal', return_value={'observation': {'source_root': '/other'}}):
            with self.assertRaises(BuildControlError):
                restore.apply_restored_budget(SimpleNamespace(project='p'), dict(self.document, name='p'),
                                              metadata, source_root='/source')

    def test_legacy_rejects_memory_only_increase_while_new_cold_predicate_accepts(self):
        rows = [[1, 0, 10, 'tini'], [2, 1, 20, 'python3'], [3, 2, 30, 'fullmag-api']]
        guest = {'schema': 'fullmag.preowner-cold-api-probe.v1', 'processes': rows,
            'processes_sha256': restore.base._sha(json.dumps(rows, separators=(',', ':')).encode()),
            'probe_present': True, 'health_status': 200, 'health_state': 'degraded',
            'active_session': False, 'current_status': 503, 'current_owner_pids_absent': True,
            'failure_reason': 'error: ' + restore.base.REFUSAL, 'requested_policy': self.requested,
            'failure_fence_relative': 'runtime-control/runtime-service/api-failure-' + 'a' * 32 + '.json'}
        for key in ('api_instance_sha256', 'failure_fence_sha256', 'owner_sha256',
                    'process_tree_sha256', 'native_config_sha256'): guest[key] = 'a' * 64
        response = SimpleNamespace(returncode=0, stdout=json.dumps(guest).encode())
        ledger = {'policy': self.stored, 'total_budget': self.stored['total_budget']}
        with patch.object(restore.base, 'docker_capture', return_value=response):
            with self.assertRaises(BuildControlError): restore.base._cold_probe('backend', self.document, ledger)
        with patch.object(restore, 'docker_capture', return_value=response):
            _, budget = restore._cold('backend', self.document, ledger)
            self.assertEqual(budget, {'cpus': 8, 'memory_bytes': 32 * GIB})
        for key, changed in [('processes', rows + [[4, 2, 40, 'unknown']]), ('active_session', True),
                             ('current_owner_pids_absent', False), ('current_status', 200)]:
            mutated = dict(guest, **{key: changed})
            with self.subTest(key=key), patch.object(restore, 'docker_capture', return_value=SimpleNamespace(
                    returncode=0, stdout=json.dumps(mutated).encode())):
                with self.assertRaises(BuildControlError): restore._cold('backend', self.document, ledger)

    def test_retained_recreate_carries_authenticated_pin_again(self):
        import docker_volume_dev as dev
        pin = {'journal_relative': 'exact', 'journal_sha256': 'a' * 64}
        previous = {'cold_budget_restore': pin, 'inputs': {'source_root': '/source'}}
        with patch.object(dev, '_retained_native_recovery_context', return_value={}), patch.object(
            restore, 'authenticate_journal', return_value={'observation': {'source_root': '/source'}}):
            result = dev._retained_recovery_context(None, previous, {}, fresh_state=False)
            self.assertEqual(result, {'cold_budget_restore': pin})
        with patch.object(dev, '_retained_native_recovery_context', return_value={}), patch.object(
            restore, 'authenticate_journal', side_effect=BuildControlError('restore CAS differs')):
            with self.assertRaises(BuildControlError):
                dev._retained_recovery_context(None, previous, {}, fresh_state=False)

    def test_root_namespace_exception_is_explicit_and_scoped(self):
        base = restore.base
        previous = {'schema': 'fullmag.docker-build-operation.v1', 'phase': 'development',
            'state': 'failed-confirmed', 'attempt': 'a' * 32, 'compose_project': 'p',
            'control_volume': 'v', 'inputs': {'source_root': '/source', 'image_id': 'sha256:' + 'b' * 64},
            'ledger_profile': 'group-ledger-v1', 'error': base.REFUSAL,
            'worker_cgroup': {'state': 'ready', 'container_id': 'c' * 64,
                             'image_id': 'sha256:' + 'b' * 64, 'compose_project': 'p'}}
        document = {'name': 'p'}; previous['config_sha256'] = base._sha(base.canonical(document))
        raw = base.canonical(previous) + b'\n'; compose = base.canonical(document) + b'\n'
        def read(path, **kwargs):
            return compose if path.endswith('/compose.json') else raw
        control = SimpleNamespace(project='p', volume='v', namespace='', read_bytes=read)
        kwargs = dict(selected=Path('/source'), attempt='a' * 32, config_sha256=previous['config_sha256'],
                      image_id='sha256:' + 'b' * 64, backend_container_id='c' * 64)
        with self.assertRaises(BuildControlError):
            base._load_parent(control, previous, document, **kwargs)
        base._load_parent(control, previous, document, allow_legacy_root_namespace=True, **kwargs)
        control.namespace = 'foreign'
        with self.assertRaises(BuildControlError):
            base._load_parent(control, previous, document, allow_legacy_root_namespace=True, **kwargs)


class ReleasedInventoryTests(unittest.TestCase):
    """Execute the existing image-side safety code against local locked files."""
    def setUp(self):
        import docker_volume_pre_ack_retry as release
        self.release = release
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name); self.store = self.root / 'store'; self.ledger = self.root / 'ledger'
        (self.store / 'runs' / 'run' / 'resource_leases' / 'cpu').mkdir(parents=True)
        (self.ledger / 'proofs').mkdir(parents=True)
        (self.store / 'WRITER.lock').touch(); (self.ledger / 'WRITER.lock').touch()
        self.proof = {'schema_version': 'host_resource_release_proof.v2', 'host_id': 'host',
                      'store_id': 'store', 'request_sha256': 'r' * 64}
        raw = json.dumps(self.proof).encode(); digest = hashlib.sha256(raw).hexdigest()
        self.proof_path = self.ledger / 'proofs' / (digest + '.json'); self.proof_path.write_bytes(raw)
        self.ledger_document = {'policy': {'host_id': 'host'}, 'reservations': [{
            'identity': {'store_id': 'store'}, 'request_sha256': 'r' * 64,
            'release_proof_sha256': digest, 'state': 'released'}]}
        self.lease_path = self.store / 'runs/run/resource_leases/cpu/lease.json'
        self.lease_path.write_text('{"state":"released"}')
        self.actual = {'Image': 'sha256:' + 'b' * 64, 'Mounts': [
            {'Type': 'bind', 'Source': '/state-source', 'Destination': '/state', 'RW': True},
            {'Type': 'volume', 'Name': 'group', 'Destination': '/host-ledger', 'RW': True}],
            'HostConfig': {'Mounts': [
                {'Type': 'bind', 'Source': '/state-source', 'Target': '/state'},
                {'Type': 'volume', 'Source': 'group', 'Target': '/host-ledger',
                 'VolumeOptions': {'Subpath': 'private/ledger'}}]}}

    def observe(self):
        (self.ledger / 'HOST_RESOURCE_LEDGER.json').write_text(json.dumps(self.ledger_document))
        def capture(*args, **kwargs):
            self.assertIn('type=volume,src=group,dst=/host-ledger,readonly,volume-nocopy,volume-subpath=private/ledger', args)
            code = args[args.index('-c') + 1]
            code = code.replace("'/state/runs/docker-all/session-store'", repr(str(self.store)))
            code = code.replace("'/host-ledger/ledger'", repr(str(self.ledger)))
            return subprocess.run([sys.executable, '-B', '-c', code], capture_output=True)
        with patch.object(self.release, 'docker_capture', side_effect=capture):
            return self.release._released_snapshot(SimpleNamespace(project='project'), self.actual)

    def test_shared_lock_release_snapshot_preserves_private_subpath(self):
        observed = self.observe()
        self.assertEqual(observed['active_count'], 0)
        self.assertEqual(len(observed['reservations']), 1)
        self.assertEqual(len(observed['leases']), 1)

    def test_active_reservation_lease_or_bad_release_proof_is_rejected(self):
        for change in ('reservation', 'lease', 'proof', 'proof_identity'):
            with self.subTest(change=change):
                reservation = self.ledger_document['reservations'][0]
                reservation['state'] = 'released'; self.lease_path.write_text('{"state":"released"}')
                raw = json.dumps(self.proof).encode(); self.proof_path.write_bytes(raw)
                if change == 'reservation': reservation['state'] = 'active'
                elif change == 'lease': self.lease_path.write_text('{"state":"active"}')
                elif change == 'proof': self.proof_path.write_bytes(b'{}')
                else:
                    self.proof['store_id'] = 'other'; raw = json.dumps(self.proof).encode()
                    digest = hashlib.sha256(raw).hexdigest()
                    (self.ledger / 'proofs' / (digest + '.json')).write_bytes(raw)
                    reservation['release_proof_sha256'] = digest
                with self.assertRaises(BuildControlError):
                    self.observe()


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.records = {}
        self.iteration = '1' * 32
        self.old_root = 'iteration/attempts/' + self.iteration
        self.ready = {'schema_version': 'runtime_service_owner.v1', 'state': 'ready',
            'protocol': 'stdin-v1', 'target_id': 'docker-all', 'pid': 10, 'host': 'host',
            'owner_token': '11111111-1111-4111-8111-111111111111',
            'process_start_token': '22222222-2222-4222-8222-222222222222',
            'acquired_at': 'then', 'heartbeat_at': 'then', 'build_commit': 'a' * 40,
            'build_snapshot': 'b' * 64, 'compute_pool_generation': 1, 'preparation_pool_generation': 1,
            'compute_pool_id': 'compute', 'preparation_pool_id': 'prepare', 'control_address': 'address',
            'children': [{'role': 'compute', 'pid': 11, 'status': 'running'},
                         {'role': 'preparation', 'pid': 12, 'status': 'running'}]}
        self.owner = copy.deepcopy(self.ready); self.owner['state'] = 'drained'
        for child in self.owner['children']: child['status'] = 'exited_success'
        process = {'schema': 'fullmag.docker-process-tree.v1', 'state': 'drained',
                   'service_owner': self.ready, 'terminal_service_owner': self.owner}
        self.write('runtime-control/runtime-service/process-tree.json', process)
        self.write('runtime-control/runtime-services/OWNER.json', self.owner)
        self.write('runtime-control/runtime-services/docker-client-' + self.ready['owner_token'] + '.json', self.ready)
        self.write('runtime-control/runtime-service/docker-all.json', {'schema_version': 'runtime_service_config.v2'})
        compose = {'name': 'project', 'services': {'backend': {'image': 'sha256:' + 'b' * 64,
            'environment': {'FULLMAG_DOCKER_CPU_MILLIS': '8000', 'FULLMAG_DOCKER_MEMORY_BYTES': str(32 * GIB)}}}}
        self.write(self.old_root + '/compose.json', compose)
        self.terminal = {'schema': 'fullmag.docker-build-operation.v1', 'state': 'succeeded', 'phase': 'iteration',
            'attempt': self.iteration, 'idle_backend_stopped': True, 'compose_project': 'project',
            'control_volume': 'volume', 'inputs': {'source_root': '/source', 'image_id': 'sha256:' + 'b' * 64},
            'state_root': '/state', 'config_sha256': restore.base._sha(restore.base.canonical(compose)),
            'backend_container': 'c' * 64}
        self.write(self.old_root + '/terminal.json', self.terminal); self.write(self.old_root + '/receipt.json', self.terminal)
        drain = {'schema': 'fullmag.docker-idle-restart-drain.v1', 'backend_container_id': 'c' * 64,
                 'process_receipt': process, 'process_receipt_sha256': restore.base._sha(
                     self.records['runtime-control/runtime-service/process-tree.json'])}
        self.write(self.old_root + '/backend-drain.json', drain)
        self.previous = {'inputs': {'source_root': '/source'}, 'state_root': '/state'}
        self.fence = {'failure_fence_relative': 'runtime-control/runtime-service/api-failure-' + 'd' * 32 + '.json',
                      'failure_reason': 'exact reason'}
        self.write(self.fence['failure_fence_relative'], {'schema': 'fullmag.api-runtime-failure-fence.v1',
                   'stage': 'runtime_startup', 'reason': 'exact reason'})
        self.fence['failure_fence_sha256'] = restore.base._sha(self.records[self.fence['failure_fence_relative']])
        self.control = SimpleNamespace(project='project', volume='volume',
            read_bytes=lambda path, **kwargs: self.records[path])

    def write(self, path, document):
        self.records[path] = restore.base.canonical(document) + b'\n'

    def observe(self):
        return restore._history(self.control, self.previous, self.iteration, self.fence)

    def test_authentic_idle_drain_without_terminal_observation_is_accepted(self):
        observed = self.observe()
        self.assertEqual(observed['iteration'], self.iteration)
        self.assertIn(self.old_root + '/backend-drain.json', observed['control_hashes'])

    def test_ready_unknown_owner_wrong_drain_config_and_fence_are_rejected(self):
        original = copy.deepcopy(self.records)
        for mutation in ('ready', 'unknown', 'child', 'ready_pin', 'drain', 'receipt', 'config', 'fence'):
            self.records = copy.deepcopy(original)
            with self.subTest(mutation=mutation):
                if mutation in ('ready', 'unknown', 'child'):
                    owner = copy.deepcopy(self.owner)
                    if mutation == 'child': owner['children'][0]['status'] = 'running'
                    else: owner['state'] = mutation
                    self.write('runtime-control/runtime-services/OWNER.json', owner)
                elif mutation == 'ready_pin':
                    ready = dict(self.ready, pid=999)
                    self.write('runtime-control/runtime-services/docker-client-' + ready['owner_token'] + '.json', ready)
                elif mutation == 'drain': self.write(self.old_root + '/backend-drain.json', {})
                elif mutation == 'receipt': self.write(self.old_root + '/receipt.json', {})
                elif mutation == 'config': self.write('runtime-control/runtime-service/docker-all.json', {})
                else: self.write(self.fence['failure_fence_relative'], {})
                with self.assertRaises(BuildControlError): self.observe()


class OwnerlessTerminalReceiptTests(unittest.TestCase):
    def startup(self):
        return {
            "schema": "fullmag.docker-process-tree.v1",
            "state": "failed_outcome_retained",
            "accepted_store": "/state/runs/docker-all/session-store",
            "api_pid": 21385,
            "bootstrap": {"state": "ready"},
            "qualification": "NOT VERIFIED",
            "error": preowner.OWNERLESS_STARTUP_ERROR,
            "api_diagnostic_only": True,
            "api_failure_fence": (
                "/opt/fullmag/runtime-control/runtime-service/api-failure-"
                + "6" * 32 + ".json"
            ),
        }

    def test_actual_ownerless_startup_shape_and_exact_api_only_stop_transition(self):
        before = self.startup()
        self.assertEqual(set(before), preowner.OWNERLESS_PROCESS_KEYS)
        self.assertEqual(preowner._validate_ownerless_process_receipt(before), before)
        after = dict(before)
        after.update(
            state="shutdown_unknown",
            api_exit_code=-15,
            shutdown_error=preowner.OWNERLESS_SHUTDOWN_ERROR,
        )
        self.assertEqual(preowner._validate_ownerless_shutdown_receipt(before, after), after)

    def test_unknown_startup_and_shutdown_shapes_are_rejected(self):
        before = self.startup()
        mutations = {
            "missing_pin": lambda value: value.pop("api_failure_fence"),
            "extra_runtime_owner": lambda value: value.update(runtime_pid=21400),
            "wrong_error": lambda value: value.update(error="another startup failure"),
            "not_diagnostic_only": lambda value: value.update(api_diagnostic_only=False),
            "invalid_pid": lambda value: value.update(api_pid=True),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                bad = copy.deepcopy(before)
                mutate(bad)
                with self.assertRaises(BuildControlError):
                    preowner._validate_ownerless_process_receipt(bad)

        expected = dict(before, state="shutdown_unknown", api_exit_code=-15,
                        shutdown_error=preowner.OWNERLESS_SHUTDOWN_ERROR)
        for name, mutate in (
            ("missing_wait", lambda value: value.pop("api_exit_code")),
            ("timeout_unknown", lambda value: value.pop("api_exit_code")),
            ("different_error", lambda value: value.update(shutdown_error="shutdown timed out")),
            ("changed_startup", lambda value: value.update(api_pid=99999)),
            ("unexpected_owner", lambda value: value.update(service_owner={"state": "unknown"})),
            ("boolean_exit", lambda value: value.update(api_exit_code=True)),
        ):
            with self.subTest(name=name):
                bad = copy.deepcopy(expected)
                mutate(bad)
                with self.assertRaises(BuildControlError):
                    preowner._validate_ownerless_shutdown_receipt(before, bad)

    def test_only_exact_failed_parent_selects_ownerless_branch(self):
        exact = {"error": preowner.OWNERLESS_PARENT_ERROR}
        self.assertTrue(preowner._ownerless_parent(exact))
        for error in (
            preowner.OWNERLESS_PARENT_ERROR + " ",
            "Runtime admission failed: API startup failed",
            "Runtime startup failed; diagnostic API retained: unrelated",
        ):
            with self.subTest(error=error):
                self.assertFalse(preowner._ownerless_parent({"error": error}))

    def test_v1_startup_and_v2_compute_source_bindings_remain_distinct(self):
        start = {
            "schema": preowner.PROOF_SCHEMA,
            "source_request_id": "start-request-17",
            "source_sha256": "a" * 64,
        }
        compute = {
            "schema": preowner.COMPUTE_PROOF_SCHEMA,
            "compute": {"command_id": "command-17", "receipt_sha256": "b" * 64},
        }
        self.assertEqual(
            preowner._qualified_source_binding(start),
            {"request_id": "start-request-17", "source_sha256": "a" * 64},
        )
        self.assertEqual(preowner._qualified_source_binding(compute), {"compute": compute["compute"]})
        self.assertNotIn("request_id", preowner._qualified_source_binding(compute))
        for bad in (
            {"schema": preowner.COMPUTE_PROOF_SCHEMA, "compute": {"command_id": "x", "receipt_sha256": "b" * 64,
                                                                    "startup_source_sha256": "c" * 64}},
            {"schema": "fullmag.development-terminal-observation-proof.v3"},
        ):
            with self.subTest(bad=bad), self.assertRaises(BuildControlError):
                preowner._qualified_source_binding(bad)

    def test_omitted_root_namespace_is_allowed_only_for_exact_ownerless_parent(self):
        attempt = "a" * 32
        backend = "c" * 64
        image = "sha256:" + "d" * 64
        document = {"name": "project"}
        config_sha = hashlib.sha256(preowner.canonical(document)).hexdigest()
        parent = {
            "schema": "fullmag.docker-build-operation.v1",
            "phase": "development",
            "ledger_profile": "group-ledger-v1",
            "state": "failed-confirmed",
            "attempt": attempt,
            "compose_project": "project",
            "control_volume": "volume",
            "config_sha256": config_sha,
            "inputs": {"source_root": "/source", "image_id": image},
            "backend_container": backend,
            "error": preowner.OWNERLESS_PARENT_ERROR,
            "worker_cgroup": {"state": "ready", "container_id": backend,
                              "image_id": image, "compose_project": "project"},
        }
        raw = preowner.canonical(parent) + b"\n"
        compose_raw = preowner.canonical(document) + b"\n"
        records = {
            f"development/attempts/{attempt}/terminal.json": raw,
            f"development/attempts/{attempt}/receipt.json": raw,
            "development/current.json": raw,
            f"development/attempts/{attempt}/compose.json": compose_raw,
        }
        control = SimpleNamespace(
            project="project", volume="volume", namespace="",
            read_bytes=lambda path, **kwargs: records[path],
        )
        self.assertEqual(
            preowner._load_parent(
                control, parent, document, selected=Path("/source"), attempt=attempt,
                config_sha256=config_sha, image_id=image, backend_container_id=backend,
                allow_legacy_root_namespace=True,
            )[3],
            parent,
        )
        for profile in (None, "global-ledger", "unknown"):
            with self.subTest(ledger_profile=profile):
                wrong = dict(parent, ledger_profile=profile)
                wrong_raw = preowner.canonical(wrong) + b"\n"
                changed = dict(records)
                for path in (
                    f"development/attempts/{attempt}/terminal.json",
                    f"development/attempts/{attempt}/receipt.json",
                    "development/current.json",
                ):
                    changed[path] = wrong_raw
                changed_control = SimpleNamespace(
                    project="project", volume="volume", namespace="",
                    read_bytes=lambda path, **kwargs: changed[path],
                )
                with self.assertRaises(BuildControlError):
                    preowner._load_parent(
                        changed_control, wrong, document, selected=Path("/source"),
                        attempt=attempt, config_sha256=config_sha,
                        image_id=image, backend_container_id=backend,
                        allow_legacy_root_namespace=True,
                    )
        foreign = copy.copy(control)
        foreign.namespace = "another-namespace"
        with self.assertRaises(BuildControlError):
            preowner._load_parent(
                foreign, parent, document, selected=Path("/source"), attempt=attempt,
                config_sha256=config_sha, image_id=image, backend_container_id=backend,
                allow_legacy_root_namespace=True,
            )
        wrong_parent = dict(parent, error=preowner.OWNERLESS_PARENT_ERROR + " ")
        wrong_raw = preowner.canonical(wrong_parent) + b"\n"
        bad_records = dict(records)
        bad_records[f"development/attempts/{attempt}/terminal.json"] = wrong_raw
        bad_records[f"development/attempts/{attempt}/receipt.json"] = wrong_raw
        bad_records["development/current.json"] = wrong_raw
        bad = SimpleNamespace(project="project", volume="volume", namespace="",
                              read_bytes=lambda path, **kwargs: bad_records[path])
        with self.assertRaises(BuildControlError):
            preowner._load_parent(
                bad, wrong_parent, document, selected=Path("/source"), attempt=attempt,
                config_sha256=config_sha, image_id=image, backend_container_id=backend,
                allow_legacy_root_namespace=True,
            )

    def test_retained_context_requires_the_pinned_post_stop_receipt(self):
        before = self.startup()
        cold_api = {
            "schema": "fullmag.preowner-ownerless-api-probe.v1",
            "process_receipt": before,
            "process_tree_sha256": hashlib.sha256(preowner.canonical(before) + b"\n").hexdigest(),
        }
        after = dict(before)
        after.update(state="shutdown_unknown", api_exit_code=-15,
                     shutdown_error=preowner.OWNERLESS_SHUTDOWN_ERROR)
        raw = preowner.canonical(after) + b"\n"
        stop_record = {
            "schema": "fullmag.preowner-ownerless-api-stop.v1",
            "process_receipt": after,
            "process_receipt_sha256": hashlib.sha256(raw).hexdigest(),
        }
        self.assertEqual(preowner._validate_ownerless_api_stop_record(cold_api, stop_record, raw), after)

        for name, record, observed in (
            ("journal_digest", dict(stop_record, process_receipt_sha256="0" * 64), raw),
            ("unknown_journal_field", dict(stop_record, runtime_pid=10), raw),
            ("receipt_changed_after_stop", stop_record, preowner.canonical({**after, "api_pid": 7}) + b"\n"),
        ):
            with self.subTest(name=name), self.assertRaises(BuildControlError):
                preowner._validate_ownerless_api_stop_record(cold_api, record, observed)

    def test_ownerless_probe_requires_exact_persisted_process_receipt(self):
        before = self.startup()
        rows = [[1, 0, 1, "tini"], [2, 1, 2, "python3"], [3, 2, 3, "fullmag-api"]]
        instance = "11111111-1111-4111-8111-111111111111"
        guest = {
            "schema": "fullmag.preowner-ownerless-api-probe.v1",
            "processes": rows,
            "processes_sha256": hashlib.sha256(json.dumps(rows, separators=(",", ":")).encode()).hexdigest(),
            "probe_present": True,
            "api_instance_sha256": hashlib.sha256(instance.encode()).hexdigest(),
            "health_status": 200,
            "health_state": "degraded",
            "active_session": False,
            "current_status": 503,
            "failure_reason": preowner.OWNERLESS_STARTUP_ERROR,
            "failure_fence_relative": before["api_failure_fence"].removeprefix("/opt/fullmag/"),
            "failure_fence_sha256": "a" * 64,
            "owner_sha256": "b" * 64,
            "process_tree_sha256": hashlib.sha256(preowner.canonical(before) + b"\n").hexdigest(),
            "native_config_sha256": "c" * 64,
            "process_receipt": before,
        }
        stdout = preowner.canonical(guest) + b"\n"
        with patch.object(preowner, "docker_capture", return_value=SimpleNamespace(stdout=stdout)):
            self.assertEqual(preowner._ownerless_api_probe("c" * 64), guest)
        for mutation in (
            lambda value: value.update(extra=True),
            lambda value: value.update(process_tree_sha256="0" * 64),
            lambda value: value["process_receipt"].update(runtime_pid=9),
        ):
            bad = copy.deepcopy(guest)
            mutation(bad)
            with patch.object(preowner, "docker_capture",
                              return_value=SimpleNamespace(stdout=preowner.canonical(bad) + b"\n")):
                with self.assertRaises(BuildControlError):
                    preowner._ownerless_api_probe("c" * 64)


class MemoryControl:
    def __init__(self):
        self.project = 'project'; self.namespace = ''; self.volume = 'volume'; self.identity = {}
        self.records = {}; self.sequence = 0

    def read_bytes(self, path, optional=False, **kwargs):
        if optional: return self.records.get(path)
        return self.records[path]

    def write(self, path, value):
        self.records[path] = restore.base.canonical(value) + b'\n'

    @contextmanager
    def operation(self, phase, inputs):
        self.sequence += 1; attempt = format(self.sequence, '032x'); root = phase + '/attempts/' + attempt
        receipt = {'phase': phase, 'attempt': attempt, 'compose_project': self.project,
                   'control_volume': self.volume, 'inputs': inputs, 'state': 'running'}
        operation = {'root': root, 'receipt': receipt}
        try: yield operation
        except BaseException:
            receipt['state'] = 'outcome-unknown-resources-retained' if operation.get('daemon_pending') else 'failed-confirmed'
            receipt['finished_at'] = 1.0
            self.write(root + '/receipt.json', receipt)
            raise
        finally:
            if receipt['state'] != 'outcome-unknown-resources-retained':
                self.write(root + '/terminal.json', receipt)
                self.write(phase + '/current.json', receipt)
                if receipt['state'] == 'succeeded': self.write(phase + '/verified.json', receipt)
            self.write(root + '/receipt.json', receipt)


class ProducerJournalTests(unittest.TestCase):
    def setUp(self):
        self.control = MemoryControl()
        self.actual = {}
        for name, letter in [('backend', 'b'), ('frontend', 'f')]:
            self.actual[name] = {'Id': letter * 64, 'Image': 'sha256:' + 'c' * 64, 'Mounts': [],
                'Config': {}, 'HostConfig': {}, 'State': {'StartedAt': 'then', 'Running': True,
                'Pid': 10, 'Status': 'running', 'ExitCode': 0, 'OOMKilled': False}}
        fixture = BudgetContractTests(); fixture.setUp()
        self.document = dict(fixture.document, name='project')
        self.previous = {'attempt': 'a' * 32, 'config_sha256': restore.base._sha(restore.base.canonical(self.document)),
            'inputs': {'image_id': 'sha256:' + 'c' * 64}, 'worker_cgroup': {'container_id': 'b' * 64}}
        root = 'development/attempts/' + self.previous['attempt']
        self.control.write(root + '/terminal.json', self.previous); self.control.write(root + '/compose.json', self.document)
        self.observation = {'attempt': self.previous['attempt'], 'config_sha256': self.previous['config_sha256'],
            'parent_terminal_sha256': restore.base._sha(self.control.records[root + '/terminal.json']),
            'compose_sha256': restore.base._sha(self.control.records[root + '/compose.json']),
            'source_root': '/tmp', 'control_namespace': '', 'cold_api': {'requested_policy': fixture.requested},
            'ledger': {'policy': fixture.stored}, 'budget': {'cpus': 8, 'memory_bytes': 32 * GIB},
            'history': {'iteration': 'd' * 32, 'native_config_sha256': 'a' * 64},
            'containers': {name: restore.base._container_pin(row) for name, row in self.actual.items()}}
        self.args = SimpleNamespace(repo_root='/tmp', source_root='/tmp', attempt='a' * 32,
            config_sha256=self.previous['config_sha256'], image_id='sha256:' + 'c' * 64,
            backend_container_id='b' * 64, drain_attempt='d' * 32, apply=False, expected_plan_sha256=None)

    @contextmanager
    def patched(self, *, drift=False, interrupted=False):
        def publish(control, path, value):
            self.assertNotIn(path, control.records); control.write(path, value)
            return restore.base._sha(control.records[path])
        def collect(*args, running, **kwargs):
            observed = copy.deepcopy(self.observation)
            if drift and not running: observed['budget']['memory_bytes'] += GIB
            return observed, copy.deepcopy(self.actual)
        def stop(*args, **kwargs):
            if interrupted is True: raise KeyboardInterrupt()
            self.assertEqual(args[:3], ('kill', '--signal', 'SIGTERM'))
            self.actual['backend']['State'].update(Running=False, Pid=0, Status='exited')
            if interrupted == 'after': raise KeyboardInterrupt()
            return SimpleNamespace(returncode=0)
        with ExitStack() as stack:
            stack.enter_context(redirect_stdout(io.StringIO()))
            for target, attribute, value in [
                ('docker_dev_host', 'require_host', lambda: None),
                ('docker_dev', '_select_source', lambda *a: (Path('/tmp'), {})),
                ('docker_dev', '_compose_identity', lambda *a: {}),
                (restore, 'BuildControl', lambda *a: self.control),
                (restore, '_collect', collect), (restore, 'docker_capture', stop),
                ('docker_volume_stop_unadmitted', '_control_bytes', lambda control, path, **kwargs: control.read_bytes(path, **kwargs)),
                (restore.base, '_publish_immutable', publish),
                (restore.base, '_inspect', lambda kind, identifier: next(
                    row for row in self.actual.values() if row['Id'] == identifier))]:
                if isinstance(target, str): stack.enter_context(patch(target + '.' + attribute, value))
                else: stack.enter_context(patch.object(target, attribute, value))
            yield

    def test_preview_apply_and_authentic_terminal_journal(self):
        with self.patched():
            preview = restore.stop(self.args)
            self.args.apply = True; self.args.expected_plan_sha256 = preview['plan_sha256']
            result = restore.stop(self.args)
            self.assertTrue(self.actual['frontend']['State']['Running'])
            metadata = {key: result[key] for key in ('journal_relative', 'journal_sha256')}
            restore.authenticate_journal(self.control, metadata)
            for path in (metadata['journal_relative'], 'cold-stored-budget-stop/attempts/00000000000000000000000000000002/terminal.json'):
                original = self.control.records[path]; self.control.records[path] = b'{}\n'
                with self.assertRaises(BuildControlError): restore.authenticate_journal(self.control, metadata)
                self.control.records[path] = original

    def test_changed_preview_inventory_and_interrupted_stop_cannot_mint_journal(self):
        for failure in ('preview', 'inventory', 'interrupt'):
            self.setUp()
            with self.subTest(failure=failure), self.patched(drift=failure == 'inventory', interrupted=failure == 'interrupt'):
                preview = restore.stop(self.args); self.args.apply = True
                self.args.expected_plan_sha256 = '0' * 64 if failure == 'preview' else preview['plan_sha256']
                with self.assertRaises(KeyboardInterrupt if failure == 'interrupt' else BuildControlError):
                    restore.stop(self.args)
                path, intent = restore._paths('b' * 64)
                self.assertNotIn(path, self.control.records)
                if failure != 'preview':
                    self.assertIn(intent, self.control.records)
                    with self.assertRaises(BuildControlError):
                        restore.retained_context(self.control, {}, {}, self.actual)


class ContinuationTests(unittest.TestCase):
    setUp = ProducerJournalTests.setUp
    patched = ProducerJournalTests.patched
    def test_lost_signal_ack_continues_without_resignal_and_replays_terminal_readback(self):
        with self.patched():
            preview = restore.stop(self.args)
        self.args.apply = True; self.args.expected_plan_sha256 = preview['plan_sha256']
        with self.patched(interrupted='after'):
            with self.assertRaises(KeyboardInterrupt): restore.stop(self.args)
        path, intent_path = restore._paths('b' * 64)
        self.args.continue_intent_sha256 = restore.base._sha(self.control.records[intent_path])
        self.control._inspect_operation_helper = lambda *args, **kwargs: 'e' * 64
        def commit(control, op, original_raw, result, *args):
            for target in (op['root'] + '/receipt.json', op['root'] + '/terminal.json', restore.PHASE + '/current.json', restore.PHASE + '/verified.json'):
                control.write(target, result)
        with self.patched(), patch.object(restore, '_continuation_commit', side_effect=commit), patch.object(
            restore, 'docker_capture', side_effect=AssertionError('Continuation must never signal')):
            result = restore.stop(self.args)
            self.assertIn(path, self.control.records)
            self.assertEqual(restore.stop(self.args), result)
            self.args.continue_intent_sha256 = '0' * 64
            with self.assertRaises(BuildControlError): restore.stop(self.args)

    def test_success_receipt_gap_only_waits_for_original_writer(self):
        with self.patched(): preview = restore.stop(self.args)
        self.args.apply = True; self.args.expected_plan_sha256 = preview['plan_sha256']
        with self.patched(): restore.stop(self.args)
        path, intent_path = restore._paths('b' * 64)
        intent = json.loads(self.control.records[intent_path]); op = intent['operation']
        del self.control.records[op['root'] + '/terminal.json']
        self.args.continue_intent_sha256 = restore.base._sha(self.control.records[intent_path])
        before = copy.deepcopy(self.control.records)
        with self.patched(), patch.object(restore, '_wait_original_terminal', side_effect=BuildControlError('still active')) as wait, patch.object(
            restore, '_continuation_commit', side_effect=AssertionError('Concurrent producer must not publish')), patch.object(
            restore, '_publish_once', side_effect=AssertionError('Concurrent producer must not publish')):
            with self.assertRaises(BuildControlError): restore.stop(self.args)
            wait.assert_called_once()
        self.assertEqual(self.control.records, before)

    def test_terminal_gap_waits_for_complete_original_publication(self):
        with self.patched(): preview = restore.stop(self.args)
        self.args.apply = True; self.args.expected_plan_sha256 = preview['plan_sha256']
        with self.patched(): restore.stop(self.args)
        _, intent_path = restore._paths('b' * 64)
        self.args.continue_intent_sha256 = restore.base._sha(self.control.records[intent_path])
        before = copy.deepcopy(self.control.records)
        with self.patched(), patch.object(restore, '_wait_original_publication', side_effect=BuildControlError('phase gap')) as wait, patch.object(
            restore, '_continuation_commit', side_effect=AssertionError('Original writer owns the gap')):
            with self.assertRaises(BuildControlError): restore.stop(self.args)
            wait.assert_called_once()
        self.assertEqual(self.control.records, before)

    def test_nongraceful_or_replaced_backend_cannot_confirm_stop(self):
        pin = self.observation['containers']['backend']
        self.actual['backend']['State'].update(Running=False, Pid=0, Status='exited', ExitCode=137)
        with self.patched(), self.assertRaises(BuildControlError):
            restore._wait_backend_stop('b' * 64, pin, timeout=0)
        self.actual['backend']['State'].update(ExitCode=0, StartedAt='another-incarnation')
        with self.patched(), self.assertRaises(BuildControlError):
            restore._wait_backend_stop('b' * 64, pin, timeout=0)

    def test_removed_recreation_context_keeps_the_same_journal_pin(self):
        with self.patched(): preview = restore.stop(self.args)
        self.args.apply = True; self.args.expected_plan_sha256 = preview['plan_sha256']
        with self.patched(): result = restore.stop(self.args)
        # A later managed recreate stops its own frontend before recording
        # the retained removal snapshot. Its immutable fingerprint is stable.
        self.actual['frontend']['State'].update(Running=False, Pid=0, Status='exited')
        proof = {'schema': 'fullmag.docker-removed-recreation-container.v1', 'container_id': 'b' * 64,
            'frontend_container': 'f' * 64, 'image_id': 'sha256:' + 'c' * 64,
            'prior_terminal_sha256': self.observation['parent_terminal_sha256'],
            'prior_compose_sha256': self.observation['compose_sha256']}
        with self.patched():
            context = restore.retained_context(self.control, self.previous, self.document, self.actual,
                                               removed_container_proof=proof)
            self.assertIsInstance(context, restore.ColdBudgetRestoreContext)
            self.assertEqual(context['cold_budget_restore']['journal_sha256'], result['journal_sha256'])
            proof['container_id'] = 'e' * 64
            with self.assertRaises(BuildControlError):
                restore.retained_context(self.control, self.previous, self.document, self.actual,
                                         removed_container_proof=proof)


class ContinuationCommitTests(unittest.TestCase):
    def exercise(self, fail_after=None, hold_observer=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            class Control:
                def path(self, relative): return str(root / relative)
                def read_bytes(self, relative, optional=False):
                    path = root / relative
                    if optional and not path.exists(): return None
                    return path.read_bytes()
                def helper_args(self, script):
                    return ['bash', '-euo', 'pipefail', '-c', script.replace('/control/', str(root) + '/')]
            control = Control(); op = {'root': restore.PHASE + '/attempts/' + 'a' * 32, 'attempt': 'a' * 32}
            original = {'state': 'outcome-unknown-resources-retained'}
            result = {'state': 'succeeded', 'result': {'state': 'stopped-confirmed'}}
            def write(path, document):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(restore.base.canonical(document) + b'\n')
            write(root / op['root'] / 'receipt.json', original)
            write(root / 'intent.json', {'intent': 'exact'}); write(root / 'journal.json', {'journal': 'exact'})
            (root / 'active').write_text(op['attempt'] + '\n'); (root / 'operation.lock').touch()
            operation_fd = (root / 'operation.lock').open('r+'); self.addCleanup(operation_fd.close)
            fcntl.flock(operation_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            observer = root / op['root'] / 'cold-restore-observer.lock'
            observer_fd = None
            if hold_observer:
                observer.touch(); observer_fd = observer.open('r+'); self.addCleanup(observer_fd.close)
                fcntl.flock(observer_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            def publish(control, path, document):
                write(root / path, document)
                return restore.base._sha((root / path).read_bytes())
            first = True
            def capture(args, **kwargs):
                nonlocal first
                script = args[-1]
                self.assertNotIn('rm ', script)
                if fail_after is not None and first and 'cold-restore-observer.lock' in script:
                    script = 'count=0; ' + script.replace('sync "$parent"; done; fi',
                        'sync "$parent"; count=$((count+1)); if test "$count" = "' + str(fail_after) + '"; then exit 73; fi; done; fi')
                    first = False
                executed = subprocess.run(args[:-1] + [script], capture_output=True)
                # Simulate the original helper's documented reaction to the
                # final terminal. The commit script itself never removes active.
                if (root / op['root'] / 'terminal.json').exists():
                    (root / 'active').unlink(missing_ok=True)
                return executed
            parameters = (control, op, restore.base.canonical(original) + b'\n', result,
                'intent.json', restore.base._sha((root / 'intent.json').read_bytes()),
                'journal.json', restore.base._sha((root / 'journal.json').read_bytes()))
            with patch.object(restore.base, '_publish_immutable', side_effect=publish), patch.object(
                restore, 'bounded_capture', side_effect=capture):
                if fail_after is not None or hold_observer:
                    with self.assertRaises(BuildControlError): restore._continuation_commit(*parameters)
                    if hold_observer:
                        self.assertFalse((root / op['root'] / 'terminal.json').exists())
                        return
                restore._continuation_commit(*parameters)
                restore._continuation_commit(*parameters)
            expected = restore.base.canonical(result) + b'\n'
            for target in (op['root'] + '/receipt.json', op['root'] + '/terminal.json',
                           restore.PHASE + '/current.json', restore.PHASE + '/verified.json'):
                self.assertEqual((root / target).read_bytes(), expected)
            self.assertFalse((root / 'active').exists())

    def test_exact_finalization_and_idempotent_readback(self): self.exercise()

    def test_each_atomic_publication_boundary_can_resume_without_signal(self):
        for boundary in (1, 2, 3, 4):
            with self.subTest(boundary=boundary): self.exercise(fail_after=boundary)

    def test_concurrent_observer_cannot_publish(self): self.exercise(hold_observer=True)


if __name__ == '__main__':
    unittest.main()
