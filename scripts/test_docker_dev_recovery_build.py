"""Interpreted repair-build admission and actual kernel-guard regressions; no compilation."""
import argparse
import ast
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import sys
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import docker_dev_recovery_build as repair
import test_docker_backend_dev as package_tests
import test_backend_candidate_recovery as recovery_tests


class RecoveryBuildTests(unittest.TestCase):
    def terminal(self):
        return ({'schema': 'fullmag.docker-process-tree.v1', 'state': 'shutdown_unknown',
                 'api_pid': 101, 'api_exit_code': 101},
                {'schema_version': 'runtime_service_owner.v1', 'state': 'failed', 'children': [
                    {'role': 'compute', 'pid': 102, 'status': 'exited_failure'},
                    {'role': 'preparation', 'pid': 103, 'status': 'exited_success'}]})

    def test_only_terminal_failed_owner_and_complete_api_exit_are_admitted(self):
        process, owner = self.terminal()
        repair.validate_terminal(process, owner)
        for field, value in (('state', 'ready'), ('api_exit_code', None), ('api_pid', True)):
            with self.subTest(field=field), self.assertRaises(ValueError):
                repair.validate_terminal({**process, field: value}, owner)
        for value in ('ready', 'unknown', 'drained'):
            with self.subTest(state=value), self.assertRaises(ValueError):
                repair.validate_terminal(process, {**owner, 'state': value})
        owner['children'][0]['status'] = 'running'
        with self.assertRaises(ValueError):
            repair.validate_terminal(process, owner)

    def test_exact_backend_and_readonly_source_are_required(self):
        identity = {'project_name': 'own'}
        actual = {'Id': 'b'*64, 'Image': 'sha256:'+'a'*64, 'State': {'Running': True},
                  'Config': {'Labels': {'com.docker.compose.project': 'own',
                                         'com.docker.compose.service': 'backend'}},
                  'Mounts': [{'Destination': '/opt/fullmag/source', 'Type': 'bind', 'RW': False}]}
        with patch.object(repair, 'validate_source_labels') as labels:
            repair.validate_backend(actual, identity, actual['Id'], actual['Image'])
            labels.assert_called_once_with(actual, identity)
            with self.assertRaises(ValueError):
                repair.validate_backend(actual, identity, 'c'*64, actual['Image'])
            actual['Mounts'][0]['RW'] = True
            with self.assertRaises(ValueError):
                repair.validate_backend(actual, identity, actual['Id'], actual['Image'])

    def guard_fixture(self, root):
        for name in ('STARTUP-GATE.lock', 'LAUNCH.lock', 'OWNER.lock'):
            (root/name).touch()
        @contextlib.contextmanager
        def cache_lock(_root):
            with (root/'cache.lock').open('w') as lock:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                yield
        control = root/'package'/'.development'
        (control/'candidates').mkdir(parents=True)
        namespace = dict(Path=Path, contextlib=contextlib, fcntl=fcntl, os=os, stat=stat,
                         time=__import__('time'), json=json, hashlib=hashlib, require=repair.require)
        namespace.update(backend=SimpleNamespace(
            _assert_no_links=lambda *args: None, _runtime_build_lock=cache_lock,
            _validated_package=lambda *args, **kwargs: (None, b'unchanged', None), PACKAGE_ROOT=root/'package',
            _ensure_package_development_root=lambda _: control, PACKAGE_CANDIDATES_DIRNAME='candidates',
            PACKAGE_ROTATION_JOURNAL_NAME='rotation.pending.json',
            _validate_candidate_marker=lambda *args, **kwargs: None),
            runtime=SimpleNamespace(canonical_paths=lambda: None, runtime_services_root=lambda _: root),
            pinned_evidence=lambda *args: {}, read=lambda _: b'', archive_superseded=lambda *args: None)
        # Execute the actual guard functions, with only image-specific observations replaced.
        tree = ast.parse(repair.RUNTIME)
        functions = [node for node in tree.body if isinstance(node, ast.FunctionDef)
                     and node.name in {'runtime_locks', 'guard', 'retained_unknown'}]
        exec(compile(ast.Module(body=functions, type_ignores=[]), '<repair-guard>', 'exec'), namespace)
        return namespace['guard']

    def exercise_guard(self, acknowledge):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            guard = self.guard_fixture(root)
            ready_r, ready_w = os.pipe()
            decision_r, decision_w = os.pipe()
            child = os.fork()
            if child == 0:
                os.close(ready_r); os.close(decision_w)
                try:
                    guard({}, ready_w, decision_r)
                    os._exit(0)
                except BaseException:
                    os._exit(2)
            os.close(ready_w); os.close(decision_r)
            try:
                ready = os.fdopen(ready_r)
                self.assertEqual(ready.readline(), 'READY\n')
                if acknowledge:
                    with os.fdopen(decision_w, 'w') as decision:
                        if acknowledge == 'abort':
                            decision.write('ABORT\n'); decision.flush()
                            self.assertEqual(ready.readline(), 'ABORTED\n')
                        else:
                            decision.write('BEGIN\n'); decision.flush()
                            self.assertEqual(ready.readline(), 'BUILDING\n')
                            decision.write(json.dumps({'candidate': '/candidate',
                                'receipt_sha256': hashlib.sha256(b'unchanged').hexdigest()})+'\n')
                    _, status = os.waitpid(child, 0)
                    self.assertEqual(os.waitstatus_to_exitcode(status), 0)
                    child = None
                else:
                    os.close(decision_w)
                with (root/'OWNER.lock').open('r+') as owner:
                    if acknowledge:
                        fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    else:
                        with self.assertRaises(BlockingIOError):
                            fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                ready.close()
                if child is not None:
                    os.kill(child, signal.SIGTERM)
                    os.waitpid(child, 0)

    def test_controller_eof_retains_runtime_guard(self):
        self.exercise_guard(False)

    def test_validated_candidate_releases_runtime_guard(self):
        self.exercise_guard(True)

    def test_explicit_abort_before_build_releases_runtime_guard(self):
        self.exercise_guard('abort')

    def test_control_path_uses_backend_mount_and_inside_code_parses(self):
        self.assertEqual(repair.backend_control_path('/control/recovery-build/attempts/demo/result.json'),
                         '/opt/fullmag/control/recovery-build/attempts/demo/result.json')
        with self.assertRaises(ValueError):
            repair.backend_control_path('/control/../state/result.json')
        ast.parse(repair.inside_code())
        ast.parse(repair.inside_code(promote=True))

    def test_build_only_uses_canonical_candidate_without_rotation_or_serve(self):
        tree = ast.parse(repair.RUNTIME)
        inside = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'inside')
        called = {node.func.attr for node in ast.walk(inside)
                  if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)}
        self.assertIn('_prepare_locked', called)
        self.assertIn('_write_candidate_marker', called)
        self.assertFalse(called & {'_serve', '_rotate_package', '_publish_runtime_provenance',
                                   '_recover_pending_package_rotation', '_reject_partial_package_candidates'})


