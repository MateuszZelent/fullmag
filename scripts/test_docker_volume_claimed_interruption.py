"""Read-only collector authority and generated controller contract checks."""
import copy
import hashlib
import json
import unittest

import docker_volume_claimed_interruption as operator
from test_docker_claimed_build import fixture


class CollectorTests(unittest.TestCase):
    def test_exact_pin_is_validator_compatible_and_preserves_inputs(self):
        expected, ledger, observed = fixture()
        files = {role: binding['path'] for role, binding in expected['files'].items()}
        before = copy.deepcopy((ledger, observed, files))
        result = operator.make_build_pin(ledger, files, observed, 'run-one', 'task-one')
        self.assertEqual(result, expected)
        self.assertEqual(before, (ledger, observed, files))

    def test_different_selected_task_or_multiple_occupied_reservations_refuse(self):
        for mode in ('run', 'task', 'additional'):
            expected, ledger, observed = fixture()
            files = {role: binding['path'] for role, binding in expected['files'].items()}
            if mode == 'additional':
                ledger['reservations'].append(copy.deepcopy(ledger['reservations'][0]))
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                operator.make_build_pin(ledger, files, observed,
                                        'other' if mode == 'run' else 'run-one',
                                        'other' if mode == 'task' else 'task-one')

    def test_pending_inbox_and_terminal_task_cannot_bootstrap_build(self):
        for role, mutate in (
            ('catalog', lambda value: value['tasks'][0].update(lifecycle='interrupted')),
            ('inbox', lambda value: value['payload'].update(pending={'sequence': 1})),
        ):
            expected, ledger, observed = fixture()
            files = {name: binding['path'] for name, binding in expected['files'].items()}
            value = json.loads(observed[role])
            mutate(value)
            observed[role] = json.dumps(value).encode()
            with self.subTest(role=role), self.assertRaises(ValueError):
                operator.make_build_pin(ledger, files, observed, 'run-one', 'task-one')

    def test_generated_controller_compiles_and_uses_existing_guards(self):
        source = operator.collector_code()
        compile(source, '<claimed-collector>', 'exec')
        self.assertIn("with runtime_locks() as paths:", source)
        self.assertIn("with claimed_build_locks({'claimed_interruption_build': pin, 'diagnostic_api_only': True}, paths):", source)
        # The embedded recovery helper definitions are inert: only collection
        # appears as an executable module-level entrypoint.
        import ast
        module = ast.parse(source)
        calls = [node.value for node in module.body if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call)]
        self.assertEqual([node.func.id for node in calls if isinstance(node.func, ast.Name)], ['collect'])
        self.assertNotIn('repair.', source)

