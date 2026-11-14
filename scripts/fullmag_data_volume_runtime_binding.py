"""Explicit, immutable runtime successors of an unchanged data-volume plan.

A binding changes neither the original plan/Windows lineage nor dataset scope.
Its producer authenticates managed stop/recreation/development receipts and the
live successor. The root consumers receive its exact SHA through Linux request
v2. It grants no admission, copy, drain or data-migration authority.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
from pathlib import Path
import re


SCHEMA='fullmag.data-volume-runtime-binding.v1'
RUNTIME_KEYS=('attempt','config_sha256','state_root','backend','frontend','image_id',
              'runtime_witness_path','runtime_witness_sha256')
KEYS={'schema','state','volume_id','plan_sha256','project_id','worktree_id','compose_project',
      'source_root','storage_root','runtime_root','previous_runtime_pins','runtime_pins',
      'source_roots','services','witnesses','admission','runtime_source','loader_sha256',
      'relationship','historical_owner_continuity','namespace_admitted','data_migrated'}
SERVICE_KEYS={'id','fingerprint','pid','started_at','nano_cpus','memory_bytes'}


def require(value,message):
    if not value:raise ValueError(message)


def sha_field(value):
    return type(value) is str and re.fullmatch('[0-9a-f]{64}',value) is not None


def runtime_pins(value):
    """The existing retained-runtime shape, independent of Docker imports."""
    require(type(value) is dict and set(RUNTIME_KEYS) <= value.keys(),
            'Complete retained runtime pins required')
    pins={key:value[key] for key in RUNTIME_KEYS}
    require(type(pins['attempt']) is str and re.fullmatch('[0-9a-f]{32}',pins['attempt']),
            'Exact retained development attempt required')
    require(all(sha_field(pins[key]) for key in
            ('config_sha256','backend','frontend','runtime_witness_sha256')),
            'Exact retained service and digest pins required')
    require(pins['backend'] != pins['frontend'],'Runtime services must be distinct')
    require(type(pins['image_id']) is str and re.fullmatch('sha256:[0-9a-f]{64}',pins['image_id']),
            'Immutable retained image required')
    require(type(pins['runtime_witness_path']) is str and re.fullmatch(
        r'(development|iteration|resume)/attempts/[0-9a-f]{32}/terminal\.json',pins['runtime_witness_path']),
        'Bounded retained runtime witness required')
    require(type(pins['state_root']) is str,'Canonical retained state root required')
    return pins


def validate_binding(value,plan,plan_sha256):
    require(type(value) is dict and set(value) == KEYS and value['schema'] == SCHEMA,
            'Closed runtime binding required')
    require(value['state'] == 'qualified-runtime-successor-only' and
        value['namespace_admitted'] is False and value['data_migrated'] is False and
        value['relationship'] == 'diamond-by-common-stop' and
        value['historical_owner_continuity'] == 'not-proven',
        'Runtime binding is not namespace or data-migration authority')
    require(sha_field(plan_sha256) and value['plan_sha256'] == plan_sha256 and
        type(plan) is dict and plan.get('schema') == 'fullmag.data-volume-plan.v1',
        'Runtime binding must retain the exact original plan')
    for key in ('volume_id','project_id','worktree_id','compose_project','source_root','storage_root','runtime_root'):
        require(value[key] == plan.get(key),'Runtime binding changed the original scope: '+key)
    old=runtime_pins(plan['runtime_pins']);new=runtime_pins(value['runtime_pins'])
    require(value['previous_runtime_pins'] == old and value['runtime_pins'] == new and
        new['attempt'] != old['attempt'] and new['state_root'] == old['state_root'] and
        all(new[k] != old[k] for k in ('backend','frontend')),
        'Runtime binding must describe a recreated pair in the same StateRoot')
    require(value['source_roots'] == plan.get('observation',{}).get('datasets'),
            'Runtime binding changed an original dataset identity')
    services=value['services']
    require(type(services) is dict and set(services) == {'backend','frontend'},
            'Both successor service observations required')
    for role,s in services.items():
        require(type(s) is dict and set(s) == SERVICE_KEYS and s['id'] == new[role] and
            sha_field(s['fingerprint']) and all(type(s[k]) is int and s[k] > 0
                for k in ('pid','nano_cpus','memory_bytes')) and type(s['started_at']) is str and
            re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z',s['started_at']) and
            not s['started_at'].startswith('0001-'), 'Exact successor service incarnation required')
        previous=plan['observation']['services'][role]
        require(all(s[k] == previous[k] for k in ('nano_cpus','memory_bytes')),
                'Runtime binding cannot change the group resource budget')
    witnesses=value['witnesses']
    require(type(witnesses) is dict and set(witnesses) == {'stop','recreation','development'},
            'Exact stop/recreation/development witness references required')
    for role,phase in (('stop','iteration'),('recreation','recreate-services'),('development','development')):
        ref=witnesses[role]
        require(type(ref) is dict and set(ref) == {'path','sha256'} and sha_field(ref['sha256']) and
            type(ref['path']) is str and re.fullmatch(phase+r'/attempts/[0-9a-f]{32}/terminal\.json',ref['path']),
            'Bounded immutable successor witness required')
    dev=witnesses['development']
    require(dev == {'path':'development/attempts/'+new['attempt']+'/terminal.json',
                    'sha256':new['runtime_witness_sha256']} and new['runtime_witness_path'] == dev['path'],
            'Successor runtime witness must be its successful development')
    admission=value['admission']
    require(type(admission) is dict and set(admission) == {'certificate_sha256','owner_marker_sha256','probe_sha256','owner_token_sha256','engine_id'} and
        all(sha_field(admission[k]) for k in ('certificate_sha256','owner_marker_sha256','probe_sha256','owner_token_sha256')) and
        type(admission['engine_id']) is str and 0 < len(admission['engine_id']) <= 256 and
        admission['engine_id'] == plan['observation']['engine_id'],
        'Successor admission observation differs from the original engine')
    source=value['runtime_source']
    require(type(source) is dict and set(source) == {'source_commit','source_snapshot_sha256','backend_build_receipt_sha256'} and
        type(source['source_commit']) is str and re.fullmatch('[0-9a-f]{40}',source['source_commit']) and
        all(sha_field(source[k]) for k in ('source_snapshot_sha256','backend_build_receipt_sha256')) and
        sha_field(value['loader_sha256']), 'Exact successor source and loader identity required')
    return deepcopy(value)


def load_plan(op,linux_request):
    """Return original bytes separately from a derived, never-published view."""
    # Deferred import avoids coupling this pure model to the launcher/Docker.
    import linux_data_volume_provision as qualification
    from fullmag_data_volume_linux_request import validate_linux_request
    linux_request=validate_linux_request(linux_request)
    raw,plan=qualification._read(Path(op)/'plan.json')
    selected=linux_request.get('runtime_binding_sha256')
    # Legacy consumers retain their existing entrypoint/journal/scope checks.
    # A v1 request never selects a successor merely because one exists.
    if selected is None:return raw,plan,None
    require(Path(op) == Path(linux_request['storage_root'])/'migrations/data-volumes'/linux_request['volume_id'],
            'Runtime binding operation scope differs from the Linux request')
    require(all(plan.get(k) == linux_request[k] for k in ('volume_id','storage_root','mount_root')) and
        plan.get('observation',{}).get('datasets') == linux_request['source_roots'],
        'Original plan scope differs from the Linux request')
    require(sha_field(selected),'Exact runtime binding SHA required')
    path=Path(op)/'runtime-bindings'/(selected+'.json')
    _,body=qualification._read(path,selected)
    binding=validate_binding(body,plan,hashlib.sha256(raw).hexdigest())
    require(binding['loader_sha256'] == hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            'Runtime binding loader source changed')
    view=deepcopy(plan)
    view['runtime_pins']=deepcopy(binding['runtime_pins'])
    view['observation']['services']=deepcopy(binding['services'])
    return raw,view,binding
