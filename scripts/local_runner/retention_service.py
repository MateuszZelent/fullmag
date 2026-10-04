"""Nonblocking administrative retention commands owned by one coordinator."""
import json
from pathlib import Path
import re
import threading
import time
import uuid
from contextlib import contextmanager

from fullmag_storage import atomic_json, validate_path
from local_runner.retention_executor import apply_execution_plan
from local_runner.retention import _read_json


class RetentionService:
    def __init__(self, hub, queue, layout, *, owner, call):
        self.hub, self.queue, self.layout = hub, queue, layout
        self.owner, self.call = owner, call
        self.storage = Path(layout['storage_root'])
        self.lock = threading.RLock()
        self.thread = None
        self.active_id = None
        self.stopping = False
        self.build_running = False
        self.last_automatic = 0.0
        self.hub.retention_execution_available = True

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
        atomic_json(path, record)

    def get(self, plan_id):
        path = self._path(plan_id, operation=True)
        if not path.exists():
            path = self._path(plan_id)
        if not path.exists():
            raise ValueError('Retention plan not found')
        record = dict(_read_json(path))
        original = self._path(plan_id)
        if path != original and original.exists():
            record = {**dict(_read_json(original)), **record}
        if record.get('status') in ('planning', 'accepted', 'running'):
            with self.lock:
                live = self.active_id == plan_id and self.busy
            if not live:
                record.update(status='interrupted_unknown', applied=False,
                              error='Previous operation stopped; reconcile with a fresh plan')
        # The metadata needed by the executor stays on disk. The UI receives
        # one control-plane copy rather than a duplicate raw engine inventory.
        record.pop('raw_engine_plan', None)
        return record

    def _launch(self, plan_id, target):
        self.active_id = plan_id
        self.thread = threading.Thread(target=target, name='retention-' + plan_id, daemon=True)
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

    def preview(self, *, automatic=False):
        with self.lock:
            if self.stopping:
                return {'status': 'blocked', 'applied': False, 'error': 'coordinator_draining'}
            if self.build_running:
                return {'status': 'blocked', 'applied': False, 'error': 'build_in_progress'}
            if self.busy:
                return self.get(self.active_id)
            plan_id = 'plan-' + uuid.uuid4().hex
            self._save({'plan_id': plan_id, 'status': 'planning', 'applied': False})
            def work():
                try:
                    plan = self.hub.generate_retention_plan(queue=self.queue)
                    plan['plan_id'] = plan_id
                    self._save(plan)
                    if automatic:
                        # Policy and drain state may change while inventory runs.
                        if self.stopping or self.hub.get_retention_policy()['mode'] != 'automatic':
                            return
                        self._execute(plan)
                except Exception as error:
                    self._save({'plan_id': plan_id, 'status': 'failed', 'applied': False,
                                'error': f'{type(error).__name__}: {error}'})
            self._launch(plan_id, work)
            return {'plan_id': plan_id, 'status': 'planning', 'applied': False}

    def _execute(self, plan):
        try:
            policy = self.hub.get_retention_policy()
            result = apply_execution_plan(self.layout, plan, self.queue, owner=self.owner,
                                          call=self.call, policy=policy)
        except Exception as error:
            result = {'plan_id': plan['plan_id'], 'status': 'blocked', 'applied': False,
                      'error': f'{type(error).__name__}: {error}', 'reclaimed_bytes': None,
                      'finished_at': time.time()}
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
            plan = dict(_read_json(self._path(plan_id)))
            if plan.get('status') != 'preview':
                return {'plan_id': plan_id, 'status': 'blocked', 'applied': False,
                        'error': 'plan_is_not_a_completed_preview'}
            accepted = {**plan, 'status': 'accepted', 'applied': False}
            self._save(accepted)
            self._launch(plan_id, lambda: self._execute(plan))
            return {'plan_id': plan_id, 'status': 'accepted', 'applied': False}

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
            self.preview(automatic=True)

    def drain(self):
        with self.lock:
            self.stopping = True

    def resume(self):
        with self.lock:
            self.stopping = False
