import json
from contextlib import ExitStack, contextmanager, nullcontext
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock
import docker_isolated_session_recovery as recovery
from docker_build_control import BuildControlError, canonical


class SuccessorAdmissionTests(unittest.TestCase):
    def test_normalization_preserves_original_pointer_and_only_changes_missing_ids(self):
        for mutation in (None,'error','state','source','nonnull'):
            with self.subTest(mutation=mutation),tempfile.TemporaryDirectory() as folder:
                control,pins,current,_,documents,context,compose,state=self.failed_fixture(folder)
                normalized=canonical(current)
                del current['backend_container'];current['frontend_container']=None
                original=canonical(current);documents['development/current.json']=original
                if mutation in ('error','state'): current[mutation]='changed'
                elif mutation=='source': current['inputs']['source_root']='/other'
                elif mutation=='nonnull': current['backend_container']='9'*64
                if mutation: original=canonical(current);documents['development/current.json']=original
                with mock.patch('docker_control_namespace.assert_namespace_activation'):
                    if mutation:
                        with self.assertRaises(BuildControlError):
                            recovery._successor_admission_pins(control,pins,original,context=context,
                                compose=compose,state=state,validation_terminal_raw=normalized)
                    else:
                        result=recovery._successor_admission_pins(control,pins,original,context=context,
                            compose=compose,state=state,validation_terminal_raw=normalized)
                        self.assertEqual(result[control.namespace+'/development/current.json'],original)

    def failed_fixture(self, folder):
        root=Path(folder); state=root/'runtime/state'; state.mkdir(parents=True)
        user=root/'user-data/current'; user.mkdir(parents=True)
        control=mock.Mock(project='fullmag-master',namespace='namespaces/'+'a'*32,
                          namespace_registry_sha256='b'*64)
        identity={'source_root':'/repo','project_id':'project','worktree_id':'master',
                  'checkout_kind':'main'}
        compose={'name':control.project,'services':{'backend':{'volumes':[
            {'type':'bind','source':str(user),'target':'/user-data'}]},'frontend':{}}}
        pins={'development_attempt':'c'*32,'compose_config_sha256':recovery.digest(canonical(compose)),
              'backend_container_id':'e'*64,'frontend_container_id':'f'*64,
              'old_image_id':'sha256:'+'1'*64}
        current={'schema':'fullmag.docker-build-operation.v1','phase':'development',
            'state':'failed-confirmed','attempt':pins['development_attempt'],
            'compose_project':control.project,'config_sha256':pins['compose_config_sha256'],
            'backend_container':pins['backend_container_id'],'frontend_container':pins['frontend_container_id'],
            'control_namespace':control.namespace,'namespace_registry_sha256':control.namespace_registry_sha256,
            'state_root':str(state),'image_id':pins['old_image_id'],
            'inputs':dict(identity,source_project_id=identity['project_id'],
                source_worktree_id=identity['worktree_id'],source_checkout_kind=identity['checkout_kind'],
                image_id=pins['old_image_id'])}
        verified=dict(current,state='succeeded',attempt='2'*32,backend_container='3'*64,
                      frontend_container='4'*64,image_id='sha256:'+'5'*64,
                      inputs=dict(current['inputs'],image_id='sha256:'+'5'*64))
        documents={'development/current.json':canonical(current),
                   'development/verified.json':canonical(verified),
                   'isolated-snapshot/native-validation.json':b'validated-native-proof'}
        for receipt in (current,verified):
            terminal_path,compose_path=recovery.retained._terminal_paths(receipt['attempt'])
            documents[terminal_path]=canonical(receipt);documents[compose_path]=canonical(compose)
        control.read_bytes.side_effect=lambda path,**kwargs: documents[path]
        context={'identity':identity,'layout':{'runtime_root':str(root/'runtime'),'storage_root':str(root)}}
        return control,pins,current,verified,documents,context,compose,state

    def test_failed_current_pins_its_successful_verified_predecessor(self):
        with tempfile.TemporaryDirectory() as folder:
            control,pins,current,verified,documents,context,compose,state=self.failed_fixture(folder)
            with mock.patch('docker_control_namespace.assert_namespace_activation'):
                result=recovery._successor_admission_pins(control,pins,canonical(current),
                    context=context,compose=compose,state=state)
            expected={control.namespace+'/'+path:raw for path,raw in documents.items()}
            terminal_path,compose_path=recovery.retained._terminal_paths(current['attempt'])
            result.update({control.namespace+'/'+terminal_path:canonical(current),
                           control.namespace+'/'+compose_path:canonical(compose)})
            self.assertEqual(result,expected)
            with self.assertRaises(ValueError):
                recovery.retained._validate_terminal_and_compose(control,pins,context['identity'],
                    canonical(current),canonical(compose),context['layout'])

    def test_failed_current_rejects_unrelated_or_changed_predecessor(self):
        mutations=('current','verified','namespace','registry','source','state_root','user_data',
                   'terminal','compose','attempt','same_attempt','config','backend','frontend','image','verified_state')
        for field in mutations:
            with self.subTest(field=field),tempfile.TemporaryDirectory() as folder:
                control,pins,current,verified,documents,context,compose,state=self.failed_fixture(folder)
                terminal_path,compose_path=recovery.retained._terminal_paths(verified['attempt'])
                if field=='current': documents['development/current.json']=canonical(dict(current,state='starting'))
                elif field=='verified': documents['development/verified.json']=b'[]'
                elif field=='namespace': verified['control_namespace']='namespaces/'+'9'*32
                elif field=='registry': verified['namespace_registry_sha256']='9'*64
                elif field=='source': verified['inputs']['source_root']='/different'
                elif field=='state_root':
                    other=state.parent/'other';other.mkdir();verified['state_root']=str(other)
                elif field=='user_data':
                    other=Path(folder)/'user-data/other';other.mkdir()
                    old=json.loads(canonical(compose));old['services']['backend']['volumes'][0]['source']=str(other)
                    documents[compose_path]=canonical(old);verified['config_sha256']=recovery.digest(canonical(old))
                elif field=='terminal': documents[terminal_path]=canonical(dict(verified,state='starting'))
                elif field=='compose': documents[compose_path]=b'{}'
                elif field=='attempt': verified['attempt']='../escape'
                elif field=='same_attempt': verified['attempt']=current['attempt']
                elif field=='config': verified['config_sha256']=None
                elif field=='backend': verified['backend_container']=False
                elif field=='frontend': verified['frontend_container']='wrong'
                elif field=='image': verified['inputs']['image_id']=None
                elif field=='verified_state': verified['state']='failed-confirmed'
                if field not in ('verified','terminal'):
                    documents['development/verified.json']=canonical(verified)
                if field not in ('terminal','attempt'):
                    documents[terminal_path]=canonical(verified)
                with mock.patch('docker_control_namespace.assert_namespace_activation'):
                    with self.assertRaises((BuildControlError,ValueError)):
                        recovery._successor_admission_pins(control,pins,canonical(current),
                            context=context,compose=compose,state=state)

    def test_failed_current_requires_exact_terminal_metadata(self):
        for field in ('state','source','project','config','backend','frontend','image','state_root'):
            with self.subTest(field=field),tempfile.TemporaryDirectory() as folder:
                control,pins,current,_,_,context,compose,state=self.failed_fixture(folder)
                if field=='state': current['state']=['failed-confirmed']
                elif field=='source': current['inputs']['source_root']='/other'
                elif field=='project': current['compose_project']='other'
                elif field=='config': current['config_sha256']='9'*64
                elif field=='backend': current['backend_container']='9'*64
                elif field=='frontend': current['frontend_container']='9'*64
                elif field=='image': current['inputs']['image_id']='sha256:'+'9'*64
                elif field=='state_root': current['state_root']='/outside'
                with self.assertRaises((ValueError,recovery.storage.StorageError)):
                    recovery.retained._validate_terminal_and_compose(control,pins,context['identity'],
                        canonical(current),canonical(compose),context['layout'],
                        allowed_terminal_states=('succeeded','failed-confirmed'))

    def fixture(self):
        control=mock.Mock(namespace='namespaces/'+'a'*32,
                          namespace_registry_sha256='b'*64)
        pins={'development_attempt':'c'*32,'compose_config_sha256':'d'*64,
              'backend_container_id':'e'*64,'frontend_container_id':'f'*64}
        terminal=canonical({'schema':'fullmag.docker-build-operation.v1',
            'phase':'development','state':'succeeded','attempt':pins['development_attempt'],
            'config_sha256':pins['compose_config_sha256'],
            'backend_container':pins['backend_container_id'],
            'frontend_container':pins['frontend_container_id'],
            'control_namespace':control.namespace,
            'namespace_registry_sha256':control.namespace_registry_sha256})
        documents={'development/current.json':terminal,'development/verified.json':terminal,
                   'isolated-snapshot/native-validation.json':b'validated-native-proof'}
        control.read_bytes.side_effect=lambda path: documents[path]
        return control,pins,terminal,documents

    def test_admitted_predecessor_pins_all_admission_evidence(self):
        control,pins,terminal,documents=self.fixture()
        with mock.patch('docker_control_namespace.assert_namespace_activation') as validate:
            result=recovery._successor_admission_pins(control,pins,terminal)
        validate.assert_called_once_with(control)
        self.assertEqual(result,{control.namespace+'/'+path:raw for path,raw in documents.items()})

    def test_unadmitted_or_changed_current_receipt_is_refused(self):
        for path in ('development/current.json','development/verified.json'):
            with self.subTest(path=path):
                control,pins,terminal,documents=self.fixture()
                documents[path]=canonical({'state':'starting'})
                with mock.patch('docker_control_namespace.assert_namespace_activation'):
                    with self.assertRaises(BuildControlError):
                        recovery._successor_admission_pins(control,pins,terminal)
        control,pins,terminal,_=self.fixture()
        with mock.patch('docker_control_namespace.assert_namespace_activation',
                        side_effect=BuildControlError('native admission absent')):
            with self.assertRaises(BuildControlError):
                recovery._successor_admission_pins(control,pins,terminal)

    def test_wrong_attempt_config_containers_or_namespace_are_refused(self):
        for key in ('attempt','config_sha256','backend_container','frontend_container',
                    'control_namespace','namespace_registry_sha256','state','phase'):
            with self.subTest(key=key):
                control,pins,terminal,documents=self.fixture()
                value=json.loads(terminal);value[key]='wrong'
                terminal=canonical(value)
                documents['development/current.json']=documents['development/verified.json']=terminal
                with mock.patch('docker_control_namespace.assert_namespace_activation'):
                    with self.assertRaises(BuildControlError):
                        recovery._successor_admission_pins(control,pins,terminal)

    def test_native_receipt_cannot_change_during_validation(self):
        control,pins,terminal,documents=self.fixture()
        def changed(_control):
            documents['isolated-snapshot/native-validation.json']=b'changed'
        with mock.patch('docker_control_namespace.assert_namespace_activation',side_effect=changed):
            with self.assertRaises(BuildControlError):
                recovery._successor_admission_pins(control,pins,terminal)

    def test_successor_is_explicit_and_existing_retry_keeps_original_start(self):
        control=mock.Mock(project='fullmag-master',namespace='namespaces/'+'a'*32,
            namespace_registry={'retirement':{'schema':recovery.SNAPSHOT_SCHEMA,'recovery_id':'a'*32}})
        original_start={'restore_run_id':'original-held-run'}
        control.read.return_value=original_start.copy()
        args=SimpleNamespace(recovery_id='b'*32,successor_snapshot=False,apply=False,
            operator_pins=Path('pins.json'),restore_run_id='new-held-run')
        with mock.patch.object(recovery.retained,'_read_operator_file',return_value=({},b'{}',Path('pins.json'))), \
             mock.patch.object(recovery.retained,'_request_context',return_value={'control':control}):
            with self.assertRaises(BuildControlError):
                recovery.recover(args)
            args.recovery_id='a'*32;args.restore_run_id='original-held-run'
            self.assertEqual(recovery.recover(args)['state'],'snapshot-awaiting-gated-start')
            args.restore_run_id='new-held-run'
            with self.assertRaises(BuildControlError):
                recovery.recover(args)
        self.assertEqual(control.read.return_value,original_start)
        control.write.assert_not_called()
        control.write_bytes.assert_not_called()