class FailedMakeAcknowledgementTests(unittest.TestCase):
    def factory(self, root, state='failed', exit_code=2):
        candidate=root/'package'/'.development'/'candidates'/'.backend-package-candidate-failed'
        candidate.mkdir(parents=True); (candidate/'.candidate-owner.json').write_bytes(b'marker')
        attempt=root/'attempt';attempt.mkdir();(attempt/'attempt.json').write_bytes(b'durable waited exit')
        record={'state':state,'exit_code':exit_code,'log_sha256':'a'*64,'log_size':17}
        backend=SimpleNamespace(PACKAGE_ROOT=root/'package',PACKAGE_CANDIDATE_MARKER='.candidate-owner.json',
            FAILED_MAKE_RECEIPT_NAME='attempt.json',_validate_candidate_marker=lambda *args,**kwargs:None,
            _read_failed_make_attempt=lambda *args:(record,attempt,attempt/'log'),
            _validated_package=lambda *args,**kwargs:('current',b'package',{}))
        scope={'Path':Path,'backend':backend,'require':repair.require,'hashlib':hashlib,
               'read':lambda path:path.read_bytes(),'pinned_evidence':lambda *args:{'ledger':'unchanged'}}
        tree=ast.parse(repair.RUNTIME);function=next(node for node in tree.body
            if isinstance(node,ast.FunctionDef) and node.name=='failed_make_result')
        exec(compile(ast.Module(body=[function],type_ignores=[]),'<failed-make-proof>','exec'),scope)
        return candidate,record,scope

    def test_only_durable_nonzero_make_failure_is_acknowledged(self):
        with tempfile.TemporaryDirectory() as directory:
            candidate,record,scope=self.factory(Path(directory))
            result=scope['failed_make_result']({'source_commit':'b'*40},candidate,None,{'ledger':'unchanged'},('current',b'package',{}))
            self.assertEqual(result['state'],'failed-confirmed');self.assertEqual(result['make_exit_code'],2)
            self.assertFalse(result['package_promoted']);self.assertFalse(result['runtime_started'])
            for state,code in [('building',2),('succeeded',0),('failed',0),('failed',True)]:
                record.update(state=state,exit_code=code)
                with self.subTest(state=state,code=code),self.assertRaises(ValueError):
                    scope['failed_make_result']({'source_commit':'b'*40},candidate,None,{'ledger':'unchanged'},('current',b'package',{}))

    def test_changed_runtime_partial_publication_and_foreign_candidate_are_retained(self):
        with tempfile.TemporaryDirectory() as directory:
            candidate,_,scope=self.factory(Path(directory))
            arguments=({'source_commit':'b'*40},candidate,None,{'ledger':'changed'},('current',b'package',{}))
            with self.assertRaises(ValueError):scope['failed_make_result'](*arguments)
            (candidate/'backend-build-receipt.json').write_bytes(b'partial publication')
            with self.assertRaises(ValueError):
                scope['failed_make_result']({'source_commit':'b'*40},candidate,None,{'ledger':'unchanged'},('current',b'package',{}))

    def test_guard_releases_kernel_locks_only_after_exact_failed_ack(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);guard=RecoveryBuildTests().guard_fixture(root)
            result={'schema':'fullmag.docker-recovery-build-failure.v1','state':'failed-confirmed','candidate':'/candidate','make_exit_code':2}
            guard.__globals__['failed_make_result']=lambda *args:result
            guard.__globals__['archive_failed_make']=lambda *args:result
            guard.__globals__['backend']._write_json=lambda path,value,label:path.write_text(json.dumps(value))
            ready_r,ready_w=os.pipe();decision_r,decision_w=os.pipe();pid=os.fork()
            if pid==0:
                os.close(ready_r);os.close(decision_w)
                try:guard({'result_path':str(root/'result.json')},ready_w,decision_r)
                except BaseException:os._exit(2)
                os._exit(0)
            os.close(ready_w);os.close(decision_r)
            try:
                with os.fdopen(ready_r) as ready,os.fdopen(decision_w,'w') as decision:
                    self.assertEqual(ready.readline(),'READY\n');decision.write('BEGIN\n');decision.flush()
                    self.assertEqual(ready.readline(),'BUILDING\n');decision.write(json.dumps(result)+'\n');decision.flush()
                    self.assertEqual(ready.readline(),'FAILED_CONFIRMED\n')
                _,status=os.waitpid(pid,0);pid=None;self.assertEqual(os.waitstatus_to_exitcode(status),0)
                with (root/'OWNER.lock').open('r+') as lock:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
                self.assertEqual(json.loads((root/'result.json').read_text()),result)
            finally:
                if pid is not None:os.kill(pid,signal.SIGTERM);os.waitpid(pid,0)

    def test_full_parent_and_guard_acknowledge_actual_backend_build_exception(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);guard=RecoveryBuildTests().guard_fixture(root);scope=guard.__globals__
            backend=scope['backend']
            class BackendBuildError(RuntimeError):
                pass
            backend.BackendBuildError=BackendBuildError
            backend.PACKAGE_CANDIDATE_MARKER='.candidate-owner.json'
            backend.FAILED_MAKE_RECEIPT_NAME='attempt.json'
            backend._preflight_candidate_storage=lambda *args:None
            backend._capture_start_manifest=lambda *args:root/'manifest.json'
            backend._read_json=lambda *args:({'resolved_commit':'b'*40},None)
            backend._toolchain_identity=lambda:(None,{})
            backend._write_candidate_marker=lambda candidate,*args,**kwargs:(candidate/backend.PACKAGE_CANDIDATE_MARKER).write_bytes(b'marker')
            backend._write_json=lambda path,value,*args:path.write_text(json.dumps(value))
            backend._ensure_directory=lambda path,*args:path.mkdir(parents=True,exist_ok=True)
            backend._fsync_owned_tree=lambda *args:None
            backend._fsync_directory=lambda *args:None
            attempt=root/'failed-attempt';attempt.mkdir()
            def prepare(*args):
                (attempt/'attempt.json').write_bytes(b'waitpid Make exit 2')
                raise BackendBuildError('Canonical Make failed with exit 2')
            backend._prepare_locked=prepare
            backend._read_failed_make_attempt=lambda *args:({'state':'failed','exit_code':2,
                'log_sha256':'a'*64,'log_size':17},attempt,attempt/'log')
            scope.update(argparse=argparse,tempfile=tempfile,ctypes=__import__('ctypes'),
                         read=lambda path:path.read_bytes())
            tree=ast.parse(repair.RUNTIME)
            functions=[node for node in tree.body if isinstance(node,ast.FunctionDef)
                and node.name in {'inside','failed_make_result','archive_failed_make','rename_no_replace'}]
            exec(compile(ast.Module(body=functions,type_ignores=[]),'<actual-parent-guard>','exec'),scope)
            request={'compose_project':'test','source_root':'/test','source_commit':'b'*40,
                     'result_path':str(root/'result.json')}
            with patch.dict(os.environ,FULLMAG_COMPOSE_PROJECT='test',FULLMAG_SOURCE_HOST_ROOT='/test'):
                with self.assertRaises(SystemExit) as stopped:scope['inside'](request)
            self.assertEqual(stopped.exception.code,43)
            proof=json.loads((root/'result.json').read_bytes())
            self.assertEqual(proof['make_exit_code'],2)
            self.assertTrue(Path(proof['candidate_archive']).is_dir())
            self.assertEqual(list((root/'package'/'.development'/'candidates').iterdir()),[])
            self.assertEqual((attempt/'attempt.json').read_bytes(),b'waitpid Make exit 2')
            for name in ('STARTUP-GATE.lock','LAUNCH.lock','OWNER.lock','cache.lock'):
                with (root/name).open('r+') as lock:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)


