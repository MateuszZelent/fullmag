"""Read-only authority for an explicitly pinned stopped diagnostic predecessor.

This only hydrates missing service IDs in memory. Native ownership and the full
ledger/store/run closure remain mandatory in the caller's snapshot protocol.
"""
from __future__ import annotations

import hashlib
from pathlib import PurePosixPath
import re
import uuid

from docker_build_control import BuildControlError, canonical
from docker_volume_reconcile import fingerprint
import docker_linux_host_readmission as retained

SCHEMA = 'fullmag.docker-preowner-policy-stop.v1'
REFUSAL = 'stored host resource policy differs from explicit ledger configuration'


def _require(condition, message):
    if not condition:
        raise BuildControlError('Stopped predecessor: '+message)


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _relative(value):
    _require(isinstance(value,str) and len(value)<=512
             and re.fullmatch(r'[A-Za-z0-9_./-]+',value) is not None
             and not value.startswith('/') and str(PurePosixPath(value))==value
             and not any(part in ('.','..') for part in value.split('/')), 'unsafe control path')
    return value


def load_stopped_predecessor(control, pins, original_terminal_raw, proof_relative_path, expected_sha):
    """Return (normalized bytes, namespace-prefixed raw CAS pins, service pins)."""
    retained._sha(expected_sha,'explicit stopped-proof SHA-256')
    for key,pattern in (('development_attempt',retained._ATTEMPT),('backend_container_id',retained._CONTAINER_ID),
                        ('frontend_container_id',retained._CONTAINER_ID),('old_image_id',retained._IMAGE_ID)):
        _require(isinstance(pins.get(key),str) and pattern.fullmatch(pins[key]) is not None,'malformed operator '+key)
    _require(proof_relative_path=='verification/preowner-policy-stop-'+pins['backend_container_id']+'.json',
             'proof path does not identify the pinned backend')
    documents={}
    def read(path):
        path=_relative(path)
        raw=retained._read_control(control,path)
        documents[(control.namespace+'/' if control.namespace else '')+path]=raw
        return raw
    terminal=retained._parse_object(original_terminal_raw,'original failed development terminal')
    meta={'schema':'fullmag.docker-build-operation.v1','compose_project':control.project,
          'control_volume':control.volume,'control_namespace':control.namespace,
          'namespace_registry_sha256':control.namespace_registry_sha256}
    expected=dict(meta,phase='development',state='failed-confirmed',attempt=pins['development_attempt'],
                  config_sha256=pins['compose_config_sha256'])
    _require(all(terminal.get(k)==v for k,v in expected.items()),'original terminal authority differs')
    inputs=terminal.get('inputs',{})
    _require(isinstance(inputs,dict) and inputs.get('source_root')==pins['source_root']
             and inputs.get('image_id')==pins['old_image_id'], 'original source/image differs')
    _require(read('development/current.json')==original_terminal_raw,'original terminal is no longer current')
    terminal_path,_=retained._terminal_paths(pins['development_attempt'])
    _require(read(terminal_path)==original_terminal_raw,'immutable development terminal differs')
    raw=read(proof_relative_path)
    _require(_sha(raw)==expected_sha,'explicit stopped-proof digest differs')
    proof=retained._parse_object(raw,'stopped predecessor proof')
    _require(proof.get('schema')==SCHEMA and proof.get('state')=='stopped-confirmed'
             and proof.get('data_preserved') is True and proof.get('native_owner_drained') is False,
             'proof is not a data-preserving diagnostic stop')
    plan=proof.get('plan');_require(isinstance(plan,dict),'missing stop plan')
    plan_sha=retained._sha(proof.get('plan_sha256'),'stop plan SHA-256')
    _require(_sha(canonical(plan))==plan_sha and plan.get('schema')==SCHEMA
             and plan.get('development_attempt')==pins['development_attempt']
             and plan.get('config_sha256')==pins['compose_config_sha256']
             and plan.get('development_terminal_sha256')==_sha(original_terminal_raw), 'plan authority differs')
    controller=retained._sha(plan.get('controller_sha256'),'stop controller SHA-256')
    retained._sha(plan.get('probe_sha256'),'stop probe SHA-256')
    operation_root=proof.get('operation_root')
    _require(isinstance(operation_root,str) and re.fullmatch(
        r'preowner-policy-stop/attempts/[0-9a-f]{32}',operation_root) is not None,'invalid stop operation root')
    operation=retained._parse_object(read(operation_root+'/terminal.json'),'stop operation terminal')
    expected=dict(meta,phase='preowner-policy-stop',state='succeeded',attempt=operation_root.rsplit('/',1)[1])
    _require(all(operation.get(k)==v for k,v in expected.items()),'stop operation authority differs')
    expected_inputs={'attempt':pins['development_attempt'],'config_sha256':pins['compose_config_sha256'],
                     'source_root':pins['source_root'],'backend_container_id':pins['backend_container_id'],
                     'image_id':pins['old_image_id'],'controller_sha256':controller}
    _require(operation.get('inputs')==expected_inputs,'stop operation inputs differ')
    result=operation.get('result',{})
    _require(isinstance(result,dict) and result.get('state')=='stopped-confirmed'
             and result.get('journal_path')==proof_relative_path and result.get('journal_sha256')==expected_sha
             and result.get('native_owner_drained') is False,'stop operation result does not bind the proof')
    stored_plan=retained._parse_object(read(operation_root+'/plan.json'),'immutable stop plan')
    _require(stored_plan==plan and _sha(canonical(stored_plan))==plan_sha,'immutable stop plan differs')
    guest=plan.get('guest');_require(isinstance(guest,dict),'missing guest proof')
    reason=guest.get('failure_reason')
    _require(guest.get('schema')=='fullmag.preowner-policy-stop-probe.v1'
             and guest.get('current_session_present') is False and isinstance(reason,str) and REFUSAL in reason
             and terminal.get('error','').strip()==('Runtime startup failed; diagnostic API retained: '+reason).strip(),
             'guest is not the same idle diagnostic failure')
    instance=guest.get('api_instance_id')
    _require(isinstance(instance,str) and str(uuid.UUID(instance))==instance,'invalid diagnostic API identity')
    hashes=guest.get('control_hashes');_require(isinstance(hashes,dict) and 0<len(hashes)<=16,'missing control hashes')
    _require({'runtime-control/runtime-services/OWNER.json','runtime-control/runtime-service/process-tree.json',
              'runtime-control/runtime-service/docker-all.json','backend/runtime-provenance.json'}<=set(hashes),
             'missing preserved owner/process/provenance hashes')
    for path,digest in hashes.items():
        retained._sha(digest,'preserved control SHA-256')
        _require(_sha(read(path))==digest,'preserved control bytes changed: '+path)
    released=plan.get('released')
    _require(isinstance(released,dict) and released.get('schema')=='fullmag.pre-ack-released-observation.v1'
             and type(released.get('active_count')) is int and released['active_count']==0
             and all(isinstance(released.get(key),list) for key in ('reservations','leases'))
             and isinstance(plan.get('run_pins'),dict) and 0<len(plan['run_pins'])<=8192,'missing ledger/run proof')
    for path,digest in plan['run_pins'].items():
        _relative(path);retained._sha(digest,'preserved run SHA-256')
    services={}
    for role in ('backend','frontend'):
        service=plan.get(role);_require(isinstance(service,dict),'missing '+role+' pin')
        _require(service.get('id')==pins[role+'_container_id'] and service.get('image')==pins['old_image_id']
                 and proof.get(role+'_after')==service,'service identity/image or stopped pin differs')
        retained._sha(service.get('fingerprint'),role+' fingerprint')
        started=service.get('started_at')
        _require(isinstance(started,str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z',started)
                 and not started.startswith('0001-'),'missing service incarnation timestamp')
        if role=='backend':
            _require(terminal.get('backend_started_at')==started,'backend start differs from failed terminal')
        field=role+'_container'
        _require(terminal.get(field) in (None,service['id']),'non-null original service ID differs')
        terminal[field]=service['id'];services[role]=service
    _require(services['backend']['id']!=services['frontend']['id'],'service roles share an ID')
    return canonical(terminal),documents,services


def validate_stopped_incarnations(actual_by_service, services):
    """Call on every stopped-pair observation, including immediately precommit."""
    _require(isinstance(actual_by_service,dict) and set(actual_by_service)=={'backend','frontend'},'ambiguous service pair')
    for role in ('backend','frontend'):
        actual=actual_by_service[role];pin=services[role]
        _require(isinstance(actual,dict) and isinstance(actual.get('State'),dict),'missing service inspection/state')
        state=actual['State']
        _require(actual.get('Id')==pin['id'] and actual.get('Image')==pin['image']
                 and fingerprint(actual)==pin['fingerprint'] and state.get('StartedAt')==pin['started_at'],
                 role+' incarnation changed')
        _require(state.get('Status')=='exited' and type(state.get('Pid')) is int and state['Pid']==0
                 and all(state.get(key) is False for key in ('Running','Paused','Restarting','Dead','OOMKilled'))
                 and type(state.get('ExitCode')) is int and state['ExitCode'] in ({0} if role=='backend' else {0,143}),
                 role+' is not gracefully stopped')