class NativeRequestCollectorTests(unittest.TestCase):
    def test_emitted_request_keeps_docker_and_native_config_producers_separate(self):
        import ast
        import inspect
        from pathlib import Path
        from types import SimpleNamespace
        import docker_claimed_worker_interruption as pure

        docker_config = {'Image':'sha256:'+'a'*64, 'Env':['MODE=diagnostic']}
        native_config_raw = b'{ "host_execution": {"compute_placements": {}} }\n'
        native_sha = hashlib.sha256(native_config_raw).hexdigest()
        docker_sha = pure.recovery.canonical_json_sha256(docker_config)
        self.assertNotEqual(docker_sha, native_sha)
        host = ast.parse(inspect.getsource(operator.collect_request))
        update = next(node for node in ast.walk(host) if isinstance(node,ast.Call)
                      and isinstance(node.func,ast.Attribute) and node.func.attr == 'update'
                      and isinstance(node.func.value,ast.Name) and node.func.value.id == 'inputs')
        namespace = dict(inputs={}, selected=Path('/selected'), control=SimpleNamespace(project='own'),
                         pin={}, args=SimpleNamespace(use_installed_package=True,
                             backend_container_id='b'*64, image_id='sha256:'+'a'*64),
                         before={'Config':docker_config,'State':{'StartedAt':'incarnation'},'HostConfig':{}},
                         engine_id='engine', hashlib=hashlib, pure=pure)
        exec(compile(ast.fix_missing_locations(ast.Module(body=[ast.Expr(update)], type_ignores=[])), '<host-config-producer>', 'exec'), namespace)
        request = namespace['inputs']
        self.assertEqual(request['container']['config_sha256'], docker_sha)
        request.update(candidate_receipt_sha256='c'*64, request_id='id')
        module = ast.parse(operator.REQUEST_COLLECT)
        collector = next(node for node in module.body if isinstance(node,ast.FunctionDef) and node.name == 'collect_native')
        guarded = next(node for node in collector.body if isinstance(node,ast.With))
        # Run the production output assembly against two deliberately different
        # producer inputs; all guard and I/O operations remain outside this slice.
        assembly = [node for node in guarded.body if isinstance(node,ast.Assign)
                    and any(isinstance(target,ast.Name) and target.id in {'pins','interruption'} for target in node.targets)]
        records = {role:b'record' for role in ('launch','inbox','started','supervisor_slot','catalog')}
        records['inbox'] = b'{"payload":{}}'
        namespace = dict(request=request, hashlib=hashlib, json=json, owner_raw=b'owner',
                         config_raw=native_config_raw, process_raw=b'process', records=records,
                         digest_json=lambda value:pure.recovery.canonical_json_sha256(value), journal={},
                         executable_sha='d'*64, source={'source_snapshot_sha256':'e'*64},
                         certificate_raw=b'certificate', manifest={}, identity={},
                         pin={'consumed_launch_token':'token','catalog_revision':1,'expected_task':{}},
                         placement={'gpu_uuid':'GPU-one'})
        exec(compile(ast.Module(body=assembly, type_ignores=[]), '<guest-request-producers>', 'exec'), namespace)
        emitted = namespace['interruption']
        self.assertEqual(emitted['container']['config_sha256'], docker_sha)
        self.assertEqual(emitted['pins']['config_sha256'], native_sha)
        self.assertNotEqual(emitted['container']['config_sha256'], emitted['pins']['config_sha256'])

    def journal_fixture(self):
        pin, _, _ = fixture()
        identity = pin['identity']
        claim = {key: identity[key] for key in ('run_id', 'task_id', 'attempt_id', 'ownership_epoch')}
        claim['lease'] = dict(resource_id=identity['resource_id'], lease_token=identity['lease_token'],
                              heartbeat_sequence=0, kind='gpu', budget={'slots': 1})
        entries = []
        for direction, command_sequence, event_sequence in [('command', 1, 0), ('event', 1, 1)]:
            payload = dict(message=dict(direction=direction, envelope={direction: 'start' if direction == 'command' else 'started'}),
                           checkpoint=dict(command_sequence=command_sequence, event_sequence=event_sequence, claim=claim))
            digest = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
            entries.append({**{key: identity[key] for key in ('run_id', 'task_id', 'attempt_id', 'ownership_epoch', 'lease_token')},
                            'sequence': 1, 'direction': direction, 'payload': payload, 'payload_sha256': digest})
        return identity, claim, entries

    def test_full_native_claim_retained_in_canonical_journal_order(self):
        identity, claim, entries = self.journal_fixture()
        before = copy.deepcopy(entries)
        journal, actual = operator.make_journal_snapshot(list(reversed(entries)), identity)
        self.assertEqual(actual, claim)
        self.assertEqual(journal, dict(commands=[{'command': 'start'}], events=[{'event': 'started'}]))
        self.assertEqual(entries, before)

    def test_journal_tampering_gaps_duplicates_or_other_lease_refuse(self):
        for mode in ('hash', 'gap', 'duplicate', 'lease'):
            identity, _, entries = self.journal_fixture()
            if mode == 'hash':
                entries[0]['payload_sha256'] = '0'*64
            elif mode == 'gap':
                entries[0]['sequence'] = 2
            elif mode == 'duplicate':
                entries.append(copy.deepcopy(entries[0]))
            else:
                entries[0]['lease_token'] = 'another'
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                operator.make_journal_snapshot(entries, identity)

    def test_native_collector_compiles_with_no_stale_probe_dependency(self):
        source = operator.request_collector_code()
        compile(source, '<claimed-request-collector>', 'exec')
        self.assertIn('collect_native(json.loads(sys.argv[1]))', source)
        self.assertNotIn('repair.', source)
        self.assertNotIn('.linux-native-probe.json', source)
        self.assertIn('exclude_candidate_marker=True', source)


