"""Retain referenced runtime packages and remove exact unreferenced old leaves."""
from contextlib import ExitStack
import hashlib
import os
from pathlib import Path
import re
import shutil
import time

from fullmag_storage import atomic_json, file_lock, validate_path
from local_runner import retention
from local_runner.retention_executor import (
    CleanupBlocked, _directory_identity, _execution_identity_matches,
    _guard_evidence, _guard_owners, _json,
)
from local_runner.retention_persistence import (
    RetentionPersistenceError, failure_fields, operation_outcome_template,
    preflight_operation_evidence, read_document, write_document,
)
from local_runner.runtime_references import plan_runtime_references
from local_runner.runtime_use import retention_mutation_guard
from local_runner.storage_maintenance import complete_jobs, container_inventory, guard_no_mount_users


def _reference_roots(storage):
    """Read authoritative extra roots; absence never attests legacy coverage."""
    roots = []
    complete = False
    if os.path.lexists(storage / 'results'):
        roots.append(retention._checked_child(storage, ('results',), kind='directory'))
    config_path = storage / 'index/runtime-reference-roots.json'
    if os.path.lexists(config_path):
        config_path = retention._checked_child(storage, ('index', 'runtime-reference-roots.json'), kind='file')
        config = _json(config_path)
        if config.get('schema') != 'fullmag.runtime-reference-roots.v1' or not isinstance(config.get('relative_roots'), list):
            raise CleanupBlocked('invalid_runtime_reference_roots')
        complete = config.get('legacy_inventory_complete') is True
        for relative in config['relative_roots']:
            if not isinstance(relative, str) or relative.startswith('/') or '\\' in relative:
                raise CleanupBlocked('invalid_runtime_reference_root')
            parts = tuple(relative.split('/'))
            if not parts or any(part in ('', '.', '..') for part in parts):
                raise CleanupBlocked('invalid_runtime_reference_root')
            if parts[0] in ('builds', 'cache', 'locks', 'index'):
                raise CleanupBlocked('payload_or_control_root_is_not_consumer_metadata')
            roots.append(retention._checked_child(storage, parts))
    return roots, complete


def _receipt_hash(storage, job):
    path = retention._checked_child(storage, ('runs', job['worktree_id'], job['job_id'],
                                              'artifacts', 'build-receipt.json'), kind='file')
    if path.stat().st_size > 4 * 1024 * 1024:
        raise CleanupBlocked('oversized_build_receipt')
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _package(storage, job):
    return retention._checked_child(storage, ('runs', job['worktree_id'], job['job_id'],
                                              'artifacts', 'outputs', '.fullmag', 'local'), kind='directory')


def plan_runtime_cleanup(layout, queue, *, owner, call, policy, job_ids=None):
    storage = retention._canonical_storage(layout['storage_root'])
    jobs = complete_jobs(queue)
    wanted = set(job_ids) if job_ids is not None else None
    by_id = {job['job_id']: job for job in jobs}
    if wanted is not None and (not wanted <= set(by_id) or any(by_id[jid]['owner'] != owner for jid in wanted)):
        raise CleanupBlocked('unknown_or_foreign_runtime_job')
    inspections, coordinator_id = container_inventory(layout, call)
    reference_roots, complete_roots = _reference_roots(storage)
    raw = plan_runtime_references(storage, jobs, inspections, reference_roots,
                                  min_artifacts_to_keep=policy['min_artifacts_to_keep'],
                                  jobs_complete=True, containers_complete=True,
                                  reference_roots_complete=complete_roots,
                                  current_coordinator_id=coordinator_id)
    candidates, retained = [], list(raw['retained'])
    for candidate in raw['candidates']:
        jid = candidate['job_id']
        row = {**candidate, 'resource_id': f"art-{candidate['worktree_id']}-{jid}",
               'name': f"{candidate['worktree_id']}/{jid}/artifacts/outputs/.fullmag/local"}
        if by_id[jid]['owner'] != owner or (wanted is not None and jid not in wanted):
            retained.append({**row, 'why_retained': 'outside_selected_scope'})
            continue
        try:
            target = _package(storage, by_id[jid])
            if str(target) != candidate['package_path']:
                raise CleanupBlocked('noncanonical_runtime_package')
            tree = retention.inspect_execution(target)
            row.update(size_bytes=tree['logical_bytes'], package_tree=tree,
                       build_receipt_sha256=_receipt_hash(storage, by_id[jid]))
            candidates.append(row)
        except Exception as error:
            retained_row = {**row}
            retained_row.update(failure_fields(
                error, summary_key='why_retained', label='retention_failure',
            ))
            retained.append(retained_row)
    return {'scope': 'runtime', 'status': 'preview', 'candidates': candidates,
            'candidates_count': len(candidates), 'retained': retained, 'retained_count': len(retained),
            'estimated_reclaimed_bytes': sum(item['size_bytes'] for item in candidates),
            'raw_runtime_plan': raw, 'reference_status': raw['status'],
            'reference_errors': raw['errors'], 'protected_external': raw['protected_external'],
            'created_at': time.time()}