class StoppedProofIntegrationTests(unittest.TestCase):
    @contextmanager
    def environment(self, folder, *, apply=False):
        fixture=SuccessorAdmissionTests().failed_fixture(folder)
        control,pins,current,verified,documents,context,compose,state=fixture
        normalized=canonical(current);del current['backend_container'];del current['frontend_container']
        original=canonical(current)
        terminal_path,compose_path=recovery.retained._terminal_paths(pins['development_attempt'])
        documents['development/current.json']=documents[terminal_path]=original
        control.volume='control';control.namespace_registry={'retirement':{
            'schema':recovery.SNAPSHOT_SCHEMA,'recovery_id':'a'*32,'old_request_id':'old'}}
        context['control']=control;context['selected']=Path('/repo');pins['source_root']='/repo';pins['request_id']='request'
        store=state/'runs/docker-all/session-store';store.mkdir(parents=True)
        (Path(context['layout']['runtime_root'])/'docker-volume-dev').mkdir()
        owner=b'owner';certificate=canonical({'host_inode':state.stat().st_ino,'host_device':17,'engine_id':'engine'})
        pins.update(expected_certificate_sha256=recovery.digest(certificate),expected_owner_sha256=recovery.digest(owner),
                    expected_inode=state.stat().st_ino,old_host_device=17,new_host_device=state.stat().st_dev,filesystem_uuid='uuid')
        args=SimpleNamespace(recovery_id='b'*32,successor_snapshot=True,apply=apply,
            operator_pins=Path('pins.json'),restore_run_id='held',retained_terminal_runs=Path('/terminal-pins'),
            retained_held_manual_runs=Path('/held-pins'),stopped_predecessor_proof='verification/proof.json',
            stopped_predecessor_proof_sha256=recovery.digest(b'proof'))
        stopped_pins={control.namespace+'/verification/proof.json':b'proof',
                      control.namespace+'/development/current.json':original,
                      control.namespace+'/'+terminal_path:original}
        runtime={name:b'{}' for name in recovery.retained._RUNTIME_RECORDS}
        evidence={control.namespace+'/'+path:raw for path,raw in documents.items()}
        evidence.update(stopped_pins)
        evidence.update({control.namespace+'/'+path:runtime[name] for name,path in recovery.retained._RUNTIME_RECORDS.items()})
        def read_owned(path,*_):
            if path.name==recovery.host.CERTIFICATE_NAME:return certificate
            if path.name==recovery.host.OWNER_NAME:return owner
            if str(path)=='/terminal-pins':return b'[]'
            if str(path)=='/held-pins':return canonical([{'run_id':'held'}])
            return b'{}'
        pair={role:{'Id':pins[role+'_container_id'],'Image':pins['old_image_id']} for role in ('backend','frontend')}
        services={'backend':{'proof':'backend'},'frontend':{'proof':'frontend'}}
        with ExitStack() as stack:
            def patch(target,name,**kwargs):return stack.enter_context(mock.patch.object(target,name,**kwargs))
            patch(recovery.retained,'_read_operator_file',return_value=(pins,b'{}',Path('pins.json')))
            patch(recovery.retained,'_request_context',return_value=context)
            loader=patch(recovery,'load_stopped_predecessor',return_value=(normalized,stopped_pins,services))
            observe=patch(recovery,'_stopped_pair',return_value=pair)
            validate=patch(recovery,'validate_stopped_incarnations')
            patch(recovery.retained,'_read_runtime_records',return_value=runtime)
            patch(recovery.host,'read_owned_regular',side_effect=read_owned)
            patch(recovery.retained,'_engine_id',return_value='engine')
            patch(recovery.retained,'_filesystem_uuid',return_value='uuid')
            patch(recovery,'_raw',side_effect=lambda _,path:b'registry' if path==recovery.REGISTRY_PATH else evidence[path])
            patch(recovery.recovery,'_ledger_and_store_snapshot',return_value={'full-native-store-proof':True})
            patch(recovery.retained,'_owner_lock',return_value=nullcontext())
            fd=os.open(store,os.O_RDONLY);stack.callback(os.close,fd)
            patch(recovery,'hold_source_writer',return_value=nullcontext(fd))
            fence=mock.Mock();patch(recovery,'hold_managed_workspace_database',return_value=nullcontext(fence))
            patch(recovery,'snapshot_control_workspace',return_value={'source':{},'copied':{}})
            patch(recovery,'snapshot_tree',return_value={'total_bytes':0})
            patch(recovery.shutil,'disk_usage',return_value=SimpleNamespace(free=10**12))
            patch(recovery.storage,'git',return_value='c'*40)
            patch(Path,'read_bytes',return_value=b'controller')
            patch(recovery,'copy_verified_tree');patch(recovery,'_admit_copy')
            patch(recovery.host,'admit_runtime_uid');patch(recovery,'_once')
            patch(recovery,'validate_copied_workspace',return_value={})
            patch(recovery,'validate_snapshot_namespace_receipt')
            patch(recovery,'docker_capture',return_value=SimpleNamespace(stdout=b'',stderr=b''))
            commit=patch(recovery,'bounded_capture',return_value=SimpleNamespace(returncode=0,stdout=b'{}',stderr=b''))
            patch(recovery,'_remove_stopped')
            control.operation.return_value=nullcontext({'receipt':{}})
            stack.enter_context(mock.patch('docker_control_namespace.assert_namespace_activation'))
            yield args,control,pins,original,stopped_pins,loader,observe,validate,commit

    def test_failed_missing_ids_proof_wires_all_observations_and_original_cas(self):
        with tempfile.TemporaryDirectory() as folder,self.environment(folder,apply=True) as env:
            args,control,pins,original,proof_pins,loader,observe,validate,commit=env
            result=recovery.recover(args)
            self.assertEqual(result['state'],'snapshot-awaiting-gated-start')
            loader.assert_called_once_with(control,pins,original,args.stopped_predecessor_proof,args.stopped_predecessor_proof_sha256)
            self.assertEqual(observe.call_count,4);self.assertEqual(validate.call_count,4)
            self.assertEqual([c.args[0] for c in validate.call_args_list],[observe.return_value]*4)
            payload=json.loads(commit.call_args.kwargs['data'])
            for path,raw in proof_pins.items():self.assertEqual(payload['pins'][path],recovery.digest(raw))
            operation_inputs=control.operation.call_args.args[1]
            self.assertEqual(operation_inputs['stopped_predecessor_proof'],{
                'path':args.stopped_predecessor_proof,'sha256':args.stopped_predecessor_proof_sha256})
            self.assertIn('docker_isolated_stopped_predecessor.py',operation_inputs['executor']['script_sha256'])

    def test_proof_flags_require_explicit_failed_successor_and_both_values(self):
        for mutation in ('missing_proof','missing_sha','no_proof','not_successor','not_failed'):
            with self.subTest(mutation=mutation),tempfile.TemporaryDirectory() as folder,self.environment(folder) as env:
                args,control,pins,original,proof_pins,loader,*_=env
                if mutation=='missing_proof':args.stopped_predecessor_proof=None
                elif mutation=='missing_sha':args.stopped_predecessor_proof_sha256=None
                elif mutation=='no_proof':args.stopped_predecessor_proof=args.stopped_predecessor_proof_sha256=None
                elif mutation=='not_successor':args.successor_snapshot=False
                else:
                    changed=canonical(dict(json.loads(original),state='succeeded'))
                    control.read_bytes.side_effect=lambda path,**kwargs:changed
                with self.assertRaises((BuildControlError,ValueError)):recovery.recover(args)
                loader.assert_not_called()

    def test_conflicting_raw_control_pins_are_rejected(self):
        target={'same':b'original'}
        recovery._merge_control_pins(target,{'same':b'original','other':b'proof'})
        with self.assertRaises(BuildControlError):recovery._merge_control_pins(target,{'same':b'normalized'})
        self.assertEqual(target['same'],b'original')