class PrepareTests(unittest.TestCase):
    def result_fixture(self, state='prepared'):
        inputs = dict(request_sha256='1'*64, interruption_sha256='2'*64,
                      backend_container_id='3'*64, backend_started_at='2026-11-05T12:00:00Z')
        result = dict(schema_version='fullmag.claimed-interruption-prepare-phase.v1', **inputs,
                      state=state, native_invoked=True, native_exit_code=0, effects_known=True,
                      runtime_started=False, container_stopped=False, capacity_released=False,
                      native_result=dict(status='prepared', request_sha256=inputs['interruption_sha256'], capacity_released=False),
                      storage_probe_path='/state/.linux-native-probe.json', storage_probe_sha256='4'*64)
        return inputs, result

    def test_exact_prepared_acknowledgement(self):
        inputs, result = self.result_fixture()
        self.assertEqual(operator.validate_prepare_result(result, inputs), 'prepared')

    def test_verify_ack_cannot_be_confused_with_prepare(self):
        inputs, result = self.result_fixture()
        inputs['verify_only'] = True
        with self.assertRaises(ValueError):
            operator.validate_prepare_result(result, inputs)
        result.update(state='verified', native_result=dict(status='verified_source_protocol',
                      request_sha256=inputs['interruption_sha256'], mutated=False))
        self.assertEqual(operator.validate_prepare_result(result, inputs), 'verified')
        inputs['verify_only'] = False
        with self.assertRaises(ValueError):
            operator.validate_prepare_result(result, inputs)

    def test_wrong_ack_or_crossed_lifecycle_boundary_refuses(self):
        for field, value in [('request_sha256', '5'*64), ('backend_container_id', '6'*64),
                             ('backend_started_at', 'another'), ('capacity_released', True), ('runtime_started', True),
                             ('container_stopped', True), ('native_exit_code', 1), ('native_invoked', False),
                             ('storage_probe_sha256', 'REQUIRES_FRESH_PHASE_LOCAL_PROBE')]:
            inputs, result = self.result_fixture()
            result[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                operator.validate_prepare_result(result, inputs)

    def test_clean_rejected_verify_requires_explicit_authority_and_equal_effects(self):
        inputs, result = self.result_fixture('verified-rejected')
        inputs.update(verify_only=True, diagnostic_api_only=True, claimed_interruption_build={})
        result.update(native_exit_code=1, effects_before_sha256='7'*64, effects_after_sha256='7'*64)
        self.assertEqual(operator.validate_prepare_result(result, inputs), 'verified-rejected')
        for field, value in [('verify_only', False), ('diagnostic_api_only', False), ('claimed_interruption_build', None)]:
            changed = {**inputs, field: value}
            with self.subTest(field=field), self.assertRaises(ValueError):
                operator.validate_prepare_result(result, changed)
        for field, value in [('effects_known', False), ('effects_after_sha256', '8'*64), ('native_exit_code', 0)]:
            changed = {**result, field: value}
            with self.subTest(field=field), self.assertRaises(ValueError):
                operator.validate_prepare_result(changed, inputs)

    def test_known_errors_require_known_native_effect_boundary(self):
        inputs, result = self.result_fixture('native-error-process-exit-known')
        with self.assertRaises(ValueError):
            operator.validate_prepare_result(result, inputs)
        result.update(native_exit_code=1, effects_known=False)
        from docker_build_control import BuildControlError
        with self.assertRaises(BuildControlError):
            operator.validate_prepare_result(result, inputs)
        result.update(state='preflight-error-confirmed', native_invoked=False)
        with self.assertRaises(ValueError):
            operator.validate_prepare_result(result, inputs)
        result.pop('native_exit_code')
        self.assertEqual(operator.validate_prepare_result(result, inputs), 'preflight-error-confirmed')

    def test_unknown_missing_or_malformed_ack_preserves_uncertainty(self):
        from docker_build_control import BuildControlError
        inputs, result = self.result_fixture('outcome-unknown-resources-retained')
        with self.assertRaises(BuildControlError):
            operator.validate_prepare_result(result, inputs)
        for value in (None, {}, {'state': 'prepared'}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                operator.validate_prepare_result(value, inputs)

    def test_prepare_controller_has_fresh_probe_then_only_prepare_native_call(self):
        import ast
        source = operator.prepare_code()
        compile(source, '<claimed-prepare>', 'exec')
        self.assertNotIn('repair.', source)
        module = ast.parse(operator.PREPARE)
        body = module.body[0]
        calls = [node for node in ast.walk(body) if isinstance(node, ast.Call)]
        fresh = [node for node in calls if isinstance(node.func, ast.Attribute)
                 and isinstance(node.func.value, ast.Name) and node.func.value.id == 'linux_native_probe'
                 and node.func.attr == 'run']
        self.assertEqual(len(fresh), 1)
        self.assertEqual([(item.arg, item.value.value) for item in fresh[0].keywords], [('require_restart', True)])
        self.assertNotIn('claimed_build_locks(', ast.get_source_segment(operator.PREPARE, body))
        self.assertNotIn('with runtime_locks(', ast.get_source_segment(operator.PREPARE, body))
        self.assertIn("'--prepare-claimed-interruption'", operator.PREPARE)
        self.assertNotIn('--complete-claimed-interruption', operator.PREPARE)
        self.assertNotIn('shell=True', operator.PREPARE)

    def test_prepare_execution_uses_fresh_probe_and_exact_pins(self):
        import contextlib
        import io
        import os
        from pathlib import Path
        import subprocess
        import types
        from unittest.mock import Mock, patch
        digest = lambda raw: hashlib.sha256(raw).hexdigest()
        owner, process, receipt, probe = b'owner', b'process', b'receipt', b'{"fresh":true}'
        interruption = dict(container=dict(container_id='3'*64, image_id='sha256:'+'4'*64),
                            container_started_at='incarnation', pins=dict(owner_sha256=digest(owner),
                            process_receipt_sha256=digest(process), package_receipt_sha256=digest(receipt),
                            executable_sha256='5'*64))
        native_raw = json.dumps(dict(interruption=interruption)).encode()
        interruption_sha = digest(json.dumps(interruption, sort_keys=True, separators=(',', ':')).encode())
        request = dict(request_sha256=digest(native_raw), interruption_sha256=interruption_sha,
                       backend_container_id='3'*64, backend_started_at='incarnation', image_id='sha256:'+'4'*64,
                       compose_project='fullmag-master', source_root='/source', guest_request_path='/request',
                       owner_sha256=digest(owner), process_receipt_sha256=digest(process),
                       candidate_basename='.backend-package-candidate-one', result_path='/ack')
        probe_module = types.SimpleNamespace(run=Mock(return_value={'fresh': True}), read_regular=Mock(return_value=probe))
        writer = Mock()
        package_receipt = {'artifacts':[{'path':'bin/fullmag-runtime-service','sha256':'5'*64,'size':123}]}
        backend = types.SimpleNamespace(PACKAGE_ROOT=Path('/package'), PACKAGE_DEVELOPMENT_DIRNAME='.development',
                    PACKAGE_CANDIDATES_DIRNAME='candidates', _validate_candidate_marker=Mock(),
                    _validated_package=Mock(return_value=(package_receipt, receipt, {})), _write_json=writer)
        runtime = types.SimpleNamespace(canonical_paths=lambda: types.SimpleNamespace(config=Path('/config')),
                                        runtime_services_root=lambda paths: Path('/owner'),
                                        process_receipt_path=lambda paths: Path('/process'))
        runner = Mock(return_value=subprocess.CompletedProcess([], 0,
                      json.dumps(dict(status='prepared', request_sha256=interruption_sha, capacity_released=False)).encode(), b''))
        namespace = dict(os=os, json=json, hashlib=hashlib, Path=Path, backend=backend, runtime=runtime,
                         require=operator.repair.require,
                         read=lambda path: {'/request': native_raw, '/owner/OWNER.json': owner, '/process': process}[str(path)],
                         digest_json=lambda value: digest(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()),
                         verify_effects_snapshot=Mock(return_value={'evidence': 'unchanged'}),
                         hash_regular=lambda path, *, allow_readonly_hardlink=False: ('5'*64, 123), subprocess=types.SimpleNamespace(run=runner, PIPE=subprocess.PIPE))
        exec(compile(operator.PREPARE, '<prepare-test>', 'exec'), namespace)
        with patch.dict('sys.modules', linux_native_probe=probe_module), patch.dict(os.environ,
                FULLMAG_COMPOSE_PROJECT='fullmag-master', FULLMAG_SOURCE_HOST_ROOT='/source'), contextlib.redirect_stdout(io.StringIO()):
            namespace['prepare_native'](request)
        probe_module.run.assert_called_once_with(require_restart=True)
        self.assertIsNotNone(runner.call_args, writer.call_args)
        command = runner.call_args.args[0]
        self.assertEqual(command, ['/package/.development/candidates/.backend-package-candidate-one/bin/fullmag-runtime-service',
                         '--prepare-claimed-interruption', '--config', '/config', '--request', '/request',
                         '--request-sha256', digest(native_raw), '--storage-probe', '/state/.linux-native-probe.json',
                         '--storage-probe-sha256', digest(probe)])
        self.assertEqual(writer.call_args.args[1]['state'], 'prepared')
        self.assertFalse(writer.call_args.args[1]['capacity_released'])

        runner.return_value = subprocess.CompletedProcess([], 0,
            json.dumps(dict(status='verified_source_protocol', request_sha256=interruption_sha, mutated=False)).encode(), b'')
        request['verify_only'] = True
        with patch.dict('sys.modules', linux_native_probe=probe_module), patch.dict(os.environ,
                FULLMAG_COMPOSE_PROJECT='fullmag-master', FULLMAG_SOURCE_HOST_ROOT='/source'), contextlib.redirect_stdout(io.StringIO()):
            namespace['prepare_native'](request)
        self.assertEqual(runner.call_args.args[0], command + ['--verify-only'])
        self.assertEqual(writer.call_args.args[1]['state'], 'verified')
        # A clean read-only native rejection has known unchanged effects and
        # may terminate its diagnostic operation. Mutating prepare never does.
        request.update(verify_only=True, diagnostic_api_only=True, claimed_interruption_build={})
        runner.return_value = subprocess.CompletedProcess([], 1, b'', b'verification rejected')
        namespace['verify_effects_snapshot'] = Mock(return_value={'evidence': 'unchanged'})
        with patch.dict('sys.modules', linux_native_probe=probe_module), patch.dict(os.environ,
                FULLMAG_COMPOSE_PROJECT='fullmag-master', FULLMAG_SOURCE_HOST_ROOT='/source'), contextlib.redirect_stdout(io.StringIO()):
            namespace['prepare_native'](request)
        clean = writer.call_args.args[1]
        self.assertEqual(clean['state'], 'verified-rejected')
        self.assertTrue(clean['effects_known'])
        self.assertEqual(operator.validate_prepare_result(clean, request), 'verified-rejected')
        for role in ('ledger', 'private_file', 'interruption_intent'):
            runner.reset_mock()
            namespace['verify_effects_snapshot'] = Mock(side_effect=[{role: 'before'}, {role: 'after'}])
            with patch.dict('sys.modules', linux_native_probe=probe_module), patch.dict(os.environ,
                    FULLMAG_COMPOSE_PROJECT='fullmag-master', FULLMAG_SOURCE_HOST_ROOT='/source'), contextlib.redirect_stdout(io.StringIO()):
                namespace['prepare_native'](request)
            runner.assert_called_once()
            drift = writer.call_args.args[1]
            self.assertEqual(drift['state'], 'outcome-unknown-resources-retained')
            self.assertFalse(drift['effects_known'])
            from docker_build_control import BuildControlError
            with self.assertRaises(BuildControlError):
                operator.validate_prepare_result(drift, request)
        request['verify_only'] = False

        request['use_installed_package'] = True
        backend._validate_candidate_marker.reset_mock()
        runner.return_value = subprocess.CompletedProcess([], 0,
            json.dumps(dict(status='prepared', request_sha256=interruption_sha, capacity_released=False)).encode(), b'')
        with patch.dict('sys.modules', linux_native_probe=probe_module), patch.dict(os.environ,
                FULLMAG_COMPOSE_PROJECT='fullmag-master', FULLMAG_SOURCE_HOST_ROOT='/source'), contextlib.redirect_stdout(io.StringIO()):
            namespace['prepare_native'](request)
        self.assertEqual(runner.call_args.args[0][0], '/package/bin/fullmag-runtime-service')
        backend._validate_candidate_marker.assert_not_called()
        self.assertTrue(backend._validated_package.call_args.kwargs['exclude_development_control'])
        runner.reset_mock()
        backend._validated_package.return_value = ({}, b'foreign installed package', {})
        with patch.dict('sys.modules', linux_native_probe=probe_module), patch.dict(os.environ,
                FULLMAG_COMPOSE_PROJECT='fullmag-master', FULLMAG_SOURCE_HOST_ROOT='/source'), contextlib.redirect_stdout(io.StringIO()):
            namespace['prepare_native'](request)
        runner.assert_not_called()
        self.assertEqual(writer.call_args.args[1]['state'], 'preflight-error-confirmed')
        backend._validated_package.return_value = (package_receipt, receipt, {})
        request['use_installed_package'] = False

        # A failed native invocation can already have persisted quarantine or
        # catalog evidence. The wrapper must retain uncertainty, never retry.
        runner.reset_mock()
        runner.return_value = subprocess.CompletedProcess([], 1, b'', b'failure after durable quarantine publication')
        with patch.dict('sys.modules', linux_native_probe=probe_module), patch.dict(os.environ,
                FULLMAG_COMPOSE_PROJECT='fullmag-master', FULLMAG_SOURCE_HOST_ROOT='/source'), contextlib.redirect_stdout(io.StringIO()):
            namespace['prepare_native'](request)
        runner.assert_called_once()
        observed = writer.call_args.args[1]
        self.assertEqual(observed['state'], 'native-error-process-exit-known')
        self.assertEqual(observed['native_exit_code'], 1)
        self.assertFalse(observed['effects_known'])
        from docker_build_control import BuildControlError
        with self.assertRaises(BuildControlError):
            operator.validate_prepare_result(observed, request)


class VerifyEffectsSnapshotTests(unittest.TestCase):
    def test_snapshot_covers_ledger_private_files_and_new_intent(self):
        import os
        import stat
        import tempfile
        import types
        from pathlib import Path
        from unittest.mock import patch
        digest = lambda value: hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            store, ledger = Path(directory)/'store', Path(directory)/'ledger'
            identity = dict(run_id='run-one', task_id='task-one', attempt_id='attempt-one', ownership_epoch=1)
            relative = 'runs/run-one/worker-attempts/task-one/attempt-one/epoch-1'
            epoch = store/relative
            epoch.mkdir(parents=True)
            private = epoch/'partial.csv'
            private.write_bytes(b'partial row')
            def inventory(root, current, files):
                for path in current.rglob('*'):
                    if path.is_file():
                        raw = path.read_bytes()
                        files[path.relative_to(root).as_posix()] = dict(bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())
            files = {}
            inventory(epoch, epoch, files)
            manifest = dict(schema_version='claimed_worker_preserved_files.v1', root_relative=relative, files=files)
            token = '12345678-1234-1234-1234-123456789abc'
            native = dict(interruption=dict(identity=identity, request_id=token,
                          pins=dict(preserved_files_manifest_sha256=digest(manifest))))
            current_ledger = {'ledger': 'before'}
            namespace = dict(os=os, re=operator.re, stat=stat, Path=Path, hashlib=hashlib,
                require=operator.repair.require, pinned_evidence=lambda request, paths: dict(current_ledger),
                digest_json=digest, inventory_regular=inventory, read=lambda path: b'exact request',
                runtime=types.SimpleNamespace(runtime_services_root=lambda paths: store/'runtime-services'),
                backend=types.SimpleNamespace(_assert_no_links=lambda path, label: None),
                hash_regular=lambda path: (hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_size))
            exec(compile(operator.VERIFY_EFFECTS, '<verify-effects>', 'exec'), namespace)
            request = dict(verify_only=True, diagnostic_api_only=True, claimed_interruption_build={}, guest_request_path='/request')
            with patch.dict(os.environ, FULLMAG_HOST_LEDGER_ROOT=str(ledger)):
                snapshot = lambda: namespace['verify_effects_snapshot'](request, types.SimpleNamespace(store=store), native)
                baseline = snapshot()
                current_ledger['ledger'] = 'changed'
                self.assertNotEqual(snapshot(), baseline)
                current_ledger['ledger'] = 'before'
                intent = ledger/'claimed-worker-interruptions'/token/'request.json'
                intent.parent.mkdir(parents=True)
                intent.write_bytes(b'new intent')
                self.assertNotEqual(snapshot(), baseline)
                self.assertIn('request.json', snapshot()['interruption_records'][str(intent.parent)])
                private.write_bytes(b'changed partial row')
                with self.assertRaises(ValueError):
                    snapshot()



class PublishedExecutableHashTests(unittest.TestCase):
    def functions(self):
        import os
        import stat
        import types
        from pathlib import Path
        namespace = dict(os=os, stat=stat, hashlib=hashlib, Path=Path,
                         require=operator.repair.require,
                         backend=types.SimpleNamespace(_assert_no_links=lambda path, label: None))
        exec(compile(operator.REQUEST_COLLECT, '<hash-regression>', 'exec'), namespace)
        return namespace

    def test_published_readonly_hardlink_is_only_allowed_explicitly(self):
        import os
        import tempfile
        from pathlib import Path
        namespace = self.functions()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            published = root/'published'
            published.write_bytes(b'exact published binary')
            os.link(published, root/'shared-package')
            published.chmod(0o555)
            expected = (hashlib.sha256(published.read_bytes()).hexdigest(), published.stat().st_size)
            self.assertEqual(namespace['hash_regular'](published, allow_readonly_hardlink=True), expected)
            with self.assertRaises(ValueError):
                namespace['hash_regular'](published)
            with self.assertRaises(ValueError):
                namespace['inventory_regular'](root, root, {})
            published.chmod(0o755)
            with self.assertRaises(ValueError):
                namespace['hash_regular'](published, allow_readonly_hardlink=True)

    def test_normal_regular_and_nofollow_symlink(self):
        import tempfile
        from pathlib import Path
        namespace = self.functions()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            normal = root/'normal'
            normal.write_bytes(b'user data')
            self.assertEqual(namespace['hash_regular'](normal), (hashlib.sha256(b'user data').hexdigest(), 9))
            link = root/'link'
            link.symlink_to(normal)
            for options in ({}, {'allow_readonly_hardlink':True}):
                with self.assertRaises((ValueError, OSError)):
                    namespace['hash_regular'](link, **options)

    def test_fd_link_count_drift_is_rejected(self):
        import os
        import tempfile
        import types
        from pathlib import Path
        from unittest.mock import patch
        namespace = self.functions()
        with tempfile.TemporaryDirectory() as directory:
            normal = Path(directory)/'normal'
            normal.write_bytes(b'user data')
            actual = normal.stat()
            changed = types.SimpleNamespace(**{name:getattr(actual,name) for name in (
                'st_mode','st_nlink','st_dev','st_ino','st_size','st_mtime_ns','st_ctime_ns')})
            changed.st_nlink += 1
            with patch.object(os, 'fstat', side_effect=[actual,changed]):
                with self.assertRaises(ValueError):
                    namespace['hash_regular'](normal)

    def test_collector_forwards_installed_flag_into_operation_inputs(self):
        import ast
        import inspect
        source = ast.parse(inspect.getsource(operator.collect_request))
        updates = [node for node in ast.walk(source) if isinstance(node,ast.Call)
                   and isinstance(node.func,ast.Attribute) and node.func.attr == 'update'
                   and isinstance(node.func.value,ast.Name) and node.func.value.id == 'inputs']
        flag = next(keyword.value for node in updates for keyword in node.keywords
                    if keyword.arg == 'use_installed_package')
        self.assertEqual(ast.unparse(flag), 'args.use_installed_package')

    def test_installed_collector_is_explicit_and_uses_package_validation(self):
        import ast
        from pathlib import Path
        from types import SimpleNamespace
        from unittest.mock import Mock
        module = ast.parse(operator.REQUEST_COLLECT)
        collector = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == 'collect_native')
        guarded = next(node for node in collector.body if isinstance(node,ast.With))
        start = next(index for index,node in enumerate(guarded.body)
                     if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id == 'installed' for target in node.targets))
        selection = ast.Module(body=guarded.body[start:start+4], type_ignores=[])
        # Execute the production selection statements, including the exact
        # package validator call; no collector effects or runtime invocation.
        for installed in (False, True, None, 'true'):
            backend = SimpleNamespace(PACKAGE_ROOT=Path('/package'), PACKAGE_DEVELOPMENT_DIRNAME='.development',
                                      PACKAGE_CANDIDATES_DIRNAME='candidates', _validate_candidate_marker=Mock(),
                                      _validated_package=Mock(return_value=({},b'receipt',{})))
            namespace = {'request':{'candidate_basename':'.backend-package-candidate-one','use_installed_package':installed},
                         'backend':backend,'Path':Path}
            exec(compile(selection, '<package-selection>', 'exec'), namespace)
            expected = Path('/package') if installed is True else Path('/package/.development/candidates/.backend-package-candidate-one')
            self.assertEqual(namespace['package'], expected)
            self.assertEqual(backend._validated_package.call_args.kwargs,
                             {'exclude_candidate_marker':installed is not True,'exclude_development_control':installed is True})
            self.assertEqual(backend._validate_candidate_marker.call_count, 0 if installed is True else 1)




if __name__ == '__main__':
    unittest.main()
