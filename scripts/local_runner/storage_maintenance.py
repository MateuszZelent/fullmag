"""Coordinator-owned maintenance of exact historical source capsules."""
from contextlib import ExitStack
import hashlib
import os
from pathlib import Path
import re
import shutil
import socket
import time

from fullmag_storage import atomic_json, file_lock, validate_path
from local_runner import retention
from local_runner.build_executor import capsule_path
from local_runner.retention_executor import (
    CleanupBlocked, _containers, _guard_owners, _json, _overlap, _path_key,
)
from local_runner.runtime_use import retention_mutation_guard


def complete_jobs(queue):
    """Never turn a paginated or unavailable inventory into deletion authority."""
    if not callable(getattr(queue, 'connection', None)):
        raise CleanupBlocked('complete_queue_inventory_unavailable')
    with queue.connection() as database:
        return [queue.record(row) for row in database.execute('SELECT * FROM jobs ORDER BY sequence')]


def container_inventory(layout, call):
    items = _containers(call)
    coordinator_id = layout.get('coordinator_container_id')
    if layout.get('container_coordinator'):
        current = [item for item in items
                   if item.get('Config', {}).get('Hostname') == socket.gethostname()
                   and item.get('Config', {}).get('Labels', {}).get('com.fullmag.local-runner.role') == 'coordinator'
                   and item.get('State', {}).get('Running') is True]
        if len(current) != 1:
            raise CleanupBlocked('cannot_identify_current_coordinator')
        coordinator_id = current[0]['Id']
    return items, coordinator_id


def guard_no_mount_users(layout, target, call):
    """A stopped foreign container remains a user; only this coordinator is exempt."""
    storage = Path(layout['storage_root'])
    suffix = target.relative_to(storage).as_posix().casefold()
    roots = (str(storage), layout.get('host_storage_root'), layout.get('daemon_storage_root'))
    targets = [_path_key(root) + '/' + suffix for root in roots if root]
    items, coordinator_id = container_inventory(layout, call)
    for item in items:
        if item['Id'] == coordinator_id:
            if item.get('Config', {}).get('Labels', {}).get('com.fullmag.local-runner.role') != 'coordinator':
                raise CleanupBlocked('coordinator_identity_mismatch')
            continue
        mounts = item.get('Mounts')
        if not isinstance(mounts, list):
            raise CleanupBlocked('unknown_container_mounts')
        for mount in mounts:
            if mount.get('Type') == 'bind' and any(
                    _overlap(_path_key(mount.get('Source')), key) for key in targets):
                raise CleanupBlocked('container_references_source:' + item['Id'])


def _source(storage, job):
    relative = job['payload']['capsule_relative']
    expected = capsule_path(storage, job)
    actual = retention._checked_child(storage, tuple(relative.split('/')), kind='directory')
    if expected != actual:
        raise CleanupBlocked('noncanonical_source')
    return actual


def _manifest_hash(source):
    path = retention._checked_child(source, ('manifest.json',), kind='file')
    if path.stat().st_size > 32 * 1024 * 1024:
        raise CleanupBlocked('oversized_source_manifest')
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _guard_source_pins(storage, job):
    path = storage / 'index' / 'pinned-resources.json'
    pins = _json(path) if os.path.lexists(path) else {}
    wt, jid, capture = job['worktree_id'], job['job_id'], job['payload']['capture_id']
    keys = (jid, f'src-{wt}-{capture}', f'run-{wt}-{jid}', f'art-{wt}-{jid}', f'exec-{wt}-{jid}')
    if any(key in pins for key in keys):
        raise CleanupBlocked('pinned_source_or_job')
    from local_runner.retention_executor import _guard_pins
    run = storage / 'runs' / wt / jid
    _guard_pins(storage, run, job)


