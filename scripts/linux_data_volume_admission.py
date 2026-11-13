"""Prepare copied admission under a supervised root job; no CLI or startup.

The managed parent retains the live host/group and OLD native fences until
this exact process is terminal. Stored acknowledgements authenticate inputs,
not lock ownership. This stage adds a NEW writer and preserves partial state;
fresh image/guest probing, registration and original retirement follow later.
"""
from __future__ import annotations

from contextlib import ExitStack
import os
from pathlib import Path
import re

from fullmag_data_volume_guard import _observe_directory,_parse_object,_read_optional_regular
from fullmag_data_volume_fs import _same_directory
from fullmag_data_volume_journal import append_started,append_terminal,next_phase
from fullmag_data_volume_linux_request import _path,validate_linux_request
from fullmag_data_volume_manifest import _validate_manifest,inventory_datasets,require_matching_data
from fullmag_data_volume_runtime_binding import load_plan
from linux_data_volume_format import _document,_publish_journal
import linux_data_volume_provision as qualification
try:
    from . import fullmag_data_volume_admission as admission
    from . import linux_data_volume_bind as bind_stage
except ImportError:
    import fullmag_data_volume_admission as admission
    import linux_data_volume_bind as bind_stage


SCHEMA='fullmag.data-volume-linux-admission-request.v1'
REQUEST_KEYS={'schema','volume_id','storage_root','token','bind_request_sha256',
              'bind_receipt_sha256','fence_ready_sha256','components'}
COMPONENTS=(*bind_stage.COMPONENTS,'linux_native_data_volume_migration.py','linux_native_host.py',
    'docker_dev_host.py','fullmag_storage.py','fullmag_data_volume_admission.py','linux_data_volume_admission.py')
ARTIFACTS=('linux-admission-started.json','linux-admission-result.json','linux-admission-failed.json')
require=qualification.require


def validate_request(value):
    require(type(value) is dict and set(value) == REQUEST_KEYS and value['schema'] == SCHEMA,
            'Closed root admission request required')
    for key in ('volume_id','token'):
        require(type(value[key]) is str and re.fullmatch('[0-9a-f]{32}',value[key]) and value[key] != '0'*32,
                'Exact nonzero admission identity required')
    for key in ('bind_request_sha256','bind_receipt_sha256','fence_ready_sha256'):
        require(type(value[key]) is str and re.fullmatch('[0-9a-f]{64}',value[key]),'Exact admission predecessor SHA required')
    _path(value['storage_root'],'admission storage root')
    require(type(value['components']) is dict and set(value['components']) == set(COMPONENTS) and
        all(type(v) is str and re.fullmatch('[0-9a-f]{64}',v) for v in value['components'].values()),
        'Exact root admission component pins required')
    return value


def _components(request):
    for name in COMPONENTS:
        raw=_read_optional_regular(Path(__file__).parent/name,'root admission source',maximum=4*1024**2)
        require(raw is not None and qualification.digest(raw) == request['components'][name],
                'Root admission source changed: '+name)


def _mount(path):
    raw=qualification._capture(['findmnt','--json','--mountpoint',str(path),
        '--output','TARGET,FSROOT,FSTYPE,UUID,MAJ:MIN,OPTIONS,PROPAGATION']).stdout
    rows=_parse_object(raw,'admission mount observation').get('filesystems')
    require(type(rows) is list and len(rows) == 1 and type(rows[0]) is dict,'One exact admission mount required')
    return rows[0]