class IsolatedCommitTests(unittest.TestCase):
    def fixture(self, root):
        (root/'namespaces/new').mkdir(parents=True)
        (root/'namespaces/current.json').write_bytes(b'old-registry')
        (root/'operation.lock').write_bytes(b'')
        (root/'original-owner.json').write_bytes(b'original-owner')
        return {'previous_registry_sha256':recovery.digest(b'old-registry'),
                'pins':{'original-owner.json':recovery.digest(b'original-owner')},
                'namespace':'namespaces/new','recovery_id':'a'*32,'registry':{'new':'registry'}}

    def run_commit(self, root, payload):
        script=recovery.COMMIT.replace("pathlib.Path('/control')",'pathlib.Path('+repr(str(root))+')')
        return subprocess.run([sys.executable,'-I','-B','-c',script],input=canonical(payload),capture_output=True)

    def test_commit_preserves_owner_and_links_same_operation_lock(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);payload=self.fixture(root)
            result=self.run_commit(root,payload)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual((root/'original-owner.json').read_bytes(),b'original-owner')
            self.assertEqual(json.loads((root/'namespaces/current.json').read_bytes()),payload['registry'])
            self.assertEqual((root/'operation.lock').stat().st_ino,(root/'namespaces/new/operation.lock').stat().st_ino)

    def test_registry_cas_or_source_pin_drift_never_publishes(self):
        for field in ('registry','owner'):
            with self.subTest(field=field), tempfile.TemporaryDirectory() as folder:
                root=Path(folder);payload=self.fixture(root)
                if field=='registry':(root/'namespaces/current.json').write_bytes(b'new-external-value')
                else:(root/'original-owner.json').write_bytes(b'changed')
                before=(root/'namespaces/current.json').read_bytes()
                self.assertNotEqual(self.run_commit(root,payload).returncode,0)
                self.assertEqual((root/'namespaces/current.json').read_bytes(),before)

    def test_owner_control_pins_validated_config_image_without_mutating_control(self):
        control=mock.Mock(image='nvidia/cuda:base@sha256:'+'a'*64,
                          namespace='namespaces/'+'b'*32)
        backend={'Image':'sha256:'+'c'*64}
        owner=recovery._owner_control(control,backend)
        self.assertIsNot(owner,control)
        self.assertEqual(owner.image,backend['Image'])
        self.assertEqual(owner.namespace,control.namespace)
        self.assertEqual(control.image,'nvidia/cuda:base@sha256:'+'a'*64)
        for invalid in ({}, {'Image':'nvidia/cuda:latest'}):
            with self.assertRaises(BuildControlError):
                recovery._owner_control(control,invalid)

    def test_removal_refuses_live_container_without_stop(self):
        record={'old_container_ids':{'backend':'a'*64},'old_image_id':'sha256:'+'b'*64,'compose_project':'fullmag-master'}
        row={'Id':'a'*64,'Image':record['old_image_id'],'State':{'Status':'running','Running':True}}
        responses=[mock.Mock(stdout=('a'*64+'\n').encode()),mock.Mock(stdout=json.dumps([row]).encode())]
        with mock.patch.object(recovery,'docker_capture',side_effect=responses) as capture:
            with self.assertRaises(ValueError):recovery._remove_stopped(record)
        self.assertFalse(any(c.args[0] in ('stop','rm','restart') for c in capture.call_args_list))

