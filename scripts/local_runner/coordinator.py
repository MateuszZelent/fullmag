"""Host-owned diagnostic executor with retained Docker state and durable leases.

No network ingress is exposed. Only trusted local callers with storage access
may run this module; the queue's owner field is not an authentication protocol.
"""
from contextlib import contextmanager, ExitStack
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import time

from fullmag_storage import StorageError, atomic_json, build_lock, file_lock, initialize, resolve_layout, validate_path
from local_runner.queue import JobQueue, QueueError
from local_runner.worker import assert_container_identity, build_worker_command
from local_runner.worker_entrypoint import verify_source


class CoordinatorError(RuntimeError):
    pass


_LOG_STREAM_CHUNK_BYTES = 64 * 1024
_LOG_STREAM_TIMEOUT_SECONDS = 60
_LOG_STREAM_CLEANUP_JOIN_SECONDS = 5


class _DockerLogSpoolsPreservedError(CoordinatorError):
    def __init__(self, message, *, spool_directory):
        super().__init__(message)
        self.preserve_spools = True
        self.spool_directory = str(spool_directory)


def docker(arguments):
    if os.name != 'nt':
        raise CoordinatorError('This coordinator adapter supports Windows Docker Desktop only')
    requests_all_logs = (
        '--tail=all' in arguments
        or any(arguments[index:index + 2] == ['--tail', 'all']
               for index in range(len(arguments) - 1))
    )
    if arguments[:1] == ['logs'] and (len(arguments) == 2 or requests_all_logs):
        raise CoordinatorError('Complete Docker logs require stream_container_logs')
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
    return result.stdout + result.stderr if arguments[0] == 'logs' else result.stdout


