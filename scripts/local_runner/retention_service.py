"""Nonblocking administrative retention commands owned by one coordinator."""
from datetime import datetime, timezone
import math
from pathlib import Path
import re
import threading
import time
import uuid
from contextlib import contextmanager

from fullmag_storage import validate_path
from local_runner import retention
from local_runner.retention_executor import apply_execution_plan
from local_runner.retention import PreviewCancelled
from local_runner.retention_persistence import (
    MANIFEST_SCHEMA,
    _read_small_object,
    failure_fields,
    read_document,
    write_document,
)


_MAX_PLAN_LIST_ITEMS = 100
_PLAN_ID = re.compile(r'plan-[a-f0-9]{8,32}\Z')
_RETENTION_SCOPES = frozenset(('execution', 'sources', 'runtime'))


def _is_finite_number(value):
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


class RetentionService:
    def __init__(self, hub, queue, layout, *, owner, call, stream_logs=None):
        self.hub, self.queue, self.layout = hub, queue, layout
        self.owner, self.call = owner, call
        self.stream_logs = stream_logs
        self.storage = Path(layout['storage_root'])
        self.lock = threading.RLock()
        self.thread = None
        self.active_id = None
        self.active_kind = None
        self.active_scope = None
        self.cancel_event = None
        self.stopping = False
        self.build_running = False
        self.last_automatic = 0.0
        self.next_automatic_scope = 'execution'
        self.hub.retention_execution_available = True
        self.hub.runtime_retention_available = True

    @property
    def busy(self):
        with self.lock:
            return self.thread is not None and self.thread.is_alive()

    def _path(self, plan_id, *, operation=False):
        if not isinstance(plan_id, str) or re.fullmatch(r'plan-[a-f0-9]{8,32}', plan_id) is None:
            raise ValueError('Invalid retention plan ID')
        directory = 'retention-operations' if operation else 'retention-plans'
        path = validate_path(self.storage / 'index' / directory / (plan_id + '.json'), self.storage)
        return path

    def _save(self, record, *, operation=False):
        path = self._path(record['plan_id'], operation=operation)
        path.parent.mkdir(parents=True, exist_ok=True)
        write_document(
            self.storage,
            path,
            record,
            kind='operation' if operation else 'plan',
            scope=record.get('scope'),
        )

    @staticmethod
    def _list_timestamp(value):
        if _is_finite_number(value):
            try:
                return float(value)
            except OverflowError:
                return 0.0
        if isinstance(value, str) and len(value) <= 64:
            try:
                parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                return parsed.timestamp()
            except (OverflowError, OSError, ValueError):
                pass
        return 0.0

    def _list_metadata_record(self, storage, plan_id, *, operation=False):
        if not isinstance(plan_id, str) or _PLAN_ID.fullmatch(plan_id) is None:
            return None
        kind = 'operation' if operation else 'plan'
        path = self._path(plan_id, operation=operation)
        document = _read_small_object(storage, path)
        schema = document.get('storage_schema')
        if schema is None:
            record = document
        elif schema == MANIFEST_SCHEMA:
            scope = document.get('scope')
            if (document.get('kind') != kind or document.get('plan_id') != plan_id
                    or scope not in _RETENTION_SCOPES):
                return None
            payload = document.get('payload')
            if (not isinstance(payload, dict) or payload.get('plan_id') != plan_id
                    or payload.get('scope') != scope):
                return None
            record = payload
        else:
            return None
        if record.get('plan_id') != plan_id:
            return None
        scope = record.get('scope')
        if scope is not None and scope not in _RETENTION_SCOPES:
            return None
        return record

    @staticmethod
    def _list_document_directory(storage, name):
        try:
            return retention._checked_child(storage, ('index', name), kind='directory')
        except retention._PathIssue as error:
            if error.reason == 'missing_run_path':
                return None
            raise

    @staticmethod
    def _list_document_ids(directory):
        if directory is None:
            return
        for path in directory.iterdir():
            match = re.fullmatch(r'(plan-[a-f0-9]{8,32})\.json', path.name)
            if match is not None:
                yield match.group(1)

    @staticmethod
    def _plan_document_exists(storage, plan_id):
        try:
            retention._checked_child(
                storage, ('index', 'retention-plans', plan_id + '.json'), kind='file'
            )
        except retention._PathIssue as error:
            if error.reason == 'missing_run_path':
                return False
            # Unsafe or unreadable plan paths must not cause a duplicate entry
            # from the operation directory.
            return True
        return True

    @classmethod
    def _plan_summary(cls, plan_id, *records):
        merged = {}
        for record in records:
            if record is not None:
                merged.update(record)
        summary = {'plan_id': plan_id}
        scope = merged.get('scope')
        if scope in _RETENTION_SCOPES:
            summary['scope'] = scope
        status = merged.get('status')
        if isinstance(status, str) and 0 < len(status) <= 64:
            summary['status'] = status
        applied = merged.get('applied')
        if isinstance(applied, bool):
            summary['applied'] = applied
        for key in ('created_at', 'started_at', 'finished_at'):
            value = merged.get(key)
            if (isinstance(value, str) and len(value) <= 64) or (
                _is_finite_number(value)
            ):
                summary[key] = value
        for key in (
            'candidates_count', 'retained_count', 'estimated_reclaimed_bytes',
            'reclaimed_bytes', 'removed_logical_bytes',
        ):
            value = merged.get(key)
            if isinstance(value, int) and not isinstance(value, bool) and 0 <= value and len(str(value)) <= 128:
                summary[key] = value
            elif isinstance(value, float) and _is_finite_number(value) and value >= 0:
                summary[key] = value
        return summary

    def list(self):
        """List bounded plan summaries without reconciling or loading inventory parts."""
        storage = retention._canonical_storage(self.storage)
        plan_directory = self._list_document_directory(storage, 'retention-plans')
        operation_directory = self._list_document_directory(storage, 'retention-operations')
        items = []
        total = 0

        def add(plan_id, plan_record, operation_record=None):
            nonlocal total
            if plan_record is None and operation_record is None:
                return
            summary = self._plan_summary(plan_id, plan_record, operation_record)
            total += 1
            items.append(summary)
            items.sort(
                key=lambda item: (self._list_timestamp(item.get('created_at')), item['plan_id']),
                reverse=True,
            )
            if len(items) > _MAX_PLAN_LIST_ITEMS:
                items.pop()

        for plan_id in self._list_document_ids(plan_directory):
            try:
                plan_record = self._list_metadata_record(storage, plan_id)
            except Exception:
                plan_record = None
            try:
                operation_record = self._list_metadata_record(storage, plan_id, operation=True)
            except Exception:
                operation_record = None
            add(plan_id, plan_record, operation_record)

        for plan_id in self._list_document_ids(operation_directory):
            if self._plan_document_exists(storage, plan_id):
                continue
            try:
                operation_record = self._list_metadata_record(storage, plan_id, operation=True)
            except Exception:
                operation_record = None
            add(plan_id, None, operation_record)

        return {'items': items, 'total': total}

    def get(self, plan_id):
        with self.lock:
            operation_path = self._path(plan_id, operation=True)
            original_path = self._path(plan_id)
            has_operation = operation_path.exists()
            path = operation_path if has_operation else original_path
            if not path.exists():
                raise ValueError('Retention plan not found')
            kind = 'operation' if has_operation else 'plan'
            operation_record = read_document(
                self.storage, path, plan_id=plan_id, kind=kind
            )
            original_record = {}
            if has_operation and original_path.exists():
                original_record = read_document(
                    self.storage, original_path, plan_id=plan_id, kind='plan'
                )
            record = {**original_record, **operation_record}
            if record.get('status') in ('planning', 'cancel_requested', 'accepted', 'running'):
                live = self.active_id == plan_id and self.busy
                if not live:
                    operation_record = {
                        **operation_record,
                        'status': 'interrupted_unknown',
                        'applied': False,
                        'error': 'Previous operation stopped; reconcile with a fresh plan',
                    }
                    # Persist only the operation receipt. The merged plan stays
                    # in the plan document and is never duplicated into recovery.
                    self._save(operation_record, operation=has_operation)
                    record = {**original_record, **operation_record}
        # The metadata needed by the executor stays on disk. The UI receives
        # one control-plane copy rather than a duplicate raw engine inventory.
        record.pop('raw_engine_plan', None)
        record.pop('raw_runtime_plan', None)
        return record
    def _launch(self, plan_id, target, *, kind, scope, cancel_event=None):
        self.active_id = plan_id

        self.active_kind = kind
        self.active_scope = scope
        self.cancel_event = cancel_event

        def run():
            try:
                target()
            finally:
                with self.lock:
                    if self.active_id == plan_id:
                        self.active_kind = None
                        self.active_scope = None
                        self.cancel_event = None

        self.thread = threading.Thread(target=run, name='retention-' + plan_id, daemon=True)
        self.thread.start()

    @contextmanager
    def build_slot(self):
        # Serialize admission, without holding a mutex for the whole build.
        # The filesystem locks remain the cross-process safety boundary.
        with self.lock:
            admitted = not self.busy and not self.build_running
            if admitted:
                self.build_running = True
        try:
            yield admitted
        finally:
            if admitted:
                with self.lock:
                    self.build_running = False

    def preview(self, *, automatic=False, scope='execution', job_ids=None):
        if scope not in ('execution', 'sources', 'runtime'):
            raise ValueError('Unknown maintenance scope')
        if job_ids is not None and (not isinstance(job_ids, list) or not 1 <= len(job_ids) <= 256
                or any(not isinstance(jid, str) or re.fullmatch(r'[a-f0-9]{32}', jid) is None for jid in job_ids)):
            raise ValueError('Expected up to 256 full job IDs')
        with self.lock:
            if self.stopping:
                return {'scope': scope, 'status': 'blocked', 'applied': False, 'error': 'coordinator_draining'}
            if self.build_running:
                return {'scope': scope, 'status': 'blocked', 'applied': False, 'error': 'build_in_progress'}
            if self.busy:
                return {'scope': scope, 'status': 'blocked', 'applied': False,
                        'error': 'another_retention_operation_active', 'active_plan_id': self.active_id}
            plan_id = 'plan-' + uuid.uuid4().hex
            created_at = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
            planning = {'plan_id': plan_id, 'scope': scope, 'status': 'planning', 'applied': False, 'created_at': created_at}
            self._save(planning)
            cancel_event = threading.Event() if scope == 'execution' else None

            def save_progress(fields):
                with self.lock:
                    if cancel_event is not None and cancel_event.is_set():
                        raise PreviewCancelled("Retention preview was cancelled")
                    if self.active_id == plan_id and self.active_kind == 'preview':
                        self._save({**planning, **fields})

            def work():
                try:
                    if scope == 'sources':
                        from local_runner.storage_maintenance import plan_source_compaction
                        plan = plan_source_compaction(self.layout, self.queue, owner=self.owner, job_ids=job_ids)
                    elif scope == 'runtime':
                        from local_runner.runtime_retention import plan_runtime_cleanup
                        plan = plan_runtime_cleanup(self.layout, self.queue, owner=self.owner, call=self.call,
                                                    policy=self.hub.get_retention_policy(), job_ids=job_ids)
                    else:
                        plan = self.hub.generate_retention_plan(
                            queue=self.queue, job_ids=job_ids, progress=save_progress,
                            cancelled=cancel_event)
                    plan['scope'] = scope
                    plan['created_at'] = created_at
                    plan['plan_id'] = plan_id
                    if automatic:
                        with self.lock:
                            if cancel_event is not None and cancel_event.is_set():
                                raise PreviewCancelled("Retention preview was cancelled")
                            # Policy and drain state may change while inventory runs.
                            policy = self.hub.get_retention_policy()
                            should_apply = (not self.stopping and policy['mode'] == 'automatic'
                                            and (scope != 'runtime' or policy['runtime_retention_enabled']))
                            if should_apply:
                                accepted = {**plan, 'status': 'accepted', 'applied': False}
                                self._save(accepted)
                                # This transition shares the cancellation lock:
                                # once apply is accepted, cancel can no longer
                                # mistake it for a read-only preview.
                                self.active_kind = 'apply'
                            else:
                                self._save(plan)
                                self.active_kind = None
                            self.hub.record_event(
                                'INFO', 'retention_plan_created',
                                f"Created retention plan {plan_id} ({plan.get('candidates_count', 0)} candidates)")
                        if should_apply:
                            self._execute(accepted)
                    else:
                        with self.lock:
                            if cancel_event is not None and cancel_event.is_set():
                                raise PreviewCancelled("Retention preview was cancelled")
                            self._save(plan)
                            # The result is now durable and cannot be canceled.
                            self.active_kind = None
                            self.hub.record_event(
                                'INFO', 'retention_plan_created',
                                f"Created retention plan {plan_id} ({plan.get('candidates_count', 0)} candidates)")
                except PreviewCancelled:
                    self._finish_cancelled(plan_id, scope, created_at)
                except Exception as error:
                    with self.lock:
                        if cancel_event is not None and cancel_event.is_set() and self.active_kind == 'preview':
                            self._finish_cancelled(plan_id, scope, created_at)
                        else:
                            self._save({'plan_id': plan_id, 'scope': scope, 'status': 'failed', 'applied': False,
                                        **failure_fields(error, summary_key='error', label='failure')})
            self._launch(plan_id, work, kind='preview', scope=scope, cancel_event=cancel_event)
            return {'plan_id': plan_id, 'scope': scope, 'status': 'planning', 'applied': False}

    def _finish_cancelled(self, plan_id, scope, created_at):
        with self.lock:
            current = read_document(
                self.storage,
                self._path(plan_id),
                plan_id=plan_id,
                kind='plan',
                scope=scope,
            )
            allowed = (
                'processed_jobs', 'total_jobs', 'current_job_id', 'tree_phase',
                'tree_entries_enumerated', 'tree_stat_entries', 'tree_files',
                'tree_logical_bytes', 'orphan_scan_phase',
                'orphan_worktrees_enumerated', 'orphan_jobs_enumerated',
            )
            details = {key: current[key] for key in allowed if key in current}
            self._save({
                'plan_id': plan_id,
                'scope': scope,
                'status': 'cancelled',
                'applied': False,
                'created_at': created_at,
                'finished_at': time.time(),
                'error': 'preview_cancelled',
                **details,
            })
            self.hub.record_event('INFO', 'retention_terminal',
                                  f"Retention {plan_id}: cancelled")
    def _execute(self, plan):
        scope = plan.get('scope', 'execution')
        try:
            policy = self.hub.get_retention_policy()
            if scope == 'sources':
                from local_runner.storage_maintenance import apply_source_compaction
                executor = apply_source_compaction
            elif scope == 'runtime':
                from local_runner.runtime_retention import apply_runtime_cleanup
                executor = apply_runtime_cleanup
            elif scope == 'execution':
                executor = apply_execution_plan
            else:
                raise ValueError('Unknown maintenance scope')
            executor_kwargs = {
                'owner': self.owner,
                'call': self.call,
                'policy': policy,
            }
            if scope == 'execution':
                executor_kwargs['stream_logs'] = self.stream_logs
            result = executor(self.layout, plan, self.queue, **executor_kwargs)
        except Exception as error:
            operation_path = self._path(plan['plan_id'], operation=True)
            if operation_path.exists():
                # Keep the last durable progress record. It either remains
                # terminal or is reconciled as interrupted_unknown after this
                # worker exits; overwriting it would discard partial evidence.
                try:
                    result = read_document(
                        self.storage,
                        operation_path,
                        plan_id=plan['plan_id'],
                        kind='operation',
                        scope=scope,
                    )
                except Exception:
                    result = {
                        'plan_id': plan['plan_id'],
                        'scope': scope,
                        'status': 'blocked',
                        'applied': False,
                        'error': 'operation_receipt_unreadable',
                        'reclaimed_bytes': None,
                        'finished_at': time.time(),
                    }
            else:
                result = {
                    'plan_id': plan['plan_id'],
                    'scope': scope,
                    'status': 'blocked',
                    'applied': False,
                    'reclaimed_bytes': None,
                    'finished_at': time.time(),
                }
                result.update(failure_fields(error, summary_key='error', label='failure'))
                self._save(result, operation=True)
        self.hub._invalidate_resources_cache()
        with self.hub._lock:
            self.hub._plans[plan['plan_id']] = {**plan, **result}
            while len(self.hub._plans) > 16:
                self.hub._plans.pop(next(iter(self.hub._plans)))
        self.hub.record_event('INFO' if result.get('applied') else 'WARN', 'retention_terminal',
                              f"Retention {plan['plan_id']}: {result['status']}")
        return result
    def apply(self, plan_id):
        with self.lock:
            if self._path(plan_id, operation=True).exists():
                return self.get(plan_id)
            if self.stopping:
                return {'plan_id': plan_id, 'status': 'blocked', 'applied': False,
                        'error': 'coordinator_draining'}
            if self.build_running:
                return {'plan_id': plan_id, 'status': 'blocked', 'applied': False,
                        'error': 'build_in_progress'}
            if self.busy:
                if self.active_id == plan_id:
                    return self.get(plan_id)
                return {'plan_id': plan_id, 'status': 'blocked', 'applied': False,
                        'error': 'another_retention_operation_active'}
            plan = read_document(
                self.storage, self._path(plan_id), plan_id=plan_id, kind='plan'
            )
            if plan.get('status') != 'preview':
                return {'plan_id': plan_id, 'status': 'blocked', 'applied': False,
                        'error': 'plan_is_not_a_completed_preview'}
            accepted = {**plan, 'status': 'accepted', 'applied': False}
            self._save(accepted)
            self._launch(plan_id, lambda: self._execute(plan),
                         kind='apply', scope=plan.get('scope', 'execution'))
            return {'plan_id': plan_id, 'status': 'accepted', 'applied': False}

    def cancel(self, plan_id):
        # Validate before inspecting in-memory operation state or touching disk.
        self._path(plan_id)
        with self.lock:
            live = self.active_id == plan_id and self.busy
            if live and self.active_kind == 'preview' and self.active_scope == 'execution':
                if self.cancel_event is None:
                    return {'plan_id': plan_id, 'scope': 'execution', 'status': 'blocked',
                            'applied': False, 'error': 'cancellation_unavailable'}
                record = self.get(plan_id)
                if self.cancel_event.is_set():
                    return record
                if record.get('status') != 'planning':
                    # Final publication and the preview -> apply transition are
                    # serialized with this lock; preserve whichever state won.
                    return record
                self.cancel_event.set()
                record.update(status='cancel_requested', applied=False)
                self._save(record)
                return record

            try:
                record = self.get(plan_id)
            except ValueError as error:
                if str(error) != 'Retention plan not found':
                    raise
                return {'plan_id': plan_id, 'status': 'blocked', 'applied': False,
                        'error': 'retention_plan_not_found'}
            scope = record.get('scope')
            if scope in ('sources', 'runtime') or (live and self.active_scope in ('sources', 'runtime')):
                return {'plan_id': plan_id, 'scope': scope or self.active_scope,
                        'status': 'blocked', 'applied': False,
                        'error': 'retention_scope_not_cancellable'}
            if live and self.active_kind == 'apply':
                return {'plan_id': plan_id, 'scope': scope or self.active_scope,
                        'status': 'blocked', 'applied': False,
                        'error': 'retention_operation_not_cancellable'}
            if live and record.get('status') in ('planning', 'cancel_requested', 'accepted', 'running'):
                return {'plan_id': plan_id, 'scope': scope or self.active_scope,
                        'status': 'blocked', 'applied': False,
                        'error': 'retention_operation_not_cancellable'}
            # Completed previews and reconciled terminal/unknown outcomes are
            # idempotent reads: never manufacture a cancellation result.
            return record

    def tick(self, *, force=False):
        with self.lock:
            if self.stopping or self.busy or self.build_running or self.queue.active():
                return
            if self.hub.get_retention_policy()['mode'] != 'automatic':
                return
            now = time.monotonic()
            if not force and now - self.last_automatic < 300:
                return
            self.last_automatic = now
            policy = self.hub.get_retention_policy()
            scope = self.next_automatic_scope if policy['runtime_retention_enabled'] else 'execution'
            self.next_automatic_scope = 'runtime' if scope == 'execution' else 'execution'
            self.preview(automatic=True, scope=scope)

    def drain(self):
        with self.lock:
            self.stopping = True

    def resume(self):
        with self.lock:
            self.stopping = False
