"""No-build continuation from prepared FEM task to a verified saved tensor.

The caller owns the private store, package preflight, image attestation and
final package revalidation. This process gate does not qualify physics.
"""
import json
import math
import hashlib
import re
import subprocess
from pathlib import Path
from urllib.parse import quote

import fullmag_storage as storage
from local_runner.build_executor import artifact_sha256
from verify_project_api_runtime import json_request, terminate_process, wait_for_health, write_atomic_json
from verify_resource_discovery_runtime import (
    durable_leases, start_api, validate_publisher, worker_control_evidence,
)
from verify_saved_fem_archive_roundtrip import check_integrity_result

BINARIES = ('fullmag-api-resource-pool', 'fullmag-api-accepted-scheduler',
            'fullmag-api-accepted-worker')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_json(path, root, limit=4 * 1024 * 1024):
    path = storage.validate_path(path, root, 'FEM runtime record')
    require(path.is_file() and 0 < path.stat().st_size <= limit, 'Missing or oversized FEM runtime record')
    value = json.loads(path.read_text(encoding='utf-8'))
    require(isinstance(value, dict), 'FEM runtime record must be an object')
    return value


def run_process(command, *, cwd, env, log_path, timeout, evidence, checkpoint):
    """Observation deadlines retain the exact process; they never retry it."""
    out = log_path.with_suffix('.stdout.log')
    err = log_path.with_suffix('.stderr.log')
    record = {'command': command, 'stdout': str(out), 'stderr': str(err), 'state': 'launching'}
    evidence.setdefault('commands', []).append(record)
    checkpoint()
    with out.open('x', encoding='utf-8') as stdout, err.open('x', encoding='utf-8') as stderr:
        process = subprocess.Popen(command, cwd=cwd, env=env, stdout=stdout, stderr=stderr)
        record.update(state='observing', pid=process.pid)
        checkpoint()
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            record['state'] = 'observation_timeout_process_retained'
            checkpoint()
            raise ValueError(f'FEM observation timeout; process retained pid={process.pid}; inspect {out}')
    record.update(state='terminal', exit_code=process.returncode,
                  stdout_sha256=artifact_sha256(out), stderr_sha256=artifact_sha256(err))
    checkpoint()
    require(process.returncode == 0, f'FEM runtime process failed; inspect {err}')
    return read_json(out, out.parent)


def validate_execution(metadata):
    provenance = metadata.get('execution_provenance', {})
    resolution = provenance.get('execution_resolution', {})
    require(provenance.get('execution_engine') == 'fem_cpu_native', 'FEM runtime did not use native CPU engine')
    for key in ('authored_request', 'effective_request', 'resolved_execution'):
        selected = resolution.get(key, {})
        require(all(selected.get(name) == value for name, value in
                    {'backend': 'fem', 'device': 'cpu', 'precision': 'double', 'mode': 'strict'}.items()),
                'FEM execution identity differs from exact CPU double request')
    require(resolution.get('resolution_mode') == 'exact' and
            resolution.get('fallback_occurred') is False and resolution.get('fallback_reason') is None,
            'FEM CPU execution used fallback or an inexact resolution')
    return provenance


def native_plan_digest(path, root):
    """Preserve serde's numeric tokens when hashing the native JSON plan."""
    class Number(str):
        pass
    def object_pairs(pairs):
        require(len({key for key, _ in pairs}) == len(pairs), 'Duplicate native metadata keys')
        return dict(pairs)
    def reject_constant(value):
        raise ValueError('Nonfinite native JSON number: ' + value)
    path = storage.validate_path(path, root)
    require(path.is_file() and path.stat().st_size <= 4 * 1024 * 1024, 'Oversized native plan metadata')
    document = json.loads(path.read_text(encoding='utf-8'), parse_float=Number,
                          parse_constant=reject_constant, object_pairs_hook=object_pairs)
    require(isinstance(document, dict) and isinstance(document.get('plan'), dict), 'Native metadata omits the plan')
    def canonical(value):
        if isinstance(value, Number):
            return str(value)
        if isinstance(value, dict):
            return '{' + ','.join(json.dumps(key, ensure_ascii=False) + ':' + canonical(value[key])
                                  for key in sorted(value)) + '}'
        if isinstance(value, list):
            return '[' + ','.join(canonical(item) for item in value) + ']'
        return json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    return hashlib.sha256(canonical(document['plan']).encode('utf-8')).hexdigest()


