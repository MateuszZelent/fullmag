"""Interpreted private fixtures; no real Docker or operator mutations."""
from contextlib import nullcontext, closing
import copy
import json
from pathlib import Path
import sqlite3
import threading
import unittest
from unittest.mock import Mock, patch

from local_runner import coordinator_replacement as replacement, coordinator_lifecycle as lifecycle
from local_runner import container_client as client, boris_transition as transition, coordinator_image as producer
from local_runner import container_main, build_executor
from local_runner.service import ServicePaths, read_stop_request
import test_coordinator_lifecycle as lifecycle_tests
from test_local_runner_container_client import CONTAINER_ID, IMAGE, NEW_IMAGE

NEW_ID='f'*64


class ReplacementTests(unittest.TestCase):
    def setUp(self):
        lifecycle_tests.LifecycleTests.setUp(self)
        result=lifecycle_tests.LifecycleTests.run_stop(self)
        self.receipt_path=Path(result['receipt_path'])
        self.receipt_digest=replacement._sha(self.receipt_path.read_bytes())
        self.real_image_proof=replacement._image_proof
        self.mock_proof=patch.object(replacement,'_image_proof',return_value=dict(path=str(self.receipt_path),sha256=self.receipt_digest))
        self.mock_proof.start(); self.addCleanup(self.mock_proof.stop)
        self.arguments=dict(quiesce_receipt=self.receipt_path,quiesce_receipt_sha256=self.receipt_digest,
            expected_container_id=CONTAINER_ID,expected_image_id=IMAGE,
            expected_container_sha256=transition._sha(self.baseline[1]),expected_build_config_sha256=transition._sha(self.baseline[2]),
            image_id=NEW_IMAGE,image_build_receipt=self.receipt_path,image_build_receipt_sha256=self.receipt_digest,
            docker_call=self.docker_call,health_call=lambda *a:copy.deepcopy(self.health))
        self.effects=[]

    def docker_call(self, args):
        if args[:2]==['image','inspect']:
            return json.dumps([dict(Id=args[2],Config=dict(Entrypoint=producer.ENTRYPOINT))])
        if args[0] in ('rm','create','start'):
            record=json.loads(replacement.pending_path(self.storage).read_text())
            expected={'rm':'REMOVE_REQUESTED','create':'CREATE_REQUESTED','start':'START_REQUESTED'}[args[0]]
            self.assertEqual(record['phase'],expected); self.effects.append(args[0])
        result=self.docker(args)
        if args[0]=='create':
            self.docker.container_id=NEW_ID; self.docker.inspection['Id']=NEW_ID; result=NEW_ID
        if self.docker.inspection:
            self.docker.inspection['Config']['Entrypoint']=producer.ENTRYPOINT
        return result if args[0]!='inspect' else json.dumps([self.docker.inspection])

    def run_replace(self,**kwargs):
        return replacement.replace_exited(self.layout,'alice',**{**self.arguments,**kwargs})

    def recover(self,**kwargs):
        record=json.loads(replacement.pending_path(self.storage).read_text())
        return replacement.recover_exited(self.layout,'alice',record['transaction_id'],docker_call=self.docker_call,
                health_call=lambda *a:copy.deepcopy(self.health),**kwargs)

    def test_success_preserves_secret_catalog_queue_pause_and_returns_no_secret(self):
        queue=lifecycle._queue_guard(self.storage)
        result=self.run_replace()
        self.assertEqual(result['status'],'SUCCEEDED_PAUSED'); self.assertEqual(result['container_id'],NEW_ID)
        self.assertEqual(self.effects,['rm','create','start'])
        self.assertEqual(replacement._blobs(self.storage,'alice')[::2],self.baseline[::2])
        self.assertEqual(queue,lifecycle._queue_guard(self.storage));self.assertIsNotNone(read_stop_request(ServicePaths.from_storage(self.storage)))
        self.assertFalse(replacement.is_pending(self.storage)); self.assertNotIn('configs',result)

    def test_every_checkpoint_write_failure_precedes_its_effect_and_recovers_forward(self):
        for phase,effects in [('REMOVE_REQUESTED',[]),('PUBLIC_UPDATE_REQUESTED',['rm']),('CREATE_REQUESTED',['rm']),('START_REQUESTED',['rm','create'])]:
            with self.subTest(phase=phase):
                # Each fixture is independent; a failed checkpoint cannot authorize its effect.
                case=ReplacementTests(); case.setUp()
                try:
                    original=replacement._write
                    def fault(path,value):
                        if isinstance(value,dict) and value.get('phase')==phase:raise OSError('synthetic durable checkpoint fault')
                        return original(path,value)
                    with patch.object(replacement,'_write',side_effect=fault):
                        with self.assertRaises(OSError):case.run_replace()
                    self.assertEqual(case.effects,effects)
                    case.recover();self.assertFalse(replacement.is_pending(case.storage))
                finally:case.doCleanups()

    def test_lost_create_requires_explicit_full_id_and_never_name_only_adoption(self):
        def lost(args):
            result=self.docker_call(args)
            if args[0]=='create':raise OSError('lost response after actual create')
            return result
        with self.assertRaises(client.ContainerClientError):self.run_replace(docker_call=lost)
        with self.assertRaisesRegex(client.ContainerClientError,'explicit exact'):self.recover()
        with self.assertRaises(client.ContainerClientError):self.recover(expected_new_container_id='a'*64)
        self.recover(expected_new_container_id=NEW_ID)
        self.assertEqual(self.effects,['rm','create','start'])

    def test_lost_rm_response_recovers_from_actual_absence(self):
        def lost(args):
            result=self.docker_call(args)
            if args[0]=='rm':raise OSError('lost rm response')
            return result
        with self.assertRaises(client.ContainerClientError):self.run_replace(docker_call=lost)
        self.recover();self.assertEqual(self.effects,['rm','create','start'])

    def test_running_old_refused_before_mutation(self):
        self.docker.inspection['State'].update(Running=True,Status='running')
        with self.assertRaises(client.ContainerClientError):self.run_replace()
        self.assertEqual(self.effects,[])

    def test_quiesce_hash_mismatch_and_legacy_receipt_refused(self):
        with self.assertRaises(client.ContainerClientError):self.run_replace(quiesce_receipt_sha256='a'*64)
        receipt=json.loads(self.receipt_path.read_text());receipt['schema']='fullmag.runner.coordinator-quiesce.v1'
        self.receipt_path.write_text(json.dumps(receipt))
        with self.assertRaises(client.ContainerClientError):self.run_replace(quiesce_receipt_sha256=replacement._sha(self.receipt_path.read_bytes()))
        self.assertEqual(self.effects,[])

    def test_token_change_even_with_public_cas_refused(self):
        secret=json.loads(self.baseline[0]);secret['token']='0'*64
        (self.storage/'index'/transition.NAMES[0]).write_text(json.dumps(secret))
        with self.assertRaises(client.ContainerClientError):self.run_replace()
        self.assertEqual(self.effects,[])

    def test_queue_change_after_quiesce_refused_without_restore(self):
        with closing(sqlite3.connect(self.storage/'index'/'runner-jobs.sqlite')) as db, db:
            db.execute("UPDATE jobs SET source_digest='external-change'")
        with self.assertRaises(client.ContainerClientError):self.run_replace()
        self.assertEqual(self.effects,[])

    def test_pause_change_refuses_before_rm_and_retains_pending(self):
        marker=ServicePaths.from_storage(self.storage).stop_request_path
        data=json.loads(marker.read_text());data['reason']='external';marker.write_text(json.dumps(data))
        with self.assertRaises(client.ContainerClientError):self.run_replace()
        self.assertEqual(self.effects,[]);self.assertTrue(replacement.is_pending(self.storage))

    def test_profile_delta_only_boris_preserves_token_and_fem(self):
        before=self.baseline; current=[json.loads(b) for b in before]
        for index in (0,1):current[index]['allowed_profiles'].append('boris-cpu-v1')
        entry={'image_digest':NEW_IMAGE,'cpus':1,'memory_bytes':1024}
        current[2]['profiles']['boris-cpu-v1']=entry
        blobs=[json.dumps(v).encode() for v in current]
        replacement._delta(self.storage,'alice',before,blobs,'enable-boris-cpu',transition.entry_sha(entry))
        replacement._delta(self.storage,'alice',blobs,before,'disable-boris-cpu',transition.entry_sha(entry))
        current[2]['profiles']['fem-cpu-release']={'tampered':True}
        with self.assertRaises(client.ContainerClientError):replacement._delta(self.storage,'alice',before,[json.dumps(v).encode() for v in current],'enable-boris-cpu',transition.entry_sha(entry))

    def test_recovery_config_drift_remains_pending_no_auto_overwrite(self):
        with patch.object(replacement,'_create',side_effect=OSError('pre-create')):
            with self.assertRaises(OSError):self.run_replace()
        catalog=self.storage/'index'/transition.NAMES[2];catalog.write_text(json.dumps(dict(schema='fullmag.runner-build-config.v1',operator='alice',profiles={})))
        with self.assertRaises(client.ContainerClientError):self.recover()
        self.assertTrue(replacement.is_pending(self.storage));self.assertEqual(self.effects,['rm'])

    def test_unconfirmed_health_retains_pending_pause_for_forward_recovery(self):
        self.health['worker_alive']=True
        with self.assertRaises(client.ContainerClientError):self.run_replace()
        self.assertTrue(replacement.is_pending(self.storage));self.health['worker_alive']=False
        self.recover();self.assertEqual(self.effects,['rm','create','start'])

    def test_corrupt_pending_blocks_host_mutations_but_not_status(self):
        path=replacement.pending_path(self.storage);path.parent.mkdir();path.write_text('{corrupt')
        with self.assertRaises(client.ContainerClientError):client.start(self.layout,'alice',docker_call=self.docker)
        with self.assertRaises(client.ContainerClientError):client.configure(self.layout,IMAGE,'alice')
        with self.assertRaises(client.ContainerClientError):client.request(self.layout,'alice','POST','/resume',{})
        self.assertEqual(client.status(self.layout,'alice',docker_call=self.docker)['state'],'exited')
        with self.assertRaises(ValueError):self.recover()
        self.assertTrue(replacement.is_pending(self.storage))

    def test_runtime_claim_guard_inside_existing_lock_never_claims(self):
        path=replacement.pending_path(self.storage);path.parent.mkdir();path.write_text('broken')
        queue=Mock();queue.active.return_value=[];queue.next_queued.return_value={'job_id':'queued'}
        with patch.object(build_executor,'JobQueue',return_value=queue),patch.object(build_executor,'file_lock',return_value=nullcontext()),patch.object(build_executor.shutil,'disk_usage',return_value=Mock(free=10*1024**3)):
            result=build_executor.execute_build({'storage_root':str(self.storage),'container_coordinator':True},owner='alice',call=lambda a:'[]')
        self.assertEqual(result['state'],'waiting_for_coordinator_replacement');queue.claim.assert_not_called()

    def test_concurrent_resume_during_pending_keeps_marker_and_refuses(self):
        path=replacement.pending_path(self.storage);path.parent.mkdir();path.write_text('broken')
        app=container_main.Application.__new__(container_main.Application)
        app.storage=self.storage;app.owner="alice";app.paths=ServicePaths.from_storage(self.storage);app._lifecycle_lock=threading.RLock();app._worker_thread=None;app._worker_state='paused'
        before=app.paths.stop_request_path.read_bytes();results=[]
        threads=[threading.Thread(target=lambda:results.append(app.resume())) for _ in range(8)]
        for thread in threads:thread.start()
        for thread in threads:thread.join(timeout=2)
        self.assertEqual(len(results),8);self.assertTrue(all(r['resumed'] is False and r['worker_started'] is False for r in results))
        self.assertEqual(before,app.paths.stop_request_path.read_bytes())

    def test_snapshot_bytes_bound_and_hash_tamper(self):
        receipt=json.loads(self.receipt_path.read_text());source=receipt['config_snapshot'];path=Path(source['path'])
        self.assertEqual([bytes.fromhex(b) for b in json.loads(path.read_text())['configs']],self.baseline)
        path.write_text('{}')
        with self.assertRaises(client.ContainerClientError):self.run_replace()
        with self.assertRaises(ValueError):replacement.snapshot(self.storage/'builds'/'too-large',self.storage,'alice',[b'x'*65537,b'',b''])

    def test_managed_candidate_requires_actual_source_readback(self):
        context=self.storage/'tmp'/'candidate';context.mkdir(parents=True)
        (context/'context.json').write_text('{}')
        context_sha=replacement._sha((context/'context.json').read_bytes())
        names=('coordinator_replacement.py','build_executor.py','container_main.py')
        files={"local_runner/"+name:replacement._sha(Path(replacement.__file__).with_name(name).read_bytes()) for name in names}
        manifest={'files':[{'path':name,'sha256':sha} for name,sha in files.items()]}
        proof=dict(proof_sha256=context_sha,files=files)
        folder=self.storage/'builds'/'image-proof';folder.mkdir()
        proof_path=folder/'source-readback.json';proof_path.write_text(json.dumps(proof))
        identity=dict(Id=NEW_IMAGE,RootFS={'Layers':['immutable-layer']},Entrypoint=producer.ENTRYPOINT)
        receipt=dict(schema='fullmag.runner.coordinator-image-build.v1',status='SUCCEEDED_IMAGE_ONLY',image_id=NEW_IMAGE,
            native_compilation_executed=False,operator_changed=False,context=str(context),context_sha256=context_sha,
            image_inspect=identity,source_readback_sha256=replacement._sha(proof_path.read_bytes()))
        path=folder/'terminal-receipt.json';path.write_text(json.dumps(receipt));digest=replacement._sha(path.read_bytes());calls=[]
        def docker(args):
            calls.append(args)
            if args[0]=='image':return json.dumps([{'Id':NEW_IMAGE,'RootFS':identity['RootFS'],'Config':{'Entrypoint':producer.ENTRYPOINT,'WorkingDir':'/opt/runner/scripts','Env':[]}}])
            return json.dumps(proof)
        with patch.object(producer,'validate_context',return_value=manifest):
            result=self.real_image_proof(self.storage,NEW_IMAGE,path,digest,docker)
            self.assertEqual(result['image_inspect'],identity)
            self.assertIn('--read-only',calls[-1]);self.assertIn('65532:65532',calls[-1]);self.assertIn('--network',calls[-1])
            def wrong(args):return docker(args) if args[0]=='image' else json.dumps({'files':{}})
            with self.assertRaisesRegex(client.ContainerClientError,'Actual image source'):
                self.real_image_proof(self.storage,NEW_IMAGE,path,digest,wrong)
            for override in ({'WorkingDir':'/tmp'}, {'Env':['PYTHONPATH=/tmp/foreign']}, {'Env':['PYTHONHOME=/tmp/foreign']}):
                def configured(args):
                    if args[0]!='image':return docker(args)
                    values=json.loads(docker(args));values[0]['Config'].update(override);return json.dumps(values)
                with self.assertRaisesRegex(client.ContainerClientError,'working directory/environment'):
                    self.real_image_proof(self.storage,NEW_IMAGE,path,digest,configured)
            identity['RootFS']={'Layers':['changed']}
            with self.assertRaises(client.ContainerClientError):self.real_image_proof(self.storage,NEW_IMAGE,path,digest,docker)

    def test_atomic_write_fsync_failure_retains_original_no_partial_publication(self):
        folder=self.storage/'builds'/'atomic';folder.mkdir();path=folder/'pending.json';path.write_bytes(b'original')
        with patch.object(replacement.os,'fsync',side_effect=OSError('synthetic fsync failure')):
            with self.assertRaises(OSError):replacement._write(path,{'phase':'REMOVE_REQUESTED'})
        self.assertEqual(path.read_bytes(),b'original');self.assertEqual([p.name for p in folder.iterdir()],['pending.json'])

    def test_pending_health_refuses_submission_without_queue_mutation(self):
        path=replacement.pending_path(self.storage);path.parent.mkdir();path.write_text('corrupt')
        app=container_main.Application.__new__(container_main.Application)
        app.storage=self.storage;app.owner="alice";app.paths=ServicePaths.from_storage(self.storage);app._lifecycle_lock=threading.RLock()
        app._worker_thread=None;app._worker_state='paused';app._worker_error=None;app._worker_started_at=None;app._worker_finished_at=None
        app.queue=Mock();app.queue.active.return_value=[];app.queue.next_queued.return_value=None
        app._service_record=lambda:{'state':'paused'}
        self.assertTrue(app._health_snapshot()['replacement_pending']);self.assertFalse(app._health_snapshot()['accepting_jobs'])
        with self.assertRaises(container_main.APIUnavailable):app._assert_submission_ready()
        app.queue.submit.assert_not_called()

    def test_read_proof_bounds_and_path_escape_refused(self):
        path=self.storage/'builds'/'large.json';path.write_bytes(b'x'*(replacement.MAX_BYTES+1))
        with self.assertRaises(client.ContainerClientError):replacement._read(path,self.storage)
        with self.assertRaises(Exception):replacement._read(self.storage.parent/'escape.json',self.storage)

    def test_boris_lock_race_checks_pending_after_both_locks(self):
        from contextlib import contextmanager
        locks=[]
        @contextmanager
        def raced(path,*args,**kwargs):
            locks.append(str(path))
            if len(locks)==2:
                pending=replacement.pending_path(self.storage);pending.parent.mkdir();pending.write_text('pending')
            yield
        with patch.object(transition,'file_lock',side_effect=raced):
            with self.assertRaises(client.ContainerClientError):transition._locks(self.layout)
        self.assertEqual(len(locks),2)
        self.assertEqual(replacement._blobs(self.storage,'alice'),self.baseline)

    def test_unreadable_pending_and_parent_fail_closed(self):
        raw=self.storage/'index'/'local-runner-exited-replacement'/'pending.json'
        original=Path.lstat
        def denied(path,*args,**kwargs):
            if path==raw: raise PermissionError('synthetic unreadable pending')
            return original(path,*args,**kwargs)
        with patch.object(Path,'lstat',denied):
            self.assertTrue(replacement.is_pending(self.storage))
        with patch.object(replacement,'validate_path',side_effect=PermissionError('unreadable parent')):
            self.assertTrue(replacement.is_pending(self.storage))

    def test_dangling_pending_link_is_inspected_as_raw_path(self):
        raw=self.storage/'index'/'local-runner-exited-replacement'/'pending.json'
        original=Path.lstat; inspected=[]
        def link(path,*args,**kwargs):
            if path==raw: inspected.append(path); return Mock()
            return original(path,*args,**kwargs)
        with patch.object(replacement,'validate_path',return_value=self.storage/'missing-target'),patch.object(Path,'lstat',link):
            self.assertTrue(replacement.is_pending(self.storage))
        self.assertEqual(inspected,[raw])
        from fullmag_storage import StorageError
        with patch.object(replacement,'validate_path',side_effect=StorageError('parent junction')):
            self.assertTrue(replacement.is_pending(self.storage))

    def test_lost_create_adoption_refuses_env_workdir_overrides(self):
        def lost(args):
            result=self.docker_call(args)
            if args[0]=='create':raise OSError('lost create result')
            return result
        with self.assertRaises(client.ContainerClientError):self.run_replace(docker_call=lost)
        for key,value in (('WorkingDir','/tmp/foreign'),('Env',['PYTHONPATH=/tmp/foreign'])):
            self.docker.inspection['Config'][key]=value
            with self.assertRaisesRegex(client.ContainerClientError,'command/user'):
                self.recover(expected_new_container_id=NEW_ID)
            del self.docker.inspection['Config'][key]
        self.assertTrue(replacement.is_pending(self.storage));self.assertEqual(self.effects,['rm','create'])


if __name__=='__main__':unittest.main()