def _stream_process_logs(
    command,
    emit,
    *,
    spool_directory,
    environment=None,
    timeout_seconds=_LOG_STREAM_TIMEOUT_SECONDS,
    popen_factory=None,
):
    """Drain both CLI pipes to private disk spools, then emit stdout and stderr."""
    if not callable(emit):
        raise TypeError('Docker log stream consumer must be callable')
    if (type(timeout_seconds) not in (int, float)
            or not math.isfinite(timeout_seconds) or timeout_seconds <= 0):
        raise ValueError('Docker log stream timeout must be positive')
    directory = Path(spool_directory)
    if not directory.is_dir():
        raise CoordinatorError('Docker log stream spool directory is unavailable')
    popen = subprocess.Popen if popen_factory is None else popen_factory
    spool_paths = {}
    spool_streams = {}
    process = None
    readers = []
    untracked_pipes = []
    failures = []
    failures_lock = threading.Lock()
    primary_error = None
    cleanup_errors = []
    preserve_spools = False
    result = None

    def record_failure(error):
        with failures_lock:
            if not failures:
                failures.append(error)
        if process is not None:
            try:
                process.terminate()
            except Exception:
                pass

    def drain_pipe(pipe, spool):
        try:
            while True:
                chunk = pipe.read(_LOG_STREAM_CHUNK_BYTES)
                if not chunk:
                    break
                written = spool.write(chunk)
                if written != len(chunk):
                    raise OSError('short write while spooling Docker logs')
            spool.flush()
            os.fsync(spool.fileno())
        except Exception as error:
            record_failure(error)
        finally:
            try:
                pipe.close()
            except Exception as error:
                record_failure(error)
            try:
                spool.close()
            except Exception as error:
                record_failure(error)

    def stop_process():
        if process is None:
            return
        try:
            if process.poll() is None:
                process.terminate()
        except Exception as error:
            cleanup_errors.append(('process terminate', error))
        try:
            if process.poll() is None:
                process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                process.kill()
            except Exception as error:
                cleanup_errors.append(('process kill', error))
            try:
                process.wait(timeout=5)
            except Exception as error:
                cleanup_errors.append(('process wait', error))
        except Exception as error:
            cleanup_errors.append(('process wait', error))

    def close_quietly(resource, label):
        if resource is None:
            return
        try:
            resource.close()
        except Exception as error:
            cleanup_errors.append((label, error))

    def thread_started(thread):
        try:
            return thread.ident is not None
        except Exception:
            return False

    try:
        for channel in ('stdout', 'stderr'):
            descriptor, spool_path = tempfile.mkstemp(
                prefix='.docker-log-' + channel + '-',
                suffix='.tmp',
                dir=str(directory),
            )
            spool_paths[channel] = Path(spool_path)
            try:
                spool_streams[channel] = os.fdopen(descriptor, 'wb')
            except BaseException:
                try:
                    os.close(descriptor)
                except OSError:
                    pass
                raise

        process = popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=False,
            bufsize=0,
            env=environment,
        )
        untracked_pipes = [
            pipe for pipe in (process.stdout, process.stderr) if pipe is not None
        ]
        if process.stdout is None or process.stderr is None:
            raise CoordinatorError('Docker logs process did not expose both output pipes')
        for channel, pipe in zip(('stdout', 'stderr'), (process.stdout, process.stderr)):
            thread = threading.Thread(
                target=drain_pipe,
                args=(pipe, spool_streams[channel]),
                name='docker-logs-' + channel,
                daemon=True,
            )
            reader = {
                'channel': channel,
                'pipe': pipe,
                'spool': spool_streams[channel],
                'thread': thread,
                'started': False,
            }
            readers.append(reader)
            try:
                thread.start()
            except BaseException:
                # A custom Thread implementation may fail after starting.
                # Record only threads with an actual ident so cleanup never
                # joins an unstarted Thread or loses a live reader.
                reader['started'] = thread_started(thread)
                raise
            reader['started'] = True

        try:
            process.wait(timeout=timeout_seconds)
        except subprocess.TimeoutExpired as error:
            stop_process()
            raise CoordinatorError('Docker logs stream timed out') from error

        for reader in readers:
            if reader['started']:
                reader['thread'].join(timeout=timeout_seconds)
        if any(reader['started'] and reader['thread'].is_alive() for reader in readers):
            raise CoordinatorError('Docker logs stream readers did not finish')
        if failures:
            raise CoordinatorError('Docker logs stream spool failed') from failures[0]
        if process.returncode != 0:
            stderr_path = spool_paths['stderr']
            with stderr_path.open('rb') as stream:
                stream.seek(max(0, stderr_path.stat().st_size - 1024))
                detail = stream.read(1024).decode('utf-8', errors='replace').strip()
            raise CoordinatorError(
                f'Docker logs failed with exit code {process.returncode}: {detail}'
            )

        for channel in ('stdout', 'stderr'):
            with spool_paths[channel].open('rb') as stream:
                while True:
                    chunk = stream.read(_LOG_STREAM_CHUNK_BYTES)
                    if not chunk:
                        break
                    emit(channel, chunk)
        result = 'stdout_then_stderr'
    except BaseException as error:
        primary_error = error

    # Process termination/reaping and each reader cleanup are independent.
    # Keep the original stream/start failure as the primary exception.
    stop_process()
    for reader in readers:
        if reader['started']:
            try:
                reader['thread'].join(timeout=_LOG_STREAM_CLEANUP_JOIN_SECONDS)
            except Exception as error:
                cleanup_errors.append(('thread join', error))

    live_readers = []
    for reader in readers:
        if reader['started']:
            try:
                if reader['thread'].is_alive():
                    live_readers.append(reader)
            except Exception as error:
                cleanup_errors.append(('thread state', error))
                live_readers.append(reader)

    if process is not None:
        try:
            if process.poll() is None:
                cleanup_errors.append(('process reap', CoordinatorError(
                    'Docker logs child process remains alive after cleanup',
                )))
        except Exception as error:
            cleanup_errors.append(('process state', error))

    # A live drainer owns its pipe and spool. Do not close or unlink either;
    # the caller preserves the whole private spool directory for recovery.
    live_resource_ids = {
        id(resource)
        for reader in live_readers
        for resource in (reader['pipe'], reader['spool'])
    }
    for reader in readers:
        if id(reader['pipe']) not in live_resource_ids:
            close_quietly(reader['pipe'], 'pipe close')
        if id(reader['spool']) not in live_resource_ids:
            close_quietly(reader['spool'], 'spool close')
    tracked_pipe_ids = {id(reader['pipe']) for reader in readers}
    for pipe in untracked_pipes:
        if id(pipe) not in tracked_pipe_ids:
            close_quietly(pipe, 'pipe close')
    for channel, stream in spool_streams.items():
        if id(stream) not in live_resource_ids:
            close_quietly(stream, 'spool close')

    if live_readers:
        preserve_spools = True
    elif process is not None:
        try:
            if process.poll() is None:
                preserve_spools = True
        except Exception:
            preserve_spools = True

    if not preserve_spools:
        for spool_path in spool_paths.values():
            try:
                spool_path.unlink()
            except FileNotFoundError:
                pass
            except Exception as error:
                cleanup_errors.append(('spool unlink', error))

    if preserve_spools:
        original = primary_error or (cleanup_errors[0][1] if cleanup_errors else None)
        message = 'Docker logs cleanup left a live process or reader; private spools were preserved'
        error = _DockerLogSpoolsPreservedError(message, spool_directory=directory)
        if original is not None:
            raise error from original
        raise error

    if primary_error is not None:
        if cleanup_errors:
            cleanup_summary = '; '.join(
                f'{label}: {type(error).__name__}: {error}'
                for label, error in cleanup_errors
            )
            wrapped = CoordinatorError(f'{primary_error}; cleanup also failed: {cleanup_summary}')
            raise wrapped from primary_error
        raise primary_error
    if cleanup_errors:
        label, error = cleanup_errors[0]
        raise CoordinatorError(f'Docker logs {label} failed: {error}') from error
    return result


