"""Supervise the exact WSL root copy while its native writer fences stay held.

The caller owns storage.build_lock and the managed migration operation. Neither
an observation error nor a saved result file makes a still-live client terminal.
Unknown outcomes retain the helper/lease and never kill or replay the root job.
"""
from __future__ import annotations

from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time

from docker_compose_identity import compose_project_identity
from docker_data_volume_linux import _wsl_executable
import fullmag_storage as storage
from fullmag_data_volume_guard import _open_directory_nofollow
from fullmag_data_volume_linux_request import validate_linux_request
from fullmag_data_volume_runtime_binding import load_plan
from linux_data_volume_copy import COMPONENTS, validate_request, validate_result
import linux_data_volume_copy as copy_stage
from linux_data_volume_format import _document
import linux_data_volume_provision as qualification

try:
    from . import docker_data_volume_root_bootstrap as root_bootstrap
except ImportError:
    import docker_data_volume_root_bootstrap as root_bootstrap

_ROOT_COPY_BOOTSTRAP = root_bootstrap.bootstrap("copy")


def _operation_match(fence, request):
    operation = fence.operation
    qualification.require(operation is not None and operation is fence.control._active_operation and
        operation['receipt'].get('phase') == 'data-volume-migration' and
        operation['receipt'].get('attempt') == request['token'] and
        operation.get('daemon_pending') is True and getattr(fence,'released',False) is False and
        fence.request['token'] == request['token'] and fence.request['volume_id'] == request['volume_id'],
        'The held copy fence must belong to the current managed migration')
    return operation


def prepare_command(fence, source, distro, request_path, request_sha256):
    """Bind argv to the selected group, original Linux scope and held helper."""
    source, request_path = Path(source), Path(request_path)
    qualification.require(type(distro) is str and re.fullmatch('[A-Za-z0-9_-]{1,80}',distro),
                          'Exact WSL distro required')
    qualification.require(type(request_sha256) is str and re.fullmatch('[0-9a-f]{64}',request_sha256),
                          'Exact root copy request SHA required')
    _, value = qualification._read(request_path,request_sha256)
    request = validate_request(value)
    _operation_match(fence,request)
    layout = storage.resolve_layout(source,profile='docker-all-gpu')
    identity = compose_project_identity(layout)
    op = Path(layout['storage_root'])/'migrations/data-volumes'/request['volume_id']
    qualification.require(request_path == op/'linux-copy-request.json' and
        request['storage_root'] == layout['storage_root'] and fence.control.project == identity['project_name'],
        'Copy job is outside the selected source group')
    _, linux_raw = qualification._read(op/'linux-provision-request.json',request['linux_request_sha256'])
    linux = validate_linux_request(linux_raw)
    _, plan, _binding = load_plan(op,linux)
    qualification.require(plan.get('source_root') == str(source) and
        plan.get('project_id') == identity['project_id'] and plan.get('worktree_id') == identity['worktree_id'] and
        plan.get('compose_project') == identity['project_name'] and
        plan.get('provision_request',{}).get('wsl_distro') == distro and
        plan.get('runtime_pins',{}).get('image_id') == fence.control.image,
        'Copy job plan belongs to another checkout, image or WSL distro')
    qualification.require(plan.get('volume_id') == request['volume_id'] and
        linux['volume_id'] == request['volume_id'] and linux['storage_root'] == request['storage_root'] and
        linux['source_roots'] == plan['observation']['datasets'] and
        {role:{k:pin[k] for k in ('device','inode')} for role,pin in linux['source_roots'].items()} == fence.request['source_roots'],
        'Copy job original root identities differ from the held helper')
    _, ready = qualification._read(op/'copy-fence-ready.json',request['fence_ready_sha256'])
    qualification.require(ready == fence.ready, 'Copy job does not use the exact live helper acknowledgement')
    for name in COMPONENTS:
        raw = qualification._read_optional_regular(source/'scripts'/name,'root copy component',maximum=4*1024**2)
        qualification.require(raw is not None and hashlib.sha256(raw).hexdigest() == request['components'][name],
                              'Root copy component source changed: '+name)
    command = [_wsl_executable(),'--distribution',distro,'--user','root','--exec',
        '/usr/bin/python3','-I','-B','-c',_ROOT_COPY_BOOTSTRAP,str(source),str(request_path),
        request_sha256,json.dumps(request['components'],sort_keys=True,separators=(',',':'))]
    return command,op,request


