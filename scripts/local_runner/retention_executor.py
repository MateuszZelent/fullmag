"""Execute one reviewed retention plan under the runner's lifecycle locks.

Only private execution trees are eligible here. Sources, results, receipts,
artifact packages and shared build caches are never deletion targets.
"""
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import stat
import time
import uuid

from fullmag_storage import atomic_json, file_lock, validate_path
from local_runner import retention
from local_runner.build_executor import attest_build_container, validate_build_receipt
from local_runner.runtime_use import retention_mutation_guard
from local_runner.retention_persistence import (
    RetentionPersistenceError, failure_fields, operation_outcome_template,
    preflight_operation_evidence, read_document, write_document,
)


class CleanupBlocked(RuntimeError):
    pass


def _json(path):
    try:
        return dict(retention._read_json(path))
    except retention._PathIssue as error:
        raise CleanupBlocked(error.reason) from error


def _containers(call):
    ids = call(['ps', '-a', '-q', '--no-trunc']).split()
    if any(re.fullmatch(r'[a-f0-9]{64}', item) is None for item in ids):
        raise CleanupBlocked('invalid_container_inventory')
    items = json.loads(call(['inspect', *ids])) if ids else []
    if (not isinstance(items, list) or len(items) != len(ids)
            or {item.get('Id') for item in items if isinstance(item, dict)} != set(ids)):
        raise CleanupBlocked('incomplete_container_inventory')
    return items


def _path_key(value):
    if not isinstance(value, str) or not value or '\x00' in value:
        raise CleanupBlocked('invalid_mount_path')
    return value.replace('\\', '/').rstrip('/').casefold()


def _directory_identity(path, reason):
    """Return stable metadata for a real directory, refusing links/reparse points."""
    try:
        info = os.lstat(path)
    except OSError as error:
        raise CleanupBlocked(reason) from error
    if (
        stat.S_ISLNK(info.st_mode)
        or bool(getattr(info, 'st_file_attributes', 0) & 0x400)
        or not stat.S_ISDIR(info.st_mode)
        or info.st_dev in (None, 0)
        or info.st_ino in (None, 0)
    ):
        raise CleanupBlocked(reason)
    return {'device': info.st_dev, 'inode': info.st_ino}


def _execution_identity_matches(expected, observed):
    return (
        expected.get('root_device') not in (None, 0)
        and expected.get('root_inode') not in (None, 0)
        and expected.get('root_device') == observed.get('root_device')
        and expected.get('root_inode') == observed.get('root_inode')
        and expected == observed
    )


def _overlap(left, right):
    return left == right or left.startswith(right + '/') or right.startswith(left + '/')


