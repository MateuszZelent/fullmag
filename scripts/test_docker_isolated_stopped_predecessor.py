import copy
import hashlib
import unittest
from types import SimpleNamespace

from docker_build_control import BuildControlError, canonical
from docker_volume_reconcile import fingerprint
import docker_isolated_stopped_predecessor as stopped


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


class StoppedPredecessorTests(unittest.TestCase):
    def fixture(self):
        control=SimpleNamespace(project='fullmag-master',volume='control',namespace='namespaces/'+'1'*32,
                                namespace_registry_sha256='2'*64)
        pins={'development_attempt':'3'*32,'compose_config_sha256':'4'*64,'source_root':'/repo',
              'backend_container_id':'a'*64,'frontend_container_id':'b'*64,'old_image_id':'sha256:'+'c'*64}
        meta={'schema':'fullmag.docker-build-operation.v1','compose_project':control.project,
              'control_volume':control.volume,'control_namespace':control.namespace,
              'namespace_registry_sha256':control.namespace_registry_sha256}
        reason='policy refusal: stored host resource policy differs from explicit ledger configuration'
        terminal=dict(meta,phase='development',state='failed-confirmed',attempt=pins['development_attempt'],
                      config_sha256=pins['compose_config_sha256'],backend_started_at='2026-10-28T20:02:26.498430595Z',
                      inputs={'source_root':'/repo','image_id':pins['old_image_id']},
                      error='Runtime startup failed; diagnostic API retained: '+reason)
        actual={}
        services={}
        for role in ('backend','frontend'):
            actual[role]={'Id':pins[role+'_container_id'],'Image':pins['old_image_id'],
                          'Config':{},'HostConfig':{},'Mounts':[],
                          'State':{'Status':'exited','Pid':0,'Running':False,'Paused':False,
                                   'Restarting':False,'Dead':False,'OOMKilled':False,'ExitCode':0,
                                   'StartedAt':terminal['backend_started_at']}}
            services[role]={'id':actual[role]['Id'],'image':actual[role]['Image'],
                            'started_at':actual[role]['State']['StartedAt'],'fingerprint':fingerprint(actual[role])}
        hashes={path:sha(path.encode()) for path in (
            'runtime-control/runtime-services/OWNER.json','runtime-control/runtime-service/process-tree.json',
            'runtime-control/runtime-service/docker-all.json','backend/runtime-provenance.json',
            'runtime-control/runtime-service/api-failure-'+'d'*32+'.json')}
        plan={'schema':stopped.SCHEMA,'development_attempt':pins['development_attempt'],
              'config_sha256':pins['compose_config_sha256'],'development_terminal_sha256':sha(canonical(terminal)),
              'controller_sha256':'5'*64,'probe_sha256':'6'*64,**services,
              'guest':{'schema':'fullmag.preowner-policy-stop-probe.v1',
                       'api_instance_id':'12345678-1234-4234-8234-123456789abc',
                       'current_session_present':False,'failure_reason':reason,'control_hashes':hashes},
              'released':{'schema':'fullmag.pre-ack-released-observation.v1','active_count':0,
                          'reservations':[],'leases':[]},'run_pins':{'run/run_intent.json':'8'*64}}
        operation_root='preowner-policy-stop/attempts/'+'9'*32
        proof={'schema':stopped.SCHEMA,'state':'stopped-confirmed','data_preserved':True,
               'native_owner_drained':False,'plan':plan,'plan_sha256':sha(canonical(plan)),
               'operation_root':operation_root,'backend_after':copy.deepcopy(services['backend']),
               'frontend_after':copy.deepcopy(services['frontend'])}
        proof_path='verification/preowner-policy-stop-'+pins['backend_container_id']+'.json'
        op=dict(meta,phase='preowner-policy-stop',state='succeeded',attempt='9'*32,
                inputs={'attempt':pins['development_attempt'],'config_sha256':pins['compose_config_sha256'],
                        'source_root':'/repo','backend_container_id':pins['backend_container_id'],
                        'image_id':pins['old_image_id'],'controller_sha256':plan['controller_sha256']},
                result={'state':'stopped-confirmed','journal_path':proof_path,
                        'journal_sha256':sha(canonical(proof)+b'\n'),'native_owner_drained':False})
        docs={path:path.encode() for path in hashes}
        docs.update({'development/current.json':canonical(terminal),
                     'development/attempts/'+pins['development_attempt']+'/terminal.json':canonical(terminal),
                     proof_path:canonical(proof)+b'\n',operation_root+'/terminal.json':canonical(op),
                     operation_root+'/plan.json':canonical(plan)+b'\n'})
        control.read_bytes=lambda path,**kwargs:docs[path]
        return control,pins,terminal,proof,op,docs,actual,proof_path

    def load(self, fixture):
        control,pins,terminal,proof,op,docs,actual,path=fixture
        return stopped.load_stopped_predecessor(control,pins,canonical(terminal),path,sha(docs[path]))

    def test_exact_stop_proof_hydrates_only_memory_and_pins_every_record(self):
        fixture=self.fixture();control,pins,terminal,proof,op,docs,actual,path=fixture
        before=copy.deepcopy(docs)
        normalized,pinned,services=self.load(fixture)
        expected=dict(terminal,backend_container=pins['backend_container_id'],frontend_container=pins['frontend_container_id'])
        self.assertEqual(normalized,canonical(expected))
        self.assertEqual(pinned,{control.namespace+'/'+path:raw for path,raw in docs.items()})
        self.assertEqual(docs,before)
        stopped.validate_stopped_incarnations(actual,services)

    def test_mismatched_stop_authority_is_rejected(self):
        for field in ('hash','terminal','current','attempt','config','id','image','started_at','fingerprint',
                      'namespace','registry','op_source','op_result','schema','data_preserved','drained',
                      'active_session','nonnull','control_drift','plan_file','op_state','malformed_path'):
            with self.subTest(field=field):
                fixture=self.fixture();control,pins,terminal,proof,op,docs,actual,path=fixture
                if field=='hash':
                    with self.assertRaises((BuildControlError,ValueError)):
                        stopped.load_stopped_predecessor(control,pins,canonical(terminal),path,'0'*64)
                    continue
                if field=='terminal': proof['plan']['development_terminal_sha256']='f'*64
                elif field=='current': docs['development/current.json']=b'{}'
                elif field=='attempt': proof['plan']['development_attempt']='f'*32
                elif field=='config': proof['plan']['config_sha256']='f'*64
                elif field=='id': proof['plan']['backend']['id']='f'*64
                elif field=='image': proof['plan']['frontend']['image']='sha256:'+'f'*64
                elif field=='started_at': proof['plan']['backend']['started_at']='2026-10-28T21:00:00Z'
                elif field=='fingerprint': proof['plan']['frontend']['fingerprint']=''
                elif field=='namespace': op['control_namespace']='namespaces/'+'f'*32
                elif field=='registry': op['namespace_registry_sha256']='f'*64
                elif field=='op_source': op['inputs']['source_root']='/other'
                elif field=='op_result': op['result']['journal_path']='verification/wrong.json'
                elif field=='schema': proof['schema']='wrong'
                elif field=='data_preserved': proof['data_preserved']=1
                elif field=='drained': proof['native_owner_drained']=0
                elif field=='active_session': proof['plan']['guest']['current_session_present']=True
                elif field=='nonnull': terminal['backend_container']='f'*64
                elif field=='control_drift': docs['runtime-control/runtime-services/OWNER.json']=b'changed'
                elif field=='op_state': op['state']='failed-confirmed'
                elif field=='malformed_path': path='../'+path
                proof['plan_sha256']=sha(canonical(proof['plan']))
                op['result']['journal_sha256']=sha(canonical(proof)+b'\n')
                docs[path]=canonical(proof)+b'\n'
                docs[proof['operation_root']+'/terminal.json']=canonical(op)
                docs[proof['operation_root']+'/plan.json']=canonical(proof['plan'])+b'\n'
                if field=='plan_file':docs[proof['operation_root']+'/plan.json']=b'{}'
                with self.assertRaises((BuildControlError,ValueError)):
                    stopped.load_stopped_predecessor(control,pins,canonical(terminal),path,sha(docs[path]))

    def test_null_and_matching_original_ids_are_allowed_but_wrong_nonnull_is_not(self):
        for value in (None,'matching','wrong'):
            with self.subTest(value=value):
                fixture=self.fixture();control,pins,terminal,proof,op,docs,actual,path=fixture
                terminal['backend_container']=(pins['backend_container_id'] if value=='matching'
                                                else 'f'*64 if value=='wrong' else None)
                terminal['frontend_container']=None
                original=canonical(terminal)
                docs['development/current.json']=docs['development/attempts/'+pins['development_attempt']+'/terminal.json']=original
                proof['plan']['development_terminal_sha256']=sha(original)
                proof['plan_sha256']=sha(canonical(proof['plan']))
                docs[path]=canonical(proof)+b'\n'
                op['result']['journal_sha256']=sha(docs[path])
                docs[proof['operation_root']+'/terminal.json']=canonical(op)
                docs[proof['operation_root']+'/plan.json']=canonical(proof['plan'])+b'\n'
                if value=='wrong':
                    with self.assertRaises(BuildControlError): self.load(fixture)
                else:
                    normalized,_,_=self.load(fixture)
                    self.assertIn(pins['backend_container_id'].encode(),normalized)
                    self.assertEqual(docs['development/current.json'],original)

    def test_restarted_or_changed_physical_pair_is_rejected(self):
        for field in ('id','image','fingerprint','started','running','pid','oom','paused','restarting','dead','status','exit'):
            with self.subTest(field=field):
                fixture=self.fixture();actual=fixture[6];_,_,services=self.load(fixture)
                row=actual['backend']
                if field=='id': row['Id']='f'*64
                elif field=='image':row['Image']='sha256:'+'f'*64
                elif field=='fingerprint':row['Config']={'changed':True}
                elif field=='started':row['State']['StartedAt']='2026-10-28T21:00:00Z'
                elif field=='running':row['State']['Running']=True
                elif field=='pid':row['State']['Pid']=1
                elif field=='oom':row['State']['OOMKilled']=True
                elif field=='paused':row['State']['Paused']=True
                elif field=='restarting':row['State']['Restarting']=True
                elif field=='dead':row['State']['Dead']=True
                elif field=='status':row['State']['Status']='created'
                elif field=='exit':row['State']['ExitCode']=False
                with self.assertRaises((BuildControlError,ValueError)):
                    stopped.validate_stopped_incarnations(actual,services)


if __name__=='__main__': unittest.main()
