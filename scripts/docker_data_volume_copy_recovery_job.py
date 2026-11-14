"""Supervise one retained-copy requalification with fresh native guards."""
from pathlib import Path
import hashlib
import json
import os
import re
import subprocess

from docker_compose_identity import compose_project_identity
from docker_data_volume_linux import _wsl_executable
from fullmag_data_volume_linux_request import validate_linux_request
from fullmag_data_volume_runtime_binding import load_plan
import fullmag_storage as storage
import linux_data_volume_copy as root_copy
import linux_data_volume_provision as qualification
try:
    from . import docker_data_volume_copy_job as supervisor
    from . import docker_data_volume_root_bootstrap as root_bootstrap
except ImportError:
    import docker_data_volume_copy_job as supervisor
    import docker_data_volume_root_bootstrap as root_bootstrap


def _attempt(operation_root, request):
    expected=Path(request['storage_root'])/'migrations/data-volumes'/request['volume_id']
    qualification.require(Path(operation_root)==expected,'Recovery job changed the selected operation')
    return expected/'recovery'/request['token']


def _original(operation_root,request):
    _,old=qualification._read(operation_root/'linux-copy-request.json',request['original_copy_request_sha256'])
    old=root_copy.validate_request(old)
    qualification.require(all(old[k]==request[k] for k in ('volume_id','storage_root')),
                          'Recovery changed the original copy scope')
    return old


def _command(owner,source,distro,path,expected_sha256,*,probe):
    source,path=Path(source),Path(path)
    qualification.require(type(distro) is str and re.fullmatch('[A-Za-z0-9_-]{1,80}',distro),
                          'Exact recovery WSL distro required')
    qualification.require(type(expected_sha256) is str and re.fullmatch('[0-9a-f]{64}',expected_sha256),
                          'Exact recovery request SHA required')
    _,value=qualification._read(path,expected_sha256)
    request=(root_copy.validate_recovery_probe_request(value) if probe else root_copy.validate_recovery_request(value))
    control=owner if probe else owner.control
    if probe:
        operation=control._active_operation
        qualification.require(operation is not None and operation['receipt'].get('phase')=='data-volume-migration' and
            operation['receipt'].get('attempt')==request['token'] and operation.get('daemon_pending') is False,
            'Read-only recovery probe requires its live managed operation before native guards')
        control._assert_live_operation_helper(operation)
    else:supervisor._operation_match(owner,request)
    layout=storage.resolve_layout(source,profile='docker-all-gpu');identity=compose_project_identity(layout)
    op=Path(layout['storage_root'])/'migrations/data-volumes'/request['volume_id'];attempt=_attempt(op,request)
    name='copy-recovery-probe-request.json' if probe else 'copy-recovery-request.json'
    qualification.require(path==attempt/name and
        request['storage_root']==layout['storage_root'] and control.project==identity['project_name'],
        'Recovery request escapes the selected source group')
    old=_original(op,request)
    _,linux_raw=qualification._read(op/'linux-provision-request.json',old['linux_request_sha256'])
    linux=validate_linux_request(linux_raw)
    _,plan,_binding=load_plan(op,linux)
    qualification.require(all(plan.get(k)==v for k,v in {
        'source_root':str(source),'project_id':identity['project_id'],'worktree_id':identity['worktree_id'],
        'compose_project':identity['project_name'],'volume_id':request['volume_id']}.items()) and
        plan.get('provision_request',{}).get('wsl_distro')==distro and
        plan.get('runtime_pins',{}).get('image_id')==control.image and
        linux['source_roots']==plan['observation']['datasets'] and
        (probe or {role:{k:pin[k] for k in ('device','inode')} for role,pin in linux['source_roots'].items()}==owner.request['source_roots']),
        'Recovery source/image/device identities differ from the live group')
    _,drain=qualification._read(op/'group-drained.json',old['drain_sha256'])
    validate_original_history(op,old,request['original_copy_request_sha256'],drain)
    if probe:
        qualification.require(request['fence_ready_sha256']==old['fence_ready_sha256'],
                              'Read-only probe must pin the original historical acknowledgement')
    else:
        _,ready=qualification._read(attempt/'fence-ready.json',request['fence_ready_sha256'])
        qualification.require(ready==owner.ready,'Recovery job does not use its exact live acknowledgement')
    for name in root_copy.COMPONENTS:
        raw=qualification._read_optional_regular(source/'scripts'/name,'root recovery source',maximum=4*1024**2)
        qualification.require(raw is not None and hashlib.sha256(raw).hexdigest()==request['components'][name],
                              'Root recovery component source changed: '+name)
    command=[_wsl_executable(),'--distribution',distro,'--user','root','--exec',
        '/usr/bin/python3','-I','-B','-c',root_bootstrap.bootstrap('probe-copy-recovery' if probe else 'recover-copy'),str(source),str(path),
        expected_sha256,json.dumps(request['components'],sort_keys=True,separators=(',',':'))]
    return command,attempt,request


def prepare_command(fence,source,distro,path,expected_sha256):
    return _command(fence,source,distro,path,expected_sha256,probe=False)


def prepare_probe_command(control,source,distro,path,expected_sha256):
    return _command(control,source,distro,path,expected_sha256,probe=True)


def validate_original_history(op,old,original_sha256,drain):
    _,started=qualification._read(op/'linux-copy-started.json')
    qualification.require(started=={'schema':'fullmag.data-volume-copy-started.v1','volume_id':old['volume_id'],
        'token':old['token'],'request_sha256':original_sha256},'Original copy start evidence differs')
    _,held=qualification._read(op/'copy-fence-ready.json',old['fence_ready_sha256'])
    root_copy.validate_held_fence(held,old['token'],old['volume_id'],drain['process_receipt_sha256'])


