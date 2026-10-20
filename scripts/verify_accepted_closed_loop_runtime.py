#!/usr/bin/env python3
"""No-build B02 public full-3D closed-loop process gate; never qualifies a basis."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import sys
import subprocess
import threading
import time
import uuid
from urllib.parse import quote
import urllib.request

import fullmag_storage as storage
from local_runner.worker_entrypoint import verify_source
from local_runner.build_executor import artifact_sha256
from managed_fem_runtime_package import load_package, runtime_runs_root
from accepted_fem_cpu_runtime import require, read_json, validate_lease
from verify_project_api_runtime import write_atomic_json, wait_for_health, terminate_process, assert_build_identity
from verify_resource_discovery_runtime import durable_leases, worker_control_evidence

BINARIES = ('fullmag', 'fullmag-api', 'fullmag-api-preparation-resource-pool',
            'fullmag-api-accepted-fem-preparation-scheduler', 'fullmag-api-accepted-fem-preparer',
            'fullmag-api-accepted-scheduler', 'fullmag-api-accepted-worker')
EXAMPLE = 'examples/fem_antenna_closed_loop_nonmagnetic.py'
# Existing script-execution-identity.v1: this fixed authored fixture expands once.
INSPECTION_EXECUTION_ID = 'script-execution-' + hashlib.sha256(json.dumps({
    'schema': 'fullmag.script-execution-identity.v1', 'authored_step_id': 'inspect_loop', 'expansion_index': 0},
    sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def drain(pipe, destination, limit, overflow, errors):
    try:
        written = 0
        with destination.open('xb') as stream:
            while True:
                chunk = pipe.read(65536)
                if not chunk:
                    break
                keep = chunk[:max(0, limit - written)]
                stream.write(keep)
                written += len(keep)
                if len(keep) != len(chunk):
                    overflow.set()
            stream.flush()
    except BaseException as error:
        errors.append(type(error).__name__)
        overflow.set()
    finally:
        pipe.close()


def run_process(argv, *, cwd, env, log_path, timeout, evidence, checkpoint):
    """Bound both logs. On deadline/overflow retain the exact process and pipe owners."""
    stdout = log_path.with_suffix('.stdout.log')
    stderr = log_path.with_suffix('.stderr.log')
    require(not stdout.exists() and not stderr.exists(), 'Process logs must be fresh')
    record = {'command': argv, 'stdout': str(stdout), 'stderr': str(stderr), 'state': 'launching'}
    evidence.setdefault('commands', []).append(record)
    checkpoint()
    process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    record.update(state='observing', pid=process.pid)
    checkpoint()
    overflow = threading.Event()
    errors = []
    threads = [threading.Thread(target=drain, args=(process.stdout, stdout, 4 * 1024**2, overflow, errors)),
               threading.Thread(target=drain, args=(process.stderr, stderr, 1024**2, overflow, errors))]
    # These pipe owners survive a failed main thread until the exact child exits.
    # The managed keeper/container retains ownership; neither this code nor the
    # observer kills native work at a timeout or retries scientific execution.
    for thread in threads:
        thread.start()
    deadline = time.monotonic() + timeout
    while process.poll() is None:
        if overflow.is_set() or time.monotonic() >= deadline:
            record.update(state='observation_timeout_process_retained' if not overflow.is_set()
                          else 'log_bound_process_retained', drain_errors=errors)
            checkpoint()
            raise ValueError('Owned process retained; inspect bounded logs and exact PID')
        time.sleep(0.05)
    for thread in threads:
        thread.join(timeout=2)
    if any(thread.is_alive() for thread in threads):
        record.update(state='inherited_pipe_process_retained', exit_code=process.returncode)
        checkpoint()
        raise ValueError('Owned descendant retains a process pipe')
    record.update(state='terminal', exit_code=process.returncode,
                  stdout_sha256=artifact_sha256(stdout), stderr_sha256=artifact_sha256(stderr))
    checkpoint()
    require(not overflow.is_set() and not errors, 'Process exceeded bounded output contract')
    require(process.returncode == 0, 'B02 process failed; inspect bounded stderr')
    return read_json(stdout, stdout.parent)


def start_api(binary, runtime, env, destination, receipt, checkpoint):
    with socket.socket() as reserve:
        reserve.bind(('127.0.0.1', 0))
        port = reserve.getsockname()[1]
    overflow, errors = threading.Event(), []
    record = {'command': [str(binary)], 'log': str(destination), 'state': 'launching', 'port': port}
    receipt.setdefault('api_processes', []).append(record)
    checkpoint()
    process = subprocess.Popen([str(binary)], cwd=runtime, env=dict(env, FULLMAG_API_PORT=str(port)),
                               stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    record.update(state='observing', pid=process.pid)
    checkpoint()
    thread = threading.Thread(target=drain, args=(process.stdout, destination, 4*1024**2, overflow, errors))
    thread.start()
    return process, (thread, overflow, errors, record, process, checkpoint), 'http://127.0.0.1:' + str(port)


def close_api_log(log, strict=True):
    thread, overflow, errors, record, process, checkpoint = log
    thread.join(timeout=2)
    record.update(state='terminal' if not thread.is_alive() else 'inherited_pipe_retained',
                  exit_code=process.returncode, log_overflow=overflow.is_set(), drain_errors=errors)
    if not thread.is_alive():
        record['log_sha256'] = artifact_sha256(Path(record['log']))
    checkpoint()
    if strict:
        require(not thread.is_alive() and not overflow.is_set() and not errors, 'Owned API log exceeded bound')


def json_request(url, *, method='GET', payload=None):
    body = None if payload is None else json.dumps(payload, separators=(',', ':')).encode()
    require(body is None or len(body) <= 2 * 1024**2, 'Verifier HTTP request bound')
    request = urllib.request.Request(url, data=body, method=method,
        headers={'accept': 'application/json', 'content-type': 'application/json'})
    with urllib.request.urlopen(request, timeout=10) as response:
        raw = response.read(4 * 1024**2 + 1)
        require(len(raw) <= 4 * 1024**2, 'Verifier HTTP response bound')
        return response.status, json.loads(raw)


def get_resource(base, path):
    status, value = json_request(base + path)
    require(status == 200 and isinstance(value, dict), 'Public B02 resource unavailable')
    return value


def preparation_proof(store, run_id, task_id, resource_id):
    base = store / 'runs' / run_id
    def single(directory):
        paths = list(directory.glob('*.json'))
        require(len(paths) == 1, 'Preparation process proof must be unique')
        return read_json(paths[0], store), artifact_sha256(paths[0])
    receipt = read_json(base / 'task_preparation_receipts' / (task_id + '.json'), store)
    launch, launch_sha = single(base / 'preparation_process_launches')
    exit_record, exit_sha = single(base / 'preparation_process_exit_receipts')
    lease, lease_sha = single(base / 'preparation_resource_leases' / resource_id)
    for field in ('run_id', 'task_id', 'preparation_attempt_id', 'resource_id', 'lease_token'):
        require(lease.get(field) is not None and launch.get(field) == lease[field] and exit_record.get(field) == lease[field],
                'Preparation durable process/lease identity mismatch')
    payload = receipt.get('payload', {})
    require(receipt.get('run_id') == run_id and receipt.get('task_id') == task_id
            and lease.get('run_id') == run_id and lease.get('task_id') == task_id and lease.get('resource_id') == resource_id
            and lease.get('state') == 'released' and lease.get('released_at') is not None
            and exit_record.get('status_success') is True and exit_record.get('exit_code') == 0
            and exit_record.get('timed_out') is False
            and payload.get('schema_version') == 'closed_loop_preparation_receipt.v1'
            and payload.get('preparation_id') == 'prep-' + task_id and payload.get('native'),
            'Closed-loop canonical preparation or process proof refused')
    return {'receipt': receipt, 'launch_sha256': launch_sha, 'exit_sha256': exit_sha, 'lease_sha256': lease_sha}


def fixed_bytes(path, expected, limit):
    require(re.fullmatch('[a-f0-9]{64}', expected) is not None, 'Invalid pinned digest')
    require(path.is_absolute() and not any(parent.is_symlink() for parent in (path, *path.parents))
            and '..' not in path.parts and path.is_file(), 'Pinned input must be an unaliased absolute regular file')
    with path.open('rb') as stream:
        require(0 < os.fstat(stream.fileno()).st_size <= limit, 'Pinned input byte bound')
        raw = stream.read(limit + 1)
    require(len(raw) <= limit and hashlib.sha256(raw).hexdigest() == expected, 'Pinned input changed or grew')
    return raw


def fingerprint(root):
    """Content inventory only; explicit process ownership and native lock remain mandatory."""
    records = []
    total = 0
    for path in sorted(root.rglob('*')):
        require(not path.is_symlink(), 'Private store contains a link')
        if path.is_dir():
            continue
        require(path.is_file() and len(records) < 20000, 'Private store member bound')
        size = path.stat().st_size
        total += size
        require(size <= 512 * 1024 * 1024 and total <= 2 * 1024**3, 'Private store byte bound')
        records.append((path.relative_to(root).as_posix(), size, artifact_sha256(path)))
    return {'sha256': hashlib.sha256(json.dumps(records, separators=(',', ':')).encode()).hexdigest(),
            'files': len(records), 'bytes': total}


def clone_store(source, destination):
    before = fingerprint(source)
    require(not destination.exists() and shutil.disk_usage(destination.parent).free >= before['bytes'] + 1024**3,
            'Private cold-negative clone requires fresh path and bounded free capacity')
    destination.mkdir()
    for path in sorted(source.rglob('*')):
        target = destination / path.relative_to(source)
        if path.is_dir():
            target.mkdir()
        else:
            with path.open('rb') as stream, target.open('xb') as result:
                maximum = os.fstat(stream.fileno()).st_size
                require(maximum <= 512 * 1024**2, 'Cold clone member bound')
                copied = 0
                while True:
                    block = stream.read(min(65536, maximum - copied + 1))
                    if not block:
                        break
                    copied += len(block)
                    require(copied <= maximum, 'Cold clone source grew')
                    result.write(block)
    require(fingerprint(source) == before and fingerprint(destination) == before, 'Cold clone preimage changed')
    return destination


def one_task(submitted, run_id):
    tasks = submitted.get('run', {}).get('body', {}).get('tasks', [])
    ids = submitted.get('materialization', {}).get('body', {}).get('task_ids', [])
    require(submitted.get('run_id') == run_id and submitted.get('submit', {}).get('status') == 201
            and len(tasks) == 1 and len(ids) == 1 and tasks[0].get('task_id') == ids[0]
            and tasks[0].get('lifecycle') == 'accepted'
            and tasks[0].get('readiness', {}).get('reason') == 'accepted_task_awaiting_preparation',
            'Public script did not produce one accepted inspection awaiting preparation')
    require(re.fullmatch('[A-Za-z0-9_.-]+', ids[0]) is not None, 'Unsafe task identity')
    return submitted['project_id'], ids[0]


def public_output(base, project, run, task, execution):
    prefix = '/v2/persistence/projects/' + quote(project, safe='') + '/runs/' + quote(run, safe='')
    current = get_resource(base, prefix)
    require(current.get('project_id') == project and current.get('run_id') == run
            and len(current.get('tasks', [])) == 1 and current['tasks'][0].get('task_id') == task
            and current['tasks'][0].get('lifecycle') == 'succeeded'
            and current['tasks'][0].get('accepted_state_ref') is None,
            'Public inspection task is not state-free succeeded')
    solutions = get_resource(base, prefix + '/solution-sets?limit=2')
    require(solutions.get('project_id') == project and solutions.get('run_id') == run
            and len(solutions.get('items', [])) == 1 and solutions.get('next_cursor') is None,
            'Inspection requires one public SolutionSet')
    solution = solutions['items'][0]
    revision = solution['revision']
    require(isinstance(revision, str) and re.fullmatch('[1-9][0-9]*', revision) and int(revision) < 2**64,
            'Inspection revision is not canonical')
    owner = prefix + '/solution-sets/' + quote(solution['solution_set_id'], safe='') + '/revisions/' + revision
    members = get_resource(base, owner + '/members?limit=2')
    require(members.get('project_id') == project and members.get('run_id') == run
            and members.get('solution_set_id') == solution['solution_set_id'] and members.get('revision') == revision
            and members.get('manifest_digest') == solution['manifest_digest'] and len(members.get('items', [])) == 1
            and members.get('next_after_member_id') is None, 'Inspection members changed or exceed bound')
    member = members['items'][0]
    require(member.get('stage_id') == INSPECTION_EXECUTION_ID and member.get('case_id') == 'default'
            and member.get('task_id') == task and member.get('attempt_id') == execution['attempt_id']
            and member.get('ownership_epoch') == str(execution['ownership_epoch'])
            and member.get('execution_status') == 'succeeded', 'Public inspection attempt/epoch mismatch')
    page = get_resource(base, owner + '/members/' + quote(member['member_id'], safe='') + '/artifacts?limit=100')
    require(page.get('project_id') == project and page.get('run_id') == run
            and page.get('solution_set_id') == solution['solution_set_id'] and page.get('revision') == revision
            and page.get('manifest_digest') == solution['manifest_digest'] and page.get('member_id') == member['member_id']
            and page.get('next_after_artifact_id') is None, 'Inspection artifacts changed or exceed bound')
    outputs = [item for item in page.get('items', []) if item.get('schema_id') == 'fullmag.antenna.closed_loop_bundle@v1']
    require(len(outputs) == 1 and outputs[0].get('kind') == 'other'
            and outputs[0].get('accepted_state') is None
            and re.fullmatch('[a-f0-9]{64}', outputs[0].get('object_ref', '')), 'Missing one published raw inspection bundle')
    return outputs[0], {'run': current, 'solutions': solutions, 'members': members, 'artifacts': page}



def validate_budget(budget, free_bytes):
    require(set(budget) == {'cpu_millis', 'memory_bytes', 'gpu_memory_bytes', 'storage_bytes'}
            and all(type(value) is int and value >= 0 for value in budget.values())
            and 0 < budget['cpu_millis'] <= 2000 and 0 < budget['memory_bytes'] <= 4 * 1024**3
            and 0 < budget['storage_bytes'] <= max(0, free_bytes - 1024**3)
            and budget['gpu_memory_bytes'] == 0,
            'CPU budget exceeds bounded container or private available storage')


def run(args):
    require(os.name != 'nt' and sys.platform.startswith('linux'), 'B02 requires the managed Linux runtime container')
    repo = Path(args.repo_root).resolve()
    root = storage.absolute(args.storage_root, 'private B02 storage')
    output = storage.validate_path(Path(args.output_root), root, 'B02 evidence')
    require(not output.exists(), 'B02 evidence must be fresh')
    package = load_package(Path(args.managed_build_run_root), root, args.expected_commit, args.expected_snapshot, BINARIES)
    binaries, evidence, identity, libraries = package
    capsule = storage.validate_path(Path(args.source_capsule), root.parent, 'frozen source capsule')
    source = verify_source(capsule, evidence['managed_package']['source_digest'])
    require(repo == capsule / 'tree', 'Runtime sources must be the immutable package capsule')
    invocation = uuid.uuid4().hex
    worktree_id = 'b02-' + invocation
    runs = runtime_runs_root(repo, root, worktree_id)
    require(not runs.exists(), 'B02 runs namespace must be fresh')
    output.mkdir(parents=True)
    runs.mkdir(parents=True)
    for name in ('home', 'tmp', 'state', 'runtime'):
        (output / name).mkdir()
    receipt = {'schema': 'fullmag.accepted_closed_loop_runtime.v1', 'status': 'preflight', 'invocation_id': invocation,
               'managed_package': evidence, 'source_capsule_digest': source['source_digest'], 'commands': [],
               'scientific_qualification': 'not_verified', 'publication': 'inspection_only'}
    receipt_path = output / 'receipt.json'
    def checkpoint():
        write_atomic_json(receipt_path, receipt)
    def command(argv, name, timeout, refusal=None):
        try:
            result = run_process(argv, cwd=output / 'runtime', env=env, log_path=output / name,
                                 timeout=timeout, evidence=receipt, checkpoint=checkpoint)
        except ValueError:
            record = receipt['commands'][-1]
            if refusal is None or record.get('state') != 'terminal' or record.get('exit_code') == 0:
                raise
            diagnostic = Path(record['stderr']).read_bytes()
            require(len(diagnostic) <= 1024 * 1024 and refusal.encode() in diagnostic,
                    'Cold negative failed for an unexpected reason')
            result = {'expected_refusal': refusal}
        else:
            require(refusal is None, 'Cold negative unexpectedly succeeded')
        for item in receipt['commands'][-1:]:
            require(Path(item['stdout']).stat().st_size <= 4 * 1024 * 1024
                    and Path(item['stderr']).stat().st_size <= 1024 * 1024, 'B02 process log bound')
        return result
    api = log = None
    checkpoint()
    try:
        profile = json.loads(fixed_bytes(Path(args.execution_profile), args.profile_sha256, 1024 * 1024))
        budget = json.loads(fixed_bytes(Path(args.resources), args.resources_sha256, 64 * 1024))
        require(profile.get('schema_version') == 'execution_profile.v1' and not profile.get('defaults'),
                'B02 profile must preserve authored exact request without overrides')
        validate_budget(budget, shutil.disk_usage(runs).free)
        receipt['bounded_resource_budget'] = budget
        inputs = {}
        for name, path, digest, limit in [('project.fms', Path(args.project), args.project_sha256, 64 * 1024**2),
                                         ('profile.json', Path(args.execution_profile), args.profile_sha256, 1024**2),
                                         ('resources.json', Path(args.resources), args.resources_sha256, 64 * 1024)]:
            destination = output / name
            destination.write_bytes(fixed_bytes(path, digest, limit))
            inputs[name] = {'sha256': digest, 'path': str(destination)}
        # Only immutable capsule Python authoring bytes and managed pycore enter this root.
        runtime = output / 'runtime'
        python_parent = runtime / 'packages/fullmag-py/src'
        python_parent.mkdir(parents=True)
        copied = []
        for entry in source['files']:
            relative = entry['path']
            if relative.startswith('packages/fullmag-py/src/fullmag/'):
                require(entry['size'] <= 32 * 1024**2, 'DSL runtime member bound')
                target = runtime / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(fixed_bytes(repo / relative, entry['sha256'], 32 * 1024**2))
                copied.append({'path': relative, 'sha256': entry['sha256'], 'bytes': entry['size']})
        require(copied and sum(item['bytes'] for item in copied) <= 128 * 1024**2, 'Missing or oversized Python DSL closure')
        core = libraries.parent / '_fullmag_core.so'
        build = read_json(Path(args.managed_build_run_root) / 'artifacts/build-receipt.json', root)
        core_record = next((item for item in build['artifacts'] if item['path'] == 'outputs/.fullmag/local/_fullmag_core.so'), None)
        require(core_record and core_record['size'] <= 128 * 1024**2, 'Missing managed native Python core')
        (python_parent / '_fullmag_core.so').write_bytes(fixed_bytes(core, core_record['sha256'], 128 * 1024**2))
        example = next((entry for entry in source['files'] if entry['path'] == EXAMPLE), None)
        require(example is not None, 'Closed-loop example absent from package capsule')
        script = output / 'full-loop.py'
        script.write_bytes(fixed_bytes(repo / EXAMPLE, example['sha256'], 8 * 1024**2))
        receipt['inputs'] = inputs
        receipt['authoring_runtime'] = {'copied': copied, 'managed_pycore': core_record, 'example': example}
        env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': str(output / 'home'), 'TMPDIR': str(output / 'tmp'),
               'PYTHONDONTWRITEBYTECODE': '1', 'FULLMAG_PYTHON': args.python,
               'FULLMAG_PROJECT_STORAGE_ROOT': str(root), 'FULLMAG_REPO_ROOT': str(runtime),
               'FULLMAG_STATE_ROOT': str(output / 'state'), 'FULLMAG_WORKTREE_ID': worktree_id, 'FULLMAG_RUNS_ROOT': str(runs),
               'FULLMAG_SOURCE_GIT_COMMIT': identity['head_commit_full'],
               'FULLMAG_SOURCE_SNAPSHOT_SHA256': identity['source_snapshot_sha256'], 'FULLMAG_SOURCE_WORKTREE_STATE': 'clean',
               'FULLMAG_RUNTIME_SERVICE_SOURCE_COMMIT': args.expected_commit, 'FULLMAG_RUNTIME_SERVICE_SOURCE_SNAPSHOT': args.expected_snapshot,
               'FULLMAG_DISABLE_STATIC_CONTROL_ROOM': '1', 'FULLMAG_FEM_LIB_DIR': str(libraries), 'LD_LIBRARY_PATH': str(libraries),
               'FULLMAG_FORCE_LOCAL_FEM_CPU': '1', 'FULLMAG_FEM_EXECUTION': 'cpu', 'FULLMAG_FEM_MFEM_DEVICE': 'cpu',
               'FULLMAG_FEM_REQUIRE_GPU': '0', 'FULLMAG_FEM_REQUIRE_CEED': '0', 'FULLMAG_DISABLE_MANAGED_FEM_GPU_RUNTIME': '1'}
        probe = "import sys,json,hashlib;sys.path.insert(0,sys.argv[1]);import numpy,_fullmag_core;print(json.dumps({'python':sys.version,'executable':sys.executable,'numpy_version':numpy.__version__,'numpy_path':numpy.__file__,'core_path':_fullmag_core.__file__,'core_sha256':hashlib.sha256(open(_fullmag_core.__file__,'rb').read()).hexdigest(),'python_sha256':hashlib.sha256(open(sys.executable,'rb').read()).hexdigest(),'numpy_init_sha256':hashlib.sha256(open(numpy.__file__,'rb').read()).hexdigest()}))"
        require(Path(args.python).is_absolute(), 'Explicit image interpreter required')
        args.python = str(Path(args.python).resolve(strict=True))
        env['FULLMAG_PYTHON'] = args.python
        abi = command([args.python, '-I', '-B', '-c', probe, str(python_parent)], 'python-abi', 30)
        require(abi['core_path'] == str(python_parent / '_fullmag_core.so') and abi['core_sha256'] == core_record['sha256'],
                'Python imported another native core')
        receipt['python_abi'] = abi
        api, log, base = start_api(binaries['fullmag-api'], runtime, env, output / 'api-submit.log', receipt, checkpoint)
        wait_for_health(base, api)
        _, openapi = json_request(base + '/v2/platform/openapi.json')
        receipt['build_identity'] = assert_build_identity(openapi, {'git_commit': args.expected_commit,
            'source_snapshot_sha256': args.expected_snapshot, 'worktree_state': 'clean'})
        status, catalog = json_request(base + '/v2/platform/compute/profiles')
        require(status == 200, 'Profile catalog unavailable')
        status, publication = json_request(base + '/v2/platform/compute/profiles', method='POST', payload={
            'expected_revision': catalog['revision'], 'client_intent_id': 'b02-profile-' + invocation, 'profile': profile})
        require(status == 201, 'Private profile publication failed')
        receipt['profile_publication'] = publication
        key = 'b02-' + invocation
        run_id = 'run-' + hashlib.sha256(key.encode()).hexdigest()
        submitted = command([str(binaries['fullmag']), 'run-script-accepted', str(script), '--project', str(output / 'project.fms'),
            '--execution-profile', str(output / 'profile.json'), '--resources', str(output / 'resources.json'),
            '--idempotency-key', key, '--api-url', base], 'public-submit', 90)
        project, task = one_task(submitted, run_id)
        receipt['submit'] = submitted
        receipt['api_submit_exit_code'] = terminate_process(api)
        require(receipt['api_submit_exit_code'] is not None, 'Owned API did not exit')
        api = None
        close_api_log(log); log = None
        store = runs / 'session-store'
        mesh_id = 'b02-mesh-' + invocation
        offer = json.dumps({'resource_id': mesh_id, 'budget': budget}, separators=(',', ':'))
        receipt['meshing_pool'] = command([str(binaries['fullmag-api-preparation-resource-pool']), '--store-root', str(store),
            '--pool-id', mesh_id, '--expected-generation', '0', '--resource-offer', offer], 'mesh-pool', 30)
        preparation = command([str(binaries['fullmag-api-accepted-fem-preparation-scheduler']), '--store-root', str(store),
            '--pool-id', mesh_id, '--preparer-executable', str(binaries['fullmag-api-accepted-fem-preparer']), '--max-concurrency', '1',
            '--max-tasks', '1', '--process-timeout-seconds', '180', '--heartbeat-interval-milliseconds', '250'], 'prepare', 240)
        executed = preparation.get('executed', [])
        require(preparation.get('scheduled_count') == 1 and len(executed) == 1 and executed[0].get('run_id') == run_id
                and executed[0].get('task_id') == task and executed[0].get('status_success') is True
                and executed[0].get('timed_out') is False, 'Actual closed-loop preparation failed')
        receipt['preparation'] = preparation
        receipt['preparation_durable'] = preparation_proof(store, run_id, task, mesh_id)
        cpu_id = 'b02-cpu-' + invocation
        solve = command([str(binaries['fullmag-api-accepted-scheduler']), '--store-root', str(store), '--run-id', run_id,
            '--resource-id', cpu_id, '--resource-kind', 'cpu', '--cpu-millis', str(budget['cpu_millis']),
            '--memory-bytes', str(budget['memory_bytes']), '--gpu-memory-bytes', '0', '--storage-bytes', str(budget['storage_bytes']),
            '--worker-executable', str(binaries['fullmag-api-accepted-worker']), '--max-concurrency', '1', '--max-tasks', '1',
            '--worker-timeout-seconds', str(args.solve_timeout_seconds), '--heartbeat-interval-milliseconds', '250',
            '--max-automatic-retries', '0'], 'start-solve', args.solve_timeout_seconds + 60)
        executions = solve.get('executed', [])
        require(solve.get('scheduled_count') == 1 and len(executions) == 1 and executions[0].get('run_id') == run_id
                and executions[0].get('task_id') == task and executions[0].get('worker_timed_out') is False
                and executions[0].get('worker_cancelled') is False and executions[0].get('retry_scheduled') is False
                and executions[0].get('worker', {}).get('status') == 'completed', 'Actual closed-loop Start/worker did not complete')
        execution = executions[0]
        receipt['solver'] = solve
        leases = durable_leases(store, run_id)
        require(len(leases) == 1 and leases[0].get('state') == 'released' and leases[0].get('released_at') is not None,
                'Owned solver lease is not released')
        validate_lease(leases[0], store, run_id, task, execution)
        receipt['worker_control'] = worker_control_evidence(store, run_id, leases[0])
        api, log, base = start_api(binaries['fullmag-api'], runtime, env, output / 'api-cold-discovery.log', receipt, checkpoint)
        wait_for_health(base, api)
        artifact, public = public_output(base, project, run_id, task, execution)
        receipt['public_results'] = public
        receipt['api_cold_exit_code'] = terminate_process(api)
        require(receipt['api_cold_exit_code'] is not None, 'Owned cold API did not exit')
        api = None; close_api_log(log); log = None
        require(read_json(store / 'WRITER.owner.json', store).get('released') is True,
                'Cold-load requires released native writer and quiescent owned processes')
        before = fingerprint(store)
        argv = [str(binaries['fullmag']), 'runtime', 'verify-saved-inspection', '--store', str(store), '--project-id', project,
                '--run-id', run_id, '--task-id', task, '--attempt-id', execution['attempt_id'],
                '--ownership-epoch', str(execution['ownership_epoch']), '--object-ref', artifact['object_ref']]
        cold = command(argv, 'cold-load', 90)
        require(cold.get('status') == 'pass' and cold.get('read_only') is True and cold.get('object_ref') == artifact['object_ref']
                and cold.get('artifact_id') == artifact['artifact_id'] and cold.get('preparation_id') == 'prep-' + task,
                'Cold-load integrity identity mismatch')
        after = fingerprint(store)
        require(before == after, 'Cold-load changed existing store bytes')
        negatives = []
        for flag, value, reason in [('--attempt-id', 'b02-stale-attempt', 'expected attempt/epoch'),
                                   ('--ownership-epoch', '0', 'expected attempt/epoch'),
                                   ('--object-ref', '0' * 64, 'public CAS object differs')]:
            bad = list(argv)
            bad[bad.index(flag) + 1] = value
            negatives.append(command(bad, 'cold-negative-' + flag[2:], 90, refusal=reason))
            require(fingerprint(store) == before, 'Cold negative modified existing store')
        # Mutation negatives operate only on a new bounded private clone, never
        # on the successful owned store or a shared project/queue.
        cloned = clone_store(store, output / 'cold-negative-store')
        clone_argv = list(argv)
        clone_argv[clone_argv.index('--store') + 1] = str(cloned)
        preparation_path = cloned / 'runs' / run_id / 'task_preparation_receipts' / (task + '.json')
        original_preparation = preparation_path.read_bytes()
        changed = read_json(preparation_path, cloned)
        changed['payload']['preparation_id'] = 'prep-inspect_loop'
        write_atomic_json(preparation_path, changed)
        negative_before = fingerprint(cloned)
        negatives.append(command(clone_argv, 'cold-negative-preparation-id', 90, refusal='canonical accepted task'))
        require(fingerprint(cloned) == negative_before, 'Cold refusal modified cloned preparation/store')
        preparation_path.write_bytes(original_preparation)
        events = list((cloned / 'runs' / run_id / 'coordinator_journal' / 'event').glob('*.json'))
        require(0 < len(events) <= 4096, 'Cold negative event inventory bound')
        completed = []
        for path in events:
            record = read_json(path, cloned, 256 * 1024)
            if (record.get('task_id') == task and record.get('attempt_id') == execution['attempt_id']
                    and record.get('ownership_epoch') == execution['ownership_epoch']
                    and record.get('payload', {}).get('message', {}).get('envelope', {}).get('event', {}).get('kind') == 'completed'):
                completed.append(path)
        require(len(completed) == 1, 'Cold negative requires one exact durable Completed')
        completed[0].unlink()
        negative_before = fingerprint(cloned)
        negatives.append(command(clone_argv, 'cold-negative-missing-completed', 90, refusal='coordinator catalog watermark is ahead'))
        require(fingerprint(cloned) == negative_before and fingerprint(store) == before,
                'Cold history refusal changed clone or original successful store')
        receipt.update(cold_load=cold, cold_negative_checks=negatives, store_before=before, store_after=after)
        require(load_package(Path(args.managed_build_run_root), root, args.expected_commit, args.expected_snapshot, BINARIES)[1] == evidence,
                'Managed package changed during B02 verification')
        require(verify_source(capsule, source['source_digest']) == source, 'Source capsule changed during verification')
        receipt['status'] = 'passed'
        return 0
    except BaseException as error:
        receipt.update(status='failed', error=f'{type(error).__name__}: {error}')
        return 1
    finally:
        if api is not None:
            receipt['api_cleanup_exit_code'] = terminate_process(api)
        if log is not None:
            close_api_log(log, strict=False)
        checkpoint()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ('repo-root', 'source-capsule', 'managed-build-run-root', 'storage-root', 'expected-commit', 'expected-snapshot',
                 'project', 'project-sha256', 'execution-profile', 'profile-sha256', 'resources', 'resources-sha256', 'output-root', 'python'):
        parser.add_argument('--' + flag, required=True)
    parser.add_argument('--solve-timeout-seconds', type=int, required=True)
    args = parser.parse_args()
    require(1 <= args.solve_timeout_seconds <= 3600, 'Bounded solve timeout required')
    return run(args)


if __name__ == '__main__':
    raise SystemExit(main())
