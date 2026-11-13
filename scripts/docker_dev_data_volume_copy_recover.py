"""Requalify a retained copy under a new live host/native migration scope.

No original copy, drain replay, mount, bind, admission or Solve is performed.
The caller supplies immutable pins for the one confirmed failed predecessor.
"""
from contextlib import contextmanager
import os
from pathlib import Path
import re

try:
    from . import docker_dev_data_volume_copy as copy_parent
    from . import docker_data_volume_copy_job as original_job
    from . import docker_data_volume_copy_recovery_job as recovery_job
except ImportError:
    import docker_dev_data_volume_copy as copy_parent
    import docker_data_volume_copy_job as original_job
    import docker_data_volume_copy_recovery_job as recovery_job
from data_volume_copy_fence_service import COMPONENTS as FENCE_COMPONENTS
from docker_data_volume_copy_guard import CopyFence
from docker_data_volume_stopped_group import observe_stopped_group
from fullmag_data_volume_journal import validate_journal,next_phase
from linux_data_volume_format import _document,_publish_journal
import fullmag_storage as storage
import linux_data_volume_copy as root_copy
import linux_data_volume_provision as qualification

PARENT_COMPONENTS=(*copy_parent.PARENT_COMPONENTS,'docker_dev_data_volume_copy_recover.py',
                   'docker_data_volume_copy_recovery_job.py')
NO_LATER_ARTIFACTS=('linux-copy-result.json','source-manifest-export.json','linux-bind-request.json',
    'linux-bind-started.json','linux-bind-result.json','linux-bind-failed.json',
    'copy-recovery-prepared.json','registration-committed.json')


def _load_failed(source_root,volume_id,request_sha256,failure_sha256,journal_sha256):
    require=qualification.require
    require(all(type(v) is str and re.fullmatch('[0-9a-f]{64}',v)
                for v in (request_sha256,failure_sha256,journal_sha256)),
            'Exact failed-copy request, failure and journal SHA pins required')
    context=copy_parent._load_base_source(source_root,volume_id)
    op=context['operation_root'];linux=context['linux']
    _,old_value=qualification._read(op/'linux-copy-request.json',request_sha256)
    old=root_copy.validate_request(old_value)
    require(old['volume_id']==volume_id and old['storage_root']==context['layout']['storage_root'] and
        old['linux_request_sha256']==context['linux_request_sha256'] and
        old['provision_result_sha256']==context['provision_result_sha256'],
        'Failed copy differs from the authenticated mounted scope')
    journal_path,journal=qualification._selected_journal(op)
    raw,current=qualification._read(journal_path,journal_sha256)
    require(current==journal and journal['request_sha256']==context['plan_sha256'] and len(journal['events'])==10,
            'Recovery requires the exact selected failed copy journal')
    require(journal['events'][-1]['phase']=='copy-verified' and
        journal['events'][-1]['state']=='failed-confirmed' and
        journal['events'][-1]['receipt_sha256']==failure_sha256 and
        all(e['inputs_sha256']==request_sha256 for e in journal['events'][-2:]),
        'Recovery predecessor is not the pinned confirmed copy failure')
    terminal=original_job.validate_terminal(op,old,request_sha256,1)
    require(terminal['receipt_sha256']==failure_sha256,'Confirmed root failure SHA differs')
    _,drain=qualification._read(op/'group-drained.json',old['drain_sha256'])
    require(drain['volume_id']==volume_id and drain['token']==old['token'] and
        drain['plan_sha256']==context['plan_sha256'] and drain['source_roots']==linux['source_roots'] and
        drain['containers']=={k:context['plan']['runtime_pins'][k] for k in ('backend','frontend')},
        'Failed copy drain belongs to another original scope')
    recovery_job.validate_original_history(op,old,request_sha256,drain)
    prefix=validate_journal(dict(journal,events=journal['events'][:8]))
    require(next_phase(prefix)=='copy-verified' and prefix['events'][-1]['receipt_sha256']==old['drain_sha256'],
            'Failed copy has no exact successful drain prefix')
    for name in NO_LATER_ARTIFACTS:
        require(not os.path.lexists(op/name),'Recovery has prior/later artifacts; reconcile, never replay')
    from fullmag_data_volume_pending import pending_path
    require(not os.path.lexists(pending_path(context['layout'])),'Pending cutover cannot enter copy recovery')
    root_copy._source_roots(linux);root_copy._mounted_root(linux,context['provision'])
    return dict(context,original_request=old,original_request_sha256=request_sha256,
        failed_copy_receipt_sha256=failure_sha256,failed_journal_path=journal_path,
        failed_journal_sha256=journal_sha256,failed_journal=journal,prefix=prefix,drain=drain,
        original_terminal=terminal)