class RecoveryPromotionTests(unittest.TestCase):
    @contextlib.contextmanager
    def fixture(self):
        backend = package_tests.backend
        with tempfile.TemporaryDirectory() as directory, contextlib.ExitStack() as patches:
            root = Path(directory)
            package, build, control, candidate, previous, raw = package_tests.BackendPackageTests()._ready_rotation_fixture(
                root, '.backend-package-candidate-promotion')
            receipt = json.loads(raw)
            receipt.update(source={'resolved_commit': 'a'*40, 'source_mode': 'live-shadow-v1'},
                native_source_identity={'source_snapshot_sha256': 'b'*64},
                toolchain={'image_id': 'sha256:'+'c'*64}, build={'cargo_profile': 'backend-dev'})
            backend._write_json(candidate/'backend-build-receipt.json', receipt, 'promotion fixture')
            raw = (candidate/'backend-build-receipt.json').read_bytes()
            provenance = root/'runtime-provenance.json'
            provenance.write_bytes(b'{"state":"old"}\n')
            original_provenance = provenance.read_bytes()
            request = dict(candidate_basename=candidate.name,
                candidate_receipt_sha256=hashlib.sha256(raw).hexdigest(),
                current_receipt_sha256=hashlib.sha256(previous[1]).hexdigest(),
                provenance_sha256=hashlib.sha256(original_provenance).hexdigest(),
                result_path=str(root/'operation'/'result.json'))
            original = {'owner': 'owner-bytes', 'config': 'config-bytes', 'ledger': 'lease-bytes',
                        str(provenance): request['provenance_sha256']}
            def evidence(*args):
                return {**original, str(provenance): hashlib.sha256(provenance.read_bytes()).hexdigest()}
            namespace = dict(backend=backend, Path=lambda value: build if value == '/build' else Path(value),
                argparse=argparse, os=os, hashlib=hashlib, json=json, require=repair.require,
                read=lambda path: Path(path).read_bytes(), pinned_evidence=evidence)
            tree = ast.parse(repair.RUNTIME)
            function = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                            and node.name == 'publish_candidate')
            exec(compile(ast.Module(body=[function], type_ignores=[]), '<repair-promotion>', 'exec'), namespace)
            patches.enter_context(patch.object(backend, 'PACKAGE_ROOT', package))
            patches.enter_context(patch.object(backend, 'PROVENANCE_PATH', provenance))
            patches.enter_context(patch.dict(os.environ, FULLMAG_RUNTIME_IMAGE_ID='sha256:'+'c'*64))
            patches.enter_context(patch.object(backend, '_capture_start_manifest', return_value=root/'manifest'))
            patches.enter_context(patch.object(backend, '_toolchain_identity', return_value=(None, receipt['toolchain'])))
            compatible = patches.enter_context(patch.object(backend, '_package_matches_fresh_live_manifest', return_value=True))
            prepare = patches.enter_context(patch.object(backend, '_prepare_locked', side_effect=AssertionError('No Make')))
            serve = patches.enter_context(patch.object(backend, '_serve', side_effect=AssertionError('No serve')))
            status = {'mutated': False}
            yield SimpleNamespace(backend=backend, publish=lambda: namespace['publish_candidate'](request, None, original, status),
                request=request, status=status, package=package, candidate=candidate, control=control,
                previous=previous, raw=raw, provenance=provenance, original_provenance=original_provenance,
                compatible=compatible, prepare=prepare, serve=serve)

    def test_success_publishes_coherent_package_and_retains_old_payload_without_serving(self):
        with self.fixture() as fixture:
            result = fixture.publish()
            self.assertTrue(fixture.status['mutated'])
            self.assertEqual(result['state'], 'promoted')
            self.assertFalse(result['runtime_started'])
            self.assertEqual((fixture.package/'backend-build-receipt.json').read_bytes(), fixture.raw)
            provenance = json.loads(fixture.provenance.read_bytes())
            self.assertEqual(provenance['build_receipt_sha256'], fixture.request['candidate_receipt_sha256'])
            self.assertEqual(provenance['package_root'], str(fixture.package))
            self.assertEqual((Path(result['rollback_package'])/'backend-build-receipt.json').read_bytes(), fixture.previous[1])
            self.assertFalse(fixture.candidate.exists())
            self.assertFalse((fixture.control/fixture.backend.PACKAGE_ROTATION_JOURNAL_NAME).exists())
            fixture.prepare.assert_not_called()
            fixture.serve.assert_not_called()

    def test_wrong_receipt_or_provenance_pins_refuse_before_mutation(self):
        for pin in ('candidate_receipt_sha256', 'current_receipt_sha256', 'provenance_sha256'):
            with self.subTest(pin=pin), self.fixture() as fixture:
                fixture.request[pin] = '0'*64
                with self.assertRaises(ValueError):
                    fixture.publish()
                self.assertFalse(fixture.status['mutated'])
                self.assertEqual((fixture.package/'backend-build-receipt.json').read_bytes(), fixture.previous[1])
                self.assertEqual(fixture.provenance.read_bytes(), fixture.original_provenance)
                self.assertTrue(fixture.candidate.exists())

    def test_stale_source_refuses_before_rotation(self):
        with self.fixture() as fixture:
            fixture.compatible.return_value = False
            with self.assertRaisesRegex(ValueError, 'current source/toolchain'):
                fixture.publish()
            self.assertFalse(fixture.status['mutated'])
            self.assertEqual((fixture.package/'backend-build-receipt.json').read_bytes(), fixture.previous[1])
            self.assertEqual(fixture.provenance.read_bytes(), fixture.original_provenance)

    def test_publication_failure_restores_original_package_and_retains_journal(self):
        with self.fixture() as fixture:
            def broken_publish(_package):
                fixture.provenance.write_bytes(b'partial publication')
                raise OSError('injected publication failure')
            with patch.object(fixture.backend, '_publish_runtime_provenance', side_effect=broken_publish):
                with self.assertRaisesRegex(OSError, 'injected publication failure'):
                    fixture.publish()
            self.assertTrue(fixture.status['mutated'])
            self.assertEqual((fixture.package/'backend-build-receipt.json').read_bytes(), fixture.previous[1])
            self.assertEqual(fixture.provenance.read_bytes(), fixture.original_provenance)
            self.assertTrue((fixture.control/fixture.backend.PACKAGE_ROTATION_JOURNAL_NAME).is_file())
            self.assertEqual((fixture.candidate/'backend-build-receipt.json').read_bytes(), fixture.raw)

    def test_result_write_failure_reinstates_journal_after_normal_finalization(self):
        with self.fixture() as fixture:
            write_json = fixture.backend._write_json
            def broken_result(path, *args):
                if str(path) == fixture.request['result_path']:
                    raise OSError('injected result write')
                return write_json(path, *args)
            with patch.object(fixture.backend, '_write_json', side_effect=broken_result):
                with self.assertRaisesRegex(OSError, 'injected result write'):
                    fixture.publish()
            self.assertEqual((fixture.package/'backend-build-receipt.json').read_bytes(), fixture.raw)
            self.assertTrue((fixture.control/fixture.backend.PACKAGE_ROTATION_JOURNAL_NAME).is_file())
            self.assertFalse(fixture.candidate.exists())

    def test_finalization_failure_keeps_coherent_new_package_and_journal(self):
        with self.fixture() as fixture:
            with patch.object(fixture.backend, '_finalize_published_candidate', side_effect=OSError('injected finalize')):
                with self.assertRaisesRegex(OSError, 'injected finalize'):
                    fixture.publish()
            self.assertEqual((fixture.package/'backend-build-receipt.json').read_bytes(), fixture.raw)
            self.assertEqual(json.loads(fixture.provenance.read_bytes())['build_receipt_sha256'],
                             fixture.request['candidate_receipt_sha256'])
            self.assertTrue((fixture.control/fixture.backend.PACKAGE_ROTATION_JOURNAL_NAME).is_file())


