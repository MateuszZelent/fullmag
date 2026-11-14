"""Live OLD/NEW dataset views between a verified bind and admission preparation.

Saved JSON is evidence, not a capability. The creator must retain the original
copied_group host scope. This module neither mounts, starts, admits nor retires
anything, and it does not replace the separate NEW store writer fence.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import os
from pathlib import Path
import re
import sys
import threading

import docker_data_volume_bind_job as bind_job
from fullmag_data_volume_guard import _observe_directory,resolve_mount_uuid
from fullmag_data_volume_journal import validate_journal
from fullmag_data_volume_linux_request import validate_linux_request
from fullmag_data_volume_runtime_binding import load_plan
from linux_data_volume_copy import _mounted_root
import linux_data_volume_provision as qualification


require=qualification.require


def _mount(path):
    observed=qualification._capture(['findmnt','--json','--target',str(path),
        '--output','TARGET,FSROOT,FSTYPE,UUID,MAJ:MIN,OPTIONS,PROPAGATION'])
    row=qualification._parse_object(observed.stdout,'relocated mount observation').get('filesystems')
    require(type(row) is list and len(row) == 1 and type(row[0]) is dict,'One relocated mount observation required')
    value=row[0]
    require(all(type(value.get(k)) is str and value[k] for k in
        ('target','fsroot','fstype','maj:min','options','propagation')) and
        'uuid' in value and 'UUID' not in value and
        (value['uuid'] is None or (type(value['uuid']) is str and bool(value['uuid']))) and
        re.fullmatch(r'[0-9]+:[0-9]+',value['maj:min']), 'Incomplete relocated mount observation')
    if value['uuid'] is None and value['fstype'] == 'ext4':
        value=dict(value)
        value['uuid']=resolve_mount_uuid(path,None,major_minor=value['maj:min'])
    for k in ('target','fsroot'):
        p=Path(value[k])
        require(p.is_absolute() and str(p) == value[k] and '..' not in p.parts,'Noncanonical relocated mount path')
    return value


def _location(path,row):
    path=Path(path);target=Path(row['target'])
    require(path == target or target in path.parents,'Mount observation does not cover its path')
    return row['maj:min'],Path(row['fsroot'])/path.relative_to(target)


def _overlap(left,right):
    return left == right or left in right.parents or right in left.parents


def _raw(path):
    return qualification._read_optional_regular(Path(path),'relocated immutable evidence',maximum=4*1024**2)


def _live_copied(copied):
    # Resolve the instance which actually issued this scope. Never import a
    # second ContextVar instance or accept a caller-supplied authentication hook.
    name=type(copied).__module__
    require(name in ('docker_dev_data_volume_copy','scripts.docker_dev_data_volume_copy'),
            'The original live copied-group host scope is required')
    module=sys.modules.get(name)
    require(module is not None and type(copied) is getattr(module,'_CopiedGroupScope',None) and
        Path(module.__file__).resolve() == Path(__file__).with_name('docker_dev_data_volume_copy.py').resolve(),
        'The original copied-scope issuer is required')
    return module.require_live_copied_group(copied)


class RelocatedGroup:
    """In-process proof tied to the same live host scope and immutable bind."""
    def __init__(self,copied,bound):
        require(_live_copied(copied) is copied,'The original copied scope is required')
        require(type(bound) is dict and set(bound) == {'context','terminal'} and
            all(bound['context'].get(k) == v for k,v in copied['context'].items()),
            'Bound view differs from the original copied context')
        context=bound['context'];terminal=bound['terminal'];op=context['operation_root']
        request_sha=terminal['result']['request_sha256']
        _,request=qualification._read(op/'linux-bind-request.json',request_sha)
        require(bind_job.validate_terminal(op,request,request_sha,0) == terminal,
                'Bound view requires the exact successful bind terminal')
        require(request['copy_receipt_sha256'] == copied['terminal']['receipt_sha256'],
                'Bound view differs from the live original copy terminal')
        _,linux_value=qualification._read(op/'linux-provision-request.json',context['linux_request_sha256'])
        linux=validate_linux_request(linux_value)
        plan_raw,plan,binding=load_plan(op,linux)
        require(plan == context['plan'] and linux == context['linux'] and
            hashlib.sha256(plan_raw).hexdigest() == context['plan_sha256'],
            'Bound view original plan/Linux scope changed')
        self._copied=copied
        self._bound=deepcopy(bound);self._pid=os.getpid();self._thread=threading.get_ident()
        self._op=Path(op);self._plan=deepcopy(plan);self._linux=deepcopy(linux)
        self._journal_path,self._journal=qualification._selected_journal(op)
        self._journal=validate_journal(self._journal)
        self._evidence={}
        paths=[op/name for name in ('plan.json','linux-provision-request.json','linux-provision-result.json',
            'linux-copy-request.json','linux-copy-result.json','linux-bind-request.json','linux-bind-result.json')]
        paths.append(Path(terminal['result']['pending_marker']['path']))
        if binding is not None:
            paths.append(op/'runtime-bindings'/(linux['runtime_binding_sha256']+'.json'))
        for path in paths:
            raw=_raw(path);require(raw is not None,'Relocated immutable evidence is missing')
            self._evidence[Path(path)]=hashlib.sha256(raw).hexdigest()
        self._selector=_raw(op/'active-attempt.json')
        # This cannot be issued after an unobserved successor phase has begun.
        require(self._journal['events'] and self._journal['events'][-1]['phase'] == 'binds-switched' and
            self._journal['events'][-1]['state'] == 'succeeded' and
            self._journal['events'][-1]['receipt_sha256'] == terminal['receipt_sha256'],
            'Relocated journal does not end at the exact successful bind')
        self.check(context['source'],plan)

    def check(self,source,plan):
        require(_live_copied(self._copied) is self._copied and self._pid == os.getpid() and
            self._thread == threading.get_ident(),'The original live relocated host scope is required')
        require(Path(source) == self._bound['context']['source'] and plan == self._plan,
                'Relocated view belongs to another source/plan')
        for path,digest in self._evidence.items():
            raw=_raw(path)
            require(raw is not None and hashlib.sha256(raw).hexdigest() == digest,'Relocated immutable evidence changed')
        require(_raw(self._op/'active-attempt.json') == self._selector,'Relocated journal selector changed')
        path,current=qualification._selected_journal(self._op);current=validate_journal(current)
        prefix=self._journal['events'];suffix=current['events'][len(prefix):]
        require(path == self._journal_path and
            {k:current[k] for k in ('schema','volume_id','request_sha256')} ==
            {k:self._journal[k] for k in ('schema','volume_id','request_sha256')} and
            current['events'][:len(prefix)] == prefix and
            all(e['phase'] == 'admission-prepared' and e['state'] in ('started','succeeded') for e in suffix),
            'Relocated journal changed or requires separate recovery/qualification')
        _,provision=qualification._read(self._op/'linux-provision-result.json',
            self._bound['context']['provision_result_sha256'])
        _mounted_root(self._linux,provision)
        mount_root=Path(self._linux['mount_root']);base=_mount(mount_root)
        require(base['target'] == str(mount_root) and base['fsroot'] == '/' and
            base['fstype'] == 'ext4' and base['uuid'] == self._linux['filesystem_uuid'] and
            base['propagation'] == 'private' and {'rw','nodev','nosuid'} <= set(base['options'].split(',')),
            'Relocated new-volume mount changed')
        old={};canonical={};consumers=[];locations=[]
        for role,row in self._bound['terminal']['result']['switch']['roots'].items():
            backup=Path(row['backup_root']);new=Path(row['canonical_root']);payload=Path(row['copied_root'])
            require(_observe_directory(backup) == row['original_identity'] and
                _observe_directory(new) == row['bound_identity'],'Relocated dataset identity changed: '+role)
            mounted=_mount(new)
            payload_key=_location(payload,base)
            require(mounted['target'] == str(new) and mounted['fstype'] == 'ext4' and
                mounted['uuid'] == base['uuid'] and _location(new,mounted) == payload_key and
                mounted['propagation'] == 'private' and {'rw','nodev','nosuid'} <= set(mounted['options'].split(',')),
                'Relocated canonical mount or payload alias changed: '+role)
            old[role]=backup;canonical[role]=new;consumers.extend((backup,new,payload))
            locations.extend((_location(backup,_mount(backup)),payload_key))
            # Also cover aliases of an ancestor which carries the new child bind.
            parent=_mount(new.parent)
            device,parent_root=_location(new.parent,parent)
            locations.append((device,parent_root/new.name))
        self._locations=tuple(locations);self._consumers=tuple(consumers)
        return {'old_roots':old,'canonical_roots':canonical,'consumer_roots':tuple(consumers)}

    def overlaps(self,path):
        """Use lexical and filesystem-root aliases; an unproved mount is an error."""
        self.check(self._bound['context']['source'],self._plan)
        path=Path(path)
        if any(_overlap(path,root) for root in self._consumers):return True
        device,relative=_location(path,_mount(path))
        return any(device == other and _overlap(relative,root) for other,root in self._locations)

    def old_mounts(self,source,request):
        observed=self.check(source,self._plan)
        require(request['volume_id'] == self._linux['volume_id'] and request['source_roots'] ==
            {r:{k:p[k] for k in ('device','inode')} for r,p in self._linux['source_roots'].items()},
            'Relocated fence must retain the exact original dataset identities')
        return {target:observed['old_roots'][role] for target,role in (('/state','state'),('/user-data','user_data'))}


def from_bound(copied,bound):
    return RelocatedGroup(copied,bound)


def require_relocated(value,source,plan):
    require(type(value) is RelocatedGroup,'An authenticated live relocated view is required')
    return value.check(source,plan)


def fence_mounts(value,source,request,actual):
    require(type(value) is RelocatedGroup,'An authenticated live relocated view is required')
    pins=value._plan['runtime_pins']
    require(actual.get('Id') == pins['backend'] and actual.get('Image') == pins['image_id'],
            'Relocated fence belongs to another backend incarnation/image')
    return value.old_mounts(source,request)