def validate_lease(lease, root, run_id, task_id, execution):
    require(lease.get('schema_version') == 'resource_lease.v1' and
            lease.get('run_id') == run_id and lease.get('task_id') == task_id and
            all(lease.get(key) == execution.get(key) for key in
                ('attempt_id', 'ownership_epoch', 'resource_id')), 'FEM lease ownership differs from scheduler execution')
    require(type(lease.get('ownership_epoch')) is int and lease['ownership_epoch'] > 0,
            'Invalid FEM lease ownership epoch')
    for key in ('run_id', 'task_id', 'attempt_id', 'resource_id', 'lease_token'):
        require(isinstance(lease.get(key), str) and re.fullmatch('[A-Za-z0-9_.-]+', lease[key]) and
                lease[key] not in ('.', '..'), 'Invalid FEM lease identity')
    expected = root / 'runs' / run_id / 'resource_leases' / lease['resource_id'] / (lease['lease_token'] + '.json')
    actual = storage.validate_path(Path(lease['path']), root, 'FEM lease record')
    require(actual == expected, 'FEM lease record path aliases another resource or token')
    persisted = read_json(actual, root)
    require(persisted == {key: value for key, value in lease.items() if key not in ('path', 'sha256')} and
            artifact_sha256(actual) == lease['sha256'], 'FEM lease bytes changed after discovery')


def validate_completed_outputs(store_root, attempt_root, accepted_state, task_id, lease):
    completed = read_json(attempt_root / 'worker_execution_completed.v1.json', store_root)
    require(completed.get('status') == 'completed' and completed.get('accepted_state_ref') == accepted_state,
            'Completed worker receipt differs from the public accepted state')
    require(type(completed.get('completed_step_count')) is int and completed['completed_step_count'] > 0,
            'Completed FEM worker receipt has no executed solver steps')
    identity = completed.get('identity', {})
    started = read_json(attempt_root / 'worker_execution_started.v1.json', store_root)
    require(completed.get('schema_version') == 'fullmag.accepted_worker_execution.v1' and
            identity.get('schema_version') == 'fullmag.accepted_worker_execution.v1' and
            started.get('identity') == identity and isinstance(identity.get('start_message_id'), str) and
            bool(identity['start_message_id']) and type(identity.get('start_sequence')) is int and
            identity['start_sequence'] > 0 and isinstance(identity.get('plan_fingerprint'), str) and
            re.fullmatch('[a-f0-9]{64}', identity['plan_fingerprint']) and
            isinstance(identity.get('case_id'), str) and bool(identity['case_id']),
            'FEM start/completed receipts differ or omit full execution identity')
    claim = identity.get('claim', {})
    require(claim.get('run_id') == accepted_state['id']['run_id'] and claim.get('task_id') == task_id and
            claim.get('ownership_epoch') == accepted_state['generation']['runtime_epoch'] and
            claim.get('attempt_id') == lease['attempt_id'] and
            claim.get('lease', {}).get('resource_id') == lease['resource_id'] and
            claim.get('lease', {}).get('lease_token') == lease['lease_token'],
            'Completed FEM worker claim differs from its accepted ownership and resource lease')
    journal = store_root / 'runs' / lease['run_id'] / 'coordinator_journal/command'
    paths = list(journal.glob('*.json'))
    require(0 < len(paths) <= 4096, 'FEM command journal exceeds the observation bound')
    starts = []
    for path in paths:
        entry = read_json(path, store_root, 64 * 1024)
        envelope = entry.get('payload', {}).get('message', {}).get('envelope', {})
        if envelope.get('command', {}).get('kind') == 'start':
            starts.append(envelope)
    fenced_claim = {key: claim[key] for key in ('run_id', 'task_id', 'attempt_id', 'ownership_epoch')}
    fenced_claim['lease_token'] = lease['lease_token']
    require(len(starts) == 1 and starts[0].get('message_id') == identity['start_message_id'] and
            starts[0].get('sequence') == identity['start_sequence'] and starts[0].get('claim') == fenced_claim,
            'FEM completed attempt is not the exact journal Start command')
    outputs = completed.get('outputs', [])
    require(len(outputs) == 2 and {item.get('port_id') for item in outputs} == {'final_state', 'total_energy'},
            'FEM runtime requires exactly the declared final_state and total_energy outputs')
    expected = {'final_state': ('state', 'fullmag.runner.field_json'),
                'total_energy': ('scalar', 'fullmag.study.scalar_json')}
    for output in outputs:
        require(output.get('case_id') == identity.get('case_id'), 'FEM output case differs from worker identity')
        kind, codec = expected[output['port_id']]
        require((output.get('data_kind'), output.get('codec_id'), output.get('codec_version')) ==
                (kind, codec, 'v1'), 'FEM output codec differs from its declared port')
        digest = output.get('object_ref', '')
        require(isinstance(digest, str) and re.fullmatch('[a-f0-9]{64}', digest), 'Invalid FEM output CAS digest')
        path = storage.validate_path(store_root / 'objects/sha256' / digest, store_root)
        require(type(output.get('byte_count')) is int and output['byte_count'] > 0 and
                path.is_file() and path.stat().st_size == output['byte_count'] and
                artifact_sha256(path) == digest, 'FEM output CAS size/hash mismatch')
        if output['port_id'] == 'total_energy':
            scalar = read_json(path, store_root, 64 * 1024)
            require(scalar.get('schema_version') == 'study_scalar.v1' and scalar.get('quantity_id') == 'E_total' and
                    scalar.get('unit') == 'J' and type(scalar.get('value_si')) in (int, float) and
                    math.isfinite(scalar['value_si']) and type(scalar.get('time_s')) in (int, float) and
                    math.isfinite(scalar['time_s']) and scalar['time_s'] >= 0 and
                    type(scalar.get('step')) is int and scalar['step'] > 0 and
                    scalar.get('step') == accepted_state['id']['accepted_step'],
                    'FEM total_energy scalar has invalid identity, units, value or clock')
    return completed