def _observe_readonly_probe(process):
    try:
        output,errors=process.communicate()
        return process.wait(),output,errors
    except BaseException:
        # Observe this same read-only client to its real terminal before the
        # caller releases its managed host operation. Never restart or kill it.
        while True:
            try:
                process.communicate()
                process.wait()
                break
            except BaseException:continue
        raise


def run_root_probe(control,source,distro,path,expected_sha256):
    command,attempt,request=prepare_probe_command(control,source,distro,path,expected_sha256)
    operation=control._active_operation
    process=subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    code,output,errors=_observe_readonly_probe(process)
    control._assert_live_operation_helper(operation)
    qualification.require(len(output)<=64*1024 and len(errors)<=64*1024,'Oversized read-only probe response')
    observation={'schema':'fullmag.data-volume-recovery-probe-observation.v1','request_sha256':expected_sha256,
        'token':request['token'],'exit_code':code,'stdout_sha256':qualification.digest(output),
        'stderr_sha256':qualification.digest(errors),'selector_changed':False,'native_guards_acquired':False}
    from linux_data_volume_format import _document
    observed_sha=_document(attempt,'probe-observation.json',observation)
    control.write(operation['root']+'/data-copy-recovery-probe-terminal.json',dict(observation,receipt_sha256=observed_sha))
    qualification.require(code==0,'Read-only root preflight refused; selector unchanged: '+errors[-2048:].decode('utf-8','replace'))
    result=qualification._parse_object(output,'read-only recovery probe result')
    op=Path(request['storage_root'])/'migrations/data-volumes'/request['volume_id']
    old=_original(op,request)
    _,linux=qualification._read(op/'linux-provision-request.json',old['linux_request_sha256'])
    qualification.require(result=={'schema':'fullmag.data-volume-copy-recovery-probe-result.v1',
        'state':'ready-for-copy-recovery','volume_id':request['volume_id'],'token':request['token'],
        'request_sha256':expected_sha256,'original_copy_request_sha256':request['original_copy_request_sha256'],
        'failed_copy_receipt_sha256':request['failed_copy_receipt_sha256'],'filesystem_uuid':linux['filesystem_uuid']},
        'Read-only root preflight response differs from the selected request')
    for name,expected in request['components'].items():
        raw=qualification._read_optional_regular(Path(source)/'scripts'/name,'post-probe root source',maximum=4*1024**2)
        qualification.require(raw is not None and qualification.digest(raw)==expected,'Recovery source changed during its read-only probe')
    return result


def validate_terminal(attempt,request,expected_sha256,exit_code):
    qualification.require(type(exit_code) is int,'Observed terminal recovery client required')
    op=Path(request['storage_root'])/'migrations/data-volumes'/request['volume_id']
    qualification.require(Path(attempt)==_attempt(op,request),'Recovery terminal escapes its exact attempt')
    _,stored=qualification._read(Path(attempt)/'copy-recovery-request.json',expected_sha256)
    qualification.require(root_copy.validate_recovery_request(stored)==request,'Recovery terminal request changed')
    _,journal=qualification._selected_journal(op);event=journal['events'][-1] if journal['events'] else {}
    qualification.require(event.get('phase')=='copy-verified' and event.get('inputs_sha256')==expected_sha256,
                          'Recovery terminal journal belongs to another request')
    success=op/'linux-copy-result.json';failure=Path(attempt)/'copy-recovery-failed.json'
    if exit_code==0:
        qualification.require(not os.path.lexists(failure) and event.get('state')=='succeeded',
                              'Recovery success lacks one confirmed terminal')
        raw,result=qualification._read(success,event['receipt_sha256'])
        old=_original(op,request)
        _,linux_raw=qualification._read(op/'linux-provision-request.json',old['linux_request_sha256'])
        root_copy.validate_result(result,old,validate_linux_request(linux_raw),request['original_copy_request_sha256'])
        qualification.require(result['schema']=='fullmag.data-volume-linux-copy-result.v2' and
            result['recovery_request_sha256']==expected_sha256 and
            result['failed_copy_receipt_sha256']==request['failed_copy_receipt_sha256'],
            'Recovery result does not bind its exact request and retained failure')
        root_copy.require_current_copy_components(Path(__file__).resolve().parents[1],op,old,result)
    else:
        qualification.require(not os.path.lexists(success) and event.get('state')=='failed-confirmed',
                              'Recovery failure has no unambiguous terminal')
        raw,result=qualification._read(failure,event['receipt_sha256'])
        qualification.require(type(result) is dict and set(result)=={
            'schema','state','volume_id','token','request_sha256','original_copy_request_sha256',
            'error_type','originals_archive_and_payload_retained'} and
            result['schema']=='fullmag.data-volume-copy-recovery-failure.v1' and
            result['state']=='failed-confirmed' and result['volume_id']==request['volume_id'] and
            result['token']==request['token'] and result['request_sha256']==expected_sha256 and
            result['original_copy_request_sha256']==request['original_copy_request_sha256'] and
            result['originals_archive_and_payload_retained'] is True,
            'Recovery confirmed failure scope differs')
    return {'state':result['state'],'receipt_sha256':hashlib.sha256(raw).hexdigest(),'result':result}


def run_root_recovery(fence,source,distro,path,expected_sha256,*,poll_interval=2.0):
    fence.check()
    command,attempt,request=prepare_command(fence,source,distro,path,expected_sha256)
    return supervisor.run_prepared_root('copy-recovery',fence,command,attempt,request,expected_sha256,
                                        validate_terminal,poll_interval=poll_interval)