class SnapshotActivationTests(unittest.TestCase):
    def fixture(self):
        import hashlib
        import docker_control_namespace as namespace
        request={'retained_terminal_runs':[{'run_id':'terminal'}],
                 'retained_held_manual_runs':[{'run_id':'held'}]}
        manifest=canonical({'retired_request_ids':['old-preview','old-other']})
        request_raw=canonical(request)
        record={'schema':recovery.SNAPSHOT_SCHEMA,'old_request_id':'old-preview',
                'request_sha256':recovery.digest(request_raw),'original_config_sha256':'c'*64,
                'source_manifest_sha256':recovery.digest(manifest),
                'terminal_run_count':1,'held_manual_run_count':1}
        validation={'schema_version':'runtime_service_retained_snapshot_validation.v1',
                    'state':'validated-read-only','request_sha256':record['request_sha256'],
                    'config_sha256':'c'*64,'source_manifest_sha256':record['source_manifest_sha256'],
                    'run_ids':['held','terminal'],'terminal_count':1,'held_count':1,
                    'owner_changed':False,'compute_started':False}
        control=mock.Mock(namespace='namespaces/'+'a'*32,
                          namespace_registry={'retirement':record})
        control.read.return_value=validation
        control.read_bytes.side_effect=lambda path: manifest if 'manifest' in path else request_raw
        return namespace,control,validation

    def test_activation_requires_native_admission_and_typed_receipt(self):
        for replacement in (None,{'owner_changed':0},{'unknown':False}):
            with self.subTest(replacement=replacement):
                namespace,control,validation=self.fixture()
                control.read.return_value=None if replacement is None else {**validation,**replacement}
                with self.assertRaises(BuildControlError):
                    namespace.assert_namespace_activation(control,'new-request')

    def test_activation_rejects_all_retired_requests_even_after_admission(self):
        for request in ('old-preview','old-other'):
            namespace,control,_=self.fixture()
            with self.assertRaises(BuildControlError):
                namespace.assert_namespace_activation(control,request)

    def test_activation_allows_new_request_only_after_exact_native_evidence(self):
        namespace,control,_=self.fixture()
        namespace.assert_namespace_activation(control,'new-request')

    def test_activation_rejects_manifest_drift(self):
        namespace,control,_=self.fixture()
        control.read_bytes.side_effect=None
        control.read_bytes.return_value=b'{}'
        with self.assertRaises(BuildControlError):
            namespace.assert_namespace_activation(control,'new-request')