def get_resource(base_url, path):
    status, result = json_request(base_url + path)
    require(status == 200 and isinstance(result, dict), 'FEM result resource is unavailable')
    return result


def saved_source(base_url, project_id, run_id, task_id, accepted_state, completed):
    prefix = '/v2/persistence/projects/' + quote(project_id, safe='') + '/runs/' + quote(run_id, safe='')
    discovery = get_resource(base_url, prefix + '/solution-sets?limit=2')
    require(discovery.get('project_id') == project_id and discovery.get('run_id') == run_id and
            len(discovery.get('items', [])) == 1 and discovery.get('next_cursor') is None,
            'Expected exactly one project-owned FEM SolutionSet')
    solution = discovery['items'][0]
    revision = solution['revision']
    require(isinstance(revision, str) and re.fullmatch('[1-9][0-9]*', revision) and int(revision) < 2**64,
            'Invalid FEM SolutionSet revision')
    owner = prefix + '/solution-sets/' + quote(solution['solution_set_id'], safe='') + '/revisions/' + revision
    members = get_resource(base_url, owner + '/members?limit=2')
    require(members.get('project_id') == project_id and members.get('run_id') == run_id and
            members.get('solution_set_id') == solution['solution_set_id'] and members.get('revision') == revision and
            members.get('manifest_digest') == solution['manifest_digest'], 'FEM member page owner/revision mismatch')
    require(len(members.get('items', [])) == 1 and members.get('next_after_member_id') is None,
            'Expected exactly one FEM SolutionSet member')
    member = members['items'][0]
    require(member.get('task_id') == task_id and member.get('stage_id') == accepted_state['id']['stage_id'] and
            member.get('attempt_id') == completed['identity']['claim']['attempt_id'] and
            member.get('case_id') == completed['identity']['case_id'] and
            member.get('ownership_epoch') == str(accepted_state['generation']['runtime_epoch']) and
            member.get('execution_status') == 'succeeded', 'FEM SolutionSet member differs from accepted task')
    member_path = owner + '/members/' + quote(member['member_id'], safe='')
    artifacts = get_resource(base_url, member_path + '/artifacts?limit=100')
    require(artifacts.get('project_id') == project_id and artifacts.get('run_id') == run_id and
            artifacts.get('solution_set_id') == solution['solution_set_id'] and artifacts.get('revision') == revision and
            artifacts.get('manifest_digest') == solution['manifest_digest'] and
            artifacts.get('member_id') == member['member_id'], 'FEM artifact page owner/revision mismatch')
    require(artifacts.get('next_after_artifact_id') is None, 'FEM artifact page exceeds fixture bound')
    items = artifacts.get('items', [])
    state_ref = next(output['object_ref'] for output in completed['outputs'] if output['port_id'] == 'final_state')
    states = [item for item in items if item.get('object_ref') == state_ref and item.get('kind') == 'state']
    datasets = [item for item in items if item.get('schema_id') == 'fullmag.materialized_dataset.v1']
    require(len(states) == 1 and len(datasets) == 1, 'FEM result lacks one state and materialized dataset')
    expected_public_state = dict(accepted_state['id'], accepted_step=str(accepted_state['id']['accepted_step']))
    for output, kind in [(item, 'state' if item['port_id'] == 'final_state' else 'table')
                         for item in completed['outputs']]:
        matches = [item for item in items if item.get('object_ref') == output['object_ref'] and item.get('kind') == kind]
        require(len(matches) == 1 and matches[0].get('schema_id') == output['codec_id'] + '@' + output['codec_version'] and
                matches[0].get('byte_length') == str(output['byte_count']) and
                matches[0].get('accepted_state') == (expected_public_state if kind == 'state' else None),
                'Public FEM typed output identity/codec/length/accepted state mismatch')
    dataset = get_resource(base_url, member_path + '/artifacts/' + quote(datasets[0]['artifact_id'], safe='') +
                           '/materialized-dataset')
    require(dataset.get('integrity') == 'verified' and dataset.get('project_id') == project_id and
            dataset.get('run_id') == run_id and dataset.get('solution_set_id') == solution['solution_set_id'] and
            dataset.get('member_id') == member['member_id'] and dataset.get('containing_solution_revision') == revision and
            dataset.get('artifact_id') == datasets[0]['artifact_id'], 'FEM materialized dataset integrity/owner mismatch')
    pinned = dict(dataset['source'])
    require(pinned.get('run_id') == run_id and pinned.get('solution_set_id') == solution['solution_set_id'] and
            pinned.get('member_id') == member['member_id'], 'FEM tensor source owner mismatch')
    pinned_revision = pinned.get('solution_revision')
    require(isinstance(pinned_revision, str) and re.fullmatch('[1-9][0-9]*', pinned_revision) and
            int(pinned_revision) < 2**64, 'Invalid pinned FEM tensor revision')
    pinned['solution_revision'] = int(pinned_revision)
    return pinned, states[0]['artifact_id'], {'discovery': discovery, 'members': members,
                                             'artifacts': artifacts, 'dataset': dataset}


