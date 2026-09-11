"""Host-owned diagnostic executor with retained Docker state and durable leases.

No network ingress is exposed. Only trusted local callers with storage access
may run this module; the queue's owner field is not an authentication protocol.
"""
from contextlib import contextmanager, ExitStack
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time

from fullmag_storage import StorageError, atomic_json, build_lock, file_lock, initialize, resolve_layout, validate_path
from local_runner.queue import JobQueue, QueueError
from local_runner.worker import assert_container_identity, build_worker_command
from local_runner.worker_entrypoint import verify_source


class CoordinatorError(RuntimeError):
    pass


def docker(arguments):
    if os.name != 'nt':
        raise CoordinatorError('This coordinator adapter supports Windows Docker Desktop only')
    executable = shutil.which('docker.exe')
    if executable is None:
        raise CoordinatorError('Native Docker CLI unavailable')
    environment = {key: value for key, value in os.environ.items()
                   if key not in ('DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH')}
    context = subprocess.run([executable, 'context', 'inspect', 'desktop-linux'],
                             capture_output=True, text=True, timeout=30, env=environment)
    try:
        endpoint = json.loads(context.stdout)[0]['Endpoints']['docker']['Host']
    except (ValueError, KeyError, IndexError, TypeError) as error:
        raise CoordinatorError('Cannot attest Docker Desktop context') from error
    if context.returncode or endpoint != 'npipe:////./pipe/dockerDesktopLinuxEngine':
        raise CoordinatorError('Refusing a nonlocal or non-Desktop Docker endpoint')
    result = subprocess.run([executable, '--context', 'desktop-linux', *arguments],
                            capture_output=True, text=True, timeout=60, env=environment)
    if result.returncode:
        raise CoordinatorError(f'Docker {arguments[0]} failed: {result.stderr.strip()}')
    return result.stdout


def inspect_owned(call, container_id, job_id):
    payload = json.loads(call(['inspect', container_id]))
    assert_container_identity(payload, job_id, container_id)
    return payload[0] if isinstance(payload, list) else payload