def guard_containers(layout, job, journal, target, call):
    """Remove only this exact exited worker, then reject every other mount user."""
    storage = Path(layout['storage_root'])
    suffix = target.relative_to(storage).as_posix()
    roots = [str(storage), layout.get('daemon_storage_root'), layout.get('host_storage_root')]
    targets = [_path_key(root) + '/' + suffix.casefold() for root in roots if root]
    coordinator_id = layout.get('coordinator_container_id')
    items = _containers(call)
    if layout.get('container_coordinator'):
        current = [item for item in items
                   if item.get('Config', {}).get('Hostname') == socket.gethostname()
                   and item.get('Config', {}).get('Labels', {}).get('com.fullmag.local-runner.role') == 'coordinator'
                   and item.get('State', {}).get('Running') is True]
        if len(current) != 1:
            raise CleanupBlocked('cannot_identify_current_coordinator')
        coordinator_id = current[0]['Id']
    own = next((item for item in items if item['Id'] == journal['container_id']), None)
    if own is not None:
        state = own.get('State', {})
        if (state.get('Status') != 'exited' or state.get('Running') is not False
                or state.get('ExitCode') != journal.get('exit_code')):
            raise CleanupBlocked('worker_not_confirmed_exited')
        attest_build_container(own, journal)
    for item in items:
        if item['Id'] == coordinator_id:
            labels = item.get('Config', {}).get('Labels', {})
            if labels.get('com.fullmag.local-runner.role') != 'coordinator':
                raise CleanupBlocked('coordinator_identity_mismatch')
            continue
        if own is not None and item['Id'] == own['Id']:
            continue
        mounts = item.get('Mounts')
        if not isinstance(mounts, list):
            raise CleanupBlocked('unknown_container_mounts')
        for mount in mounts:
            if mount.get('Type') != 'bind':
                continue
            source = _path_key(mount.get('Source'))
            if any(_overlap(source, target_key) for target_key in targets):
                raise CleanupBlocked('container_references_execution:' + item['Id'])
    if own is not None:
        # Historical worker.log kept only a tail. Capture every log line still
        # available from this attested exited container before destroying it.
        log_path = validate_path(target.parent / 'worker-full.log', storage)
        temporary = validate_path(target.parent / ('worker-full-' + uuid.uuid4().hex + '.tmp'), storage)
        log_bytes = call(['logs', own['Id']]).encode('utf-8')
        try:
            with temporary.open('xb') as stream:
                stream.write(log_bytes)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, log_path)
            atomic_json(validate_path(target.parent / 'worker-full-log.json', storage), {
                'container_id': own['Id'], 'job_id': job['job_id'],
                'bytes': len(log_bytes), 'sha256': hashlib.sha256(log_bytes).hexdigest(),
                'scope': 'all_available_container_logs', 'captured_at': time.time(),
            })
        finally:
            if temporary.exists():
                temporary.unlink()
        # No force, no volume deletion. Complete available logs are now durable.
        call(['rm', own['Id']])
        if own['Id'] in {item['Id'] for item in _containers(call)}:
            raise CleanupBlocked('worker_removal_not_confirmed')
    return {'removed_worker_container_id': own['Id'] if own is not None else None}


def _guard_pins(storage, run_root, job):
    path = storage / 'index' / 'pinned-resources.json'
    pins = _json(path) if os.path.lexists(path) else {}
    keys = (job['job_id'], f"exec-{job['worktree_id']}-{job['job_id']}",
            f"run-{job['worktree_id']}-{job['job_id']}")
    if any(key in pins for key in keys):
        raise CleanupBlocked('pinned')
    for parts in (('artifacts.pin',), ('execution', 'artifacts.pin'), ('artifacts', 'artifacts.pin')):
        # A malformed/symlink pin is protective too; do not follow it.
        if os.path.lexists(run_root.joinpath(*parts)):
            raise CleanupBlocked('pinned')
    for parts in (('receipt.json',), ('artifacts', 'build-receipt.json')):
        receipt = run_root.joinpath(*parts)
        if os.path.lexists(receipt) and _json(receipt).get('pinned') is True:
            raise CleanupBlocked('pinned')


def _guard_owners(storage, worktree_id):
    # Unknown/dead foreign owners are retained, never cleared based on age.
    for path in (storage / 'locks').glob(worktree_id + '*.owner.json'):
        record = _json(path)
        if record.get('state') != 'released':
            raise CleanupBlocked('active_or_unknown_storage_owner:' + path.name)


def _guard_terminal_evidence(storage, job, run_root, journal):
    if journal.get('phase') != 'terminal':
        raise CleanupBlocked('nonterminal_journal')
    receipt = _json(retention._checked_child(run_root, ('receipt.json',), kind='file'))
    for key in ('job_id', 'source_digest', 'state', 'container_id', 'exit_code'):
        if receipt.get(key) != journal.get(key):
            raise CleanupBlocked('terminal_receipt_mismatch:' + key)
    retention._checked_child(run_root, ('worker.log',), kind='file')
    # The sources remain available even when this build failed. Resolving the
    # exact capsule path also refuses a replaced source root or manifest link.
    from local_runner.build_executor import capsule_path
    from local_runner.worker_entrypoint import verify_source
    source = capsule_path(storage, job)
    verify_source(source, job['source_digest'])
    if job['state'] == 'succeeded':
        artifacts = retention._checked_child(run_root, ('artifacts',), kind='directory')
        return artifacts
    return None