def validate_terminal(op, request, request_sha256, exit_code):
    """Only a matching terminal journal and root receipt allow fence release."""
    qualification.require(type(exit_code) is int, 'An observed terminal client exit is required')
    _, journal = qualification._selected_journal(op)
    event = journal['events'][-1] if journal['events'] else {}
    qualification.require(event.get('phase') == 'copy-verified',
                          'Root copy journal belongs to another request')
    success = op/'linux-copy-result.json'; failure = op/'linux-copy-failed.json'
    if exit_code == 0:
        qualification.require(event.get('state') == 'succeeded',
                              'Successful client exit has no unambiguous completed root copy')
        raw,result = qualification._read(success,event['receipt_sha256'])
        _, linux_raw = qualification._read(op/'linux-provision-request.json',request['linux_request_sha256'])
        linux = validate_linux_request(linux_raw)
        validate_result(result,request,linux,request_sha256)
        if result['schema'] == 'fullmag.data-volume-linux-copy-result.v2':
            qualification.require(event.get('inputs_sha256') == result['recovery_request_sha256'],
                                  'Recovered copy journal does not match its recovery request')
            copy_stage.require_current_copy_components(Path(__file__).resolve().parents[1],op,request,result)
        else:
            qualification.require(not os.path.lexists(failure) and event.get('inputs_sha256') == request_sha256,
                                  'Ordinary copy cannot supersede a failure or another request')
    else:
        qualification.require(not os.path.lexists(success) and event.get('state') == 'failed-confirmed' and
            event.get('inputs_sha256') == request_sha256,
                              'Root copy client failed without a confirmed terminal root failure')
        raw,result = qualification._read(failure,event['receipt_sha256'])
        qualification.require(set(result) == {'schema','state','volume_id','token','request_sha256','error_type',
            'originals_and_partial_copy_retained'} and
            result['schema'] == 'fullmag.data-volume-linux-copy-failure.v1' and result['state'] == 'failed-confirmed' and
            result['volume_id'] == request['volume_id'] and result['token'] == request['token'] and
            result['request_sha256'] == request_sha256 and result['originals_and_partial_copy_retained'] is True,
            'Root copy confirmed failure scope differs')
    return {'state':result['state'],'receipt_sha256':hashlib.sha256(raw).hexdigest(),'result':result}


def _new_log(op, name):
    parent = _open_directory_nofollow(op)
    try:
        fd = os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o640,dir_fd=parent)
        return os.fdopen(fd,'wb')
    finally:
        os.close(parent)


def _retained_observation(op, request, request_sha256, error, *, stage='copy'):
    """Best-effort single diagnostic; failure to log must not drop any lock."""
    value={'schema':'fullmag.data-volume-'+stage+'-client-observation.v1',
        'state':'outcome-unknown-resources-retained','volume_id':request['volume_id'],
        'token':request['token'],'request_sha256':request_sha256,'error_type':type(error).__name__}
    try:_document(op,'linux-'+stage+'-client-observation-error.json',value)
    except BaseException:pass
    try:print(json.dumps(value,sort_keys=True),flush=True)
    except BaseException:pass


def _await_terminal(fence, process, op, request, request_sha256, poll_interval, prior_error=None,
                    *, validator=None, stage='copy'):
    """Do not unwind the caller's host flock on an unconfirmed root outcome.

    A lost handle during spawn needs explicit recovery. With a known handle,
    poll/wait and receipt observation are retried for that same client. No
    timeout, exception or saved file substitutes for the verified terminal.
    """
    first_error=prior_error
    validator=validate_terminal if validator is None else validator
    if first_error is not None:_retained_observation(op,request,request_sha256,first_error,stage=stage)
    while True:
        try:
            if process is not None:
                if process.poll() is not None:
                    code=process.wait()
                    terminal=validator(op,request,request_sha256,code)
                    return terminal,first_error
                fence.check()
            time.sleep(poll_interval)
        except BaseException as error:
            if first_error is None:
                first_error=error
                _retained_observation(op,request,request_sha256,error,stage=stage)
            # A second interrupt also cannot drop a lock while the root copy
            # remains unconfirmed. The retained process is never restarted.
            try:time.sleep(poll_interval)
            except BaseException:pass