def _verify_roots(context):
    linux=context['linux'];mount=Path(linux['mount_root'])
    bind_stage.copy_stage._mounted_root(linux,context['provision'])
    base=_mount(mount)
    require(base.get('target') == str(mount) and base.get('fsroot') == '/' and
        base.get('fstype') == 'ext4' and base.get('uuid') == linux['filesystem_uuid'] and
        base.get('maj:min') == context['provision']['filesystem']['mount']['maj:min'] and
        base.get('propagation') == 'private' and {'rw','nodev','nosuid'} <= set(base.get('options','').split(',')),
        'Admission new-volume mount identity changed')
    old={};new={}
    for role,row in context['bind_result']['switch']['roots'].items():
        original=Path(row['backup_root']);canonical=Path(row['canonical_root'])
        require(_observe_directory(original) == row['original_identity'] and
            _observe_directory(canonical) == row['bound_identity'],'Admission OLD/NEW dataset identity changed')
        actual=_mount(canonical)
        expected_fsroot='/'+str(Path(row['copied_root']).relative_to(mount))
        require(actual.get('target') == str(canonical) and actual.get('fsroot') == expected_fsroot and
            actual.get('fstype') == 'ext4' and actual.get('uuid') == linux['filesystem_uuid'] and
            actual.get('maj:min') == base['maj:min'] and actual.get('propagation') == 'private' and
            {'rw','nodev','nosuid'} <= set(actual.get('options','').split(',')),
            'Admission canonical bind no longer identifies the verified payload')
        old[role]=original;new[role]=canonical
    return old,new


