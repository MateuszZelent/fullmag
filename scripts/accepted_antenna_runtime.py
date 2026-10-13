"""No-build continuation of a prepared antenna task through its real worker.

The managed caller owns package/image verification, an isolated RAM store,
canonical Submit/preparation and the pinned tools manifest. This gate neither
manufactures publication records nor qualifies closed-circuit physics or LLG.
"""
import re
from urllib.parse import quote

from accepted_fem_cpu_runtime import read_json, require, run_process, validate_lease
from local_runner.build_executor import artifact_sha256
from smoke_accepted_antenna_inspection import verify
from verify_project_api_runtime import terminate_process, wait_for_health
from verify_resource_discovery_runtime import (
    durable_leases, start_api, validate_publisher, worker_control_evidence,
)


def validate_worker_publication(started, completed, owner, lease, start_commands):
    """Bind the HTTP publication to one completed, nonmagnetic worker attempt."""
    schema = 'fullmag.accepted_worker_execution.v1'
    identity = completed.get('identity', {})
    require(completed.get('schema_version') == schema and identity.get('schema_version') == schema
            and started.get('identity') == identity, 'Antenna Start/completed identity mismatch')
    claim = identity.get('claim', {})
    for key in ('run_id', 'task_id', 'attempt_id', 'ownership_epoch'):
        require(claim.get(key) == owner[key] == lease.get(key), 'Antenna worker ownership mismatch: ' + key)
    require(identity.get('case_id') == owner['case_id']
            and isinstance(identity.get('plan_fingerprint'), str)
            and re.fullmatch('[a-f0-9]{64}', identity['plan_fingerprint'])
            and isinstance(identity.get('start_message_id'), str) and bool(identity['start_message_id'])
            and type(identity.get('start_sequence')) is int and identity['start_sequence'] > 0,
            'Antenna worker omits its case, plan or Start command identity')
    resource = claim.get('lease', {})
    require(resource.get('resource_id') == lease.get('resource_id')
            and resource.get('lease_token') == lease.get('lease_token')
            and resource.get('kind') == lease.get('kind') == 'cpu'
            and resource.get('budget') == lease.get('budget')
            and resource.get('budget', {}).get('gpu_memory_bytes') == 0,
            'Antenna worker differs from its CPU resource lease')
    fenced_claim = {key: owner[key] for key in ('run_id', 'task_id', 'attempt_id', 'ownership_epoch')}
    fenced_claim['lease_token'] = lease['lease_token']
    require(len(start_commands) == 1
            and start_commands[0].get('command', {}).get('kind') == 'start'
            and start_commands[0].get('claim') == fenced_claim
            and start_commands[0].get('message_id') == identity['start_message_id']
            and start_commands[0].get('sequence') == identity['start_sequence'],
            'Antenna receipt is not bound to the exact journal Start command')
    require(completed.get('status') == 'completed'
            and type(completed.get('completed_step_count')) is int
            and completed['completed_step_count'] == 1
            and completed.get('accepted_state_ref') is None
            and completed.get('observation_source') is None,
            'Antenna receipt is incomplete or contains a magnetic observation/state')
    outputs = completed.get('outputs', [])
    require(isinstance(outputs, list) and len(outputs) == 1 and isinstance(outputs[0], dict),
            'Antenna worker must publish exactly one inspection output')
    output = outputs[0]
    require(all(output.get(key) == value for key, value in {
        'port_id': 'inspection', 'data_kind': 'artifact',
        'codec_id': 'fullmag.antenna.inspection_package', 'codec_version': 'v1',
        'case_id': owner['case_id'], 'object_ref': owner['package_object_ref'],
    }.items()), 'Antenna output differs from its published package or codec')
    require(type(output.get('byte_count')) is int and 0 < output['byte_count']
            <= resource.get('budget', {}).get('storage_bytes', 0),
            'Antenna package exceeds the admitted storage budget')
    return output