def run_root_copy(fence, source, distro, request_path, request_sha256, *, poll_interval=2.0):
    """Keep the already-held live guard until actual client terminal + proof.

    This function never restarts/kills a client and never releases on an
    observation timeout. Controlled unknown outcomes keep this supervisor and
    its caller's host lock alive. A hard supervisor death still needs the
    separate retained Docker/native ownership records and explicit recovery.
    """
    qualification.require(type(poll_interval) in (int,float) and 0 < poll_interval <= 5,
                          'Bounded root-client polling interval required')
    fence.check()
    command,op,request = prepare_command(fence,source,distro,request_path,request_sha256)
    return run_prepared_root('copy',fence,command,op,request,request_sha256,validate_terminal,
                             poll_interval=poll_interval)


def run_prepared_root(stage,fence,command,op,request,request_sha256,validator,*,
                      release_copy_sha256=None,poll_interval=2.0):
    """Supervise a prepared, source-pinned copy, bind or admission under one guard.

    Internal API only: its stage-specific caller authenticates literal argv and
    scope before entry. Bind and admission confirm their own terminal separately
    and release the copy-fence protocol with the original verified copy SHA.
    That protocol's copy_result_sha256 never changes meaning to a later receipt.
    """
    qualification.require(stage in ('copy','copy-recovery','bind','admission') and callable(validator),
                          'Only prepared copy/recovery/bind/admission root stages are supported')
    qualification.require(type(poll_interval) in (int,float) and 0 < poll_interval <= 5,
                          'Bounded root-client polling interval required')
    qualification.require((stage in ('copy','copy-recovery') and release_copy_sha256 is None) or
        (stage in ('bind','admission') and type(release_copy_sha256) is str and
         re.fullmatch('[0-9a-f]{64}',release_copy_sha256)),
        'Bind/admission release must acknowledge the exact original completed copy')
    operation = _operation_match(fence,request)
    prefix='linux-'+stage+'-client';record_prefix='data-'+stage+'-root-client'
    for suffix in ('-intent.json','-started.json','.stdout','.stderr','-observation-error.json'):
        qualification.require(not os.path.lexists(op/(prefix+suffix)),
                              'Root '+stage+' client already prepared; reconcile, never replay')
    _document(op,prefix+'-intent.json',{'schema':'fullmag.data-volume-'+stage+'-client.v1',
        'state':'prepared','volume_id':request['volume_id'],'token':request['token'],'request_sha256':request_sha256})
    with ExitStack() as stack:
        output = stack.enter_context(_new_log(op,prefix+'.stdout'))
        errors = stack.enter_context(_new_log(op,prefix+'.stderr'))
        fence.check()
        process=None;spawn_error=None
        try:
            process = subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=output,stderr=errors,start_new_session=True)
            operation['data_'+stage+'_root_process'] = process
            _document(op,prefix+'-started.json',{'schema':'fullmag.data-volume-'+stage+'-client.v1',
                'state':'started','volume_id':request['volume_id'],'token':request['token'],
                'request_sha256':request_sha256,'client_pid':process.pid})
            fence.control.write(operation['root']+'/'+record_prefix+'.json',{
                'client_pid':process.pid,'request_sha256':request_sha256,'state':'started'})
        except BaseException as error:
            spawn_error=error
        terminal,observation_error=_await_terminal(fence,process,op,request,request_sha256,poll_interval,spawn_error,
                                                  validator=validator,stage=stage)
        output.flush();os.fsync(output.fileno());errors.flush();os.fsync(errors.fileno())
        fence.check()
        fence.finish(terminal['receipt_sha256'] if stage in ('copy','copy-recovery') else release_copy_sha256)
        fence.control.write(operation['root']+'/'+record_prefix+'-terminal.json',terminal)
        if observation_error is not None:
            # Both native and host locks stayed held until a verified terminal.
            # Finalize the control lease as failed, without discarding the copy.
            operation['receipt'].update(state='failed-confirmed',**{
                'root_'+stage+'_terminal_confirmed':True,
                'root_'+stage+'_observation_error_type':type(observation_error).__name__})
            raise observation_error
        if terminal['state'] == 'failed-confirmed':
            raise RuntimeError('Root data '+stage+' failed; originals and partial artifacts retained')
        return terminal