def stream_container_logs(
    container_id,
    emit,
    *,
    spool_directory,
    timeout_seconds=_LOG_STREAM_TIMEOUT_SECONDS,
):
    """Stream complete Docker Desktop logs with bounded process-pipe reads."""
    if os.name != 'nt':
        raise CoordinatorError('This coordinator adapter supports Windows Docker Desktop only')
    if not isinstance(container_id, str) or re.fullmatch(r'[a-f0-9]{64}', container_id) is None:
        raise ValueError('Expected a full Docker container ID')
    executable = shutil.which('docker.exe')
    if executable is None:
        raise CoordinatorError('Native Docker CLI unavailable')
    environment = {
        key: value for key, value in os.environ.items()
        if key not in ('DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH')
    }
    context = subprocess.run(
        [executable, 'context', 'inspect', 'desktop-linux'],
        capture_output=True,
        text=True,
        timeout=30,
        env=environment,
    )
    try:
        endpoint = json.loads(context.stdout)[0]['Endpoints']['docker']['Host']
    except (ValueError, KeyError, IndexError, TypeError) as error:
        raise CoordinatorError('Cannot attest Docker Desktop context') from error
    if context.returncode or endpoint != 'npipe:////./pipe/dockerDesktopLinuxEngine':
        raise CoordinatorError('Refusing a nonlocal or non-Desktop Docker endpoint')
    command = [executable, '--context', 'desktop-linux', 'logs', '--tail', 'all', container_id]
    return _stream_process_logs(
        command,
        emit,
        spool_directory=spool_directory,
        environment=environment,
        timeout_seconds=timeout_seconds,
    )


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
        if job['operation'] == 'storage-probe' and terminal != 'cancelled':
            # Recover the resource without manufacturing a successful probe receipt.
            terminal = 'interrupted'
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
                 call=docker, sleep=time.sleep, timeout_seconds=300, expected_job_id=None):
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
        job = queue.claim('local-host', owner=owner, expected_job_id=expected_job_id)
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
