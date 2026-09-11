"""Host-owned catalogue and execution of snapshot builds on Docker Desktop.

Only trusted local code may submit builds. Container isolation is not a trust
boundary for arbitrary public PRs. No job can supply commands or mount paths.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import time

from fullmag_storage import atomic_json, build_lock, file_lock, initialize, resolve_layout, validate_path
from local_runner.coordinator import CoordinatorError, docker, inspect_owned
from local_runner.queue import JobQueue
from local_runner.worker import _resolve_storage_dir, _format_cpus, _format_memory
from local_runner.worker_entrypoint import verify_source


PROFILES = {'fem-cpu-release': ('fem', 'cpu'), 'fem-gpu-release': ('fem', 'gpu'),
            'fdm-cpu-release': ('fdm', 'cpu')}
TARGETS = {'source': '/source', 'workspace': '/workspace',
           'build': '/workspace/.fullmag-build', 'artifacts': '/artifacts',
           'trusted': '/runner', 'cargo': '/workspace/.fullmag-cargo',
           'rustup': '/workspace/.fullmag-rustup', 'pnpm': '/pnpm/store'}


def profile_lane(profile):
    if profile not in PROFILES:
        raise ValueError('Unknown build profile')
    return PROFILES[profile]


def configure_build(layout, profile, image_digest, *, owner, cpus=2, memory_bytes=8 * 1024**3, call=docker):
    profile_lane(profile)
    if not re.fullmatch('sha256:[a-f0-9]{64}', image_digest):
        raise ValueError('An immutable local image ID is required')
    _format_cpus(cpus)
    _format_memory(memory_bytes)
    inspected = json.loads(call(['image', 'inspect', image_digest]))
    if len(inspected) != 1 or inspected[0].get('Id') != image_digest or inspected[0].get('Config', {}).get('Volumes'):
        raise ValueError('Image identity/anonymous volume contract mismatch')
    initialize(layout)
    storage = Path(layout['storage_root'])
    path = validate_path(storage / 'index' / 'local-runner-build-config.json', storage)
    with file_lock(storage / 'locks' / 'local-runner-coordinator.lock', 'build configuration'):
        config = json.loads(path.read_text()) if path.exists() else {'schema': 'fullmag.runner-build-config.v1', 'operator': owner, 'profiles': {}}
        if config.get('schema') != 'fullmag.runner-build-config.v1' or config.get('operator') != owner:
            raise ValueError('Build configuration owner/schema mismatch')
        config['profiles'][profile] = {'image_digest': image_digest, 'cpus': cpus, 'memory_bytes': memory_bytes}
        atomic_json(path, config)
    return config


def configured_build(layout, owner, profile):
    profile_lane(profile)
    storage = Path(layout['storage_root'])
    path = validate_path(storage / 'index' / 'local-runner-build-config.json', storage)
    config = json.loads(path.read_text())
    if config.get('schema') != 'fullmag.runner-build-config.v1' or config.get('operator') != owner:
        raise ValueError('Build configuration owner/schema mismatch')
    return config['profiles'][profile]


def mount_identity(mounts):
    return sorted((m.get('Type'), os.path.normcase(os.path.abspath(m.get('Source', ''))),
                   m.get('Destination'), m.get('RW')) for m in mounts)


def capsule_path(storage, job):
    capture = job['payload']['capture_id']
    if not re.fullmatch('[a-f0-9]{32}', capture) or not re.fullmatch('[A-Za-z0-9_.-]+', job['worktree_id']):
        raise ValueError('Invalid capsule owner/capture')
    expected = f"runs/{job['worktree_id']}/{capture}/source"
    if job['payload']['capsule_relative'] != expected:
        raise ValueError('Noncanonical capsule path')
    return validate_path(Path(storage) / expected, storage)


def trusted_identity(run_root, journal, storage):
    for name, expected in journal['trusted_hashes'].items():
        if name not in ('build_entrypoint.py', 'worker_entrypoint.py', 'context.json'):
            raise ValueError('Unknown trusted input')
        path = validate_path(run_root / 'trusted' / name, storage)
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError('Trusted execution input changed')


def daemon_path(path, storage, daemon_root):
    relative = Path(path).relative_to(storage).as_posix()
    return daemon_root.rstrip('/') + '/' + relative


def build_command(job_id, source_digest, profile, config, paths, storage):
    backend, device = profile_lane(profile)
    if not re.fullmatch('[a-f0-9]{32}', job_id) or not re.fullmatch('[a-f0-9]{64}', source_digest):
        raise ValueError('Invalid job/source identity')
    image = config['image_digest']
    if not re.fullmatch('sha256:[a-f0-9]{64}', image):
        raise ValueError('Invalid immutable image')
    resolved = {key: _resolve_storage_dir(paths[key], key, Path(storage).resolve()) for key in TARGETS}
    values = list(resolved.values())
    if any(a == b or a in b.parents or b in a.parents for n, a in enumerate(values) for b in values[n + 1:]):
        raise ValueError('Host mount roots must not overlap')
    argv = ['create', '--init', '--name', 'fullmag-worker-' + job_id,
            '--label', 'owner=fullmag-local-runner', '--label', 'job=' + job_id,
            '--read-only', '--user', '65532:65532', '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges:true', '--pids-limit', '512',
            '--cpus', _format_cpus(config['cpus']), '--memory', _format_memory(config['memory_bytes']),
            '--memory-swap', _format_memory(config['memory_bytes']),
            '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m', '--network', 'bridge',
            '--env', 'PYTHONDONTWRITEBYTECODE=1', '--env', 'CARGO_HOME=/workspace/.fullmag-cargo',
            '--env', 'RUSTUP_HOME=/workspace/.fullmag-rustup', '--env', 'HOME=/workspace/.fullmag-build/home',
            '--env', 'COREPACK_HOME=/workspace/.fullmag-build/corepack',
            '--env', 'PNPM_HOME=/workspace/.fullmag-build/pnpm',
            '--env', 'TMPDIR=/workspace/.fullmag-build/tmp']
    for key, target in TARGETS.items():
        argv += ['--mount', f'type=bind,source={resolved[key]},target={target}' + (',readonly' if key in ('source', 'trusted') else '')]
    if device == 'gpu':
        argv += ['--gpus', 'all']
    argv += ['--workdir', '/workspace', '--entrypoint', 'python3', image,
             '/runner/build_entrypoint.py', '--job-id', job_id, '--source-digest', source_digest,
             '--profile', profile, '--source', '/source', '--workspace', '/workspace',
             '--build', '/workspace/.fullmag-build', '--artifacts', '/artifacts',
             '--context', '/runner/context.json', '--jobs', str(max(1, int(config['cpus'])))]
    return argv


def validate_build_receipt(artifacts, job, journal):
    path = artifacts / 'build-receipt.json'
    validate_path(path, artifacts, 'build receipt')
    if path.stat().st_size > 4 * 1024**2:
        raise ValueError('Oversized build receipt')
    receipt = json.loads(path.read_text())
    native = job.get('payload', {}).get('native_source_identity')
    if receipt.get('image_digest') != journal.get('image_digest') or receipt.get('native_source_identity') != native:
        raise ValueError('Build receipt native/image provenance mismatch')
    from local_runner.worker_entrypoint import canonical
    if native is None or receipt.get('native_source_identity_sha256') != hashlib.sha256(canonical(native)).hexdigest():
        raise ValueError('Build receipt native identity hash mismatch')
    for key, expected in {'job_id': job['job_id'], 'source_digest': job['source_digest'],
                          'profile': job['profile'], 'state': 'succeeded', 'qualification': 'NOT VERIFIED'}.items():
        if receipt.get(key) != expected:
            raise ValueError('Build receipt identity mismatch: ' + key)
    entries = receipt.get('artifacts')
    if not isinstance(entries, list) or not entries:
        raise ValueError('Build receipt has no artifacts')
    required = {'outputs/.fullmag/local/' + name for name in ('bin/fullmag-bin', 'bin/fullmag-api', '_fullmag_core.so', 'web/index.html', 'launcher-build-mode')}
    if not required.issubset({entry.get('path') for entry in entries}):
        raise ValueError('Required build outputs missing')
    stages = receipt.get('stages', [])
    if any(not any(stage.get('name') == name and stage.get('exit_code') == 0 for stage in stages)
           for name in ('native-build', 'frontend-dependencies', 'frontend-build')):
        raise ValueError('Required build stages did not pass')
    seen = set()
    for entry in entries:
        relative = entry['path']
        if relative in seen or Path(relative).is_absolute() or '..' in Path(relative).parts:
            raise ValueError('Invalid artifact member')
        seen.add(relative)
        artifact = validate_path(artifacts / relative, artifacts, 'build artifact')
        if not artifact.is_file() or artifact.stat().st_size != entry['size']:
            raise ValueError('Artifact size mismatch')
        with artifact.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        if digest != entry['sha256']:
            raise ValueError('Artifact hash mismatch')
    return receipt


def attest_build_container(inspected, journal):
    if inspected.get('Image') != journal['image_digest'] or mount_identity(inspected.get('Mounts', [])) != journal['mounts']:
        raise CoordinatorError('Build container image/mount identity mismatch')
    host = inspected.get('HostConfig', {})
    config = inspected.get('Config', {})
    if (host.get('Privileged') is not False or host.get('ReadonlyRootfs') is not True
            or config.get('User') != '65532:65532'
            or set(host.get('CapDrop') or []) != {'ALL'}
            or host.get('CapAdd')
            or 'no-new-privileges:true' not in (host.get('SecurityOpt') or [])
            or host.get('NetworkMode') != 'bridge'
            or host.get('PidMode') or host.get('IpcMode') == 'host'
            or any(m.get('Propagation') != 'rprivate' for m in inspected.get('Mounts', []))):
        raise CoordinatorError('Build container isolation policy mismatch')


def finish_build(layout, queue, job, journal, run_root, inspected, call):
    storage = Path(layout['storage_root'])
    run_root = validate_path(run_root, storage)
    trusted_identity(run_root, journal, storage)
    attest_build_container(inspected, journal)
    state = inspected.get('State', {})
    code = state.get('ExitCode')
    if state.get('Status') != 'exited' or state.get('Running') is not False or type(code) is not int:
        raise CoordinatorError('Build is not confirmed terminal; lease retained')
    terminal = 'cancelled' if queue.get(job['job_id'])['state'] == 'cancel_requested' else ('succeeded' if code == 0 else 'failed')
    if terminal == 'succeeded':
        try:
            validate_build_receipt(validate_path(run_root / 'artifacts', storage), job, journal)
            verify_source(capsule_path(storage, job), job['source_digest'])
        except (ValueError, KeyError, OSError) as error:
            terminal = 'failed'
            journal['validation_error'] = str(error)
    # Preserve log/receipt before releasing the global lease.
    validate_path(run_root / 'worker.log', storage).write_text(call(['logs', '--tail', '3000', journal['container_id']]), encoding='utf-8')
    journal.update(phase='terminal', state=terminal, exit_code=code, finished_at=time.time())
    atomic_json(run_root / 'coordinator.json', journal)
    atomic_json(run_root / 'receipt.json', {key: value for key, value in journal.items() if key != 'lease_token'})
    queue.finish(job['job_id'], journal['lease_token'], terminal, code)
    return queue.get(job['job_id'])


def execute_build(layout, *, owner, call=docker, sleep=time.sleep, timeout_seconds=8 * 3600, expected_job_id=None):
    if not layout.get('container_coordinator'):
        initialize(layout)
    storage = Path(layout['storage_root'])
    queue = JobQueue(validate_path(storage / 'index' / 'runner-jobs.sqlite', storage))
    with file_lock(validate_path(storage / 'locks' / 'local-runner-coordinator.lock', storage), 'local coordinator'), \
         file_lock(validate_path(storage / 'locks' / 'fullmag-heavy.lock', storage), 'heavy build'):
        if queue.active():
            raise CoordinatorError('Active lease requires reconciliation')
        if queue.next_queued(owner) is None:
            return None
        if shutil.disk_usage(storage).free < 8 * 1024**3:
            return {'state': 'waiting_for_disk'}
        identifiers = call(['ps', '-q', '--no-trunc']).split()
        running = json.loads(call(['inspect', *identifiers])) if identifiers else []
        if any('fullmag' in item.get('Name', '').lower()
               and 'buildx_buildkit' not in item.get('Name', '')
               and item.get('Name') != '/Fullmag_build_runner' for item in running):
            return {'state': 'waiting_for_existing_fullmag_container'}
        job = queue.claim('local-host', owner=owner, expected_job_id=expected_job_id)
        if job is None:
            return None
        try:
            if job['operation'] != 'build':
                raise ValueError('Expected a build job')
            config = configured_build(layout, owner, job['profile'])
            if layout.get('container_coordinator'):
                record_path = validate_path(storage / 'index' / (job['worktree_id'] + '.json'), storage)
                record = json.loads(record_path.read_text())
                if record['repo_root'] != job['payload']['origin_repo'] or record['worktree_id'] != job['worktree_id']:
                    raise ValueError('Registered source worktree mismatch')
                origin = {**record, 'storage_root': str(storage)}
            else:
                origin = resolve_layout(job['payload']['origin_repo'], 'windows-native')
            if origin['worktree_id'] != job['worktree_id'] or Path(origin['storage_root']) != storage:
                raise ValueError('Origin identity mismatch')
            capture = job['payload']['capture_id']
            if not re.fullmatch('[a-f0-9]{32}', capture) or job['payload']['capsule_relative'] != f"runs/{job['worktree_id']}/{capture}/source":
                raise ValueError('Noncanonical source capsule')
            capsule = capsule_path(storage, job)
            manifest = verify_source(capsule, job['source_digest'])
            from local_runner.build_source import bind_identity
            bind_identity(job['payload']['native_source_identity'], manifest)
            if Path(manifest['repo_root']) != Path(origin['repo_root']):
                raise ValueError('Capsule origin mismatch')
            if shutil.disk_usage(storage).free < 8 * 1024**3:
                raise ValueError('Build needs at least 8 GiB free; no automatic cleanup')
            image = json.loads(call(['image', 'inspect', config['image_digest']]))
            if len(image) != 1 or image[0].get('Id') != config['image_digest'] or image[0].get('Config', {}).get('Volumes'):
                raise ValueError('Build image identity mismatch')
            # Do not contend with an existing unmanaged heavy Fullmag container.
            identifiers = call(['ps', '-q', '--no-trunc']).split()
            running = json.loads(call(['inspect', *identifiers])) if identifiers else []
            for container in running:
                if 'fullmag' in container.get('Name', '').lower() and 'buildx_buildkit' not in container.get('Name', '') and container.get('Name') != '/Fullmag_build_runner':
                    raise ValueError('Existing Fullmag container must finish before queued build')
            run_root = validate_path(storage / 'runs' / job['worktree_id'] / job['job_id'], storage)
            run_root.mkdir(exist_ok=False)
            profile_key = 'runner-' + job['profile'] + '-' + config['image_digest'][7:19]
            cache = storage / 'cache' / 'windows' / ('fem-gpu' if job['profile'] == 'fem-gpu-release' else 'fem-cpu')
            paths = {'source': capsule, 'workspace': run_root / 'execution', 'artifacts': run_root / 'artifacts',
                     'trusted': run_root / 'trusted', 'build': storage / 'builds' / job['worktree_id'] / profile_key,
                     'cargo': cache / 'cargo', 'rustup': cache / 'rustup', 'pnpm': cache / 'pnpm'}
            for key, path in paths.items():
                validate_path(path, storage)
                if key != 'source':
                    path.mkdir(parents=True, exist_ok=True)
            trusted_hashes = {}
            for filename in ('build_entrypoint.py', 'worker_entrypoint.py'):
                content = (Path(__file__).parent / filename).read_bytes()
                (paths['trusted'] / filename).write_bytes(content)
                trusted_hashes[filename] = hashlib.sha256(content).hexdigest()
            context = {'schema': 'fullmag.runner-execution.v1', 'job_id': job['job_id'],
                       'source_digest': job['source_digest'], 'profile': job['profile'],
                       'image_digest': config['image_digest'], 'native_source_identity': job['payload']['native_source_identity']}
            atomic_json(paths['trusted'] / 'context.json', context)
            trusted_hashes['context.json'] = hashlib.sha256((paths['trusted'] / 'context.json').read_bytes()).hexdigest()
            command = build_command(job['job_id'], job['source_digest'], job['profile'], config, paths, storage)
            mount_paths = {key: str(path) for key, path in paths.items()}
            if layout.get('container_coordinator'):
                mount_paths = {key: daemon_path(path, storage, layout['daemon_storage_root']) for key, path in paths.items()}
                for index, part in enumerate(command):
                    if part == '--mount':
                        original = command[index + 1]
                        for key, path in paths.items():
                            original = original.replace('source=' + str(path) + ',', 'source=' + mount_paths[key] + ',')
                        command[index + 1] = original
            expected_mounts = mount_identity([{'Type': 'bind', 'Source': mount_paths[key], 'Destination': target,
                                              'RW': key not in ('source', 'trusted')} for key, target in TARGETS.items()])
            journal = {'schema': 'fullmag.local-runner.coordinator.v1', 'job_id': job['job_id'], 'owner': owner,
                       'operation': 'build', 'profile': job['profile'], 'source_digest': job['source_digest'],
                       'image_digest': config['image_digest'], 'lease_token': job['lease_token'],
                       'mounts': expected_mounts, 'trusted_hashes': trusted_hashes, 'phase': 'prepared',
                       'container_id': None, 'started_at': time.time(), 'qualification': 'NOT VERIFIED'}
            atomic_json(run_root / 'coordinator.json', journal)
        except (OSError, ValueError, KeyError, TypeError, CoordinatorError) as error:
            queue.finish(job['job_id'], job['lease_token'], 'blocked', None)
            raise CoordinatorError(str(error)) from error
        with build_lock(origin):
            trusted_identity(run_root, journal, storage)
            journal['phase'] = 'create-requested'
            atomic_json(run_root / 'coordinator.json', journal)
            container_id = call(command).strip()
            if not re.fullmatch('[a-f0-9]{64}', container_id):
                raise CoordinatorError('Ambiguous create; lease retained')
            journal.update(container_id=container_id, phase='created')
            atomic_json(run_root / 'coordinator.json', journal)
            attest_build_container(inspect_owned(call, container_id, job['job_id']), journal)
            journal['phase'] = 'start-requested'
            atomic_json(run_root / 'coordinator.json', journal)
            call(['start', container_id])
            deadline = time.monotonic() + timeout_seconds
            while True:
                inspected = inspect_owned(call, container_id, job['job_id'])
                attest_build_container(inspected, journal)
                if inspected.get('State', {}).get('Status') == 'exited':
                    return finish_build(layout, queue, job, journal, run_root, inspected, call)
                if queue.get(job['job_id'])['state'] == 'cancel_requested':
                    call(['stop', '--time', '10', container_id])
                if time.monotonic() >= deadline:
                    raise CoordinatorError('Build observation timeout; lease retained')
                sleep(2)


def reconcile_build(layout, job_id, *, owner, call=docker):
    storage = Path(layout['storage_root'])
    queue = JobQueue(validate_path(storage / 'index' / 'runner-jobs.sqlite', storage))
    with file_lock(validate_path(storage / 'locks' / 'local-runner-coordinator.lock', storage), 'build recovery'), \
         file_lock(validate_path(storage / 'locks' / 'fullmag-heavy.lock', storage), 'heavy build recovery'):
        job = queue.get(job_id)
        if job['owner'] != owner:
            raise CoordinatorError('Job owner mismatch')
        if job['state'] not in ('running', 'cancel_requested'):
            return job
        run_root = validate_path(storage / 'runs' / job['worktree_id'] / job_id, storage)
        journal = json.loads((run_root / 'coordinator.json').read_text())
        capsule_path(storage, job)
        trusted_identity(run_root, journal, storage)
        if any(journal.get(key) != job[key] for key in ('job_id', 'owner', 'source_digest', 'profile')):
            raise CoordinatorError('Build recovery identity mismatch')
        container_id = journal.get('container_id')
        if not isinstance(container_id, str) or not re.fullmatch('[a-f0-9]{64}', container_id):
            raise CoordinatorError('No exact container ID; manual recovery required')
        journal['mounts'] = [tuple(value) for value in journal['mounts']]
        inspected = inspect_owned(call, container_id, job_id)
        attest_build_container(inspected, journal)
        if job['state'] == 'cancel_requested' and inspected.get('State', {}).get('Running') is True:
            call(['stop', '--time', '10', container_id])
            inspected = inspect_owned(call, container_id, job_id)
        if inspected.get('State', {}).get('Status') != 'exited':
            return job
        return finish_build(layout, queue, job, journal, run_root, inspected, call)