def _confirmed_prior_client(control,context):
    """The previous daemon/client terminal is evidence, never a live lease."""
    old=context['original_request'];root='data-volume-migration/attempts/'+old['token']
    # Control reads are bounded by the existing authenticated volume adapter.
    import json
    receipt=json.loads(control.read_bytes(root+'/terminal.json'))
    require=qualification.require
    require(receipt.get('phase')=='data-volume-migration' and receipt.get('state')=='failed-confirmed' and
        receipt.get('attempt')==old['token'] and receipt.get('compose_project')==control.project and
        receipt.get('control_volume')==control.volume and
        receipt.get('inputs',{}).get('source_root')==str(context['source']) and
        receipt.get('inputs',{}).get('volume_id')==old['volume_id'],
        'The original migration operation has no matching confirmed daemon terminal')
    terminal=json.loads(control.read_bytes(root+'/data-copy-root-client-terminal.json'))
    require(terminal==context['original_terminal'],'Original root client terminal does not match its confirmed failure')


def _prepare_probe(context,token,control):
    """Observe root-only refusal gates before native guards or selector change."""
    op=context['operation_root'];require=qualification.require
    relative=context['failed_journal_path'].relative_to(op).as_posix()
    require(re.fullmatch(r'recovery/[0-9a-f]{32}/journal\.json',relative),
            'Exact preserved recovery predecessor path required')
    attempt=op/'recovery'/token
    require(not os.path.lexists(attempt),'Recovery attempt already exists; never replay')
    attempt.mkdir(mode=0o755)
    previous_raw,previous=qualification._read(op/'active-attempt.json')
    with (attempt/'previous-active-attempt.json').open('xb') as stream:
        stream.write(previous_raw);stream.flush();os.fsync(stream.fileno())
    prefix_sha=_document(attempt,'journal.json',context['prefix'])
    request={'schema':'fullmag.data-volume-copy-recovery-probe.v1','volume_id':context['linux']['volume_id'],
        'storage_root':context['layout']['storage_root'],'token':token,
        'original_copy_request_sha256':context['original_request_sha256'],
        'failed_copy_receipt_sha256':context['failed_copy_receipt_sha256'],
        'failed_journal_relative':relative,'failed_journal_sha256':context['failed_journal_sha256'],
        'selector_sha256':qualification.digest(previous_raw),'recovery_journal_sha256':prefix_sha,
        'fence_ready_sha256':context['original_request']['fence_ready_sha256'],
        'components':copy_parent._pins(context['source'],root_copy.COMPONENTS)}
    root_copy.validate_recovery_probe_request(request)
    probe_sha=_document(attempt,'copy-recovery-probe-request.json',request)
    observation=recovery_job.run_root_probe(control,context['source'],context['plan']['provision_request']['wsl_distro'],
        attempt/'copy-recovery-probe-request.json',probe_sha)
    _document(attempt,'probe-readiness.json',observation)
    return {'attempt':attempt,'previous_raw':previous_raw,'previous':previous,'probe':request,
            'probe_sha256':probe_sha,'probe_result':observation}


def _prepare(context,token,fence,prepared):
    op=context['operation_root'];require=qualification.require
    attempt=op/'recovery'/token
    require(prepared['attempt']==attempt,'Prepared read-only probe belongs to another attempt')
    _,observed=qualification._read(attempt/'probe-readiness.json')
    require(observed==prepared['probe_result'] and observed['request_sha256']==prepared['probe_sha256'] and
        observed['state']=='ready-for-copy-recovery' and observed['token']==token,
        'Prepared root readiness observation changed')
    previous_raw,_=qualification._read(op/'active-attempt.json')
    require(previous_raw==prepared['previous_raw'],'Previous selector changed after the read-only probe')
    request=dict(prepared['probe'],schema='fullmag.data-volume-copy-recovery-request.v1')
    ready_sha=_document(attempt,'fence-ready.json',fence.ready)
    selector={'schema':'fullmag.data-volume-active-recovery.v2','volume_id':context['linux']['volume_id'],
        'attempt':token,'journal_relative':'recovery/'+token+'/journal.json',
        'parent_journal_relative':request['failed_journal_relative'],
        'parent_journal_sha256':context['failed_journal_sha256'],'state':'started'}
    _document(op,'copy-recovery-prepared.json',{'schema':'fullmag.copy-recovery-prepared.v1','token':token,
        'failed_journal_sha256':context['failed_journal_sha256'],
        'previous_selector_sha256':qualification.digest(previous_raw),'probe_request_sha256':prepared['probe_sha256']})
    path,now=qualification._selected_journal(op)
    require(path==context['failed_journal_path'] and now==context['failed_journal'],
            'Failed predecessor changed before selector publication')
    _publish_journal(op/'active-attempt.json',prepared['previous'],selector)
    selector_raw,_=qualification._read(op/'active-attempt.json')
    request.update(selector_sha256=qualification.digest(selector_raw),fence_ready_sha256=ready_sha)
    root_copy.validate_recovery_request(request)
    request_sha=_document(attempt,'copy-recovery-request.json',request)
    return attempt,request_sha