class SupersededCandidateTests(unittest.TestCase):
    @contextlib.contextmanager
    def fixture(self):
        with RecoveryPromotionTests().fixture() as fixture:
            backend = fixture.backend
            build = fixture.package.parent/'build'
            log = backend._begin_failed_make_attempt(build, fixture.candidate, 'install-cli-dev')
            log.write_bytes((fixture.candidate/'direct-backend-build.log').read_bytes())
            backend._finish_failed_make_attempt(build, fixture.candidate, 0)
            recovery = recovery_tests.recovery
            files = {'FULLMAG_RECOVERY_HELPER_SHA256': Path(recovery.__file__),
                     'FULLMAG_RECOVERY_BACKEND_SHA256': Path(backend.__file__)}
            request = dict(result_path=fixture.request['result_path'],
                recovery_source_pins={key: hashlib.sha256(path.read_bytes()).hexdigest() for key, path in files.items()},
                superseded={'candidate_basename': fixture.candidate.name,
                    'marker_sha256': hashlib.sha256((fixture.candidate/backend.PACKAGE_CANDIDATE_MARKER).read_bytes()).hexdigest(),
                    'receipt_sha256': hashlib.sha256(fixture.raw).hexdigest(),
                    'make_attempt_sha256': hashlib.sha256(backend._failed_make_paths(build, fixture.candidate)[1].read_bytes()).hexdigest()})
            calls = []
            def run_helper(command, *, env, capture_output):
                calls.append(command)
                path = Path(command[command.index('--request')+1])
                try:
                    with patch.dict(os.environ, env):
                        result = recovery.recover(json.loads(path.read_bytes()), apply='--apply' in command,
                            package=fixture.package, build=build, control=fixture.package.parent/'control')
                    return SimpleNamespace(returncode=0, stdout=json.dumps(result).encode(), stderr=b'')
                except backend.BackendBuildError as error:
                    return SimpleNamespace(returncode=2, stdout=b'', stderr=str(error).encode())
            def source_path(value):
                if value == '/opt/fullmag/source/docker/all-in-one':
                    return Path(recovery.__file__).parent
                return Path(value)
            def unknown():
                raise RuntimeError('retained unknown')
            namespace = dict(backend=backend, Path=source_path, os=os, sys=sys, hashlib=hashlib, json=json,
                subprocess=SimpleNamespace(run=run_helper), require=repair.require, read=lambda path: Path(path).read_bytes(),
                pinned_evidence=lambda *args: {'runtime': 'unchanged'}, retained_unknown=unknown)
            tree = ast.parse(repair.RUNTIME)
            function = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                            and node.name == 'archive_superseded')
            exec(compile(ast.Module(body=[function], type_ignores=[]), '<superseded-candidate>', 'exec'), namespace)
            current = backend._validated_package(fixture.package, 'archive current package', exclude_development_control=True)
            fixture.archive = lambda: namespace['archive_superseded'](request, None, {'runtime': 'unchanged'}, current)
            fixture.superseded_request, fixture.helper_calls = request, calls
            fixture.destination = fixture.control/'quarantine'/fixture.candidate.name
            fixture.namespace = namespace
            yield fixture

    def test_preserves_exact_old_candidate_then_opens_existing_build_admission(self):
        with self.fixture() as fixture:
            before = {str(path.relative_to(fixture.candidate)): path.read_bytes()
                      for path in fixture.candidate.rglob('*') if path.is_file()}
            fixture.archive()
            after = {str(path.relative_to(fixture.destination)): path.read_bytes()
                     for path in fixture.destination.rglob('*') if path.is_file()}
            self.assertEqual(before, after)
            self.assertFalse(list((fixture.control/'candidates').iterdir()))
            self.assertEqual((fixture.package/'backend-build-receipt.json').read_bytes(), fixture.previous[1])
            self.assertEqual(fixture.provenance.read_bytes(), fixture.original_provenance)
            self.assertEqual(len(fixture.helper_calls), 2)
            self.assertNotIn('--apply', fixture.helper_calls[0])
            self.assertIn('--apply', fixture.helper_calls[1])
            # The archive helper owns its lock; only the subsequent compiler guard takes it again.
            tree = ast.parse(repair.RUNTIME)
            guard = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'guard')
            source = ast.unparse(guard)
            self.assertIn('runtime_locks(build_lock=False)', source)
            self.assertLess(source.index('archive_superseded('), source.index('backend._runtime_build_lock('))
            self.assertLess(source.index('backend._runtime_build_lock('), source.index("ready.write('READY"))
            fixture.prepare.assert_not_called()
            fixture.serve.assert_not_called()

    def test_bad_superseded_pins_never_apply_or_remove_original(self):
        for key in ('marker_sha256', 'receipt_sha256', 'make_attempt_sha256'):
            with self.subTest(pin=key), self.fixture() as fixture:
                fixture.superseded_request['superseded'][key] = '0'*64
                with self.assertRaisesRegex(ValueError, 'pins refused'):
                    fixture.archive()
                self.assertTrue(fixture.candidate.is_dir())
                self.assertFalse(fixture.destination.exists())
                self.assertEqual(len(fixture.helper_calls), 1)
                self.assertNotIn('--apply', fixture.helper_calls[0])

    def test_post_archive_unknown_preserves_archive_and_retains_guard(self):
        with self.fixture() as fixture:
            observations = iter(({'runtime': 'unchanged'}, {'runtime': 'changed'}))
            fixture.namespace['pinned_evidence'] = lambda *args: next(observations)
            with self.assertRaisesRegex(RuntimeError, 'retained unknown'):
                fixture.archive()
            self.assertTrue(fixture.destination.is_dir())
            self.assertFalse(fixture.candidate.exists())
            self.assertEqual((fixture.package/'backend-build-receipt.json').read_bytes(), fixture.previous[1])