class SnapshotPlaceholderTests(unittest.TestCase):
    def fixture(self, root):
        import docker_volume_dev as dev
        path=root/'linux-native-host.json';path.write_bytes(b'')
        snapshot={'source_root':'/source/master','destination_state_root':str(root)}
        previous={'state':'failed-confirmed','control_namespace':'namespaces/test',
                  'namespace_registry_sha256':'a'*64,'inputs':{'source_root':'/source/master'},
                  'error':'runtime-control control namespace is nonempty without its owner marker'}
        control=mock.Mock(namespace='namespaces/test',namespace_registry_sha256='a'*64)
        control.read.return_value=previous;control.read_bytes.return_value=None
        return dev,path,snapshot,previous,control

    def test_known_cache_failure_retains_empty_placeholder_without_rewriting_it(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);dev,path,snapshot,previous,control=self.fixture(root)
            before=path.stat()
            dev._snapshot_certificate_placeholder(control,root,path,snapshot)
            after=path.stat()
            self.assertEqual((before.st_ino,before.st_mtime_ns,before.st_ctime_ns),
                             (after.st_ino,after.st_mtime_ns,after.st_ctime_ns))
            self.assertEqual(path.read_bytes(),b'')

    def test_foreign_or_already_admitted_placeholder_is_never_adopted(self):
        for mutation in ('nonempty','owner','native','unknown','different_namespace'):
            with self.subTest(mutation=mutation),tempfile.TemporaryDirectory() as folder:
                root=Path(folder);dev,path,snapshot,previous,control=self.fixture(root)
                if mutation=='nonempty':path.write_bytes(b'{}')
                elif mutation=='owner':(root/recovery.host.OWNER_NAME).write_bytes(b'owner')
                elif mutation=='native':control.read_bytes.return_value=b'{}'
                elif mutation=='unknown':previous['state']='unknown'
                else:previous['control_namespace']='foreign'
                before=path.read_bytes()
                with self.assertRaises((RuntimeError,OSError,ValueError)):
                    dev._snapshot_certificate_placeholder(control,root,path,snapshot)
                self.assertEqual(path.read_bytes(),before)

if __name__=='__main__':unittest.main()
