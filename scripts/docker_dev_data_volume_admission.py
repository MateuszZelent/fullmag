"""Continue one live copied/bound host scope through root admission preparation.

No CLI, startup, namespace admission, registration or retirement. The original
copied_group keeps its host lock; this stage owns a separate managed operation
and relocated OLD native fences until the root client's actual terminal.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import os
from pathlib import Path
import threading

try:
    from . import docker_dev_data_volume_bind as bind_parent
except ImportError:
    import docker_dev_data_volume_bind as bind_parent
from data_volume_copy_fence_service import COMPONENTS as FENCE_COMPONENTS
from docker_compose_identity import compose_project_identity
from docker_data_volume_copy_guard import CopyFence
from docker_data_volume_relocated import require_relocated
from docker_data_volume_stopped_group import observe_stopped_group
from docker_development_inputs import select_checkout
import fullmag_storage as storage
from linux_data_volume_format import _document
import linux_data_volume_admission as root_admission
import linux_data_volume_provision as qualification


copy_parent=bind_parent.copy_parent
_existing_control=copy_parent._existing_control
require=qualification.require
PARENT_COMPONENTS=(*bind_parent.PARENT_COMPONENTS,'docker_dev_data_volume_admission.py','docker_data_volume_admission_job.py')
NEW_ARTIFACTS=(*root_admission.ARTIFACTS,'admission-fence-ready.json','linux-admission-request.json',
    'linux-admission-client-intent.json','linux-admission-client-started.json','linux-admission-client.stdout',
    'linux-admission-client.stderr','linux-admission-client-observation-error.json')


def run_root_admission(*args,**kwargs):
    if __package__:
        from .docker_data_volume_admission_job import run_root_admission as run
    else:
        from docker_data_volume_admission_job import run_root_admission as run
    return run(*args,**kwargs)


def _check_bound(copied,context,relocated):
    copy_parent.require_live_copied_group(copied)
    source=select_checkout(context['source'],str(context['source']))
    layout=storage.resolve_layout(source,profile='docker-all-gpu')
    require(source == context['source'] and layout == context['layout'] and
        compose_project_identity(layout) == context['identity'],'Bound source/configuration changed inside its host scope')
    require_relocated(relocated,source,context['plan'])


def _load_bound(copied,bound):
    copy_parent.require_live_copied_group(copied)
    relocated=bind_parent.relocated_copied_group(copied,bound)
    context=dict(bound['context']);op=context['operation_root'];terminal=bound['terminal']
    _check_bound(copied,context,relocated)
    require(op == Path(context['layout']['storage_root'])/'migrations/data-volumes'/context['linux']['volume_id'],
            'Bound admission operation changed its selected storage scope')
    _,request=qualification._read(op/'linux-bind-request.json',terminal['result']['request_sha256'])
    request=bind_parent.root_bind.validate_request(request)
    _,copy_request=qualification._read(op/'linux-copy-request.json',request['copy_request_sha256'])
    copy_request=bind_parent.root_copy.validate_request(copy_request)
    _,drain=qualification._read(op/'group-drained.json',copy_request['drain_sha256'])
    require(context.get('copy_receipt_sha256') == request['copy_receipt_sha256'] == copied['terminal']['receipt_sha256'] and
        context.get('copy_request_sha256') == request['copy_request_sha256'] and
        context.get('copy_request') == copy_request and context.get('drain') == drain,
        'Bound context differs from its immutable copy/drain predecessors')
    for name in NEW_ARTIFACTS:require(not os.path.lexists(op/name),'Admission has previous artifacts; reconcile, never replay')
    return context,relocated


class _PreparedGroup(dict):
    def __init__(self,copied,context,bound_terminal,terminal,relocated,native_before):
        super().__init__(context=context,bound_terminal=bound_terminal,terminal=terminal,relocated=relocated,
                         native_before=deepcopy(native_before))
        self._copied=copied;self._relocated=relocated;self._pid=os.getpid();self._thread=threading.get_ident()
        self._snapshot=deepcopy({key:self[key] for key in ('context','bound_terminal','terminal','native_before')})


def require_prepared_group(value):
    require(type(value) is _PreparedGroup,'The original prepared-group scope is required')
    copy_parent.require_live_copied_group(value._copied)
    require(getattr(value._copied,'_prepared_admission',None) is value and value._pid == os.getpid() and
        value._thread == threading.get_ident() and set(value) == {'context','bound_terminal','terminal','relocated','native_before'} and
        value['relocated'] is value._relocated and
        {key:value[key] for key in ('context','bound_terminal','terminal','native_before')} == value._snapshot,
        'Prepared group was not issued by the live admission parent or its inputs changed')
    _check_bound(value._copied,value['context'],value._relocated)
    return value


def prepare_bound_group(copied,bound):
    """One supervised preparation operation, retaining the original host lock."""
    copy_parent.require_live_copied_group(copied)
    require(getattr(copied,'_prepared_admission',None) is None,'This copied host scope already prepared admission')
    context,relocated=_load_bound(copied,bound)
    source=context['source'];op=context['operation_root'];plan=context['plan'];drain=context['drain']
    pins=copy_parent._pins;volume=context['linux']['volume_id']
    parents=pins(source,PARENT_COMPONENTS);components=pins(source,root_admission.COMPONENTS);fences=pins(source,FENCE_COMPONENTS)
    control=_existing_control(context['identity'],plan['runtime_pins']['image_id'])
    inputs={'source_root':str(source),'image_id':control.image,'volume_id':volume,'stage':'admission-prepared',
        'plan_sha256':context['plan_sha256'],'bind_request_sha256':bound['terminal']['result']['request_sha256'],
        'bind_receipt_sha256':bound['terminal']['receipt_sha256'],'copy_receipt_sha256':context['copy_receipt_sha256'],
        'runtime_binding_sha256':context.get('runtime_binding_sha256'),
        'parent_components':parents,'root_components':components,'fence_components':fences}
    with control.operation('data-volume-migration',inputs) as operation:
        _check_bound(copied,context,relocated)
        for name in NEW_ARTIFACTS:require(not os.path.lexists(op/name),'Admission artifacts appeared before its operation')
        snapshot=observe_stopped_group(control,source,plan,drain['stop_attempt'],drain['stop_sha256'],relocated=relocated)
        require(snapshot['process_receipt_sha256'] == drain['process_receipt_sha256'],'Native drain changed since the verified copy')
        token=operation['receipt']['attempt']
        request={'schema':'fullmag.data-copy-fence-request.v1','token':token,'volume_id':volume,
            'process_receipt_sha256':snapshot['process_receipt_sha256'],'components':fences,
            'source_roots':{role:{key:p[key] for key in ('device','inode')} for role,p in context['linux']['source_roots'].items()}}
        with CopyFence(control,snapshot['actual']['backend'],source,request,relocated=relocated) as fence:
            guarded=observe_stopped_group(control,source,plan,drain['stop_attempt'],drain['stop_sha256'],fence=fence,relocated=relocated)
            require(guarded['source_proof'] == snapshot['source_proof'] and
                guarded['process_receipt_sha256'] == snapshot['process_receipt_sha256'],
                'Terminal source state changed while acquiring admission guards')
            _check_bound(copied,context,relocated)
            require(pins(source,PARENT_COMPONENTS) == parents and pins(source,root_admission.COMPONENTS) == components,
                    'Admission source changed under its guards')
            ready_sha=_document(op,'admission-fence-ready.json',fence.ready)
            root_request={'schema':root_admission.SCHEMA,'volume_id':volume,'storage_root':context['layout']['storage_root'],
                'token':token,'bind_request_sha256':bound['terminal']['result']['request_sha256'],
                'bind_receipt_sha256':bound['terminal']['receipt_sha256'],'fence_ready_sha256':ready_sha,'components':components}
            root_admission.validate_request(root_request);request_sha=_document(op,'linux-admission-request.json',root_request)
            terminal,native_before=run_root_admission(fence,source,plan['provision_request']['wsl_distro'],
                op/'linux-admission-request.json',request_sha,retain_native_snapshot=True)
            require(terminal['state'] == 'admission-prepared-not-admitted' and fence.released is True and
                operation['daemon_pending'] is False and all(terminal['result'].get(key) is False for key in
                ('namespace_admitted','data_migrated','originals_retired')),
                'Admission returned without its verified terminal and original-copy acknowledgement')
        operation['receipt'].update(state='succeeded',volume_id=volume,admission_receipt_sha256=terminal['receipt_sha256'],
            bind_receipt_sha256=bound['terminal']['receipt_sha256'],copy_receipt_sha256=context['copy_receipt_sha256'],
            namespace_admitted=False,data_migrated=False,originals_retired=False)
    _check_bound(copied,context,relocated)
    prepared=_PreparedGroup(copied,context,bound['terminal'],terminal,relocated,native_before)
    copied._prepared_admission=prepared
    return prepared
