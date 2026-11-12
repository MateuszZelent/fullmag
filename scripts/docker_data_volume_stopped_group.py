"""Authenticate a stopped source group and reject other dataset consumers.

Read-only snapshot only. The caller must revalidate it after acquiring live
native copy fences and before starting the root process. A stopped container
reference is still a consumer unless its physical source is proved disjoint.
"""
from __future__ import annotations

import hashlib
from pathlib import Path
import re

from docker_build_control import canonical, docker_capture
from docker_dev_data_volume import _decode, _migration_bind_identity, _runtime_pins
from docker_volume_accepted_reattach import _control_bytes
from docker_volume_reconcile import fingerprint
from docker_volume_terminal_observation import build_captured_proof, _store_reader, validate_empty_stop
from linux_data_volume_copy import _source_roots


def require(value,message):
    if not value:raise ValueError(message)


def _original_roots(plan):
    roots = _source_roots({'source_roots':plan['observation']['datasets']})
    require(set(roots) == {'state','user_data'},'Both exact original datasets required')
    return roots


def observe_stopped_group(control,source,plan,stop_attempt,stop_sha256,*,fence=None):
    """Require exact stop/native records, unchanged incarnations and consumers."""
    require(type(stop_attempt) is str and re.fullmatch('[0-9a-f]{32}',stop_attempt) and
            type(stop_sha256) is str and re.fullmatch('[0-9a-f]{64}',stop_sha256),'Exact managed stop pins required')
    operation = control._active_operation
    require(operation is not None and operation['receipt'].get('phase') == 'data-volume-migration',
            'A live migration lease is required for a stopped-group observation')
    control._assert_live_operation_helper(operation)
    pins = _runtime_pins(plan['runtime_pins'])
    require(plan.get('source_root') == str(source) and plan.get('compose_project') == control.project and
            pins['image_id'] == control.image,'Stopped group plan source/image differs')
    allowed = {pins['backend'],pins['frontend'],operation['helper_container_id']}
    if fence is not None:
        require(fence.control is control and fence.operation is operation and
            fence.request['volume_id'] == plan['volume_id'] and
            fence.request['token'] == operation['receipt']['attempt'],'Foreign live copy fence')
        fence.check();allowed.add(fence.identifier)
    roots = _original_roots(plan)
    ids = docker_capture('ps','--all','--no-trunc','--format','{{.ID}}').stdout.decode().split()
    require(ids and len(ids) == len(set(ids)) and all(re.fullmatch('[0-9a-f]{64}',s) for s in ids),
            'Complete unambiguous container inventory required')
    actuals = _decode(docker_capture('inspect',*ids).stdout)
    require(type(actuals) is list and len(actuals) == len(ids) and
            {a.get('Id') for a in actuals} == set(ids),'Container inspection changed its inventory')
    actual = {key:next((a for a in actuals if a.get('Id') == pins[key]),None) for key in ('backend','frontend')}
    for service,a in actual.items():
        require(a is not None,'Stopped source service is absent: '+service)
        labels = a.get('Config',{}).get('Labels') or {};state=a.get('State',{})
        expected=plan['observation']['services'][service]
        require(a.get('Image') == pins['image_id'] and labels.get('com.docker.compose.project') == control.project and
            labels.get('com.docker.compose.service') == service and fingerprint(a) == expected['fingerprint'] and
            state.get('StartedAt') == expected['started_at'] and state.get('Status') == 'exited' and
            state.get('Running') is False and type(state.get('Pid')) is int and state['Pid'] == 0 and
            all(state.get(k) is False for k in ('Dead','Paused','Restarting','OOMKilled')),
            'Stopped source service incarnation/configuration differs: '+service)
    cache={};windows_proofs=[];consumers=[]
    def physical(mount,state):
        key=(mount.get('Source'),hashlib.sha256(canonical(state)).hexdigest())
        if key not in cache:
            path,proof=_migration_bind_identity(mount.get('Source'),state)
            cache[key]=path
            if proof is not None:windows_proofs.append({'source':mount.get('Source'),'proof':proof})
        return cache[key]
    for a in actuals:
        if a.get('Id') in allowed:continue
        labels=a.get('Config',{}).get('Labels') or {}
        if labels.get('com.docker.compose.project') == control.project:
            consumers.append({'id':a['Id'],'reason':'additional-group-resource'})
        for mount in a.get('Mounts',[]):
            if mount.get('Name') == control.volume:
                consumers.append({'id':a['Id'],'reason':'control-volume-reference'})
            if mount.get('Type') == 'bind':
                try:
                    p=physical(mount,a.get('State'))
                    if p is not None and any(p == r or p in r.parents or r in p.parents for r in roots.values()):
                        consumers.append({'id':a['Id'],'reason':'dataset-bind-reference'})
                except (OSError,ValueError,RuntimeError) as error:
                    consumers.append({'id':a['Id'],'reason':'unproven-bind-identity','error_type':type(error).__name__})
    require(not consumers,'Unqualified source consumers: '+str(consumers))
    mounts={m.get('Destination'):m for m in actual['backend'].get('Mounts',[])}
    for target,path in [('/state',roots['state']),('/user-data',roots['user_data']),('/opt/fullmag/source',Path(source))]:
        m=mounts.get(target,{})
        require(m.get('Type') == 'bind' and m.get('RW') is (target != '/opt/fullmag/source') and
            _migration_bind_identity(m.get('Source'))[0] == path,'Stopped source bind differs: '+target)
    read_control=lambda relative:_control_bytes(control,relative,maximum=8*1024**2)
    proof=build_captured_proof(read_control,_store_reader(roots['state']/'runs/docker-all/session-store'),
        iteration=stop_attempt,scope={'compose_project':control.project,'control_volume':control.volume,
                                    'source_root':str(source),'image_id':control.image})
    validate_empty_stop(read_control,project=control.project,volume=control.volume,source_root=str(source),
        attempt=pins['attempt'],config_sha256=pins['config_sha256'],actual=actual,
        stop_pin=(stop_attempt,stop_sha256),source_proof=proof)
    drain_raw=read_control('iteration/attempts/'+stop_attempt+'/backend-drain.json')
    drain=_decode(drain_raw)
    process_sha=drain.get('process_receipt_sha256')
    require(type(process_sha) is str and re.fullmatch('[0-9a-f]{64}',process_sha),'Exact terminal process SHA required')
    control._assert_live_operation_helper(operation)
    if fence is not None:fence.check()
    return {'actual':actual,'source_proof':proof,'process_receipt_sha256':process_sha,
            'stopped_windows_bind_proofs':windows_proofs,'consumers':[]}