def plan_source_compaction(layout, queue, *, owner, job_ids=None):
    storage = retention._canonical_storage(layout['storage_root'])
    jobs = complete_jobs(queue)
    selected = set(job_ids) if job_ids is not None else None
    known = {job['job_id'] for job in jobs if job['owner'] == owner}
    if selected is not None and not selected <= known:
        raise CleanupBlocked('unknown_or_foreign_source_job')
    candidates, retained, seen = [], [], set()
    for job in jobs:
        if job['owner'] != owner or job['operation'] != 'build' or (selected is not None and job['job_id'] not in selected):
            continue
        row = {'job_id': job['job_id'], 'worktree_id': job['worktree_id'], 'size_bytes': None}
        try:
            source = _source(storage, job)
            if str(source) in seen:
                continue
            seen.add(str(source))
            shared = [other for other in jobs if other.get('payload', {}).get('capsule_relative') == job['payload']['capsule_relative']]
            if any(other['state'] not in retention._TERMINAL_STATES for other in shared):
                raise CleanupBlocked('source_has_nonterminal_job')
            if any(other['source_digest'] != job['source_digest'] or other['owner'] != owner for other in shared):
                raise CleanupBlocked('source_identity_or_owner_mismatch')
            for other in shared:
                _guard_source_pins(storage, other)
            row.update(path=str(source), source_digest=job['source_digest'],
                       manifest_sha256=_manifest_hash(source),
                       resource_id=f"src-{job['worktree_id']}-{job['payload']['capture_id']}",
                       name=source.relative_to(storage).as_posix(), reason='share_verified_source_content')
            candidates.append(row)
        except Exception as error:
            row['why_retained'] = f'{type(error).__name__}: {error}'
            retained.append(row)
    return {'scope': 'sources', 'status': 'preview', 'candidates': candidates,
            'candidates_count': len(candidates), 'retained': retained, 'retained_count': len(retained),
            'estimated_reclaimed_bytes': None, 'created_at': time.time()}


def apply_source_compaction(layout, plan, queue, *, owner, call, policy=None):
    from local_runner.source_compaction import compact_source_capsule
    storage = retention._canonical_storage(layout['storage_root'])
    plan_id = plan.get('plan_id')
    if not isinstance(plan_id, str) or not re.fullmatch(r'plan-[a-f0-9]{8,32}', plan_id):
        raise CleanupBlocked('invalid_plan_id')
    result_path = validate_path(storage / 'index' / 'retention-operations' / (plan_id + '.json'), storage)
    result_path.parent.mkdir(parents=True, exist_ok=True)
    result = {'plan_id': plan_id, 'scope': 'sources', 'status': 'running', 'applied': False,
              'started_at': time.time(), 'items': [], 'removed_logical_bytes': 0, 'reclaimed_bytes': None,
              'disk_free_before_bytes': shutil.disk_usage(storage).free}
    with ExitStack() as locks:
        locks.enter_context(retention_mutation_guard(layout))
        for name in ('local-runner-coordinator', 'fullmag-heavy', 'retention'):
            locks.enter_context(file_lock(validate_path(storage / 'locks' / (name + '.lock'), storage), name))
        if result_path.exists():
            previous = _json(result_path)
            if previous.get('status') == 'running':
                previous.update(status='interrupted_unknown', applied=False)
            return previous
        if queue.active():
            raise CleanupBlocked('active_queue_lease')
        if plan.get('scope') != 'sources' or not isinstance(plan.get('candidates'), list):
            raise CleanupBlocked('invalid_source_plan')
        atomic_json(result_path, result)
        for candidate in plan['candidates']:
            item = {'job_id': candidate.get('job_id'), 'status': 'retained'}
            result['items'].append(item)
            try:
                job = queue.get(candidate['job_id'])
                wt = job['worktree_id']
                if not retention._valid_component(wt):
                    raise CleanupBlocked('invalid_worktree_id')
                with file_lock(validate_path(storage / 'locks' / (wt + '.lock'), storage), wt):
                    _guard_owners(storage, wt)
                    fresh = plan_source_compaction(layout, queue, owner=owner, job_ids=[job['job_id']])
                    if len(fresh['candidates']) != 1:
                        raise CleanupBlocked('source_no_longer_eligible:' + str(fresh['retained']))
                    current = fresh['candidates'][0]
                    for key in ('path', 'worktree_id', 'source_digest', 'manifest_sha256'):
                        if current.get(key) != candidate.get(key):
                            raise CleanupBlocked('source_plan_stale:' + key)
                    source = _source(storage, job)
                    guard_no_mount_users(layout, source, call)
                    if queue.active():
                        raise CleanupBlocked('queue_state_changed')
                    item.update(status='compacting', path=str(source))
                    atomic_json(result_path, result)
                    compacted = compact_source_capsule(storage, source, job['source_digest'])
                    item.update(status='compacted' if compacted['state'] == 'completed' else 'partial',
                                compaction=compacted)
            except Exception as error:
                item.update(status='partial_error' if item['status'] == 'compacting' else 'retained',
                            reason=f'{type(error).__name__}: {error}')
            atomic_json(result_path, result)
        succeeded = all(item['status'] == 'compacted' for item in result['items'])
        result.update(status='succeeded' if succeeded else 'partial', applied=succeeded,
                      finished_at=time.time(), disk_free_after_bytes=shutil.disk_usage(storage).free)
        result['disk_free_change_bytes'] = result['disk_free_after_bytes'] - result['disk_free_before_bytes']
        atomic_json(result_path, result)
    return result
