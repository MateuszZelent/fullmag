"""Read-only interlock for a cutover whose runtime is not yet qualified.

The managed migrator publishes a new immutable marker before its first rename,
outside both datasets and while holding its continuous lifecycle guards. The
marker is never a runtime capability. Ordinary startup remains blocked until
the matching final registration passes the usual filesystem guards. This
module neither creates markers nor offers a migration/recreate bypass.
"""
from __future__ import annotations

from copy import deepcopy
from pathlib import Path
import re

try:
    from .fullmag_data_volume_guard import _absolute_path, _read_optional_regular, _parse_object
    from .fullmag_data_volume import validate_registration
except ImportError:
    from fullmag_data_volume_guard import _absolute_path, _read_optional_regular, _parse_object
    from fullmag_data_volume import validate_registration


SCHEMA = 'fullmag.data-volume-pending.v1'
KEYS = {'schema','project_id','worktree_id','compose_project','source_root','volume_id',
        'plan_sha256','linux_request_sha256','copy_receipt_sha256','state_root','user_data_root'}
IDENTIFIER = re.compile(r'[a-z0-9._-]{1,128}\Z')
MAX_BYTES = 32 * 1024


def _require(value,message):
    if not value:raise ValueError(message)


def pending_path(layout):
    _require(type(layout) is dict,'Pending migration layout must be an object')
    key=layout.get('worktree_id')
    _require(type(key) is str and IDENTIFIER.fullmatch(key),'Pending migration worktree identity differs')
    return _absolute_path(layout.get('storage_root'),'pending migration storage')/'index/data-volumes'/(key+'.pending.json')


def validate_pending(value,layout,compose_project):
    """Validate a closed, group-local intent; hashes are pins, not authority."""
    pending_path(layout)
    _require(type(value) is dict and set(value) == KEYS and value['schema'] == SCHEMA,
             'Closed pending migration marker required')
    _require(type(compose_project) is str and IDENTIFIER.fullmatch(compose_project),
             'Exact pending migration Compose identity required')
    env=layout.get('env')
    _require(type(env) is dict and type(env.get('FULLMAG_PROJECT_ID')) is str and
        IDENTIFIER.fullmatch(env['FULLMAG_PROJECT_ID']),'Pending migration project identity is absent')
    _require(value['worktree_id'] == layout['worktree_id'] and value['compose_project'] == compose_project and
        value['project_id'] == env['FULLMAG_PROJECT_ID'],'Pending migration belongs to another selected group')
    _require(type(value['volume_id']) is str and re.fullmatch('[0-9a-f]{32}',value['volume_id']) and
        value['volume_id'] != '0'*32,'Exact nonzero pending migration volume identity required')
    for key in ('plan_sha256','linux_request_sha256','copy_receipt_sha256'):
        _require(type(value[key]) is str and re.fullmatch('[0-9a-f]{64}',value[key]),
                 'Exact pending migration evidence SHA required')
    source=_absolute_path(value['source_root'],'pending migration source')
    _require(source == _absolute_path(layout.get('repo_root'),'selected migration source'),
             'Pending migration source differs from the selected checkout')
    root=_absolute_path(layout['storage_root'],'pending migration storage')
    runtime=_absolute_path(layout.get('runtime_root'),'pending migration runtime root')
    _require(runtime != root and root in runtime.parents,'Pending migration runtime is outside selected storage')
    state=_absolute_path(value['state_root'],'pending migration StateRoot')
    user=_absolute_path(value['user_data_root'],'pending migration user data')
    _require(state != runtime and runtime in state.parents,
             'Pending migration StateRoot is outside selected runtime')
    _require(user == root/'user-data'/compose_project,'Pending migration user-data scope differs')
    return deepcopy(value)


def read_pending(layout,compose_project):
    path=pending_path(layout)
    raw=_read_optional_regular(path,'pending migration marker',maximum=MAX_BYTES)
    if raw is None:return None
    return validate_pending(_parse_object(raw,'pending migration marker'),layout,compose_project)


def require_registration(pending,registration):
    """Retain the marker; only the corresponding final registration resolves it."""
    if pending is None:return
    _require(registration is not None,
             'Pending data-volume migration blocks ordinary startup; use its managed recovery')
    registration=validate_registration(registration)
    _require(all(registration[key] == pending[key] for key in
                 ('project_id','worktree_id','compose_project','volume_id')),
             'Committed registration does not resolve this pending migration')
    datasets={item['role']:item['canonical_root'] for item in registration['datasets']}
    _require(datasets == {'state':pending['state_root'],'user_data':pending['user_data_root']},
             'Committed registration roots differ from the pending migration')
