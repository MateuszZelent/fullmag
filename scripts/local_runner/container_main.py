"""Trusted Docker-resident queue owner. Workers never receive its socket/token."""
import json
import hashlib
import os
from datetime import datetime, timezone
from pathlib import Path, PureWindowsPath
import re
import threading
import time

from fullmag_storage import validate_path
from local_runner.queue import JobQueue
from local_runner.build_executor import execute_build, reconcile_build, capsule_path, profile_lane, PROFILES
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
from local_runner.observability import (
    ObservabilityHub,
    build_job_timeline,
    _fast_dir_size,
    get_process_rss_bytes,
    get_process_memory_limit_bytes,
)


_RETENTION_QUEUE_LIMIT = 1000


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
        profiles = config.get('allowed_profiles')
        if (not isinstance(profiles, list) or not profiles
                or any(not isinstance(profile, str) for profile in profiles)
                or len(set(profiles)) != len(profiles)):
            raise ValueError('Coordinator requires an explicit unique profile allow-list')
        for profile in profiles:
            profile_lane(profile)
        self.allowed_profiles = frozenset(profiles)
        self.storage = Path('/storage')
        self.owner = config['operator']
        self.layout = {'storage_root': '/storage', 'container_coordinator': True,
                       'daemon_storage_root': desktop_daemon_root(config['host_storage_root'])}
        for name in ('index', 'locks'):
            validate_path(self.storage / name, self.storage).mkdir(exist_ok=True)
        self.queue = JobQueue(validate_path(self.storage / 'index' / 'runner-jobs.sqlite', self.storage))
        self.paths = ServicePaths.from_storage(self.storage)
        self.hub = ObservabilityHub(self.storage, owner=self.owner)
        self._lifecycle_lock = threading.RLock()
        self._worker_thread = None
        self._worker_state = 'starting'
        self._worker_error = None
        self._worker_result = None
        self._worker_started_at = None
        self._worker_finished_at = None
        self._worker_samples_by_job = {}
        self._worker_io_baselines = {}

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
        if payload['profile'] not in self.allowed_profiles:
            raise ValueError('Build profile is not enabled by the operator configuration')
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
            job = self.queue.submit(owner=self.owner, **payload,
                identity_payload={
                    'source_mode': detail['source_mode'],
                    'origin_repo': detail['origin_repo'],
                    'native_source_identity': detail['native_source_identity'],
                })
            self.hub.record_event(
                "INFO",
                "job_queued",
                f"Zadanie {job['job_id']} dodane do kolejki (profil: {payload.get('profile')})",
                job_id=job["job_id"],
                profile=payload.get("profile"),
            )
            return job

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
        job = self.get(job_id)
        self.queue.cancel(job_id, self.owner)
        self.hub.record_event(
            "WARN",
            "job_cancelled",
            f"Anulowano zadanie {job_id} przez operatora",
            job_id=job_id,
            profile=job.get("profile"),
        )
        return self.get(job_id)

    def logs(self, job_id):
        job = self.get(job_id)
        root = validate_path(self.storage / 'runs' / job['worktree_id'] / job_id, self.storage)
        parts = []
        for filename in ('native-build.stderr.log', 'native-build.stdout.log', 'frontend-dependencies.stdout.log', 'frontend-dependencies.stderr.log', 'frontend-build.stderr.log', 'frontend-build.stdout.log'):
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
            self.hub.record_event("WARN", "queue_paused", f"Kolejka wstrzymana przez {self.owner} (drain)")
            return existing

    def resume(self):
        with self._lifecycle_lock:
            worker_alive = self._worker_thread is not None and self._worker_thread.is_alive()
            # Once drain starts, the service can decide to stop before it
            # publishes its terminal record. Do not clear the marker until
            # the thread exits, even if the durable state still says running.
            if worker_alive and self._worker_state == 'stopping':
                health = self._health_snapshot()
                return {
                    'resumed': False,
                    'worker_started': False,
                    'worker_alive': health['worker_alive'],
                    'worker_state': health['worker_state'],
                    'stop_requested': health['stop_requested'],
                    'reason': 'worker is finishing its stop; retry resume after it exits',
                }
            clear_stop_request(self.paths, reason='operator resumed the service')
            started = self._start_worker_locked()
            health = self._health_snapshot()
            if started:
                self.hub.record_event("INFO", "queue_resumed", "Kolejka wznowiona przez operatora")
            return {
                'resumed': True,
                'worker_started': started,
                'worker_alive': health['worker_alive'],
                'worker_state': health['worker_state'],
                'stop_requested': health['stop_requested'],
            }

    def retention(self):
        jobs = self.queue.list(owner=self.owner, limit=_RETENTION_QUEUE_LIMIT)
        result = retention_plan(str(self.storage), jobs, time.time())
        # JobQueue exposes a bounded list without a count/offset API.  Keep
        # retention fail-closed and disclose that a full inventory is not
        # proven whenever the bound is reached.
        result['queue_inventory'] = {
            'limit': _RETENTION_QUEUE_LIMIT,
            'truncated': len(jobs) >= _RETENTION_QUEUE_LIMIT,
        }
        return result

    def health(self):
        import shutil
        snapshot = self._health_snapshot()
        try:
            free_bytes = shutil.disk_usage(self.storage).free
        except Exception:
            free_bytes = None
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
            'storage_free_bytes': free_bytes,
            'allowed_profiles': list(PROFILES.keys()),
            'qualification': 'NOT VERIFIED',
        }

    def _inspect_worker_metrics(self, current_job=None):
        if not current_job:
            return {
                'container_id': None,
                'container_verified': False,
                'memory_mb': None,
                'limit_mb': None,
                'cpu_percent': None,
                'io_mb_s': None,
            }
        wt = current_job.get('worktree_id', '')
        job_id = current_job.get('job_id', '')
        journal_path = self.storage / 'runs' / wt / job_id / 'coordinator.json'
        container_id = None
        if journal_path.is_file():
            try:
                journal = json.loads(journal_path.read_text(encoding='utf-8'))
                container_id = journal.get('container_id')
            except Exception:
                pass

        if not container_id:
            return {
                'container_id': None,
                'container_verified': False,
                'memory_mb': None,
                'limit_mb': None,
                'cpu_percent': None,
                'io_mb_s': None,
            }

        mem_mb = None
        limit_mb = None
        cpu_pct = None
        io_rate = None
        container_verified = False

        def _parse_bytes(value):
            value = value.strip().upper()
            mult = 1
            if value.endswith(('KIB', 'KB')):
                mult = 1024
            elif value.endswith(('MIB', 'MB')):
                mult = 1024**2
            elif value.endswith(('GIB', 'GB')):
                mult = 1024**3
            elif value.endswith('B'):
                mult = 1
            number = re.findall(r'[\d.]+', value)
            return float(number[0]) * mult if number else None

        try:
            inspect_owned(docker, container_id, job_id)
            container_verified = True
            stats_raw = docker(['stats', '--no-stream', '--no-trunc', '--format', '{{.MemUsage}}|{{.CPUPerc}}|{{.BlockIO}}', container_id])
            if stats_raw and '|' in stats_raw:
                parts = stats_raw.strip().split('|')
                if len(parts) >= 1 and '/' in parts[0]:
                    usage_part, limit_part = parts[0].split('/', 1)
                    u_b = _parse_bytes(usage_part)
                    l_b = _parse_bytes(limit_part)
                    if u_b is not None:
                        mem_mb = round(u_b / (1024 * 1024), 1)
                    if l_b is not None:
                        limit_mb = int(l_b / (1024 * 1024))
                if len(parts) >= 2:
                    cpu_raw = parts[1].replace('%', '').strip()
                    try:
                        cpu_pct = round(float(cpu_raw), 1)
                    except Exception:
                        pass
                if len(parts) >= 3 and '/' in parts[2]:
                    read_part, write_part = parts[2].split('/', 1)
                    read_b = _parse_bytes(read_part)
                    write_b = _parse_bytes(write_part)
                    if read_b is not None and write_b is not None:
                        now = time.monotonic()
                        baselines = getattr(self, '_worker_io_baselines', None)
                        if baselines is None:
                            baselines = {}
                            self._worker_io_baselines = baselines
                        previous = baselines.get(container_id)
                        baselines[container_id] = (now, read_b, write_b)
                        if previous is not None:
                            elapsed = now - previous[0]
                            read_delta = read_b - previous[1]
                            write_delta = write_b - previous[2]
                            if elapsed > 0 and read_delta >= 0 and write_delta >= 0:
                                io_rate = round((read_delta + write_delta) / (1024 * 1024) / elapsed, 2)
        except Exception:
            pass

        return {
            'container_id': container_id,
            'container_verified': container_verified,
            'memory_mb': mem_mb,
            'limit_mb': limit_mb,
            'cpu_percent': cpu_pct,
            'io_mb_s': io_rate,
        }

    def overview(self):
        health = self.health()
        volumes = self.hub.get_storage_volumes()
        trends = self.hub.get_metrics_trends()
        active = self.queue.active()

        if hasattr(self.queue, 'connection') and getattr(self.queue, 'path', None) and Path(self.queue.path).is_file():
            with self.queue.connection() as db:
                rows = db.execute("SELECT * FROM jobs WHERE (? IS NULL OR owner=?) AND state='queued' ORDER BY sequence ASC", (self.owner, self.owner)).fetchall()
                queued_jobs = [self.queue.record(r) for r in rows]
        else:
            all_queue_jobs = self.queue.list(owner=self.owner, limit=1000)
            queued_jobs = [j for j in all_queue_jobs if j.get('state') == 'queued']
            queued_jobs.sort(key=lambda j: j.get('created_at', 0))

        active_build = None
        if active:
            job = active[0]
            stages = build_job_timeline(job, self.storage)
            current_stage = next((s['name'] for s in reversed(stages) if s['status'] in ('running', 'succeeded')), 'W toku')
            active_build = {
                'job_id': job['job_id'],
                'profile': job['profile'],
                'worktree_id': job['worktree_id'],
                'source_digest': job['source_digest'],
                'created_at': job['created_at'],
                'started_at': job.get('started_at', job.get('created_at')),
                'stage': current_stage,
                'stages': stages,
            }
        recent_plans = list(self.hub._plans.values())
        last_plan = recent_plans[-1] if recent_plans else None
        worker_metrics = self._inspect_worker_metrics(active[0] if active else None)
        return {
            'active_build': active_build,
            'queued_count': len(queued_jobs),
            'next_jobs': queued_jobs[:5],
            'next_job': queued_jobs[0] if queued_jobs else None,
            'worker': {
                'state': health['worker_state'],
                'alive': health['worker_alive'],
                'accepting_jobs': health['accepting_jobs'],
                'memory_mb': worker_metrics['memory_mb'],
                'limit_mb': worker_metrics['limit_mb'],
                'cpu_percent': worker_metrics['cpu_percent'],
                'io_mb_s': worker_metrics['io_mb_s'],
            },
            'storage': volumes[0] if volumes else {},
            'last_cleanup': {
                'candidates_count': last_plan['candidates_count'] if last_plan else None,
                'estimated_reclaimed_bytes': last_plan['estimated_reclaimed_bytes'] if last_plan else None,
                'reclaimed_bytes': last_plan.get('actual_reclaimed_bytes', 0) if last_plan and last_plan.get('applied') else 0,
                'status': last_plan['status'] if last_plan else 'brak',
            },
            'trends': trends,
            'incidents': self.alerts(),
        }

    def paginated_jobs(self, query=None):
        query = query or {}
        status = query.get('status')
        profile = query.get('profile')
        worktree = query.get('worktree')
        search = query.get('search', '').lower()
        sort = query.get('sort', 'newest')
        try:
            limit = max(1, min(int(query.get('limit', 50)), 1000))
        except (ValueError, TypeError):
            limit = 50
        try:
            page = max(1, int(query.get('page', 1)))
        except (ValueError, TypeError):
            page = 1

        has_sqlite = (
            hasattr(self.queue, 'connection')
            and getattr(self.queue, 'path', None)
            and Path(self.queue.path).is_file()
        )

        if has_sqlite:
            where_clauses = ["(? IS NULL OR owner=?)"]
            params = [self.owner, self.owner]

            if status and status != 'all':
                if status in ('history', 'terminal'):
                    where_clauses.append("state IN ('succeeded', 'failed', 'cancelled')")
                else:
                    where_clauses.append("state = ?")
                    params.append(status)

            if profile and profile != 'all':
                where_clauses.append("profile = ?")
                params.append(profile)

            if worktree and worktree != 'all':
                where_clauses.append("worktree_id = ?")
                params.append(worktree)

            if search:
                where_clauses.append("(LOWER(job_id) LIKE ? OR LOWER(worktree_id) LIKE ? OR LOWER(source_digest) LIKE ?)")
                search_pat = f"%{search}%"
                params.extend([search_pat, search_pat, search_pat])

            where_sql = " WHERE " + " AND ".join(where_clauses)

            order_sql = "ORDER BY sequence DESC"
            if sort == 'oldest':
                order_sql = "ORDER BY sequence ASC"
            elif sort == 'duration':
                order_sql = "ORDER BY (COALESCE(updated_at, 0) - COALESCE(created_at, 0)) DESC"

            with self.queue.connection() as db:
                count_row = db.execute(f"SELECT COUNT(*) AS total FROM jobs{where_sql}", params).fetchone()
                total = count_row['total'] if count_row else 0

                wt_rows = db.execute("SELECT DISTINCT worktree_id FROM jobs WHERE (? IS NULL OR owner=?) AND worktree_id IS NOT NULL", (self.owner, self.owner)).fetchall()
                unique_worktrees = sorted([r['worktree_id'] for r in wt_rows if r['worktree_id']])

                offset = (page - 1) * limit
                query_params = list(params) + [limit, offset]
                rows = db.execute(f"SELECT * FROM jobs{where_sql} {order_sql} LIMIT ? OFFSET ?", query_params).fetchall()
                items = [self.queue.record(r) for r in rows]

            return {
                'items': items,
                'total': total,
                'total_count': total,
                'is_truncated': False,
                'page': page,
                'limit': limit,
                'pages': (total + limit - 1) // limit if limit > 0 else 1,
                'worktrees': unique_worktrees,
            }
        else:
            if hasattr(self.queue, '_jobs'):
                all_jobs = list(self.queue._jobs.values())
            else:
                all_jobs = self.queue.list(owner=self.owner, limit=1000)

            unique_worktrees = sorted(list({j.get('worktree_id') for j in all_jobs if j.get('worktree_id')}))
            filtered = []
            for j in all_jobs:
                if status and status != 'all':
                    if status in ('history', 'terminal'):
                        if j.get('state') not in ('succeeded', 'failed', 'cancelled'):
                            continue
                    elif j.get('state') != status:
                        continue
                if profile and profile != 'all' and j.get('profile') != profile:
                    continue
                if worktree and worktree != 'all' and j.get('worktree_id') != worktree:
                    continue
                if search:
                    j_id = j.get('job_id', '').lower()
                    wt = j.get('worktree_id', '').lower()
                    sd = j.get('source_digest', '').lower()
                    if search not in j_id and search not in wt and search not in sd:
                        continue
                filtered.append(j)

            if sort == 'oldest':
                filtered.sort(key=lambda j: j.get('created_at', 0))
            elif sort == 'duration':
                filtered.sort(key=lambda j: (j.get('updated_at', 0) or 0) - (j.get('started_at', 0) or j.get('created_at', 0) or 0), reverse=True)
            else:
                filtered.sort(key=lambda j: j.get('created_at', 0), reverse=True)

            total = len(filtered)
            start = (page - 1) * limit
            items = filtered[start : start + limit]
            return {
                'items': items,
                'total': total,
                'total_count': total,
                'is_truncated': len(all_jobs) >= 1000,
                'page': page,
                'limit': limit,
                'pages': (total + limit - 1) // limit if limit > 0 else 1,
                'worktrees': unique_worktrees,
            }

    def job_detail(self, job_id):
        job = self.get(job_id)
        stages = build_job_timeline(job, self.storage)
        wt = job.get('worktree_id', '')
        receipt = None
        started_at = job.get('started_at')
        finished_at = job.get('finished_at')

        for r_path in (
            self.storage / 'runs' / wt / job_id / 'artifacts' / 'build-receipt.json',
            self.storage / 'runs' / wt / job_id / 'receipt.json',
            self.storage / 'runs' / wt / job_id / 'artifacts' / 'receipt.json',
        ):
            if r_path.is_file():
                try:
                    receipt = json.loads(r_path.read_text(encoding='utf-8'))
                    if not started_at and receipt.get('started_at'):
                        started_at = receipt.get('started_at')
                    if not finished_at and receipt.get('finished_at'):
                        finished_at = receipt.get('finished_at')
                    break
                except Exception:
                    pass

        if not started_at or not finished_at:
            coord_path = self.storage / 'runs' / wt / job_id / 'coordinator.json'
            if coord_path.is_file():
                try:
                    journal = json.loads(coord_path.read_text(encoding='utf-8'))
                    if not started_at and journal.get('started_at'):
                        started_at = journal.get('started_at')
                    if not finished_at and journal.get('finished_at'):
                        finished_at = journal.get('finished_at')
                except Exception:
                    pass

        pinned_map = self.hub.get_pinned()
        exec_res_id = f"exec-{wt}-{job_id}"
        is_pinned = (exec_res_id in pinned_map) or (job_id in pinned_map)
        pin_info = pinned_map.get(exec_res_id) or pinned_map.get(job_id) or {}
        return {
            **job,
            'started_at': started_at,
            'finished_at': finished_at,
            'stages': stages,
            'receipt': receipt,
            'is_pinned': is_pinned,
            'pin_reason': pin_info.get('reason', ''),
            'pinned_at': pin_info.get('pinned_at', ''),
        }

    def job_events(self, job_id):
        job = self.get(job_id)
        events = self.hub.get_events(limit=100, job_id=job_id)

        wt = job.get('worktree_id', '')
        journal = {}
        journal_path = self.storage / 'runs' / wt / job_id / 'coordinator.json'
        if journal_path.is_file():
            try:
                journal = json.loads(journal_path.read_text(encoding='utf-8'))
            except Exception:
                pass

        receipt = None
        for r_path in (
            self.storage / 'runs' / wt / job_id / 'artifacts' / 'build-receipt.json',
            self.storage / 'runs' / wt / job_id / 'receipt.json',
        ):
            if r_path.is_file():
                try:
                    receipt = json.loads(r_path.read_text(encoding='utf-8'))
                    break
                except Exception:
                    pass

        has_queued = any(e.get('event') == 'job_queued' for e in events)
        created_at = job.get('created_at')
        if not has_queued and created_at:
            events.append({
                'id': f"ev-q-{job_id[:8]}",
                'timestamp': datetime.fromtimestamp(created_at, tz=timezone.utc).isoformat() if isinstance(created_at, (int, float)) else str(created_at),
                'level': 'INFO',
                'event': 'job_queued',
                'message': f"Zadanie {job_id} dodane do kolejki (profil: {job.get('profile')})",
                'job_id': job_id,
                'profile': job.get('profile'),
                'stage': None,
                'duration_seconds': None,
            })

        started_at = journal.get('started_at') or job.get('started_at')
        has_claimed = any(e.get('event') in ('job_claimed', 'job_started') for e in events)
        if not has_claimed and started_at:
            events.append({
                'id': f"ev-c-{job_id[:8]}",
                'timestamp': datetime.fromtimestamp(started_at, tz=timezone.utc).isoformat() if isinstance(started_at, (int, float)) else str(started_at),
                'level': 'INFO',
                'event': 'job_claimed',
                'message': f"Rozpoczęto kompilację zadania {job_id} (kontener worker)",
                'job_id': job_id,
                'profile': job.get('profile'),
                'stage': None,
                'duration_seconds': None,
            })

        # Enrich with stage terminal events from build-receipt if present
        if receipt and isinstance(receipt.get('stages'), list):
            has_stage_events = {e.get('stage') for e in events if e.get('stage')}
            for st in receipt['stages']:
                st_name = st.get('name')
                if st_name and st_name not in has_stage_events:
                    st_code = st.get('exit_code')
                    st_time = st.get('finished_at') or st.get('started_at') or _utc_now_iso()
                    events.append({
                        'id': f"ev-st-{job_id[:8]}-{st_name}",
                        'timestamp': st_time,
                        'level': 'INFO' if st_code == 0 else 'ERROR',
                        'event': 'stage_terminal',
                        'message': f"Etap {st_name} zakończony (exit={st_code})",
                        'job_id': job_id,
                        'profile': job.get('profile'),
                        'stage': st_name,
                        'duration_seconds': round(st.get('duration_ms', 0) / 1000.0, 2) if st.get('duration_ms') is not None else None,
                    })

        finished_at = journal.get('finished_at') or job.get('finished_at')
        has_terminal = any(e.get('event') in ('job_terminal', 'job_finished', 'job_failed', 'job_cancelled') for e in events)
        if not has_terminal and finished_at:
            st = journal.get('state') or job.get('state', 'unknown')
            lvl = 'INFO' if st == 'succeeded' else ('WARN' if st == 'cancelled' else 'ERROR')
            dur = None
            if started_at and isinstance(started_at, (int, float)) and isinstance(finished_at, (int, float)):
                dur = round(finished_at - started_at, 2)
            events.append({
                'id': f"ev-t-{job_id[:8]}",
                'timestamp': datetime.fromtimestamp(finished_at, tz=timezone.utc).isoformat() if isinstance(finished_at, (int, float)) else str(finished_at),
                'level': lvl,
                'event': 'job_terminal',
                'message': f"Zadanie {job_id} zakończone ze statusem: {st}",
                'job_id': job_id,
                'profile': job.get('profile'),
                'stage': 'Zakończono',
                'duration_seconds': dur,
            })

        events.sort(key=lambda e: str(e.get('timestamp') or ''))
        return events

    def job_metrics(self, job_id):
        self.get(job_id)
        if not hasattr(self, '_worker_samples_by_job'):
            self._worker_samples_by_job = {}
        active = self.queue.active()
        current_job = active[0] if active else None
        if current_job and current_job.get('job_id') == job_id:
            wm = self._inspect_worker_metrics(current_job)
            if (wm.get('memory_mb') is not None or wm.get('cpu_percent') is not None
                    or wm.get('io_mb_s') is not None):
                samples = self._worker_samples_by_job.setdefault(job_id, [])
                now_iso = datetime.now(timezone.utc).isoformat()
                if (not samples
                        or samples[-1].get('ram_mb') != wm.get('memory_mb')
                        or samples[-1].get('cpu_percent') != wm.get('cpu_percent')
                        or samples[-1].get('io_mb_s') != wm.get('io_mb_s')):
                    samples.append({
                        'timestamp': now_iso,
                        'scope': 'worker',
                        'job_id': job_id,
                        'ram_mb': wm.get('memory_mb'),
                        'ram_limit_mb': wm.get('limit_mb'),
                        'cpu_percent': wm.get('cpu_percent'),
                        'io_mb_s': wm.get('io_mb_s'),
                        'storage_growth_mb': None,
                    })
                    if len(samples) > 120:
                        self._worker_samples_by_job[job_id] = samples[-120:]
        return list(self._worker_samples_by_job.get(job_id, []))

    def job_resources(self, job_id):
        job = self.get(job_id)
        wt = job.get('worktree_id', '')
        run_dir = self.storage / 'runs' / wt / job_id
        items = []
        if run_dir.exists():
            for child in run_dir.iterdir():
                if child.is_dir():
                    size = _fast_dir_size(child)
                    items.append({
                        'name': child.name,
                        'path': str(child),
                        'size_bytes': size[0],
                        'file_count': size[1],
                    })
        return items

    def storage_volumes(self):
        return self.hub.get_storage_volumes()

    def storage_resources(self):
        return self.hub.get_storage_resources(queue=self.queue)

    def processes(self):
        import sys
        health = self.health()
        active = self.queue.active()
        current_job = active[0] if active else None

        coord_rss = get_process_rss_bytes()
        coord_ram_str = f"{coord_rss / (1024 * 1024):.1f} MiB" if coord_rss is not None else "niedostępne"
        coord_limit = get_process_memory_limit_bytes()
        coord_limit_str = f"{coord_limit / (1024 * 1024 * 1024):.1f} GiB" if coord_limit is not None else "Bez limitu"
        coord_cpu, coord_io = self.hub._tracker.measure()
        coord_cpu_str = f"{coord_cpu:.1f}%" if coord_cpu is not None else "niedostępne"
        coord_io_str = f"{coord_io:.2f} MB/s" if coord_io is not None else "niedostępne"
        coord_pid = os.getpid()

        rows = [
            {
                'id': f'coord-pid-{coord_pid}',
                'role': 'Koordynator (API & Queue)',
                'type': 'host/container',
                'job_id': '—',
                'started_at': health.get('coordinator', {}).get('started_at'),
                'cpu': coord_cpu_str,
                'ram': coord_ram_str,
                'limit': coord_limit_str,
                'io': coord_io_str,
                'paths': str(self.storage / 'index' / 'runner-jobs.sqlite'),
                'cmd': ' '.join(sys.argv) if getattr(sys, 'argv', None) else 'python -m local_runner.container_main',
                'status': 'running',
            },
        ]

        if current_job:
            wm = self._inspect_worker_metrics(current_job)
            cid = wm.get('container_id')
            worker_id = f"worker-{cid[:12]}" if cid else f"worker-{current_job['job_id'][:8]}"
            w_ram = f"{wm['memory_mb']:.1f} MiB" if wm.get('memory_mb') is not None else "niedostępne"
            w_limit = f"{wm['limit_mb']} MiB" if wm.get('limit_mb') is not None else "niedostępne"
            w_cpu = f"{wm['cpu_percent']:.1f}%" if wm.get('cpu_percent') is not None else "niedostępne"
            w_io = f"{wm['io_mb_s']:.2f} MB/s" if wm.get('io_mb_s') is not None else "niedostępne"
            if not wm.get('container_verified'):
                worker_status = 'unverified'
            elif not health.get('worker_alive'):
                worker_status = health.get('worker_state') or 'unavailable'
            else:
                worker_status = 'running'
            rows.append({
                'id': worker_id,
                'role': 'Kompilator (Build Worker)',
                'type': 'container (uid 65532)',
                'job_id': current_job['job_id'],
                'started_at': current_job.get('started_at', '—'),
                'cpu': w_cpu,
                'ram': w_ram,
                'limit': w_limit,
                'io': w_io,
                'paths': f"{self.storage}/runs/{current_job['worktree_id']}/{current_job['job_id']}/execution",
                'cmd': f"fullmag-build-worker --profile {current_job['profile']}",
                'status': worker_status,
            })
        else:
            rows.append({
                'id': 'worker-idle',
                'role': 'Kompilator (Build Worker)',
                'type': 'container (uid 65532)',
                'job_id': '—',
                'started_at': '—',
                'cpu': '—',
                'ram': '—',
                'limit': '—',
                'io': '—',
                'paths': '—',
                'cmd': 'brak aktywnego kontenera',
                'status': 'idle',
            })

        return rows

    def alerts(self):
        alerts = []
        health = self.health()
        volumes = self.hub.get_storage_volumes()
        vol = volumes[0] if volumes else {}
        free = vol.get('free_bytes')
        crit = vol.get('critical_threshold_bytes')
        warn = vol.get('warning_threshold_bytes')

        if free is not None and crit is not None and free <= crit:
            alerts.append({
                'key': 'storage_pressure_critical',
                'level': 'CRITICAL',
                'title': 'Krytyczny brak miejsca',
                'message': f"Wolne miejsce w storage spadło do {free // (1024*1024*1024)} GiB",
                'started_at': _timestamp(),
                'timestamp': _timestamp(),
                'resolution_criteria': 'Zwolnienie przestrzeni do poziomu powyżej progu krytycznego',
            })
        elif free is not None and warn is not None and free <= warn:
            alerts.append({
                'key': 'storage_pressure_warning',
                'level': 'WARN',
                'title': 'Ostrzeżenie o zapełnieniu dysku',
                'message': f"Wolne miejsce w storage wynosi {free // (1024*1024*1024)} GiB",
                'started_at': _timestamp(),
                'timestamp': _timestamp(),
                'resolution_criteria': 'Uruchomienie planu retencji i odzyskanie wolnego miejsca',
            })

        if health.get('worker_error'):
            alerts.append({
                'key': 'worker_error',
                'level': 'ERROR',
                'title': 'Błąd procesu wykonawczego',
                'message': str(health['worker_error']),
                'started_at': _timestamp(),
                'timestamp': _timestamp(),
                'resolution_criteria': 'Manualne wznowienie lub usunięcie przyczyny awarii',
            })

        if health.get('legacy_jobs'):
            alerts.append({
                'key': 'legacy_jobs_detected',
                'level': 'ERROR',
                'title': 'Wykryto zadania legacy',
                'message': 'Nieobsługiwane zadania starszego typu w kolejce',
                'started_at': _timestamp(),
                'timestamp': _timestamp(),
                'resolution_criteria': 'Ręczne usunięcie lub zatwierdzenie legacy rekordów',
            })

        return alerts

    def events(self, query=None):
        query = query or {}
        limit = int(query.get('limit', 100))
        level = query.get('level')
        job_id = query.get('job_id')
        return self.hub.get_events(limit=limit, level=level, job_id=job_id)

    def retention_plan_preview(self):
        return self.hub.generate_retention_plan(queue=self.queue)

    def retention_plan_apply(self, plan_id):
        return self.hub.apply_retention_plan(plan_id)

    def get_retention_policy(self):
        return self.hub.get_retention_policy()

    def put_retention_policy(self, policy):
        return self.hub.set_retention_policy(policy)

    def pin_resource(self, resource_id, payload):
        pinned = payload.get('pinned', True)
        reason = payload.get('reason', '')
        return self.hub.set_pinned(resource_id, pinned, reason)

    def _execute_next(self):
        queued = self.queue.next_queued(self.owner)
        if queued is not None and queued.get('operation') != 'build':
            raise APIUnavailable('Legacy queued job requires manual recovery')
        if queued is not None:
            self.hub.record_event(
                "INFO",
                "job_claimed",
                f"Rozpoczęto kompilację zadania {queued['job_id']} (profil: {queued.get('profile')})",
                job_id=queued["job_id"],
                profile=queued.get("profile"),
            )
        result = execute_build(self.layout, owner=self.owner, call=docker)
        if queued is not None and isinstance(result, dict):
            state = result.get('state')
            if state in ('succeeded', 'failed', 'cancelled', 'blocked'):
                level = "INFO" if state == 'succeeded' else ("WARN" if state == 'cancelled' else "ERROR")
                self.hub.record_event(
                    level,
                    "job_terminal",
                    f"Zadanie {queued['job_id']} zakończone ze statusem: {state}",
                    job_id=queued["job_id"],
                    profile=queued.get("profile"),
                )
        return result

    def _reconcile(self, jobs):
        try:
            self.hub.sample_metrics()
        except Exception:
            pass
        if jobs:
            if not hasattr(self, '_worker_samples_by_job'):
                self._worker_samples_by_job = {}
            current_job = jobs[0]
            jid = current_job.get('job_id')
            if jid and current_job.get('operation') == 'build':
                try:
                    wm = self._inspect_worker_metrics(current_job)
                    if (wm.get('memory_mb') is not None or wm.get('cpu_percent') is not None
                            or wm.get('io_mb_s') is not None):
                        samples = self._worker_samples_by_job.setdefault(jid, [])
                        now_iso = datetime.now(timezone.utc).isoformat()
                        if (not samples
                                or samples[-1].get('ram_mb') != wm.get('memory_mb')
                                or samples[-1].get('cpu_percent') != wm.get('cpu_percent')
                                or samples[-1].get('io_mb_s') != wm.get('io_mb_s')):
                            samples.append({
                                'timestamp': now_iso,
                                'scope': 'worker',
                                'job_id': jid,
                                'ram_mb': wm.get('memory_mb'),
                                'ram_limit_mb': wm.get('limit_mb'),
                                'cpu_percent': wm.get('cpu_percent'),
                                'io_mb_s': wm.get('io_mb_s'),
                                'storage_growth_mb': None,
                            })
                            if len(samples) > 120:
                                self._worker_samples_by_job[jid] = samples[-120:]
                except Exception:
                    pass
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
    from local_runner.container_api import DEFAULT_PORT, serve
    config = json.loads(Path('/control/config.json').read_text())
    app = Application(config)
    app.start_worker()
    callback_names = (
        'submit', 'list', 'get', 'logs', 'cancel', 'stop', 'health', 'resume', 'retention',
        'overview', 'paginated_jobs', 'job_detail', 'job_events', 'job_metrics', 'job_resources',
        'storage_volumes', 'storage_resources', 'processes', 'alerts', 'events',
        'retention_plan_preview', 'retention_plan_apply', 'get_retention_policy',
        'put_retention_policy', 'pin_resource',
    )
    callbacks = {name: getattr(app, name) for name in callback_names}
    port_env = os.environ.get("FULLMAG_RUNNER_PORT")
    if port_env is not None and str(port_env).strip():
        try:
            port = int(str(port_env).strip())
        except (ValueError, TypeError):
            port = int(config.get("port", DEFAULT_PORT))
    else:
        port = int(config.get("port", DEFAULT_PORT))
    serve(callbacks, config_path='/control/config.json', host='0.0.0.0', port=port)


if __name__ == '__main__':
    main()