def execute(binaries, repo_root, env, run_root, store_root, fixture, request,
            task_id, native_stage_id, evidence, checkpoint):
    """Run the production scheduler once; never retry after an observation timeout."""
    run_id, project_id = fixture['run_id'], fixture['project_id']
    require(len(request['study_plan']['steps']) == 1
            and request['study_plan']['steps'][0].get('enabled') is True,
            'Antenna gate requires one explicit enabled Study step')
    pool_id = 'antenna-cpu-' + run_root.name
    pool = run_process([
        str(binaries['fullmag-api-resource-pool']), '--store-root', str(store_root),
        '--pool-id', pool_id, '--expected-generation', '0', '--discover-local', 'true',
        '--host-resource-id', pool_id, '--include-cpu', 'true', '--require-gpu', 'false',
        '--cpu-reserve-millis', '1000', '--memory-reserve-bytes', '536870912',
        '--storage-reserve-bytes', '536870912'], cwd=repo_root, env=env,
        log_path=run_root / 'antenna-resource-pool.log', timeout=30, evidence=evidence, checkpoint=checkpoint)
    offer = validate_publisher(pool, request['run_intent']['specification']['requested_execution']['minimum_resources'])
    evidence['resource_pool'] = pool
    scheduler = run_process([
        str(binaries['fullmag-api-accepted-scheduler']), '--store-root', str(store_root),
        '--run-id', run_id, '--pool-id', pool_id, '--resident', 'true', '--discover-resources', 'true',
        '--worker-executable', str(binaries['fullmag-api-accepted-worker']), '--max-concurrency', '1',
        '--max-queued-runs', '1', '--max-tasks', '1', '--max-idle-polls', '0',
        '--idle-poll-milliseconds', '20', '--worker-timeout-seconds', '300',
        '--heartbeat-interval-milliseconds', '250', '--max-automatic-retries', '0'],
        cwd=repo_root, env=env, log_path=run_root / 'antenna-scheduler.log', timeout=360,
        evidence=evidence, checkpoint=checkpoint)
    executed = scheduler.get('executed', [])
    require(scheduler.get('status') == 'completed' and scheduler.get('scheduled_count') == 1
            and len(executed) == 1 and executed[0].get('run_id') == run_id
            and executed[0].get('task_id') == task_id and executed[0].get('worker_timed_out') is False
            and executed[0].get('worker_cancelled') is False and executed[0].get('retry_scheduled') is False
            and executed[0].get('resource_id') == offer['resource_id']
            and executed[0].get('worker', {}).get('status') == 'completed',
            'Antenna scheduler did not complete exactly the admitted task')
    evidence['scheduler'] = scheduler
    leases = durable_leases(store_root, run_id)
    require(len(leases) == 1 and leases[0].get('state') == 'released'
            and leases[0].get('released_at') is not None, 'Antenna worker did not release its lease')
    lease = leases[0]
    validate_lease(lease, store_root, run_id, task_id, executed[0])
    evidence['worker_control'] = worker_control_evidence(store_root, run_id, lease)
    evidence['resource_leases'] = leases
    api, log, base_url = start_api(binaries['fullmag-api'], repo_root, env, run_root / 'api-antenna-result.log')
    try:
        wait_for_health(base_url, api)
        step_id = request['study_plan']['steps'][0]['step_id']
        result = verify(base_url, project_id, run_id, step_id)
        owner = result['owner']
        require(owner['task_id'] == task_id and owner['native_stage_id'] == native_stage_id,
                'Antenna publication differs from the requested task/native stage')
        attempt = store_root / 'runs' / run_id / 'worker-attempts' / task_id / lease['attempt_id'] / (
            'epoch-' + str(lease['ownership_epoch']))
        journal_paths = list((store_root / 'runs' / run_id / 'coordinator_journal/command').glob('*.json'))
        require(0 < len(journal_paths) <= 4096, 'Antenna command journal exceeds the observation bound')
        commands = [read_json(path, store_root, 64 * 1024).get('payload', {}).get('message', {}).get('envelope', {})
                    for path in journal_paths]
        starts = [command for command in commands if command.get('command', {}).get('kind') == 'start']
        output = validate_worker_publication(
            read_json(attempt / 'worker_execution_started.v1.json', store_root),
            read_json(attempt / 'worker_execution_completed.v1.json', store_root), owner, lease, starts)
        package = store_root / 'objects/sha256' / output['object_ref']
        require(package.is_file() and not package.is_symlink()
                and package.stat().st_size == output['byte_count']
                and artifact_sha256(package) == output['object_ref'], 'Antenna worker package CAS mismatch')
        evidence.update(http=result, worker_output=output, physics_qualified=False,
                        durable_session_storage_qualified=False, llg_fft_qualified=False)
        checkpoint()
    finally:
        evidence['api_exit_code'] = terminate_process(api)
        log.close()
    return evidence
