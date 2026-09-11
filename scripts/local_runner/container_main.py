"""Trusted Docker-resident queue owner. Workers never receive its socket/token."""
import json
import hashlib
from datetime import datetime, timezone
from pathlib import Path, PureWindowsPath
import re
import threading
import time

from fullmag_storage import validate_path
from local_runner.queue import JobQueue
from local_runner.build_executor import execute_build, reconcile_build, capsule_path, profile_lane
from local_runner.build_source import bind_identity
from local_runner.worker_entrypoint import canonical, SCHEMA
from local_runner.coordinator import inspect_owned
from local_runner.retention import plan as retention_plan
from local_runner.service import (
    RunnerService,
    ServicePaths,
    clear_stop_request,
    read_stop_request,
    request_stop,
)
from local_runner.unix_docker import docker
from local_runner.container_api import APIUnavailable


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def desktop_daemon_root(host_path):
    value = PureWindowsPath(host_path)
    if not value.is_absolute() or not re.fullmatch('[A-Za-z]:', value.drive) or '..' in value.parts or any(c in host_path for c in ',\r\n\0'):
        raise ValueError('Expected a local Windows storage path')
    return '/run/desktop/mnt/host/' + value.drive[0].lower() + '/' + '/'.join(value.parts[1:])


def submission_manifest(source, expected_digest):
    """Validate bounded metadata; the queue verifies all bytes before create."""
    path = validate_path(Path(source) / 'manifest.json', source)
    if not path.is_file() or path.stat().st_size > 32 * 1024 * 1024:
        raise ValueError('Invalid capsule manifest')
    manifest = json.loads(path.read_text(encoding='utf-8'))
    keys = ('schema_version', 'source_mode', 'resolved_commit', 'files', 'deleted', 'included_untracked', 'excluded')
    if not isinstance(manifest, dict) or manifest.get('schema_version') != SCHEMA:
        raise ValueError('Unsupported capsule manifest')
    digest = hashlib.sha256(canonical({key: manifest[key] for key in keys})).hexdigest()
    if digest != expected_digest or manifest.get('source_digest') != digest:
        raise ValueError('Capsule metadata identity mismatch')
    return manifest


