"""Continue an exact live copied-group scope through a supervised bind.

No CLI, automatic drain/start, admission, registration or retirement. The
caller retains copied_group's host lock across this operation and later
qualification. Persisted snapshots cannot enter this continuation.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path

try:
    from . import docker_dev_data_volume_copy as copy_parent
except ImportError:
    import docker_dev_data_volume_copy as copy_parent
from data_volume_copy_fence_service import COMPONENTS as FENCE_COMPONENTS
from docker_compose_identity import compose_project_identity
from docker_data_volume_copy_guard import CopyFence
from docker_data_volume_copy_job import validate_terminal as copy_terminal
from docker_data_volume_stopped_group import observe_stopped_group
from docker_development_inputs import select_checkout
import fullmag_storage as storage
from fullmag_data_volume_guard import verify_registered_volume
from fullmag_data_volume_linux_request import validate_linux_request
from fullmag_data_volume_runtime_binding import load_plan
from linux_data_volume_format import _document
import linux_data_volume_bind as root_bind
import linux_data_volume_copy as root_copy
import linux_data_volume_provision as qualification


_existing_control=copy_parent._existing_control
PARENT_COMPONENTS=(*copy_parent.PARENT_COMPONENTS,'docker_dev_data_volume_bind.py','docker_data_volume_bind_job.py')
NEW_ARTIFACTS=(*root_bind.ARTIFACTS,'bind-fence-ready.json','linux-bind-request.json',
    'linux-bind-client-intent.json','linux-bind-client-started.json','linux-bind-client.stdout',
    'linux-bind-client.stderr','linux-bind-client-observation-error.json')


def run_root_bind(*args,**kwargs):
    # Package and direct-script users must retain the same copy-parent module
    # that owns their live ContextVar; the job itself needs no host capability.
    if __package__:
        from .docker_data_volume_bind_job import run_root_bind as run
    else:
        from docker_data_volume_bind_job import run_root_bind as run
    return run(*args,**kwargs)


def _load_completed(copied):
    scope=copy_parent.require_live_copied_group(copied);previous=scope['context']
    require=qualification.require
    source=select_checkout(previous['source'],str(previous['source']))
    layout=storage.resolve_layout(source,profile='docker-all-gpu');identity=compose_project_identity(layout)
    require(source == previous['source'] and layout == previous['layout'] and identity == previous['identity'],
            'Copied group source/configuration changed inside its host scope')
    require(verify_registered_volume(layout,identity['project_name']) is None,
            'Copied group already registered; do not replay its cutover')
    op=previous['operation_root'];terminal=scope['terminal']
    require(terminal['state'] == 'copied-and-verified-not-switched','A verified successful copy is required')
    request_sha=terminal['result']['request_sha256']
    _,request_value=qualification._read(op/'linux-copy-request.json',request_sha)
    request=root_copy.validate_request(request_value)
    require(op == Path(layout['storage_root'])/'migrations/data-volumes'/request['volume_id'] and
        request['storage_root'] == layout['storage_root'],'Copied operation scope changed')
    _,journal=qualification._selected_journal(op)
    require(journal['volume_id'] == request['volume_id'] and journal['request_sha256'] == previous['plan_sha256'],
            'Copied journal scope differs from the original volume/plan')
    require(copy_terminal(op,request,request_sha,0) == terminal,
            'The original live copy terminal changed before cutover')
    linux_raw,linux_value=qualification._read(op/'linux-provision-request.json',request['linux_request_sha256'])
    linux=validate_linux_request(linux_value)
    plan_raw,plan,_binding=load_plan(op,linux)
    require(hashlib.sha256(plan_raw).hexdigest() == previous['plan_sha256'] and plan == previous['plan'] and
        linux == previous['linux'] and hashlib.sha256(linux_raw).hexdigest() == previous['linux_request_sha256'],
        'Original plan or Linux successor scope changed after copy')
    provision_raw,provision=qualification._read(op/'linux-provision-result.json',request['provision_result_sha256'])
    require(hashlib.sha256(provision_raw).hexdigest() == previous['provision_result_sha256'] and
        provision['formatter_sha256'] == request['components']['linux_data_volume_format.py'],
        'Completed formatter changed before cutover')
    _,drain=qualification._read(op/'group-drained.json',request['drain_sha256'])
    require(drain['volume_id'] == request['volume_id'] and drain['token'] == request['token'] and
        drain['plan_sha256'] == previous['plan_sha256'] and drain['source_roots'] == linux['source_roots'] and
        drain['containers'] == {k:plan['runtime_pins'][k] for k in ('backend','frontend')},
        'Copied terminal drain belongs to another source scope')
    for name in NEW_ARTIFACTS:
        require(not os.path.lexists(op/name),'Bind has previous artifacts; reconcile, never replay')
    require(copy_parent._pins(source,root_copy.COMPONENTS) == request['components'],
            'Completed root-copy component source changed before cutover')
    root_copy._source_roots(linux);root_copy._mounted_root(linux,provision)
    return dict(previous,source=source,layout=layout,identity=identity,plan=plan,linux=linux,drain=drain,
                copy_request=request,copy_request_sha256=request_sha,copy_receipt_sha256=terminal['receipt_sha256'],
                copy_result=terminal['result'])


def bind_copied_group(copied):
    """One bind operation inside the same host scope, without nested leases."""
    copy_parent.require_live_copied_group(copied);context=_load_completed(copied)
    source=context['source'];op=context['operation_root'];plan=context['plan'];drain=context['drain']
    volume=context['linux']['volume_id'];pins=copy_parent._pins
    parents=pins(source,PARENT_COMPONENTS);components=pins(source,root_bind.COMPONENTS)
    fences=pins(source,FENCE_COMPONENTS)
    control=_existing_control(context['identity'],plan['runtime_pins']['image_id'])
    inputs={'source_root':str(source),'image_id':control.image,'volume_id':volume,'stage':'binds-switched',
        'plan_sha256':context['plan_sha256'],'copy_request_sha256':context['copy_request_sha256'],
        'copy_receipt_sha256':context['copy_receipt_sha256'],'runtime_binding_sha256':context.get('runtime_binding_sha256'),
        'parent_components':parents,'root_components':components,'fence_components':fences}
    with control.operation('data-volume-migration',inputs) as operation:
        copy_parent.require_live_copied_group(copied)
        qualification.require(_load_completed(copied) == context,'Copied context changed under the bind operation')
        snapshot=observe_stopped_group(control,source,plan,drain['stop_attempt'],drain['stop_sha256'])
        qualification.require(snapshot['process_receipt_sha256'] == drain['process_receipt_sha256'],
                              'Native terminal drain changed since the verified copy')
        token=operation['receipt']['attempt']
        request={'schema':'fullmag.data-copy-fence-request.v1','token':token,'volume_id':volume,
            'process_receipt_sha256':snapshot['process_receipt_sha256'],'components':fences,
            'source_roots':{role:{k:p[k] for k in ('device','inode')} for role,p in context['linux']['source_roots'].items()}}
        with CopyFence(control,snapshot['actual']['backend'],source,request) as fence:
            guarded=observe_stopped_group(control,source,plan,drain['stop_attempt'],drain['stop_sha256'],fence=fence)
            qualification.require(guarded['source_proof'] == snapshot['source_proof'] and
                guarded['process_receipt_sha256'] == snapshot['process_receipt_sha256'],
                'Terminal source state changed while acquiring bind guards')
            qualification.require(pins(source,PARENT_COMPONENTS) == parents and
                pins(source,root_bind.COMPONENTS) == components,'Bind source changed under its guards')
            ready_sha=_document(op,'bind-fence-ready.json',fence.ready)
            root_request={'schema':root_bind.SCHEMA,'volume_id':volume,'storage_root':context['layout']['storage_root'],
                'token':token,'copy_request_sha256':context['copy_request_sha256'],
                'copy_receipt_sha256':context['copy_receipt_sha256'],'fence_ready_sha256':ready_sha,'components':components}
            root_bind.validate_request(root_request);request_sha=_document(op,'linux-bind-request.json',root_request)
            terminal=run_root_bind(fence,source,plan['provision_request']['wsl_distro'],op/'linux-bind-request.json',request_sha)
            qualification.require(terminal['state'] == 'binds-switched-not-admitted' and
                fence.released is True and operation['daemon_pending'] is False,
                'Bind returned without its verified terminal and copy-fence acknowledgement')
        operation['receipt'].update(state='succeeded',volume_id=volume,bind_state=terminal['state'],
            bind_receipt_sha256=terminal['receipt_sha256'],copy_receipt_sha256=context['copy_receipt_sha256'],
            namespace_admitted=False,data_migrated=False,originals_retired=False)
    copy_parent.require_live_copied_group(copied)
    return {'context':context,'terminal':terminal}