def apply_runtime_cleanup(layout, plan, queue, *, owner, call, policy):
    storage = retention._canonical_storage(layout['storage_root'])
    plan_id = plan.get('plan_id')
    if not isinstance(plan_id, str) or not re.fullmatch(r'plan-[a-f0-9]{8,32}', plan_id):
        raise CleanupBlocked('invalid_plan_id')
    result_path = validate_path(storage / 'index/retention-operations' / (plan_id + '.json'), storage)
    result_path.parent.mkdir(parents=True, exist_ok=True)
    result = {'plan_id': plan_id, 'scope': 'runtime', 'status': 'running', 'applied': False,
              'started_at': time.time(), 'items': [], 'removed_logical_bytes': 0,
              'reclaimed_bytes': None, 'disk_free_before_bytes': shutil.disk_usage(storage).free}

    def persist_result(value=None):
        write_document(
            storage, result_path, result if value is None else value,
            kind='operation', scope='runtime',
        )

    with ExitStack() as locks:
        locks.enter_context(retention_mutation_guard(layout))
        for name in ('local-runner-coordinator', 'fullmag-heavy', 'retention'):
            locks.enter_context(file_lock(validate_path(storage / 'locks' / (name + '.lock'), storage), name))
        if result_path.exists():
            previous = read_document(
                storage, result_path, plan_id=plan_id, kind='operation', scope='runtime',
            )
            if previous.get('status') == 'running':
                reconciled_at = time.time()
                previous.update(status='interrupted_unknown', applied=False,
                                error='Deletion outcome is unknown after restart; manual reconciliation required',
                                finished_at=reconciled_at)
                for previous_item in previous.get('items', []):
                    if not isinstance(previous_item, dict) or previous_item.get('status') != 'deleting':
                        continue
                    deletion_state = previous_item.get('deletion_state')
                    previous_item.update(status='interrupted_unknown',
                                         deletion_state='unknown_after_restart',
                                         previous_deletion_state=deletion_state)
                    try:
                        job_id = previous_item.get('job_id')
                        if not isinstance(job_id, str):
                            raise CleanupBlocked('runtime_job_identity_missing_during_recovery')
                        job = queue.get(job_id)
                        wt = job.get('worktree_id')
                        if not retention._valid_component(wt):
                            raise CleanupBlocked('runtime_worktree_identity_invalid_during_recovery')
                        tombstone_path = validate_path(
                            storage / 'runs' / wt / job_id / 'artifacts' / 'runtime-package-retention.json',
                            storage,
                        )
                        if not os.path.lexists(tombstone_path):
                            raise CleanupBlocked('runtime_tombstone_missing_during_recovery')
                        tombstone = _json(tombstone_path)
                        if (tombstone.get('schema') != 'fullmag.runtime-package-retention.v1'
                                or tombstone.get('plan_id') != plan_id
                                or tombstone.get('job_id') != job_id
                                or tombstone.get('worktree_id') != wt
                                or tombstone.get('source_digest') != job.get('source_digest')
                                or tombstone.get('build_receipt_sha256')
                                != previous_item.get('build_receipt_sha256')
                                or tombstone.get('package_relative') != 'outputs/.fullmag/local'
                                or tombstone.get('receipt') != str(tombstone_path)):
                            raise CleanupBlocked('runtime_tombstone_identity_mismatch_during_recovery')
                        if tombstone.get('state') in ('deleting', 'partial_error'):
                            tombstone.update(state='partial_error',
                                             deletion_state='unknown_after_restart',
                                             previous_deletion_state=deletion_state,
                                             error='Deletion outcome is unknown after restart',
                                             finished_at=reconciled_at)
                            atomic_json(tombstone_path, tombstone)
                        elif tombstone.get('state') != 'removed':
                            raise CleanupBlocked('runtime_tombstone_state_invalid_during_recovery')
                    except Exception as error:
                        previous_item.update(failure_fields(
                            error,
                            summary_key='reconciliation_error',
                            label='reconciliation',
                            optional_bytes_used=previous_item.get('_optional_error_json_bytes', 0),
                        ))
                persist_result(previous)
            return previous
        if queue.active():
            raise CleanupBlocked('active_queue_lease')
        if plan.get('scope') != 'runtime' or not isinstance(plan.get('candidates'), list):
            raise CleanupBlocked('invalid_runtime_plan')
        if plan.get('raw_runtime_plan', {}).get('unknown_scope') is not False:
            raise CleanupBlocked('runtime_reference_scope_unknown')
        try:
            candidates = plan['candidates']
            sizes = [candidate.get('size_bytes') for candidate in candidates
                     if isinstance(candidate, dict)]
            if (len(sizes) != len(candidates) or any(
                    not isinstance(size, int) or isinstance(size, bool) or size < 0
                    for size in sizes)):
                raise RetentionPersistenceError('operation_candidate_size_invalid')
            total_bytes = shutil.disk_usage(storage).total
            preflight_operation_evidence(
                result, candidates, plan_id=plan_id, scope='runtime',
                outcome_template=lambda candidate: operation_outcome_template(
                    candidate, plan_id=plan_id, scope='runtime', storage_root=storage,
                ),
                final_fields={
                    'status': 'interrupted_unknown', 'applied': False,
                    'error': 'Deletion outcome is unknown after restart; manual reconciliation required',
                    'finished_at': float('1.7976931348623157e308'),
                    'disk_free_after_bytes': total_bytes,
                    'disk_free_change_bytes': -total_bytes,
                    'removed_logical_bytes': sum(sizes),
                },
            )
        except RetentionPersistenceError as error:
            result.update(status='blocked', applied=False,
                          error='operation_evidence_capacity_exceeded',
                          capacity_error=error.code, finished_at=time.time())
            persist_result()
            return result
        persist_result()
        for candidate in plan['candidates']:
            item = {'job_id': candidate.get('job_id'), 'status': 'retained', 'removed_logical_bytes': 0}
            result['items'].append(item)
            tombstone = None
            try:
                job = queue.get(candidate['job_id'])
                wt = job['worktree_id']
                if not retention._valid_component(wt) or job['owner'] != owner:
                    raise CleanupBlocked('runtime_owner_or_worktree_changed')
                with file_lock(validate_path(storage / 'locks' / (wt + '.lock'), storage), wt):
                    _guard_owners(storage, wt)
                    fresh = plan_runtime_cleanup(layout, queue, owner=owner, call=call, policy=policy,
                                                 job_ids=[job['job_id']])
                    matches = [row for row in fresh['candidates'] if row['job_id'] == job['job_id']]
                    if fresh['raw_runtime_plan']['unknown_scope'] or len(matches) != 1:
                        raise CleanupBlocked('runtime_now_referenced_or_inventory_changed')
                    current = matches[0]
                    for key in ('package_path', 'source_digest', 'tree_identity', 'reference_fingerprint',
                                'package_tree', 'build_receipt_sha256'):
                        if current.get(key) != candidate.get(key):
                            raise CleanupBlocked('runtime_plan_stale:' + key)
                    target = _package(storage, job)
                    run_root = retention._checked_child(storage, ('runs', wt, job['job_id']), kind='directory')
                    journal = _json(run_root / 'coordinator.json')
                    expected_journal = {'schema': retention._JOURNAL_SCHEMA, 'owner': job['owner'],
                                        'operation': 'build', 'profile': job['profile'],
                                        'state': 'succeeded', 'exit_code': 0}
                    if (any(journal.get(key) != value for key, value in expected_journal.items())
                            or not isinstance(journal.get('container_id'), str)
                            or re.fullmatch(r'[a-f0-9]{64}', journal['container_id']) is None):
                        raise CleanupBlocked('unverified_runtime_journal')
                    _guard_evidence(storage, job, run_root, journal)
                    guard_no_mount_users(layout, target, call)
                    if queue.active() or queue.get(job['job_id'])['state'] != job['state']:
                        raise CleanupBlocked('queue_state_changed')
                    if retention.inspect_execution(target) != current['package_tree']:
                        raise CleanupBlocked('runtime_changed_during_validation')
                    # The gate blocks every managed result publisher. This fresh
                    # graph also catches pins and references added before admission.
                    final = plan_runtime_cleanup(layout, queue, owner=owner, call=call, policy=policy,
                                                 job_ids=[job['job_id']])
                    if not any(row == current for row in final['candidates']):
                        raise CleanupBlocked('runtime_references_changed_during_validation')
                    tombstone_path = validate_path(run_root / 'artifacts/runtime-package-retention.json', storage)
                    if os.path.lexists(tombstone_path):
                        raise CleanupBlocked('existing_runtime_retention_record_requires_manual_reconciliation')
                    run_root_identity = _directory_identity(
                        run_root, 'unsafe_runtime_run_root_before_quarantine')
                    if os.name not in ('nt', 'posix') or not callable(getattr(os, 'rename', None)):
                        raise CleanupBlocked('runtime_quarantine_atomic_rename_unsupported_platform')
                    package_device = current['package_tree'].get('root_device')
                    if package_device in (None, 0) or package_device != run_root_identity['device']:
                        raise CleanupBlocked('runtime_quarantine_same_filesystem_not_proven')
                    quarantine_name = '.runtime-package-quarantine-' + plan_id
                    quarantine_path = run_root / quarantine_name
                    moved_path = quarantine_path / 'package'
                    if os.path.lexists(quarantine_path):
                        raise CleanupBlocked('runtime_quarantine_exists_requires_reconciliation')
                    tombstone = {'schema': 'fullmag.runtime-package-retention.v1', 'state': 'deleting',
                                 'plan_id': plan_id, 'job_id': job['job_id'], 'worktree_id': wt,
                                 'source_digest': job['source_digest'], 'package_relative': 'outputs/.fullmag/local',
                                 'build_receipt_sha256': current['build_receipt_sha256'],
                                 'package_tree_identity': current['package_tree'],
                                 'run_root_identity': run_root_identity,
                                 'quarantine_path': str(quarantine_path), 'moved_path': str(moved_path),
                                 'deletion_state': 'rename_pending',
                                 'started_at': time.time(), 'receipt': str(tombstone_path)}
                    item.update(status='deleting', path=str(target), tombstone=str(tombstone_path),
                                quarantine_path=str(quarantine_path), moved_path=str(moved_path),
                                build_receipt_sha256=current['build_receipt_sha256'],
                                package_tree_identity=current['package_tree'],
                                run_root_identity=run_root_identity, deletion_state='rename_pending')
                    atomic_json(tombstone_path, tombstone)
                    persist_result()

                    # The unique quarantine is created in this run so the
                    # rename binds the checked package on the same filesystem.
                    os.mkdir(quarantine_path, 0o700)
                    checked_quarantine = retention._checked_child(
                        storage, ('runs', wt, job['job_id'], quarantine_name), kind='directory')
                    quarantine_identity = _directory_identity(
                        checked_quarantine, 'unsafe_runtime_quarantine')
                    if quarantine_identity['device'] != run_root_identity['device']:
                        raise CleanupBlocked('runtime_quarantine_filesystem_identity_mismatch')
                    checked_run_root = retention._checked_child(
                        storage, ('runs', wt, job['job_id']), kind='directory')
                    if (_directory_identity(checked_run_root, 'unsafe_runtime_run_root_before_rename')
                            != run_root_identity):
                        raise CleanupBlocked('runtime_run_root_changed_before_quarantine')
                    tombstone.update(deletion_state='quarantine_created',
                                     quarantine_identity=quarantine_identity)
                    item.update(deletion_state='quarantine_created',
                                quarantine_identity=quarantine_identity)
                    atomic_json(tombstone_path, tombstone)
                    persist_result()

                    target = _package(storage, job)
                    if not _execution_identity_matches(
                            current['package_tree'], retention.inspect_execution(target)):
                        raise CleanupBlocked('runtime_changed_before_quarantine')
                    if os.path.lexists(moved_path):
                        raise CleanupBlocked('runtime_quarantine_target_exists')
                    try:
                        os.rename(target, moved_path)
                    except Exception:
                        item.update(deletion_state='rename_outcome_unknown')
                        tombstone.update(deletion_state='rename_outcome_unknown')
                        atomic_json(tombstone_path, tombstone)
                        persist_result()
                        raise
                    item.update(deletion_state='moved_unverified')
                    tombstone.update(deletion_state='moved_unverified', moved_at=time.time())
                    atomic_json(tombstone_path, tombstone)
                    persist_result()

                    checked_run_root = retention._checked_child(
                        storage, ('runs', wt, job['job_id']), kind='directory')
                    checked_quarantine = retention._checked_child(
                        storage, ('runs', wt, job['job_id'], quarantine_name), kind='directory')
                    if (_directory_identity(checked_run_root, 'unsafe_runtime_run_root_after_quarantine')
                            != run_root_identity):
                        raise CleanupBlocked('runtime_run_root_changed_after_quarantine')
                    if (_directory_identity(checked_quarantine, 'unsafe_runtime_quarantine_after_move')
                            != quarantine_identity):
                        raise CleanupBlocked('runtime_quarantine_changed_after_move')
                    if os.path.lexists(target):
                        item.update(deletion_state='source_path_reappeared')
                        tombstone.update(deletion_state='source_path_reappeared')
                        atomic_json(tombstone_path, tombstone)
                        persist_result()
                        raise CleanupBlocked('runtime_package_path_reappeared_after_quarantine')

                    item.update(deletion_state='removal_started')
                    tombstone.update(deletion_state='removal_started')
                    atomic_json(tombstone_path, tombstone)
                    persist_result()
                    checked_run_root = retention._checked_child(
                        storage, ('runs', wt, job['job_id']), kind='directory')
                    checked_quarantine = retention._checked_child(
                        storage, ('runs', wt, job['job_id'], quarantine_name), kind='directory')
                    if (_directory_identity(checked_run_root, 'unsafe_runtime_run_root_before_delete')
                            != run_root_identity):
                        raise CleanupBlocked('runtime_run_root_changed_before_delete')
                    if (_directory_identity(checked_quarantine, 'unsafe_runtime_quarantine_before_delete')
                            != quarantine_identity):
                        raise CleanupBlocked('runtime_quarantine_changed_before_delete')
                    if os.path.lexists(target):
                        raise CleanupBlocked('runtime_package_path_reappeared_before_delete')
                    moved_target = retention._checked_child(
                        storage, ('runs', wt, job['job_id'], quarantine_name, 'package'), kind='directory')
                    moved_tree = retention.inspect_execution(moved_target)
                    if not _execution_identity_matches(current['package_tree'], moved_tree):
                        item.update(deletion_state='identity_mismatch', observed_package_tree=moved_tree)
                        tombstone.update(deletion_state='identity_mismatch', observed_package_tree=moved_tree)
                        atomic_json(tombstone_path, tombstone)
                        persist_result()
                        raise CleanupBlocked('runtime_package_identity_mismatch_after_quarantine')

                    shutil.rmtree(moved_target)
                    if os.path.lexists(moved_path):
                        raise CleanupBlocked('runtime_removal_not_confirmed')
                    if os.path.lexists(target):
                        raise CleanupBlocked('runtime_package_path_reappeared_after_delete')
                    item.update(deletion_state='tree_removed')
                    tombstone.update(deletion_state='tree_removed', tree_removed_at=time.time())
                    atomic_json(tombstone_path, tombstone)
                    persist_result()
                    checked_run_root = retention._checked_child(
                        storage, ('runs', wt, job['job_id']), kind='directory')
                    checked_quarantine = retention._checked_child(
                        storage, ('runs', wt, job['job_id'], quarantine_name), kind='directory')
                    if (_directory_identity(checked_run_root, 'unsafe_runtime_run_root_after_delete')
                            != run_root_identity):
                        raise CleanupBlocked('runtime_run_root_changed_after_delete')
                    if (_directory_identity(checked_quarantine, 'unsafe_runtime_quarantine_after_delete')
                            != quarantine_identity):
                        raise CleanupBlocked('runtime_quarantine_changed_after_delete')
                    os.rmdir(checked_quarantine)
                    if os.path.lexists(quarantine_path):
                        raise CleanupBlocked('runtime_quarantine_removal_not_confirmed')
                    if os.path.lexists(target):
                        raise CleanupBlocked('runtime_package_path_reappeared_after_delete')
                    tombstone.update(state='removed', deletion_state='deleted',
                                     removed_logical_bytes=current['size_bytes'], finished_at=time.time())
                    atomic_json(tombstone_path, tombstone)
                    item.update(status='deleted', deletion_state='deleted',
                                removed_logical_bytes=current['size_bytes'])
                    result['removed_logical_bytes'] += current['size_bytes']
            except Exception as error:
                item.update(status='partial_error' if item['status'] == 'deleting' else 'retained')
                item.update(failure_fields(
                    error, summary_key='reason', label='failure',
                    optional_bytes_used=item.get('_optional_error_json_bytes', 0),
                ))
                if tombstone is not None:
                    tombstone.update(state='partial_error', error=item['reason'],
                                     deletion_state=item.get('deletion_state'), finished_at=time.time())
                    atomic_json(Path(tombstone['receipt']), tombstone)
            persist_result()
        succeeded = all(item['status'] == 'deleted' for item in result['items'])
        result.update(status='succeeded' if succeeded else 'partial', applied=succeeded,
                      finished_at=time.time(), disk_free_after_bytes=shutil.disk_usage(storage).free)
        result['disk_free_change_bytes'] = result['disk_free_after_bytes'] - result['disk_free_before_bytes']
        persist_result()
    return result