class DiagnosticBuildOnlyTests(unittest.TestCase):
    def fixture(self):
        ready = {'schema_version': 'runtime_service_owner.v1', 'state': 'ready',
                 'pid': 102, 'owner_token': 'owner', 'heartbeat_at': 'before',
                 'children': [{'role': 'compute', 'pid': 103, 'status': 'running'},
                              {'role': 'preparation', 'pid': 104, 'status': 'running'}]}
        owner = dict(ready, state='unknown', heartbeat_at='after', children=[
            {'role': 'compute', 'pid': 103, 'status': 'running'},
            {'role': 'preparation', 'pid': 104, 'status': 'exited_failure'}])
        process = {'schema': 'fullmag.docker-process-tree.v1', 'state': 'failed_outcome_retained',
                   'api_pid': 101, 'api_diagnostic_only': True, 'service_owner': ready,
                   'error': 'runtime service owner observation failed during supervision: runtime service owner is not ready'}
        return process, owner

    def test_unknown_is_preserved_and_never_admitted_by_terminal_route(self):
        process, owner = self.fixture()
        before = json.dumps([process, owner], sort_keys=True)
        repair.validate_diagnostic_build(process, owner)
        self.assertEqual(json.dumps([process, owner], sort_keys=True), before)
        with self.assertRaises(ValueError):
            repair.validate_terminal(process, owner)

    def test_changed_or_unfenced_identity_is_rejected(self):
        for field, value in [('api_diagnostic_only', False), ('api_exit_code', 0),
                             ('api_pid', True), ('state', 'drained'), ('error', 'other')]:
            process, owner = self.fixture()
            with self.subTest(field=field), self.assertRaises(ValueError):
                repair.validate_diagnostic_build(dict(process, **{field: value}), owner)
        for field, value in [('state', 'ready'), ('owner_token', 'different'), ('pid', 999)]:
            process, owner = self.fixture()
            with self.subTest(field=field), self.assertRaises(ValueError):
                repair.validate_diagnostic_build(process, dict(owner, **{field: value}))

    @contextlib.contextmanager
    def observations(self):
        import urllib.request
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            proc = root/'proc'; proc.mkdir()
            package = root/'package'; (package/'bin').mkdir(parents=True)
            (package/'bin'/'fullmag-api').touch()
            api = proc/'101'; api.mkdir()
            (api/'exe').symlink_to(package/'bin'/'fullmag-api')
            control = root/'control'; control.mkdir()
            fence = control/('api-failure-'+'a'*32+'.json')
            instance = '11111111-2222-3333-4444-555555555555'
            fence.write_text(json.dumps({'schema': 'fullmag.api-runtime-failure-fence.v1',
                'stage': 'runtime_supervision', 'api_pid': 101, 'api_instance_id': instance}))
            (api/'environ').write_bytes(('FULLMAG_API_RUNTIME_FAILURE_FENCE='+str(fence)).encode()+b'\0')
            ledger = root/'ledger'; ledger.mkdir()
            (ledger/'HOST_RESOURCE_LEDGER.json').write_text(json.dumps({'reservations': [{'state': 'released'}]}))
            def path(*parts):
                value = Path(*parts)
                return proc.joinpath(*value.parts[2:]) if value == Path('/proc') or str(value).startswith('/proc/') else value
            health = SimpleNamespace(status=200, headers={'x-fullmag-api-instance': instance},
                                     read=lambda _: b'{"status":"degraded"}')
            response = contextlib.nullcontext(health)
            namespace = dict(Path=path, os=os, re=__import__('re'), json=json, hashlib=hashlib,
                require=repair.require, read=lambda p:p.read_bytes(),
                backend=SimpleNamespace(PACKAGE_ROOT=package),
                runtime=SimpleNamespace(_validate_terminal_owner=lambda *a, **k:None,
                    process_receipt_path=lambda _:control/'process-tree.json'))
            tree = ast.parse(repair.RUNTIME)
            function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'diagnostic_api_evidence')
            exec(compile(ast.Module(body=[function], type_ignores=[]), '<diagnostic-build>', 'exec'), namespace)
            process, owner = self.fixture(); process['api_failure_fence'] = str(fence)
            with patch.dict(os.environ, FULLMAG_HOST_LEDGER_ROOT=str(ledger)), patch.object(urllib.request, 'urlopen', return_value=response):
                yield SimpleNamespace(check=lambda:namespace['diagnostic_api_evidence'](process,owner,None),
                    proc=proc, health=health, fence=fence, ledger=ledger, api=api)

    def test_live_process_lease_and_wrong_api_each_refuse_actual_probe(self):
        with self.observations() as f:
            self.assertEqual(len(f.check()), 2)
            (f.proc/'103').mkdir()
            with self.assertRaisesRegex(ValueError, 'still present'):
                f.check()
        with self.observations() as f:
            (f.ledger/'HOST_RESOURCE_LEDGER.json').write_text('{"reservations":[{"state":"active"}]}')
            with self.assertRaisesRegex(ValueError, 'reservation'):
                f.check()
        with self.observations() as f:
            f.health.headers['x-fullmag-api-instance'] = 'other'
            with self.assertRaisesRegex(ValueError, 'incarnation'):
                f.check()
        with self.observations() as f:
            f.api.joinpath('environ').write_bytes(b'')
            with self.assertRaisesRegex(ValueError, 'not fenced'):
                f.check()

    def test_inside_promotion_refuses_diagnostic_mode_before_mutation(self):
        namespace = dict(require=repair.require)
        tree = ast.parse(repair.RUNTIME)
        function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'inside_promote')
        exec(compile(ast.Module(body=[function], type_ignores=[]), '<diagnostic-promote>', 'exec'), namespace)
        with self.assertRaisesRegex(ValueError, 'cannot promote'):
            namespace['inside_promote']({'diagnostic_api_only': True})