def load_context(request_path,request_sha256):
    require(os.name == 'posix' and os.geteuid() == 0,'Host root required for admission preparation')
    require(type(request_sha256) is str and re.fullmatch('[0-9a-f]{64}',request_sha256),'Exact admission request SHA required')
    _,value=qualification._read(Path(request_path),request_sha256)
    request=validate_request(value);_components(request)
    op=Path(request['storage_root'])/'migrations/data-volumes'/request['volume_id']
    require(Path(request_path) == op/'linux-admission-request.json','Admission request escapes its selected operation')
    _,value=qualification._read(op/'linux-bind-request.json',request['bind_request_sha256'])
    bind_request=bind_stage.validate_request(value)
    require(bind_request['volume_id'] == request['volume_id'] and bind_request['storage_root'] == request['storage_root'],
            'Admission bind predecessor belongs to another volume')
    _,value=qualification._read(op/'linux-copy-request.json',bind_request['copy_request_sha256'])
    copy_request=bind_stage.copy_stage.validate_request(value)
    _,value=qualification._read(op/'linux-provision-request.json',copy_request['linux_request_sha256'])
    linux=validate_linux_request(value)
    plan_raw,plan,_binding=load_plan(op,linux);plan_sha=qualification.digest(plan_raw)
    require(plan.get('volume_id') == request['volume_id'] == copy_request['volume_id'] == linux['volume_id'] and
        plan.get('storage_root') == request['storage_root'] == copy_request['storage_root'] == linux['storage_root'] and
        plan.get('mount_root') == linux['mount_root'] and plan.get('observation',{}).get('datasets') == linux['source_roots'] and
        plan.get('source_root') == str(Path(__file__).resolve().parents[1]),'Admission original source/plan/Linux scope differs')
    require(qualification.probe_host()['boot_id'] == linux['boot_id'],'Admission requires the provisioned persistent WSL boot')
    _,provision=qualification._read(op/'linux-provision-result.json',copy_request['provision_result_sha256'])
    require(provision.get('schema') == 'fullmag.data-volume-linux-provision-result.v1' and
        provision.get('state') == 'mounted-not-data-migrated' and provision.get('volume_id') == request['volume_id'] and
        provision.get('filesystem_uuid') == linux['filesystem_uuid'] and provision.get('namespace_admitted') is False and
        provision.get('linux_request_sha256') == copy_request['linux_request_sha256'] and
        provision.get('formatter_sha256') == copy_request['components']['linux_data_volume_format.py'],
        'Admission formatter predecessor differs')
    _,copy_result=qualification._read(op/'linux-copy-result.json',bind_request['copy_receipt_sha256'])
    bind_stage.copy_stage.validate_result(copy_result,copy_request,linux,bind_request['copy_request_sha256'])
    _,result=qualification._read(op/'linux-bind-result.json',request['bind_receipt_sha256'])
    require(type(result) is dict and set(result) == {'schema','state','volume_id','token','request_sha256',
        'copy_receipt_sha256','pending_marker','switch','namespace_admitted','originals_retired'} and
        result['schema'] == 'fullmag.data-volume-linux-bind-result.v1' and result['state'] == 'binds-switched-not-admitted' and
        result['volume_id'] == request['volume_id'] and result['token'] == bind_request['token'] and
        result['request_sha256'] == request['bind_request_sha256'] and
        result['copy_receipt_sha256'] == bind_request['copy_receipt_sha256'] and
        result['namespace_admitted'] is False and result['originals_retired'] is False,'Admission successful bind receipt differs')
    bind_stage.primitive.validate_switch_result(result['switch'],bind_request,linux,copy_result)
    journal_path,journal=qualification._selected_journal(op);events=journal['events']
    require(journal['volume_id'] == request['volume_id'] and journal['request_sha256'] == plan_sha and
        next_phase(journal) == 'admission-prepared' and len(events) >= 8 and
        events[-1]['phase'] == 'binds-switched' and events[-1]['state'] == 'succeeded' and
        events[-1]['receipt_sha256'] == request['bind_receipt_sha256'] and
        events[-1]['inputs_sha256'] == request['bind_request_sha256'] and
        events[-3]['receipt_sha256'] == bind_request['copy_receipt_sha256'] and
        events[-3]['inputs_sha256'] == bind_request['copy_request_sha256'] and
        events[-5]['receipt_sha256'] == copy_request['drain_sha256'] and
        events[-7]['receipt_sha256'] == copy_request['provision_result_sha256'],
        'Admission journal does not continue its exact provision/drain/copy/bind predecessors')
    _,drain=qualification._read(op/'group-drained.json',copy_request['drain_sha256'])
    require(type(drain) is dict and set(drain) == {'schema','volume_id','token','plan_sha256','source_roots',
        'stop_attempt','stop_sha256','process_receipt_sha256','containers'} and
        drain['schema'] == 'fullmag.data-volume-group-drained.v1' and drain['volume_id'] == request['volume_id'] and
        drain['token'] == copy_request['token'] and drain['plan_sha256'] == plan_sha and drain['source_roots'] == linux['source_roots'] and
        drain['containers'] == {r:plan['runtime_pins'][r] for r in ('backend','frontend')},'Admission native drain scope differs')
    _,held=qualification._read(op/'admission-fence-ready.json',request['fence_ready_sha256'])
    bind_stage.copy_stage.validate_held_fence(held,request['token'],request['volume_id'],drain['process_receipt_sha256'])
    raw=_read_optional_regular(Path(copy_result['manifest_path']),'admission source manifest',maximum=bind_stage.MAX_MANIFEST_BYTES)
    require(raw is not None and qualification.digest(raw) == copy_result['manifest_sha256'],'Admission original manifest SHA changed')
    manifest=_validate_manifest(_parse_object(raw,'admission original manifest'),'admission original manifest')
    require(manifest['roots'] == {r:{'path':p['canonical_root'],'device':p['device'],'inode':p['inode']}
        for r,p in linux['source_roots'].items()} and manifest['data_sha256'] == copy_result['data_sha256'],
        'Admission manifest belongs to another original dataset')
    entries={e['path']:e for e in manifest['entries'] if e['role'] == 'state'}
    names=(*admission.migration.host.READMISSION_FILES,'runs/docker-all/session-store/WRITER.lock')
    require(all(name in entries and entries[name]['kind'] == 'file' for name in names),'Admission original evidence or writer entry is missing')
    layout={'repo_root':plan['source_root'],'storage_root':plan['storage_root'],'runtime_root':plan['runtime_root'],
        'worktree_id':plan['worktree_id'],'env':{'FULLMAG_PROJECT_ID':plan['project_id']}}
    marker={'schema':bind_stage.pending.SCHEMA,'project_id':plan['project_id'],'worktree_id':plan['worktree_id'],
        'compose_project':plan['compose_project'],'source_root':plan['source_root'],'volume_id':request['volume_id'],
        'plan_sha256':plan_sha,'linux_request_sha256':copy_request['linux_request_sha256'],
        'copy_receipt_sha256':bind_request['copy_receipt_sha256'],
        'state_root':linux['source_roots']['state']['canonical_root'],'user_data_root':linux['source_roots']['user_data']['canonical_root']}
    marker=bind_stage.pending.validate_pending(marker,layout,plan['compose_project'])
    context={'request':request,'operation_root':op,'plan':plan,'linux':linux,'provision':provision,
        'copy_request':copy_request,'copy_result':copy_result,'bind_request':bind_request,'bind_result':result,
        'source_manifest':manifest,'entries':entries,'writer_entry':entries[names[-1]],'drain':drain,
        'pending_layout':layout,'pending':marker,'journal_path':journal_path,'journal':journal}
    bind_stage._require_pending(context,result['pending_marker']);_verify_roots(context)
    for path in (*(op/name for name in ARTIFACTS),Path(linux['mount_root'])/'migration'/request['volume_id']/'state-admission.json'):
        require(not os.path.lexists(path),'Admission has previous artifacts; reconcile, never replay')
    return context