def configure_image(layout, image_digest, *, owner, call=docker):
    """Explicit operator enrollment, never accepted as part of a job payload."""
    if not isinstance(image_digest, str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', image_digest):
        raise CoordinatorError('Configure an immutable worker image ID')
    image = json.loads(call(['image', 'inspect', image_digest]))
    if not isinstance(image, list) or len(image) != 1 or image[0].get('Id') != image_digest:
        raise CoordinatorError('Worker image identity mismatch')
    config = image[0].get('Config', {})
    if (config.get('Entrypoint') != ['/opt/fullmag-runner/worker_entrypoint.py']
            or config.get('User') != '65532:65532' or config.get('Volumes')):
        raise CoordinatorError('Image does not match diagnostic worker contract')
    initialize(layout)
    storage = Path(layout['storage_root'])
    path = validate_path(storage / 'index' / 'local-runner-config.json', storage)
    lock = validate_path(storage / 'locks' / 'local-runner-coordinator.lock', storage)
    with file_lock(lock, 'local runner coordinator'):
        record = {'schema': 'fullmag.local-runner.config.v1', 'operator': owner,
                  'image_digest': image_digest, 'context': 'desktop-linux',
                  'operation': 'verify-source', 'qualification': 'not_assessed'}
        atomic_json(path, record)
    return record


def configured_image(layout, owner):
    storage = Path(layout['storage_root'])
    path = validate_path(storage / 'index' / 'local-runner-config.json', storage)
    config = json.loads(path.read_text(encoding='utf-8'))
    if (not isinstance(config, dict) or config.get('schema') != 'fullmag.local-runner.config.v1'
            or config.get('operator') != owner or config.get('context') != 'desktop-linux'
            or config.get('operation') != 'verify-source'):
        raise CoordinatorError('Local operator configuration mismatch')
    return config['image_digest']


def acknowledge_uncreated(layout, job_id, *, owner, reason, call=docker):
    """Explicit operator recovery, never automatic age-based reclamation.

    Caller must have confirmed create was never issued or was rejected before
    reaching the daemon, and its submitting process is finished. An empty Docker lookup
    alone is insufficient; the reason is retained as the operator attestation.
    """
    if not isinstance(reason, str) or not 20 <= len(reason.strip()) <= 1000:
        raise CoordinatorError('Provide the evidence for a rejected, no-longer-in-flight create')
    storage = Path(layout['storage_root'])
    queue = JobQueue(validate_path(storage / 'index' / 'runner-jobs.sqlite', storage))
    lock = validate_path(storage / 'locks' / 'local-runner-coordinator.lock', storage)
    with file_lock(lock, 'local runner coordinator'):
        job = queue.recovery_lease(job_id, owner)
        journal_path = validate_path(storage / 'runs' / job['worktree_id'] / job_id / 'coordinator.json', storage)
        journal = json.loads(journal_path.read_text(encoding='utf-8')) if journal_path.exists() else {
            'schema': 'fullmag.local-runner.coordinator.v1', 'job_id': job_id,
            'owner': owner, 'source_digest': job['source_digest'],
            'lease_token': job['lease_token'], 'phase': 'prepared', 'container_id': None}
        if (journal.get('job_id') != job_id or journal.get('owner') != owner
                or journal.get('phase') not in ('prepared', 'create-requested', 'operator-confirmed-uncreated')
                or journal.get('container_id') is not None
                or journal.get('lease_token') != job['lease_token']):
            raise CoordinatorError('Recovery is restricted to an unacknowledged create')
        if call(['ps', '-a', '-q', '--filter', f'name=^/fullmag-worker-{job_id}$']).strip():
            raise CoordinatorError('A matching container exists; do not release its lease')
        # Retain the attestation before releasing the lease, in a retryable phase.
        journal['recovery_reason'] = reason
        journal_path.parent.mkdir(parents=True, exist_ok=True)
        atomic_json(journal_path, journal)
        queue.finish(job_id, journal['lease_token'], 'blocked', None)
        journal.update(phase='operator-confirmed-uncreated', state='blocked')
        atomic_json(journal_path, journal)
        return queue.get(job_id)


def validate_terminal_receipt(artifacts, job):
    path = artifacts / 'source-verification.json'
    if path.is_symlink() or path.stat().st_size > 65536:
        raise CoordinatorError('Invalid worker receipt file')
    receipt = json.loads(path.read_text(encoding='utf-8'))
    expected = {'schema': 'fullmag.local-runner.source-check.v1', 'job_id': job['job_id'],
                'source_digest': job['source_digest'], 'operation': 'verify-source',
                'state': 'succeeded', 'qualification': 'not_assessed'}
    if not isinstance(receipt, dict) or any(receipt.get(key) != value for key, value in expected.items()):
        raise CoordinatorError('Worker receipt does not match the submitted job')
    return receipt


@contextmanager
def launch_lock(origin, queue, job, journal, journal_path):
    with ExitStack() as stack:
        try:
            stack.enter_context(build_lock(origin))
            journal['phase'] = 'create-requested'
            atomic_json(journal_path, journal)
        except (OSError, StorageError, ValueError) as error:
            queue.finish(job['job_id'], job['lease_token'], 'blocked', None)
            raise CoordinatorError(str(error)) from error
        # Exceptions from the Docker mutation below must retain the lease.
        yield


def reconcile(layout, job_id, *, owner, call=docker):
    """Release an interrupted observation only after exact terminal evidence.

    A missing persisted ID is deliberately a manual-recovery condition. A
    container name or elapsed lease age cannot prove an ambiguous create safe.
    This command never starts, removes, or restarts a container. An already
    recorded owner cancellation may stop the exact persisted container.
    """
    storage = Path(layout['storage_root'])
    queue = JobQueue(validate_path(storage / 'index' / 'runner-jobs.sqlite', storage))
    lock = validate_path(storage / 'locks' / 'local-runner-coordinator.lock', storage)
    with file_lock(lock, 'local runner coordinator'):
        job = queue.get(job_id)
        if job['owner'] != owner:
            raise CoordinatorError('Job owner mismatch')
        active = job['state'] in ('running', 'cancel_requested')
        run_root = validate_path(storage / 'runs' / job['worktree_id'] / job_id, storage)
        journal_path = validate_path(run_root / 'coordinator.json', storage)
        if not active and not journal_path.exists():
            return job
        journal = json.loads(journal_path.read_text(encoding='utf-8'))
        if (journal.get('schema') != 'fullmag.local-runner.coordinator.v1'
                or journal.get('job_id') != job_id or journal.get('owner') != owner
                or journal.get('source_digest') != job['source_digest']):
            raise CoordinatorError('Coordinator journal identity mismatch')
        container_id = journal.get('container_id')
        if not active and container_id is None:
            return job
        if not isinstance(container_id, str) or not re.fullmatch('[a-f0-9]{64}', container_id):
            raise CoordinatorError('No persisted full container ID; manual reconciliation required')
        inspected = inspect_owned(call, container_id, job_id)
        if inspected.get('Image') != journal.get('image_digest'):
            raise CoordinatorError('Container image identity mismatch')
        state = inspected.get('State', {})
        if job['state'] == 'cancel_requested' and state.get('Running') is True:
            call(['stop', '--time', '10', container_id])
            inspected = inspect_owned(call, container_id, job_id)
            state = inspected.get('State', {})
        if state.get('Status') != 'exited' or state.get('Running') is not False:
            raise CoordinatorError('Container is not confirmed exited; lease retained')
        code = state.get('ExitCode')
        if not isinstance(code, int) or isinstance(code, bool):
            raise CoordinatorError('Missing terminal exit code; lease retained')
        logs_path = validate_path(run_root / 'worker.log', storage)
        if not active:
            # Queue completion is authoritative; retry only exact-container logs.
            logs_path.write_text(call(['logs', '--tail', '1000', container_id]), encoding='utf-8')
            return job
        terminal = 'cancelled' if job['state'] == 'cancel_requested' else ('succeeded' if code == 0 else 'failed')
        artifacts = validate_path(run_root / 'artifacts', storage)
        if terminal == 'succeeded':
            try:
                validate_terminal_receipt(artifacts, job)
                verify_source(validate_path(storage / job['payload']['capsule_relative'], storage), job['source_digest'])
            except (OSError, ValueError, KeyError, CoordinatorError):
                terminal = 'failed'
        queue.finish(job_id, journal['lease_token'], terminal, code)
        journal.update(phase='terminal', state=terminal, exit_code=code)
        atomic_json(journal_path, journal)
        logs = call(['logs', '--tail', '1000', container_id])
        with logs_path.open('w', encoding='utf-8') as stream:
            stream.write(logs)
        return queue.get(job_id)


def execute_once(layout, *, owner, image_digest, cpus=2, memory_bytes=1024**3,
                 call=docker, sleep=time.sleep, timeout_seconds=300):
    """Execute at most one source-check; interrupted launches retain their lease.

    Stopped containers and logs are intentionally retained. Timeout is not
    permission to kill or reclaim a resource. An explicit owner cancellation
    is verified against the persisted full container ID before Docker stop.
    """
    initialize(layout)
    storage = Path(layout['storage_root'])
    queue = JobQueue(validate_path(storage / 'index' / 'runner-jobs.sqlite', storage))
    lock = validate_path(storage / 'locks' / 'local-runner-coordinator.lock', storage)
    with file_lock(lock, 'local runner coordinator'):
        active = queue.active()
        if active:
            raise CoordinatorError('An active lease needs reconciliation; it cannot expire by age')
        # Host config is validated before claiming a job. Do not let a request
        # pick an image, mount, command, or resource budget.
        if not re.fullmatch(r'sha256:[0-9a-f]{64}', image_digest):
            raise CoordinatorError('Configure an immutable worker image ID')
        image = json.loads(call(['image', 'inspect', image_digest]))
        if not image or image[0].get('Id') != image_digest:
            raise CoordinatorError('Worker image identity mismatch')
        job = queue.claim('local-host', owner=owner)
        if job is None:
            return None
        if job['owner'] != owner:
            queue.finish(job['job_id'], job['lease_token'], 'blocked', None)
            raise CoordinatorError('Current local executor cannot run another owner job')
        # Any failure before create is known not to have launched a container.
        try:
            run_root = validate_path(storage / 'runs' / job['worktree_id'] / job['job_id'], storage)
            journal_path = run_root / 'coordinator.json'
            if job['operation'] != 'verify-source' or job['profile'] != 'source-verification-v1':
                raise CoordinatorError('Operation has no qualified executor')
            origin = resolve_layout(job['payload']['origin_repo'], 'windows-native')
            if origin['worktree_id'] != job['worktree_id'] or Path(origin['storage_root']) != storage:
                raise CoordinatorError('Source worktree/storage identity mismatch')
            capture_id = job['payload'].get('capture_id')
            if not isinstance(capture_id, str) or not re.fullmatch('[a-f0-9]{32}', capture_id):
                raise CoordinatorError('Invalid source capture identity')
            relative = f"runs/{job['worktree_id']}/{capture_id}/source"
            if job['payload']['capsule_relative'] != relative:
                raise CoordinatorError('Noncanonical capsule location')
            capsule = validate_path(storage / relative, storage)
            manifest = verify_source(capsule, job['source_digest'])
            if Path(manifest['repo_root']) != Path(origin['repo_root']):
                raise CoordinatorError('Capsule belongs to another worktree')
            run_root.mkdir(parents=True, exist_ok=False)
            artifacts = run_root / 'artifacts'
            artifacts.mkdir()
            build = validate_path(storage / 'builds' / job['worktree_id'] / 'source-verification-v1', storage)
            build.mkdir(parents=True, exist_ok=True)
            command = build_worker_command(job['job_id'], image_digest, capsule, build, artifacts,
                storage_root=storage, source_digest=job['source_digest'], cpus=cpus, memory_bytes=memory_bytes, operation='verify-source')
            # Retain the container. Persist create intent before issuing any
            # Docker mutation, so an ambiguous reply never frees the queue.
            command[1] = 'create'
            command = [part for part in command if part != '--rm']
            journal = {'schema': 'fullmag.local-runner.coordinator.v1', 'job_id': job['job_id'],
                'owner': owner, 'image_digest': image_digest, 'source_digest': job['source_digest'],
                'lease_token': job['lease_token'], 'phase': 'prepared', 'container_id': None,
                'artifact_relative': artifacts.relative_to(storage).as_posix(),
                'qualification': 'not_assessed'}
            atomic_json(journal_path, journal)
        except (OSError, StorageError, ValueError, TypeError, KeyError, CoordinatorError) as error:
            queue.finish(job['job_id'], job['lease_token'], 'blocked', None)
            raise CoordinatorError(str(error)) from error
        with launch_lock(origin, queue, job, journal, journal_path):
            # Exceptions below deliberately preserve running/cancel_requested.
            # A daemon timeout can have created or started a real container.
            container_id = call(command[1:]).strip()
            if not re.fullmatch('[a-f0-9]{64}', container_id):
                raise CoordinatorError('Docker did not return a full container ID; lease retained')
            journal.update(container_id=container_id, phase='created')
            atomic_json(journal_path, journal)
            inspected = inspect_owned(call, container_id, job['job_id'])
            if inspected.get('Image') != image_digest:
                raise CoordinatorError('Container image differs from operator configuration')
            journal['phase'] = 'start-requested'
            atomic_json(journal_path, journal)
            call(['start', container_id])
            deadline = time.monotonic() + timeout_seconds
            while True:
                inspected = inspect_owned(call, container_id, job['job_id'])
                state = inspected.get('State', {})
                if state.get('Status') == 'exited' and state.get('Running') is False:
                    code = state.get('ExitCode')
                    if not isinstance(code, int) or isinstance(code, bool):
                        raise CoordinatorError('Missing terminal exit code; lease retained')
                    terminal = 'cancelled' if queue.get(job['job_id'])['state'] == 'cancel_requested' else ('succeeded' if code == 0 else 'failed')
                    if terminal == 'succeeded':
                        try:
                            validate_terminal_receipt(artifacts, job)
                            verify_source(capsule, job['source_digest'])
                        except (OSError, ValueError, KeyError, CoordinatorError):
                            terminal = 'failed'
                    queue.finish(job['job_id'], job['lease_token'], terminal, code)
                    journal.update(phase='terminal', state=terminal, exit_code=code)
                    atomic_json(journal_path, journal)
                    logs = call(['logs', '--tail', '1000', container_id])
                    with (run_root / 'worker.log').open('x', encoding='utf-8') as stream:
                        stream.write(logs)
                    return queue.get(job['job_id'])
                if queue.get(job['job_id'])['state'] == 'cancel_requested':
                    # inspect_owned above checks both labels and exact ID.
                    call(['stop', '--time', '10', container_id])
                if time.monotonic() >= deadline:
                    raise CoordinatorError('Observation timed out; container and queue lease retained')
                sleep(1)