def _guard_evidence(storage, job, run_root, journal):
    # Runtime package removal retains current-profile compatibility checks.
    artifacts = _guard_terminal_evidence(storage, job, run_root, journal)
    if artifacts is not None:
        validate_build_receipt(artifacts, job, journal)


def _guard_archive_evidence(storage, job, run_root, journal):
    from local_runner.archive_receipt import validate_archive_receipt
    artifacts = _guard_terminal_evidence(storage, job, run_root, journal)
    if artifacts is not None:
        validate_archive_receipt(artifacts, job, journal)


def apply_execution_plan(layout, plan, queue, *, owner, call, policy, now=None):
    """Revalidate exact candidates and persist terminal/partial outcomes.

    Replaying an operation ID returns its receipt, never expands its scope.
    A partial failure needs a fresh plan of the remaining tree. A restart after
    an unknown outcome similarly requires reconciliation instead of blind retry.
    """
    storage = retention._canonical_storage(layout['storage_root'])
    plan_id = plan.get('plan_id')
    if not isinstance(plan_id, str) or re.fullmatch(r'plan-[a-f0-9]{8,32}', plan_id) is None:
        raise CleanupBlocked('invalid_plan_id')
    now = time.time() if now is None else now
    operations = validate_path(storage / 'index' / 'retention-operations', storage)
    operations.mkdir(parents=True, exist_ok=True)
    result_path = validate_path(operations / (plan_id + '.json'), storage)
    result = {'plan_id': plan_id, 'scope': 'execution', 'status': 'running', 'applied': False,
              'started_at': now, 'items': [], 'removed_logical_bytes': 0,
              'reclaimed_bytes': None, 'reclaim_measurement': 'disk_free_delta_not_attributed',
              'disk_free_before_bytes': shutil.disk_usage(storage).free}

    def persist_result(value=None):
        write_document(
            storage,
            result_path,
            result if value is None else value,
            kind='operation',
            scope='execution',
        )
    with ExitStack() as locks:
        locks.enter_context(retention_mutation_guard(layout))
        for name in ('local-runner-coordinator', 'fullmag-heavy', 'retention'):
            lock = validate_path(storage / 'locks' / (name + '.lock'), storage)
            locks.enter_context(file_lock(lock, name))
        if result_path.exists():
            previous = read_document(storage, result_path, plan_id=plan_id, kind='operation', scope='execution')
            if previous.get('status') == 'running':
                previous.update(
                    status='interrupted_unknown', applied=False,
                    error='Reconcile the remaining tree with a fresh plan',
                    finished_at=time.time(),
                )
                for previous_item in previous.get('items', []):
                    if previous_item.get('status') == 'deleting':
                        previous_item.update(
                            status='interrupted_unknown',
                            deletion_state='unknown_after_restart',
                        )
                persist_result(previous)
            return previous
        if queue.active():
            raise CleanupBlocked('active_queue_lease')
        raw_plan = plan.get('raw_engine_plan')
        if not isinstance(raw_plan, dict):
            raise CleanupBlocked('missing_execution_inventory')
        candidates = raw_plan.get('candidates')
        if raw_plan.get('error'):
            raise CleanupBlocked('failed_execution_inventory')
        if not isinstance(candidates, list):
            raise CleanupBlocked('missing_bound_execution_candidates')
        candidate_summaries = plan.get('candidates')
        if not isinstance(candidate_summaries, list):
            raise CleanupBlocked('missing_execution_candidate_summaries')
        requested = set()
        for summary in candidate_summaries:
            if not isinstance(summary, dict) or not isinstance(summary.get('job_id'), str):
                raise CleanupBlocked('invalid_execution_candidate_summary')
            requested.add(summary['job_id'])
        selected_candidates = []
        seen = set()
        for candidate in candidates:
            if not isinstance(candidate, dict):
                raise CleanupBlocked('invalid_execution_candidate')
            jid = candidate.get('job_id')
            if jid not in requested or jid in seen:
                continue
            if not isinstance(jid, str):
                raise CleanupBlocked('invalid_execution_candidate_identity')
            seen.add(jid)
            selected_candidates.append(candidate)

        try:
            max_removed = sum(
                candidate['bytes']
                for candidate in selected_candidates
                if isinstance(candidate.get('bytes'), int)
                and not isinstance(candidate.get('bytes'), bool)
                and candidate['bytes'] >= 0
            )
            if len(selected_candidates) != sum(
                1 for candidate in selected_candidates
                if isinstance(candidate.get('bytes'), int)
                and not isinstance(candidate.get('bytes'), bool)
                and candidate['bytes'] >= 0
            ):
                raise RetentionPersistenceError('operation_candidate_size_invalid')
            total_bytes = shutil.disk_usage(storage).total
            preflight_operation_evidence(
                result,
                selected_candidates,
                plan_id=plan_id,
                scope='execution',
                outcome_template=lambda candidate: operation_outcome_template(
                    candidate,
                    plan_id=plan_id,
                    scope='execution',
                    storage_root=storage,
                ),
                final_fields={
                    'status': 'interrupted_unknown',
                    'applied': False,
                    'error': 'Reconcile the remaining tree with a fresh plan',
                    'finished_at': float('1.7976931348623157e308'),
                    'disk_free_after_bytes': total_bytes,
                    'disk_free_change_bytes': -total_bytes,
                    'removed_logical_bytes': max_removed,
                },
            )
        except RetentionPersistenceError as error:
            result.update(
                status='blocked',
                applied=False,
                error='operation_evidence_capacity_exceeded',
                capacity_error=error.code,
                finished_at=time.time(),
            )
            persist_result()
            return result
        persist_result()

        seen = set()
        for candidate in candidates:
            jid = candidate.get('job_id')
            if jid not in requested or jid in seen:
                continue
            seen.add(jid)
            item = {'job_id': jid, 'status': 'validating', 'removed_logical_bytes': 0}
            result['items'].append(item)
            persist_result()
            try:
                job = queue.get(jid)
                if (job.get('owner') != owner or job.get('operation') != 'build'
                        or job.get('worktree_id') != candidate.get('worktree_id')
                        or job.get('source_digest') != candidate.get('source_digest')):
                    raise CleanupBlocked('job_identity_changed')
                worktree_id = job['worktree_id']
                if not retention._valid_component(worktree_id):
                    raise CleanupBlocked('invalid_worktree_id')
                lock = validate_path(storage / 'locks' / (worktree_id + '.lock'), storage)
                with file_lock(lock, worktree_id):
                    _guard_owners(storage, worktree_id)
                    fresh = retention.plan(storage, [job], now,
                                           success_hours=policy['ttl_success_hours'],
                                           failed_hours=policy['ttl_failure_hours'])
                    if len(fresh['candidates']) != 1:
                        reason = fresh['retained'][0]['reason'] if fresh['retained'] else 'not_eligible'
                        raise CleanupBlocked(reason)
                    current = fresh['candidates'][0]
                    for key in ('execution', 'container_id', 'source_digest', 'tree_identity'):
                        if current.get(key) != candidate.get(key) or current.get(key) is None:
                            raise CleanupBlocked('plan_stale:' + key)
                    run_parts = ('runs', worktree_id, jid)
                    run_root = retention._checked_child(storage, run_parts, kind='directory')
                    target = retention._checked_child(
                        storage, run_parts + ('execution',), kind='directory',
                    )
                    if os.path.normcase(str(target)) != os.path.normcase(current['execution']):
                        raise CleanupBlocked('plan_stale:execution_path')
                    run_root_identity = _directory_identity(
                        run_root, 'unsafe_run_root_before_quarantine',
                    )
                    _guard_pins(storage, run_root, job)
                    journal = _json(run_root / 'coordinator.json')
                    _guard_archive_evidence(storage, job, run_root, journal)
                    item['container_cleanup'] = guard_containers(layout, job, journal, target, call)
                    persist_result()
                    # Recheck after potentially slow hashing and Docker calls.
                    if queue.get(jid)['state'] != job['state'] or queue.active():
                        raise CleanupBlocked('queue_state_changed')
                    _guard_pins(storage, run_root, job)
                    checked_run_root = retention._checked_child(
                        storage, run_parts, kind='directory',
                    )
                    if _directory_identity(
                        checked_run_root, 'unsafe_run_root_during_validation',
                    ) != run_root_identity:
                        raise CleanupBlocked('run_root_changed_during_validation')
                    target = retention._checked_child(
                        storage, run_parts + ('execution',), kind='directory',
                    )
                    if os.path.normcase(str(target)) != os.path.normcase(current['execution']):
                        raise CleanupBlocked('execution_path_changed_during_validation')
                    if not _execution_identity_matches(
                        current['tree_identity'], retention.inspect_execution(target),
                    ):
                        raise CleanupBlocked('execution_changed_during_validation')

                    quarantine_name = '.retention-quarantine-' + plan_id
                    quarantine_path = run_root / quarantine_name
                    moved_path = quarantine_path / 'execution'
                    if os.path.lexists(quarantine_path):
                        raise CleanupBlocked('retention_quarantine_exists_requires_reconciliation')
                    item.update(
                        status='deleting', path=str(target),
                        quarantine_path=str(quarantine_path), moved_path=str(moved_path),
                        tree_identity=current['tree_identity'],
                        run_root_identity=run_root_identity,
                        deletion_state='rename_pending',
                    )
                    persist_result()

                    # The unique private directory makes the rename destination
                    # exclusive and keeps it on the same filesystem/run root.
                    os.mkdir(quarantine_path, 0o700)
                    quarantine_identity = _directory_identity(
                        retention._checked_child(
                            storage, run_parts + (quarantine_name,), kind='directory',
                        ),
                        'unsafe_retention_quarantine',
                    )
                    if _directory_identity(
                        retention._checked_child(storage, run_parts, kind='directory'),
                        'unsafe_run_root_before_rename',
                    ) != run_root_identity:
                        raise CleanupBlocked('run_root_changed_before_quarantine')
                    item.update(
                        deletion_state='quarantine_created',
                        quarantine_identity=quarantine_identity,
                    )
                    persist_result()

                    # Rebind the source immediately before the atomic move.
                    target = retention._checked_child(
                        storage, run_parts + ('execution',), kind='directory',
                    )
                    if not _execution_identity_matches(
                        current['tree_identity'], retention.inspect_execution(target),
                    ):
                        raise CleanupBlocked('execution_changed_before_quarantine')
                    if os.path.lexists(moved_path):
                        raise CleanupBlocked('retention_quarantine_target_exists')
                    try:
                        os.rename(target, moved_path)
                    except Exception:
                        item.update(deletion_state='rename_outcome_unknown')
                        persist_result()
                        raise
                    item.update(deletion_state='moved_unverified')
                    persist_result()

                    checked_run_root = retention._checked_child(
                        storage, run_parts, kind='directory',
                    )
                    checked_quarantine = retention._checked_child(
                        storage, run_parts + (quarantine_name,), kind='directory',
                    )
                    if _directory_identity(
                        checked_run_root, 'unsafe_run_root_after_quarantine',
                    ) != run_root_identity:
                        raise CleanupBlocked('run_root_changed_after_quarantine')
                    if _directory_identity(
                        checked_quarantine, 'unsafe_retention_quarantine_after_move',
                    ) != quarantine_identity:
                        raise CleanupBlocked('retention_quarantine_changed_after_move')
                    if os.path.lexists(target):
                        item.update(deletion_state='execution_path_reappeared')
                        persist_result()
                        raise CleanupBlocked('execution_path_reappeared_after_quarantine')

                    # Persist intent before the final identity check and
                    # deletion; a restart records this exact moved path unknown.
                    item.update(deletion_state='removal_started')
                    persist_result()
                    checked_run_root = retention._checked_child(
                        storage, run_parts, kind='directory',
                    )
                    checked_quarantine = retention._checked_child(
                        storage, run_parts + (quarantine_name,), kind='directory',
                    )
                    if (_directory_identity(
                            checked_run_root, 'unsafe_run_root_before_delete',
                    ) != run_root_identity):
                        raise CleanupBlocked('run_root_changed_before_delete')
                    if (_directory_identity(
                            checked_quarantine, 'unsafe_retention_quarantine_before_delete',
                    ) != quarantine_identity):
                        raise CleanupBlocked('retention_quarantine_changed_before_delete')
                    if os.path.lexists(target):
                        raise CleanupBlocked('execution_path_reappeared_before_delete')
                    moved_target = retention._checked_child(
                        storage, run_parts + (quarantine_name, 'execution'),
                        kind='directory',
                    )
                    final_identity = retention.inspect_execution(moved_target)
                    if not _execution_identity_matches(
                        current['tree_identity'], final_identity,
                    ):
                        item.update(
                            deletion_state='identity_mismatch',
                            observed_tree_identity=final_identity,
                        )
                        persist_result()
                        raise CleanupBlocked('execution_identity_mismatch_after_quarantine')

                    shutil.rmtree(moved_target)
                    if os.path.lexists(moved_path):
                        raise CleanupBlocked('execution_removal_not_confirmed')
                    if os.path.lexists(target):
                        raise CleanupBlocked('execution_path_reappeared_after_delete')
                    item.update(deletion_state='tree_removed')
                    persist_result()
                    checked_run_root = retention._checked_child(
                        storage, run_parts, kind='directory',
                    )
                    if _directory_identity(
                        checked_run_root, 'unsafe_run_root_after_delete',
                    ) != run_root_identity:
                        raise CleanupBlocked('run_root_changed_after_delete')
                    checked_quarantine = retention._checked_child(
                        storage, run_parts + (quarantine_name,), kind='directory',
                    )
                    if _directory_identity(
                        checked_quarantine, 'unsafe_retention_quarantine_after_delete',
                    ) != quarantine_identity:
                        raise CleanupBlocked('retention_quarantine_changed_after_delete')
                    os.rmdir(checked_quarantine)
                    if os.path.lexists(quarantine_path):
                        raise CleanupBlocked('retention_quarantine_removal_not_confirmed')
                    item.update(
                        status='deleted', deletion_state='deleted',
                        removed_logical_bytes=current['bytes'],
                    )
                    result['removed_logical_bytes'] += current['bytes']
            except Exception as error:
                # Preserve exact failure and successful preceding items. No
                # positive reclaim is inferred from a partially removed tree.
                item.update(
                    status='partial_error' if item['status'] == 'deleting' else 'retained'
                )
                item.update(failure_fields(
                    error,
                    summary_key='reason',
                    label='failure',
                    optional_bytes_used=item.get('_optional_error_json_bytes', 0),
                ))
            persist_result()
        failures = any(item['status'] != 'deleted' for item in result['items'])
        result.update(status='partial' if failures else 'succeeded', applied=not failures,
                      finished_at=time.time(), disk_free_after_bytes=shutil.disk_usage(storage).free)
        result['disk_free_change_bytes'] = result['disk_free_after_bytes'] - result['disk_free_before_bytes']
        persist_result()
    return result