def execute(binaries, repo_root, env, run_root, store_root, fixture, request, task_id, evidence, checkpoint):
    run_id, project_id = fixture['run_id'], fixture['project_id']
    pool_id = 'fem-cpu-' + run_root.name
    pool = run_process([
        str(binaries['fullmag-api-resource-pool']), '--store-root', str(store_root),
        '--pool-id', pool_id, '--expected-generation', '0', '--discover-local', 'true',
        '--host-resource-id', pool_id, '--include-cpu', 'true', '--require-gpu', 'false',
        '--cpu-reserve-millis', '1000', '--memory-reserve-bytes', '536870912',
        '--storage-reserve-bytes', '536870912'], cwd=repo_root, env=env,
        log_path=run_root / 'solver-resource-pool.log', timeout=30, evidence=evidence, checkpoint=checkpoint)
    offer = validate_publisher(pool, request['run_intent']['specification']['requested_execution']['minimum_resources'])
    evidence['resource_pool'] = pool
    scheduler = run_process([
        str(binaries['fullmag-api-accepted-scheduler']), '--store-root', str(store_root),
        '--run-id', run_id, '--pool-id', pool_id, '--resident', 'true', '--discover-resources', 'true',
        '--worker-executable', str(binaries['fullmag-api-accepted-worker']), '--max-concurrency', '1',
        '--max-queued-runs', '1', '--max-tasks', '1', '--max-idle-polls', '0',
        '--idle-poll-milliseconds', '20', '--worker-timeout-seconds', '120',
        '--heartbeat-interval-milliseconds', '250', '--max-automatic-retries', '0'],
        cwd=repo_root, env=env, log_path=run_root / 'solver-scheduler.log', timeout=180,
        evidence=evidence, checkpoint=checkpoint)
    executed = scheduler.get('executed', [])
    require(scheduler.get('status') == 'completed' and scheduler.get('scheduled_count') == 1 and
            len(executed) == 1 and executed[0].get('run_id') == run_id and
            executed[0].get('task_id') == task_id and executed[0].get('worker_timed_out') is False and
            executed[0].get('worker_cancelled') is False and executed[0].get('retry_scheduled') is False and
            executed[0].get('resource_id') == offer['resource_id'] and
            executed[0].get('worker', {}).get('status') == 'completed', 'FEM CPU scheduler did not complete one task')
    evidence['scheduler'] = scheduler
    leases = durable_leases(store_root, run_id)
    require(len(leases) == 1 and leases[0].get('kind') == 'cpu' and
            leases[0].get('resource_id') == offer['resource_id'] and
            leases[0].get('state') == 'released' and leases[0].get('released_at') is not None,
            'FEM CPU solver did not release its exact durable lease')
    evidence['resource_leases'] = leases
    validate_lease(leases[0], store_root, run_id, task_id, executed[0])
    evidence['worker_control'] = worker_control_evidence(store_root, run_id, leases[0])
    metadata_paths = list((store_root / 'runs' / run_id / 'worker-attempts').glob('**/metadata.json'))
    require(len(metadata_paths) == 1, 'FEM CPU proof requires one native attempt metadata')
    metadata_path = metadata_paths[0]
    expected_attempt = store_root / 'runs' / run_id / 'worker-attempts' / task_id / leases[0]['attempt_id'] / (
        'epoch-' + str(leases[0]['ownership_epoch']))
    require(metadata_path.parent == expected_attempt, 'FEM metadata path differs from exact admitted attempt')
    evidence['execution'] = validate_execution(read_json(metadata_path, store_root))
    evidence['metadata_binding'] = {'path': str(metadata_path), 'sha256': artifact_sha256(metadata_path),
                                    'run_id': run_id, 'task_id': task_id, 'attempt_id': leases[0]['attempt_id'],
                                    'ownership_epoch': leases[0]['ownership_epoch']}
    api, log, base_url = start_api(binaries['fullmag-api'], repo_root, env, run_root / 'api-solver-result.log')
    try:
        wait_for_health(base_url, api)
        run = get_resource(base_url, '/v2/persistence/projects/' + quote(project_id, safe='') +
                           '/runs/' + quote(run_id, safe=''))
        tasks = run.get('tasks', [])
        require(len(tasks) == 1 and tasks[0].get('task_id') == task_id and
                tasks[0].get('lifecycle') == 'succeeded', 'Public FEM run does not expose successful exact task')
        accepted = tasks[0].get('accepted_state_ref', {})
        expected_step = request['study_plan']['steps'][0]['step_id']
        require(accepted.get('id', {}).get('run_id') == run_id and
                accepted.get('id', {}).get('stage_id') == expected_step and
                accepted.get('generation', {}).get('runtime_epoch') == leases[0]['ownership_epoch'],
                'FEM accepted state differs from the run/step/ownership epoch')
        completed = validate_completed_outputs(store_root, metadata_path.parent, accepted, task_id, leases[0])
        require(native_plan_digest(metadata_path, store_root) == completed['identity']['plan_fingerprint'],
                'Native FEM metadata plan differs from the fenced worker execution plan')
        evidence['run'] = run
        evidence['completed_worker'] = completed
        pinned, artifact_id, public = saved_source(base_url, project_id, run_id, task_id, accepted, completed)
        evidence['public_results'] = public
    finally:
        evidence['api_exit_code'] = terminate_process(api)
        log.close()
    pinned_path = run_root / 'pinned-fem-source.json'
    write_atomic_json(pinned_path, pinned)
    verified = run_process([str(binaries['fullmag']), 'runtime', 'verify-saved-fem-snapshot',
                                '--store', str(store_root), '--source', str(pinned_path),
                                '--source-artifact-id', artifact_id], cwd=repo_root, env=env,
                               log_path=run_root / 'saved-fem-integrity.log', timeout=90,
                               evidence=evidence, checkpoint=checkpoint)
    evidence['native_snapshot_receipt'] = check_integrity_result(verified, pinned, artifact_id)
    evidence['pinned_source'] = pinned
    evidence['pinned_source_path'] = str(pinned_path)
    evidence['source_artifact_id'] = artifact_id
    evidence['store_root'] = str(store_root)
    return evidence