def _preparation_request(context):
    host=admission.migration.host;linux=context['linux'];rows=context['bind_result']['switch']['roots']
    state=Path(rows['state']['canonical_root']);raw=host.read_owned_regular(state/host.CERTIFICATE_NAME)
    require(qualification.digest(raw) == context['entries'][host.CERTIFICATE_NAME]['sha256'],'Admission predecessor certificate SHA differs')
    certificate=host._readmission_json(raw)
    require(certificate.get('engine_id') == context['plan']['observation']['engine_id'] and
        certificate.get('image_id') == context['plan']['runtime_pins']['image_id'],'Admission native engine/image differs')
    pins={'state_root':str(state),'mount_root':linux['mount_root'],'volume_id':linux['volume_id'],
        'filesystem_uuid':linux['filesystem_uuid'],'engine_id':certificate['engine_id'],
        'owner_token':certificate['owner_token'],'image_id':certificate['image_id'],
        'source_binding_sha256':host.readmission_source_binding_sha256(certificate),
        'source_device':rows['state']['original_identity']['device'],'source_inode':rows['state']['original_identity']['inode'],
        'observed_device':rows['state']['bound_identity']['device'],'observed_inode':rows['state']['bound_identity']['inode'],
        'source_data_sha256':context['source_manifest']['data_sha256'],'copied_data_sha256':context['copy_result']['data_sha256'],
        'drained_witness_sha256':context['copy_request']['drain_sha256'],
        'files':{name:context['entries'][name]['sha256'] for name in host.READMISSION_FILES}}
    return admission.validate_request({'schema':admission.SCHEMA,'pins':pins,'writer_entry':context['writer_entry']})


def _verify_base_data(context):
    old,new=_verify_roots(context)
    for roots in (old,new):require_matching_data(context['source_manifest'],inventory_datasets(roots))
    _verify_roots(context);bind_stage._require_pending(context,context['bind_result']['pending_marker'])