@contextmanager
def recover_copied_group(source_root,volume_id,request_sha256,failure_sha256,journal_sha256):
    context=_load_failed(source_root,volume_id,request_sha256,failure_sha256,journal_sha256)
    with storage.build_lock(context['layout']):
        qualification.require(_load_failed(source_root,volume_id,request_sha256,failure_sha256,journal_sha256)==context,
                              'Failed-copy scope changed before the hostlock')
        source=context['source'];plan=context['plan'];drain=context['drain']
        control=copy_parent._existing_control(context['identity'],plan['runtime_pins']['image_id'])
        _confirmed_prior_client(control,context)
        parents=copy_parent._pins(source,PARENT_COMPONENTS);components=copy_parent._pins(source,root_copy.COMPONENTS)
        fences=copy_parent._pins(source,FENCE_COMPONENTS)
        inputs={'source_root':str(source),'image_id':control.image,'volume_id':volume_id,'stage':'recover-copy',
            'original_copy_request_sha256':request_sha256,'failed_copy_receipt_sha256':failure_sha256,
            'failed_journal_sha256':journal_sha256,'parent_components':parents,'root_components':components,
            'fence_components':fences}
        with control.operation('data-volume-migration',inputs) as operation:
            extra=(Path(context['linux']['mount_root']),)
            snapshot=observe_stopped_group(control,source,plan,drain['stop_attempt'],drain['stop_sha256'],
                                           extra_consumer_roots=extra)
            qualification.require(snapshot['process_receipt_sha256']==drain['process_receipt_sha256'],
                                  'Native terminal state changed since the failed copy')
            token=operation['receipt']['attempt']
            prepared=_prepare_probe(context,token,control)
            qualification.require(_load_failed(source_root,volume_id,request_sha256,failure_sha256,journal_sha256)==context,
                                  'Failed copy metadata changed during its read-only probe')
            fence_request={'schema':'fullmag.data-copy-fence-request.v1','token':token,'volume_id':volume_id,
                'process_receipt_sha256':snapshot['process_receipt_sha256'],'components':fences,
                'source_roots':{role:{k:p[k] for k in ('device','inode')} for role,p in context['linux']['source_roots'].items()}}
            with CopyFence(control,snapshot['actual']['backend'],source,fence_request) as fence:
                guarded=observe_stopped_group(control,source,plan,drain['stop_attempt'],drain['stop_sha256'],
                    fence=fence,extra_consumer_roots=extra)
                qualification.require(guarded['source_proof']==snapshot['source_proof'] and
                    guarded['process_receipt_sha256']==snapshot['process_receipt_sha256'] and
                    copy_parent._pins(source,PARENT_COMPONENTS)==parents and
                    copy_parent._pins(source,root_copy.COMPONENTS)==components,
                    'Recovery source or terminal state changed under native guards')
                attempt,recovery_sha=_prepare(context,token,fence,prepared)
                terminal=recovery_job.run_root_recovery(fence,source,plan['provision_request']['wsl_distro'],
                    attempt/'copy-recovery-request.json',recovery_sha)
                qualification.require(terminal['state']=='copied-and-verified-not-switched' and fence.released is True and
                    operation['daemon_pending'] is False,'Recovered copy lacks its confirmed terminal and native acknowledgement')
            operation['receipt'].update(state='succeeded',volume_id=volume_id,copy_receipt_sha256=terminal['receipt_sha256'],
                completion_mode='requalified-existing-archive-and-payload',originals_retired=False)
        scope=copy_parent._CopiedGroupScope(context,terminal)
        marker=copy_parent._CURRENT_COPY_SCOPE.set(scope)
        try:yield scope
        finally:
            scope._live=False
            copy_parent._CURRENT_COPY_SCOPE.reset(marker)
