"""Copy an already provisioned, already drained group's data under live fences.

No automatic drain/start/replay, bind switch, admission, registration or source
retirement. A separate managed capture-terminal stop must precede this stage.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from contextvars import ContextVar
from copy import deepcopy
import hashlib
import os
from pathlib import Path
import re
import threading

from bootstrap_docker_toolchain import control_volume_name
from data_volume_copy_fence_service import COMPONENTS as FENCE_COMPONENTS
from docker_build_control import BuildControl, canonical, docker_capture
from docker_compose_identity import compose_project_identity
from docker_data_volume_copy_guard import CopyFence
from docker_data_volume_copy_job import run_root_copy
from docker_data_volume_stopped_group import observe_stopped_group
from docker_development_inputs import select_checkout
from docker_dev_data_volume import _decode, _runtime_pins
from docker_dev_host import validate_host_path
import fullmag_storage as storage
from fullmag_data_volume_guard import verify_registered_volume
from fullmag_data_volume_journal import append_started, append_terminal, next_phase
from fullmag_data_volume_linux_request import validate_linux_request
from fullmag_data_volume_runtime_binding import load_plan
import linux_data_volume_copy as root_copy
from linux_data_volume_format import _document, _publish_journal
import linux_data_volume_provision as qualification


PARENT_COMPONENTS = ('docker_dev_data_volume_copy.py','docker_data_volume_stopped_group.py',
                     'docker_data_volume_copy_job.py','docker_data_volume_copy_guard.py',
                     'docker_data_volume_root_bootstrap.py',
                     'docker_data_volume_relocated.py',
                     'fullmag_data_volume_pending.py','fullmag_data_volume_runtime_binding.py')
NEW_ARTIFACTS = ('group-drain-inputs.json','group-drained.json','group-drain-source-proof.json',
                 'copy-fence-ready.json','linux-copy-request.json','linux-copy-started.json',
                 'linux-copy-result.json','linux-copy-failed.json','linux-copy-client-intent.json',
                 'linux-copy-client-started.json','linux-copy-client.stdout','linux-copy-client.stderr',
                 'linux-copy-client-observation-error.json','source-manifest-export.json')

_CURRENT_COPY_SCOPE=ContextVar('fullmag_current_copied_group',default=None)


class _CopiedGroupScope(dict):
    """In-process continuation of the host lock, never a persisted capability."""
    def __init__(self,context,terminal):
        super().__init__(context=context,terminal=terminal)
        self._snapshot=deepcopy(dict(self));self._pid=os.getpid();self._thread=threading.get_ident()
        self._live=True


def require_live_copied_group(value):
    qualification.require(type(value) is _CopiedGroupScope and _CURRENT_COPY_SCOPE.get() is value and
        value._live is True and value._pid == os.getpid() and value._thread == threading.get_ident() and
        dict(value) == value._snapshot,
        'The original live copied-group host scope is required; snapshots cannot continue migration')
    return value


def _pins(source,names):
    result={}
    for name in names:
        raw=qualification._read_optional_regular(source/'scripts'/name,'migration controller source',maximum=4*1024**2)
        qualification.require(raw is not None,'Migration controller component is missing: '+name)
        result[name]=hashlib.sha256(raw).hexdigest()
    return result


def _load_base_source(source_root,volume_id):
    """Authenticate immutable provisioning scope, without admitting a phase."""
    qualification.require(os.name == 'posix' and type(volume_id) is str and
        re.fullmatch('[0-9a-f]{32}',volume_id) and volume_id != '0'*32,'Exact WSL volume identity required')
    source=select_checkout(Path(source_root),str(source_root));validate_host_path(source,'copy source checkout')
    layout=storage.resolve_layout(source,profile='docker-all-gpu');identity=compose_project_identity(layout)
    qualification.require(verify_registered_volume(layout,identity['project_name']) is None,
                          'Data volume already registered; do not replay its copy')
    op=Path(layout['storage_root'])/'migrations/data-volumes'/volume_id
    plan_raw,plan=qualification._read(op/'plan.json')
    qualification.require(plan.get('schema') == 'fullmag.data-volume-plan.v1' and plan.get('volume_id') == volume_id and
        plan.get('source_root') == str(source) and plan.get('project_id') == identity['project_id'] and
        plan.get('worktree_id') == identity['worktree_id'] and plan.get('compose_project') == identity['project_name'] and
        plan.get('storage_root') == layout['storage_root'],'Copy plan belongs to another selected group')
    _runtime_pins(plan['runtime_pins'])
    linux_raw,linux_value=qualification._read(op/'linux-provision-request.json')
    linux=validate_linux_request(linux_value)
    original_raw,plan,binding=load_plan(op,linux)
    qualification.require(original_raw == plan_raw,'Original migration plan changed while resolving its runtime')
    qualification.require(linux['source_roots'] == plan['observation']['datasets'] and
        linux['volume_id'] == volume_id and linux['storage_root'] == layout['storage_root'] and
        linux['mount_root'] == plan['mount_root'],'Copy datasets differ from the provisioned plan')
    provision_raw,provision=qualification._read(op/'linux-provision-result.json')
    qualification.require(provision.get('schema') == 'fullmag.data-volume-linux-provision-result.v1' and
        provision.get('state') == 'mounted-not-data-migrated' and provision.get('volume_id') == volume_id and
        provision.get('filesystem_uuid') == linux['filesystem_uuid'] and
        provision.get('linux_request_sha256') == hashlib.sha256(linux_raw).hexdigest() and
        provision.get('namespace_admitted') is False,'An exact completed formatter result is required')
    return {'source':source,'layout':layout,'identity':identity,'operation_root':op,'plan':plan,
        'plan_sha256':hashlib.sha256(plan_raw).hexdigest(),'linux':linux,'provision':provision,
        'linux_request_sha256':hashlib.sha256(linux_raw).hexdigest(),
        'provision_result_sha256':hashlib.sha256(provision_raw).hexdigest(),
        'runtime_binding':binding,'runtime_binding_sha256':linux.get('runtime_binding_sha256')}


def _load_source(source_root,volume_id):
    context=_load_base_source(source_root,volume_id)
    op=context['operation_root'];linux=context['linux'];provision=context['provision']
    journal_path,journal=qualification._selected_journal(op)
    qualification.require(journal['request_sha256'] == context['plan_sha256'] and
        next_phase(journal) == 'group-drained' and journal['events'][-1]['phase'] == 'ext4-mounted' and
        journal['events'][-1]['receipt_sha256'] == context['provision_result_sha256'],
        'Copy must follow the completed formatter exactly once')
    for name in NEW_ARTIFACTS:
        qualification.require(not os.path.lexists(op/name),'Copy has previous artifacts; reconcile, never replay')
    root_copy._source_roots(linux);root_copy._mounted_root(linux,provision)
    return dict(context,journal_path=journal_path,journal=journal)


def _existing_control(identity,image):
    # Never let an operational read helper create an absent volume implicitly.
    name=control_volume_name(identity['project_name'])
    observed=_decode(docker_capture('volume','inspect',name).stdout)
    qualification.require(type(observed) is list and len(observed) == 1 and
        observed[0].get('Name') == name and observed[0].get('Driver') == 'local' and not observed[0].get('Options') and
        (observed[0].get('Labels') or {}).get('org.fullmag.compose.project') == identity['project_name'],
        'Exact existing control volume required before any helper')
    control=BuildControl(identity,image)
    qualification.require(control.volume == name,'Selected control identity changed')
    return control


def _copy_under_host_lock(context,stop_attempt,stop_sha256):
    """Finish the copy operation before the caller starts another managed stage."""
    source=context['source'];op=context['operation_root'];plan=context['plan']
    volume_id=context['linux']['volume_id']
    parents=_pins(source,PARENT_COMPONENTS);components=_pins(source,root_copy.COMPONENTS)
    fence_components=_pins(source,FENCE_COMPONENTS)
    qualification.require(components['linux_data_volume_format.py'] ==
        qualification._read(op/'linux-provision-result.json')[1].get('formatter_sha256'),
        'Formatter source differs from the completed volume stage')
    control=_existing_control(context['identity'],plan['runtime_pins']['image_id'])
    inputs={'source_root':str(source),'image_id':control.image,'volume_id':volume_id,
        'plan_sha256':context['plan_sha256'],'stop_attempt':stop_attempt,'stop_sha256':stop_sha256,
            'runtime_binding_sha256':context.get('runtime_binding_sha256'),
        'parent_components':parents,'root_components':components,'fence_components':fence_components}
    # Use the existing 32GiB operation admission; no build-space policy change.
    with control.operation('data-volume-migration',inputs) as operation:
        snapshot=observe_stopped_group(control,source,plan,stop_attempt,stop_sha256)
        token=operation['receipt']['attempt']
        fence_request={'schema':'fullmag.data-copy-fence-request.v1','token':token,'volume_id':volume_id,
            'process_receipt_sha256':snapshot['process_receipt_sha256'],'components':fence_components,
            'source_roots':{role:{k:v[k] for k in ('device','inode')}
                            for role,v in context['linux']['source_roots'].items()}}
        with CopyFence(control,snapshot['actual']['backend'],source,fence_request) as fence:
            # Refresh the complete consumer and native stop proofs while
            # all five guards are held, not just before acquiring them.
            guarded=observe_stopped_group(control,source,plan,stop_attempt,stop_sha256,fence=fence)
            qualification.require(guarded['process_receipt_sha256'] == snapshot['process_receipt_sha256'] and
                guarded['source_proof'] == snapshot['source_proof'],'Terminal source state changed before its guard')
            qualification.require(_pins(source,PARENT_COMPONENTS) == parents and
                _pins(source,root_copy.COMPONENTS) == components,'Migration source components changed under guards')
            drain_inputs={'schema':'fullmag.data-volume-group-drain-inputs.v1','volume_id':volume_id,
                'token':token,'stop_attempt':stop_attempt,'stop_sha256':stop_sha256,
                'plan_sha256':context['plan_sha256'],'source_proof_sha256':hashlib.sha256(canonical(guarded['source_proof'])).hexdigest()}
            input_sha=_document(op,'group-drain-inputs.json',drain_inputs)
            started=append_started(context['journal'],'group-drained',input_sha)
            _publish_journal(context['journal_path'],context['journal'],started)
            _document(op,'group-drain-source-proof.json',guarded['source_proof'])
            drain={'schema':'fullmag.data-volume-group-drained.v1','volume_id':volume_id,'token':token,
                'plan_sha256':context['plan_sha256'],'source_roots':context['linux']['source_roots'],
                'stop_attempt':stop_attempt,'stop_sha256':stop_sha256,
                'process_receipt_sha256':guarded['process_receipt_sha256'],
                'containers':{k:plan['runtime_pins'][k] for k in ('backend','frontend')}}
            drain_sha=_document(op,'group-drained.json',drain)
            _publish_journal(context['journal_path'],started,append_terminal(started,'succeeded',drain_sha))
            ready_sha=_document(op,'copy-fence-ready.json',fence.ready)
            request={'schema':root_copy.SCHEMA,'volume_id':volume_id,'token':token,
                'storage_root':context['layout']['storage_root'],'linux_request_sha256':context['linux_request_sha256'],
                'provision_result_sha256':context['provision_result_sha256'],
                'drain_sha256':drain_sha,'fence_ready_sha256':ready_sha,'components':components}
            root_copy.validate_request(request)
            request_sha=_document(op,'linux-copy-request.json',request)
            terminal=run_root_copy(fence,source,plan['provision_request']['wsl_distro'],
                op/'linux-copy-request.json',request_sha)
            qualification.require(terminal['state'] == 'copied-and-verified-not-switched' and
                fence.released is True and operation['daemon_pending'] is False,
                'Root copy returned without its verified terminal acknowledgement')
        operation['receipt'].update(state='succeeded',image_id=control.image,
            copy_receipt_sha256=terminal['receipt_sha256'],volume_id=volume_id,
            data_migrated=False,copy_state=terminal['state'],originals_retired=False)
        return terminal


@contextmanager
def copied_group(source_root,volume_id,stop_attempt,stop_sha256):
    """Keep the host lock through a caller's copy-to-cutover continuation.

    The copy's Docker operation and native fence have a confirmed terminal
    before yielding. A subsequent managed stage can obtain its own operation
    without nesting Docker leases. The group remains stopped; this context
    neither switches binds nor admits or retires any dataset.
    """
    qualification.require(type(stop_attempt) is str and re.fullmatch('[0-9a-f]{32}',stop_attempt) and
        type(stop_sha256) is str and re.fullmatch('[0-9a-f]{64}',stop_sha256),'Exact completed stop pins required')
    context=_load_source(source_root,volume_id)
    with storage.build_lock(context['layout']):
        qualification.require(_load_source(source_root,volume_id) == context,
                              'Copy source scope changed before the host lock')
        terminal=_copy_under_host_lock(context,stop_attempt,stop_sha256)
        scope=_CopiedGroupScope(context,terminal);token=_CURRENT_COPY_SCOPE.set(scope)
        try:yield scope
        finally:
            scope._live=False
            _CURRENT_COPY_SCOPE.reset(token)


def copy_data_volume(source_root,volume_id,stop_attempt,stop_sha256):
    """One copy transaction; retain both originals and leave the group stopped."""
    with copied_group(source_root,volume_id,stop_attempt,stop_sha256) as copied:
        return copied['terminal']


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root',required=True)
    parser.add_argument('--volume-id',required=True)
    parser.add_argument('--stop-attempt',required=True)
    parser.add_argument('--stop-sha256',required=True)
    args=parser.parse_args(argv)
    import json
    print(json.dumps(copy_data_volume(args.source_root,args.volume_id,args.stop_attempt,args.stop_sha256),sort_keys=True))


if __name__=='__main__':main()