class Application:
    def __init__(self, config):
        self.storage = Path('/storage')
        self.owner = config['operator']
        self.layout = {'storage_root': '/storage', 'container_coordinator': True,
                       'daemon_storage_root': desktop_daemon_root(config['host_storage_root'])}
        for name in ('index', 'locks'):
            validate_path(self.storage / name, self.storage).mkdir(exist_ok=True)
        self.queue = JobQueue(validate_path(self.storage / 'index' / 'runner-jobs.sqlite', self.storage))
        self.paths = ServicePaths.from_storage(self.storage)
        self._lifecycle_lock = threading.RLock()
        self._worker_thread = None
        self._worker_state = 'starting'
        self._worker_error = None
        self._worker_result = None
        self._worker_started_at = None
        self._worker_finished_at = None

    def _service_record(self):
        if not self.paths.state_path.exists():
            return {'state': self._worker_state}
        try:
            record = json.loads(self.paths.state_path.read_text(encoding='utf-8'))
        except (OSError, ValueError) as error:
            return {'state': 'error', 'last_error': f'{type(error).__name__}: {error}'}
        return record if isinstance(record, dict) else {'state': 'error', 'last_error': 'Invalid worker state record'}

    def _legacy_jobs(self, active=None):
        jobs = list(self.queue.active() if active is None else active)
        queued = self.queue.next_queued(self.owner)
        if queued is not None:
            jobs.append(queued)
        return [job for job in jobs if job.get('operation') != 'build']

    def _health_snapshot(self):
        with self._lifecycle_lock:
            thread = self._worker_thread
            worker_alive = bool(thread is not None and thread.is_alive())
            worker_state = self._worker_state
            worker_error = self._worker_error
            worker_started_at = self._worker_started_at
            worker_finished_at = self._worker_finished_at
        active = self.queue.active()
        legacy = self._legacy_jobs(active)
        if legacy:
            worker_error = 'Unsupported legacy active or queued job operation; manual recovery required'
        service = self._service_record()
        service_state = service.get('state')
        if service_state == 'error' and not worker_error:
            worker_error = service.get('last_error') or 'Worker service reported an error'
        stop = read_stop_request(self.paths)
        paused = stop is not None or worker_state in ('paused', 'failed') or not worker_alive
        accepting_jobs = worker_alive and worker_state not in ('starting', 'paused', 'failed', 'stopping') and not paused and not legacy and not worker_error
        # ``ok`` describes the API/coordinator process.  An intentional
        # paused coordinator remains healthy for lifecycle reconciliation,
        # while ``accepting_jobs`` is the submission gate.
        healthy = worker_state not in ('starting', 'failed', 'stopping') and not legacy and not worker_error
        return {
            'ok': healthy,
            'accepting_jobs': accepting_jobs,
            'worker_alive': worker_alive,
            'worker_state': worker_state,
            'worker_error': worker_error,
            'worker_started_at': worker_started_at,
            'worker_finished_at': worker_finished_at,
            'stop_requested': stop is not None,
            'service_state': service_state,
            'service_status': service,
            'active_jobs': active,
            'legacy_jobs': legacy,
        }

    def _assert_submission_ready(self):
        health = self._health_snapshot()
        if not health['accepting_jobs']:
            raise APIUnavailable('Runner worker is not healthy or is paused')

    def _worker_entry(self):
        with self._lifecycle_lock:
            # The service loop owns durable execution state; this process
            # state flips before entering it so a live worker can accept a
            # queued request during the short service-file initialization.
            self._worker_state = 'running'
            self._worker_error = None
            self._worker_result = None
            self._worker_started_at = _timestamp()
            self._worker_finished_at = None
        try:
            result = self.run()
            with self._lifecycle_lock:
                self._worker_result = result
                self._worker_state = 'paused' if isinstance(result, dict) and result.get('state') == 'stopped' else 'failed'
                self._worker_finished_at = _timestamp()
        except BaseException as error:
            with self._lifecycle_lock:
                self._worker_state = 'failed'
                self._worker_error = f'{type(error).__name__}: {error}'[:2000]
                self._worker_finished_at = _timestamp()

    def _start_worker_locked(self):
        if self._worker_thread is not None and self._worker_thread.is_alive():
            return False
        self._worker_state = 'starting'
        self._worker_thread = threading.Thread(target=self._worker_entry, name='build-queue', daemon=True)
        self._worker_thread.start()
        return True

    def start_worker(self):
        with self._lifecycle_lock:
            return self._start_worker_locked()

    def submit(self, payload):
        self._assert_submission_ready()
        if set(payload) != {'worktree_id', 'source_digest', 'profile', 'operation', 'request_key', 'payload'} or payload['operation'] != 'build':
            raise ValueError('Only catalogued build requests are accepted')
        profile_lane(payload['profile'])
        detail = payload['payload']
        if set(detail) != {'source_mode', 'capsule_relative', 'origin_repo', 'capture_id', 'native_source_identity'}:
            raise ValueError('Unknown source request fields')
        manifest = submission_manifest(capsule_path(self.storage, payload), payload['source_digest'])
        if detail['source_mode'] != manifest['source_mode'] or detail['origin_repo'] != manifest['repo_root']:
            raise ValueError('Source request metadata mismatch')
        bind_identity(detail['native_source_identity'], manifest)
        record = json.loads(validate_path(self.storage / 'index' / (payload['worktree_id'] + '.json'), self.storage).read_text())
        if record['repo_root'] != manifest['repo_root'] or record['worktree_id'] != payload['worktree_id']:
            raise ValueError('Unregistered source worktree')
        with self._lifecycle_lock:
            self._assert_submission_ready()
            return self.queue.submit(owner=self.owner, **payload,
                identity_payload={'source_mode': detail['source_mode'], 'origin_repo': detail['origin_repo']})

    def list(self):
        return self.queue.list(owner=self.owner)

    def get(self, job_id):
        job = self.queue.get(job_id)
        if job is None:
            raise LookupError('Unknown job')
        if job['owner'] != self.owner:
            raise ValueError('Job owner mismatch')
        return job

    def cancel(self, job_id):
        self.get(job_id)
        self.queue.cancel(job_id, self.owner)
        return self.get(job_id)

    def logs(self, job_id):
        job = self.get(job_id)
        root = validate_path(self.storage / 'runs' / job['worktree_id'] / job_id, self.storage)
        parts = []
        for filename in ('native-build.stderr.log', 'native-build.stdout.log', 'frontend-dependencies.stderr.log', 'frontend-build.stderr.log', 'frontend-build.stdout.log'):
            path = validate_path(root / 'artifacts' / 'logs' / filename, self.storage)
            if path.exists():
                with path.open('rb') as stream:
                    stream.seek(max(0, path.stat().st_size - 16000))
                    parts.append(filename + '\n' + stream.read(16000).decode(errors='replace'))
        journal_path = validate_path(root / 'coordinator.json', self.storage)
        if journal_path.exists():
            journal = json.loads(journal_path.read_text())
            if journal.get('container_id'):
                inspect_owned(docker, journal['container_id'], job_id)
                parts.append(docker(['logs', '--tail', '100', journal['container_id']]))
        return {'job_id': job_id, 'tail': '\n'.join(parts)}

    def stop(self):
        with self._lifecycle_lock:
            existing = read_stop_request(self.paths)
            if existing is None:
                existing = request_stop(self.paths, requested_by=self.owner)
            if self._worker_thread is not None and self._worker_thread.is_alive():
                self._worker_state = 'stopping'
            return existing

    def resume(self):
        with self._lifecycle_lock:
            clear_stop_request(self.paths, reason='operator resumed the service')
            started = self._start_worker_locked()
            health = self._health_snapshot()
            return {
                'resumed': True,
                'worker_started': started,
                'worker_alive': health['worker_alive'],
                'worker_state': health['worker_state'],
                'stop_requested': health['stop_requested'],
            }

    def retention(self):
        return retention_plan(str(self.storage), self.queue.list(owner=self.owner), time.time())

    def health(self):
        import shutil
        snapshot = self._health_snapshot()
        return {
            'ok': snapshot['ok'],
            'service': 'fullmag-build-runner',
            'worker_alive': snapshot['worker_alive'],
            'worker_state': snapshot['worker_state'],
            'worker_error': snapshot['worker_error'],
            'accepting_jobs': snapshot['accepting_jobs'],
            'coordinator': snapshot['service_status'],
            'active_jobs': snapshot['active_jobs'],
            'legacy_jobs': snapshot['legacy_jobs'],
            'stop_requested': snapshot['stop_requested'],
            'storage_free_bytes': shutil.disk_usage(self.storage).free,
            'qualification': 'NOT VERIFIED',
        }

    def _execute_next(self):
        queued = self.queue.next_queued(self.owner)
        if queued is not None and queued.get('operation') != 'build':
            raise APIUnavailable('Legacy queued job requires manual recovery')
        return execute_build(self.layout, owner=self.owner, call=docker)

    def _reconcile(self, jobs):
        legacy = [job for job in jobs if job.get('operation') != 'build']
        if legacy:
            raise APIUnavailable('Legacy active job requires manual recovery')
        return [reconcile_build(self.layout, job['job_id'], owner=self.owner, call=docker) for job in jobs]

    def run(self):
        return RunnerService(paths=self.paths, interval_seconds=5,
            execute=self._execute_next,
            active=self.queue.active,
            reconcile=self._reconcile).run()


def main():
    from local_runner.container_api import serve
    config = json.loads(Path('/control/config.json').read_text())
    app = Application(config)
    app.start_worker()
    callbacks = {name: getattr(app, name) for name in ('submit', 'list', 'get', 'logs', 'cancel', 'stop', 'health', 'resume', 'retention')}
    serve(callbacks, config_path='/control/config.json', host='0.0.0.0', port=8765)


if __name__ == '__main__':
    main()