def _verify_preparation(state,prepared,request):
    pins=request['pins'];archive=Path(pins['mount_root'])/'migration'/pins['volume_id']/'state-admission.json'
    require(type(prepared) is dict and set(prepared) == {'schema','state','volume_id','archive','certificate_sha256',
        'namespace_admitted','originals_retired'} and prepared['schema'] == admission.SCHEMA and
        prepared['state'] == 'admission-prepared-not-admitted' and prepared['volume_id'] == pins['volume_id'] and
        prepared['namespace_admitted'] is False and prepared['originals_retired'] is False and
        type(prepared['archive']) is dict and set(prepared['archive']) == {'path','sha256'} and
        prepared['archive']['path'] == str(archive),'Prepared admission result scope differs')
    raw=admission.migration.host.read_owned_regular(archive,maximum=16*1024**2)
    require(qualification.digest(raw) == prepared['archive']['sha256'],'Prepared admission archive SHA changed')
    archived=admission.migration.host._readmission_json(raw)
    require(archived.get('pins') == pins and archived.get('candidate_sha256') == prepared['certificate_sha256'],
            'Prepared admission candidate or predecessor pins changed')
    _,phase=admission.migration._validate_preparation(state,archived)
    require(phase == 'prepared','Prepared certificate/owner pair changed before stage publication')


def admission_verified(request_path,request_sha256):
    context=load_context(request_path,request_sha256);op=context['operation_root'];request=context['request']
    with bind_stage.copy_stage._operation_lock(op):
        require(load_context(request_path,request_sha256) == context,'Admission context changed before its mutex')
        state=Path(context['linux']['source_roots']['state']['canonical_root'])
        with ExitStack() as held:
            store=state/'runs/docker-all/session-store'
            store_fd=bind_stage._open_directory_nofollow(store);held.callback(os.close,store_fd)
            writer_fd=held.enter_context(bind_stage._copied_writer(state,context['writer_entry']))
            def check_writer():
                _same_directory(store,store_fd)
                admission._writer(writer_fd,store_fd,context['writer_entry'])
            check_writer()
            bind_stage._verify_archive(context);_verify_base_data(context)
            check_writer()
            preparation=_preparation_request(context)
            started=append_started(context['journal'],'admission-prepared',request_sha256)
            _publish_journal(context['journal_path'],context['journal'],started)
            try:
                check_writer()
                _document(op,'linux-admission-started.json',{'schema':'fullmag.data-volume-admission-started.v1',
                    'volume_id':request['volume_id'],'token':request['token'],'request_sha256':request_sha256})
                bind_stage._require_pending(context,context['bind_result']['pending_marker'])
                check_writer()
                prepared=admission.prepare_guarded(preparation,writer_fd=writer_fd)
                def check_prepared():
                    views=_verify_roots(context);check_writer()
                    _verify_preparation(state,prepared,preparation)
                    bind_stage._require_pending(context,context['bind_result']['pending_marker'])
                    return views
                old,_=check_prepared()
                require_matching_data(context['source_manifest'],inventory_datasets(old))
                check_prepared()
                result={'schema':'fullmag.data-volume-linux-admission-result.v1','state':'admission-prepared-not-admitted',
                    'volume_id':request['volume_id'],'token':request['token'],'request_sha256':request_sha256,
                    'bind_receipt_sha256':request['bind_receipt_sha256'],
                    'copy_receipt_sha256':context['bind_request']['copy_receipt_sha256'],
                    'pending_marker':context['bind_result']['pending_marker'],'preparation':prepared,
                    'source_data_sha256':context['source_manifest']['data_sha256'],
                    'namespace_admitted':False,'data_migrated':False,'originals_retired':False}
                result_sha=_document(op,'linux-admission-result.json',result)
                check_prepared()
                _publish_journal(context['journal_path'],started,append_terminal(started,'succeeded',result_sha))
                check_prepared()
                return result
            except BaseException as error:
                failure={'schema':'fullmag.data-volume-linux-admission-failure.v1','state':'outcome-unknown-resources-retained',
                    'volume_id':request['volume_id'],'token':request['token'],'request_sha256':request_sha256,
                    'error_type':type(error).__name__,'originals_and_copies_retained':True,'manual_recovery_required':True}
                receipt=_document(op,'linux-admission-failed.json',failure)
                _,current=qualification._read(context['journal_path'])
                if current == started:_publish_journal(context['journal_path'],started,append_terminal(started,failure['state'],receipt))
                raise