class RecoveryBuildShellTests(unittest.TestCase):
    def dispatch(self, extra=''):
        import subprocess
        wrapper = (Path(__file__).parent/'just_storage_shell.sh').read_text()
        body = wrapper.split('  *"scripts/docker_dev_recovery_build.py"*)\n',1)[1].split('\n    ;;',1)[0]
        recipe = ('python "/ignored/scripts/docker_dev_recovery_build.py" '
                  "--source-root '/selected/worktree' --backend-container-id '"+'b'*64+
                  "' --image-id 'sha256:"+'c'*64+"' --process-receipt-sha256 '"+'d'*64+
                  "' --owner-sha256 '"+'e'*64+"'"+extra)
        program = ('set -euo pipefail\nrecipe="$RECIPE_LITERAL"\n'
                   'python_cmd="/recorded/python"\nscript_dir="/registered/scripts"\n'
                   'exec() { printf \'%s\\0\' "$@"; }\n'+body)
        return subprocess.run(['/bin/bash','--noprofile','--norc','-c',program],
            env={**os.environ,'RECIPE_LITERAL':recipe},capture_output=True,timeout=15)

    def test_default_and_diagnostic_resume_preserve_exact_argv(self):
        result = self.dispatch()
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertNotIn(b'--diagnostic-api-only',result.stdout)
        suffix = " --resume-attempt '"+'a'*32+"' --resume-terminal-sha256 '"+'f'*64+"' --diagnostic-api-only"
        result = self.dispatch(suffix)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(result.stdout.split(b'\0')[-6:-1],
                         [b'--resume-attempt',b'a'*32,b'--resume-terminal-sha256',b'f'*64,b'--diagnostic-api-only'])

    def test_promotion_duplicate_and_composite_diagnostic_flags_are_rejected(self):
        promotion = (" --promote --candidate-basename '.backend-package-candidate-own'"
                     " --candidate-receipt-sha256 '"+'1'*64+"' --current-receipt-sha256 '"+'2'*64+
                     "' --provenance-sha256 '"+'3'*64+"'")
        legacy = self.dispatch(promotion)
        self.assertEqual(legacy.returncode,0,legacy.stderr)
        for suffix in [promotion+' --diagnostic-api-only',' --diagnostic-api-only --diagnostic-api-only',
                       ' --diagnostic-api-only; printf injected',' --diagnostic-api-only && printf injected']:
            result=self.dispatch(suffix)
            self.assertEqual(result.returncode,2,result.stderr)
            self.assertFalse(result.stdout)


if __name__ == '__main__':
    unittest.main()
