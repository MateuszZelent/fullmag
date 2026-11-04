import copy
import tempfile
import unittest
from pathlib import Path
import docker_backend_volume_cache as cache
from test_docker_backend_volume_cache import _profile, _container, _maintenance_receipt, TOOLCHAIN, IMAGE

class GroupBackendCacheTests(unittest.TestCase):
    def prepare(self, args, **kw):
        old, layout, source, repo, runroot=args
        return cache.prepare(layout,repo,IMAGE,runroot,source_root=source,toolchain_image=kw.pop('toolchain_image',TOOLCHAIN),control_volume_name=__import__('bootstrap_docker_toolchain').control_volume_name(layout['compose_project']),shared_packages=True,group_volume=True,**kw)

    def test_toolchain_and_profile_change_reuse_volume_and_package_namespace(self):
        with tempfile.TemporaryDirectory() as tmp:
            args=_profile(tmp,shared_packages=True)
            a=self.prepare(args)
            b=self.prepare(args,toolchain_image='sha256:'+'d'*64,cargo_profile='release')
            self.assertEqual(a['volume_names']['build'],a['volume_names']['control'])
            self.assertEqual(a['volume_names'],b['volume_names'])
            self.assertEqual(a['unit_key'],b['unit_key'])
            self.assertNotEqual(a['cache_key'],b['cache_key'])
            self.assertEqual(a['shared_package_subpath'],b['shared_package_subpath'])
            self.assertEqual(a['environment']['FULLMAG_PRIVATE_GROUP_STORAGE'],'group-volume-v1')
            mount=next(m for m in a['mounts'] if m['target']=='/build')
            self.assertEqual(mount['volume']['subpath'],'private/backend')

    def test_backend_plan_does_not_require_host_storage(self):
        with tempfile.TemporaryDirectory() as tmp:
            old,layout,source,repo,_=_profile(tmp,shared_packages=True)
            layout.pop('storage_root')
            result=cache.prepare(layout,repo,IMAGE,None,source_root=source,toolchain_image=TOOLCHAIN,
                control_volume_name=__import__('bootstrap_docker_toolchain').control_volume_name(layout['compose_project']),
                shared_packages=True,group_volume=True)
            self.assertEqual(result['receipt_storage'],'docker-named-volume')
            self.assertIsNone(result['host_receipt_path'])

    def test_interrupted_render_keeps_layout_and_legacy_resume_stays_legacy(self):
        import docker_volume_dev as dev
        class Control:
            def __init__(self):self.records={}
            def write(self,path,data):self.records[path]=copy.deepcopy(data)
        control=Control();operation={'receipt':{},'root':'development/attempts/exact'}
        self.assertTrue(dev._pin_private_group_storage(control,operation,new_render=True))
        persisted=control.records[operation['root']+'/receipt.json']
        self.assertTrue(dev._pin_private_group_storage(control,{'receipt':persisted,'root':operation['root']},new_render=False))
        self.assertFalse(dev._pin_private_group_storage(control,{'receipt':{},'root':'legacy'},new_render=False))
        refreshed={'receipt':{},'root':'frontend-refresh'}
        self.assertTrue(dev._pin_private_group_storage(control,refreshed,new_render=False,previous=persisted))
        self.assertEqual(control.records['frontend-refresh/receipt.json']['private_group_storage'],'group-volume-v1')
        control.read=lambda *a,**kw:{'schema':'fullmag.docker-group-storage-owner.v1'}
        with self.assertRaises(dev.BuildControlError):
            dev._uses_private_group_storage(control,{'receipt':{}})
        with self.assertRaises(dev.BuildControlError):
            dev._pin_private_group_storage(control,{'receipt':{'private_group_storage':'unknown'},'root':'bad'},new_render=False)

    def test_no_new_private_volume_and_canonical_control_labels(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=self.prepare(_profile(tmp,shared_packages=True))
            docs={role:{'Name':n,'Driver':'local','Options':{},'Scope':'local','Mountpoint':f'/var/lib/docker/volumes/{n}/_data','Labels':cache.volume_labels(p,role)} for role,n in p['volume_names'].items()}
            self.assertEqual(docs['build']['Labels'],docs['control']['Labels'])
            calls=[]
            def docker(*args):
                calls.append(args)
                if args[:2]!=('volume','inspect'):raise AssertionError('No private volume creation permitted')
                return [next(d for d in docs.values() if d['Name']==args[2])]
            observed=cache.ensure_volume_pair(docker,p)
            self.assertEqual(observed['build']['Name'],observed['control']['Name'])
            self.assertTrue(all(c[:2]==('volume','inspect') for c in calls))

    def test_existing_bootstrap_volume_needs_only_canonical_shared_labels(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=self.prepare(_profile(tmp,shared_packages=True))
            role=cache.BUILD_VOLUME_ROLE
            name=p['volume_names'][role]
            labels=cache._control_volume_labels(p)
            doc={'Name':name,'Driver':'local','Options':{},'Scope':'local',
                 'Mountpoint':f'/var/lib/docker/volumes/{name}/_data','Labels':labels}
            self.assertEqual(cache._validate_volume_document(doc,p,role)['Name'],name)
            doc['Labels']={**labels,'org.fullmag.source.worktree-id':'another-worktree'}
            with self.assertRaises(cache.BackendVolumeCacheError):
                cache._validate_volume_document(doc,p,role)

    def owner(self,args,namespace):
        _,layout,source,_,_=args
        layout['env']={'FULLMAG_PROJECT_ID':'resolver-source-project'}
        base=self.prepare(args,control_namespace=namespace)
        return {'schema':'fullmag.docker-group-storage-owner.v1',
                'compose_project':base['control_project'],'control_volume':base['volume_names']['control'],
                'control_namespace':namespace,'source_project_id':'resolver-source-project',
                'source_worktree_id':layout['worktree_id'],'source_root':str(source.resolve()),
                'layout':{'version':1,'private_root':'private','roles':{
                    'backend':'private/backend','frontend':'private/frontend','ledger':'private/ledger'}}}

    def historical_document(self,profile):
        name=profile['volume_names']['control']
        return {'Name':name,'Driver':'local','Options':{},'Scope':'local',
                'Mountpoint':f'/var/lib/docker/volumes/{name}/_data',
                'Labels':{**cache._control_volume_labels(profile),
                    'org.fullmag.build-control.schema':'fullmag.build-control.v1',
                    'org.fullmag.compose.project':profile['control_project'],
                    'org.fullmag.source.worktree-id':'fullmag-historical-root',
                    'org.fullmag.build.role':'control'}}

    def test_namespace_owner_allows_only_historical_root_worktree_label(self):
        with tempfile.TemporaryDirectory() as tmp:
            args=_profile(tmp,shared_packages=True);namespace='namespaces/'+'1'*32
            owner=self.owner(args,namespace)
            baseline=self.prepare(args,control_namespace=namespace)
            profile=self.prepare(args,control_namespace=namespace,prepared_group_owner=owner)
            for key in ('project_id','worktree_id','cache_key','unit_key','owner_id','volume_names','mounts'):
                self.assertEqual(profile[key],baseline[key])
            self.assertNotEqual(profile['project_id'],owner['source_project_id'])
            doc=self.historical_document(profile)
            for role in (cache.BUILD_VOLUME_ROLE,cache.CONTROL_VOLUME_ROLE):
                self.assertEqual(cache._validate_volume_document(doc,profile,role)['Name'],doc['Name'])
                with self.assertRaises(cache.BackendVolumeCacheError):cache._validate_volume_document(doc,baseline,role)

    def test_foreign_or_incomplete_prepared_owner_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            args=_profile(tmp,shared_packages=True);namespace='namespaces/'+'1'*32
            owner=self.owner(args,namespace)
            changes={'schema':'foreign','compose_project':'other','control_volume':'other',
                     'control_namespace':'namespaces/'+'2'*32,'source_project_id':args[1]['project_id'],
                     'source_worktree_id':'other','source_root':str(args[3])}
            for key,value in changes.items():
                with self.subTest(field=key),self.assertRaises(cache.BackendVolumeCacheError):
                    self.prepare(args,control_namespace=namespace,prepared_group_owner={**owner,key:value})
            with self.assertRaises(cache.BackendVolumeCacheError):
                self.prepare(args,prepared_group_owner={**owner,'control_namespace':''})
            with self.assertRaises(cache.BackendVolumeCacheError):
                self.prepare(args,control_namespace=namespace,prepared_group_owner=True)

    def test_owner_proof_does_not_allow_other_foreign_root_labels(self):
        with tempfile.TemporaryDirectory() as tmp:
            args=_profile(tmp,shared_packages=True);namespace='namespaces/'+'1'*32
            owner=self.owner(args,namespace)
            profile=self.prepare(args,control_namespace=namespace,prepared_group_owner=owner)
            doc=self.historical_document(profile)
            for key in ('org.fullmag.build-control.schema','org.fullmag.compose.project','org.fullmag.build.role',
                        'com.fullmag.compose.project','com.fullmag.toolchain.control.schema',
                        'com.fullmag.toolchain.control.project','com.fullmag.toolchain.control.mount'):
                changed=copy.deepcopy(doc);changed['Labels'][key]='foreign'
                with self.subTest(label=key),self.assertRaises(cache.BackendVolumeCacheError):
                    cache._validate_volume_document(changed,profile,cache.BUILD_VOLUME_ROLE)

    def test_owner_proof_survives_ready_serialization_and_is_revalidated(self):
        import json
        from test_docker_backend_volume_cache import DockerVolumeFixture
        with tempfile.TemporaryDirectory() as tmp:
            args=_profile(tmp,shared_packages=True);namespace='namespaces/'+'1'*32
            owner=self.owner(args,namespace)
            profile=self.prepare(args,control_namespace=namespace,prepared_group_owner=owner)
            docker=DockerVolumeFixture(profile,roles=cache.VOLUME_ROLES)
            for role in (cache.BUILD_VOLUME_ROLE,cache.CONTROL_VOLUME_ROLE):docker.documents[role]=self.historical_document(profile)
            _,layout,source,repo,runroot=args
            ready=cache.prepare_ready(layout,repo,IMAGE,runroot,docker,
                lambda prepared,overlay:_maintenance_receipt(prepared),
                source_root=source,toolchain_image=TOOLCHAIN,control_volume_name=profile['volume_names']['control'],
                shared_packages=True,group_volume=True,control_namespace=namespace,prepared_group_owner=owner)
            restored=json.loads(json.dumps(ready))
            self.assertEqual(restored['prepared_group_owner'],owner)
            self.assertEqual(restored['receipt']['prepared_group_owner'],owner)
            cache.validate(restored,restored['volume_documents'],restored['maintenance_receipt'])
            restored['prepared_group_owner']['source_worktree_id']='other'
            with self.assertRaises(cache.BackendVolumeCacheError):cache.validate_container({},restored)

    def test_launcher_passes_the_already_prepared_owner_to_cache(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        import docker_volume_dev as dev
        owner={'schema':'fullmag.docker-group-storage-owner.v1'}
        control=SimpleNamespace(project='fullmag-master',namespace='namespaces/'+'1'*32,volume='control',
            write=lambda *args:None,_assert_live_operation_helper=lambda operation:'a'*64)
        with patch.object(dev,'_uses_private_group_storage',return_value=True), \
             patch('docker_group_storage.prepare',return_value=owner), \
             patch.object(cache,'prepare',side_effect=RuntimeError('stop after cache contract')) as prepare:
            with self.assertRaisesRegex(RuntimeError,'stop after cache contract'):
                dev._backend_cache(control,{'root':'development/attempts/exact'},{},Path('/tmp'),IMAGE,TOOLCHAIN)
            self.assertIs(prepare.call_args.kwargs['prepared_group_owner'],owner)

    def test_launcher_keeps_normal_group_root_on_strict_legacy_label_path(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        import docker_volume_dev as dev
        owner={'schema':'fullmag.docker-group-storage-owner.v1','control_namespace':''}
        control=SimpleNamespace(project='fullmag-master',namespace='',volume='control',
            write=lambda *args:None,_assert_live_operation_helper=lambda operation:'a'*64)
        with patch.object(dev,'_uses_private_group_storage',return_value=True), \
             patch('docker_group_storage.prepare',return_value=owner), \
             patch.object(cache,'prepare',side_effect=RuntimeError('stop after cache contract')) as prepare:
            with self.assertRaisesRegex(RuntimeError,'stop after cache contract'):
                dev._backend_cache(control,{'root':'development/attempts/exact'},{},Path('/tmp'),IMAGE,TOOLCHAIN)
            self.assertNotIn('prepared_group_owner',prepare.call_args.kwargs)
            self.assertTrue(prepare.call_args.kwargs['group_volume'])

    def test_backend_cannot_mount_group_root_as_build_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=self.prepare(_profile(tmp,shared_packages=True))
            p['volume_documents']={role:{'Name':n,'Driver':'local','Options':{},'Scope':'local','Mountpoint':f'/var/lib/docker/volumes/{n}/_data','Labels':cache.volume_labels(p,role)} for role,n in p['volume_names'].items()}
            p['state']='ready'  # isolate mount attestation after maintenance admission
            row=_container(p)
            with self.assertRaises(cache.BackendVolumeCacheError):cache.validate_container(row,p)
            for m in row['Mounts']:
                if m['Destination']=='/build':m['Source']+='/private/backend'
            for m in row['HostConfig']['Mounts']:
                if m['Target']=='/build':m['VolumeOptions']={'Subpath':'private/backend'}
            self.assertEqual(cache.validate_container(row,p)['state'],'attested')

    def test_unknown_control_root_consumer_cannot_modify_build_subpath(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=self.prepare(_profile(tmp,shared_packages=True))
            c={'Id':'e'*64,'State':{'Running':True},'Config':{'Labels':{},'Env':[]},'Mounts':[{'Type':'volume','Name':p['volume_names']['control'],'Destination':'/foreign','Source':'/var/lib/docker/volumes/'+p['volume_names']['control']+'/_data','RW':True}], 'HostConfig':{'Mounts':[]}}
            with self.assertRaises(cache.BackendVolumeCacheError):cache._assert_no_active_consumers(p,[c])

if __name__=='__main__':unittest.main()
