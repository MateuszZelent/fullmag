"""Fixed accepted frozen fixture; shares the existing managed process owner."""
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import quote

STAGES = ('relax_a', 'active_a', 'overlap_ab', 'inactive', 'reactivate_ab')
EXAMPLE = 'examples/scenario_frozen_overlap_m3.py'
VERIFIER = 'scripts/verify_frozen_overlap_artifacts_r1.py'
SCENARIO_SHA = '2f1521916ca00995d2efddaf880f9e7aee4fbe44197e2e00d8326eceeb553fdf'
VERIFIER_SHA = '76dfad659e3698c22ec3de58ec88ca0ddfab19e62a38325f2ceafc8a0354b32e'
DEFAULTS = {'backend': 'fdm', 'device': 'cpu', 'precision': 'double', 'mode': 'strict',
            'resources': {'cpu': {'threads': 2, 'native_threads': 2, 'blas_threads': 1},
                          'ram': {'reservation_bytes': 2 << 30}}}
BUDGET = {'cpu_millis': 2000, 'memory_bytes': 2 << 30, 'gpu_memory_bytes': 0, 'storage_bytes': 512 << 20}


def need(value, message):
    if not value:
        raise ValueError(message)


def verify_tools(repo, source, fixed_bytes):
    required = {EXAMPLE: SCENARIO_SHA, VERIFIER: VERIFIER_SHA,
                'scripts/verify_accepted_frozen_overlap.py': None}
    for relative, pinned in required.items():
        entries = [item for item in source['files'] if item['path'] == relative]
        need(len(entries) == 1, 'Frozen fixture tool missing from this native capsule: ' + relative)
        entry = entries[0]
        need(pinned is None or entry['sha256'] == pinned, 'Frozen immutable fixture bytes differ')
        fixed_bytes(repo / relative, entry['sha256'], 1 << 20)


def validate_inputs(profile, budget, timeout):
    need(profile == {'schema_version': 'execution_profile.v1', 'profile_id': 'exec:e11-frozen-cpu-double',
                     'version': '1', 'description': 'E11 frozen overlap: CPU double Strict, fixed diagnostic input',
                     'defaults': DEFAULTS}, 'Frozen fixture requires its exact published typed CPU profile')
    need(budget == BUDGET and all(type(v) is int for v in budget.values()) and timeout == 300,
         'Frozen fixture requires 2CPU/2GiB/300s and the pinned storage budget')


def accepted_tasks(submitted, run_id):
    tasks = submitted.get('run', {}).get('body', {}).get('tasks', [])
    ids = submitted.get('materialization', {}).get('body', {}).get('task_ids', [])
    need(submitted.get('run_id') == run_id and submitted.get('submit', {}).get('status') == 201
         and len(tasks) == len(ids) == 5 and len(set(ids)) == 5
         and {item['task_id'] for item in tasks} == set(ids), 'Public Submit did not materialize exactly five tasks')
    need(all(re.fullmatch(r'task-[a-f0-9]{64}', item) for item in ids), 'Unsafe task identity')
    return submitted['project_id'], ids


def extract_execution_plan(metadata):
    # This is a field extraction, not the original nested JSON byte slice.
    plan = metadata['execution_plan']
    need(isinstance(plan, dict) and plan.get('backend_plan', {}).get('kind') == 'fdm',
         'Actual runner metadata must contain its inline FDM execution plan')
    raw = (json.dumps(plan, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n').encode('utf-8')
    need(0 < len(raw) <= 16 << 20, 'Extracted actual plan exceeds the control evidence budget')
    return raw


def execute(args, binaries, runtime, env, output, receipt, checkpoint, command,
            store, project, run_id, task_ids, budget, invocation):
    # Import the shared process owner only after its capsule closure was verified.
    import verify_accepted_closed_loop_runtime as owner
    from launch_accepted_closed_loop_runtime import bounded_bytes, parse_json, path_checked
    from accepted_fem_cpu_runtime import validate_lease
    from verify_resource_discovery_runtime import durable_leases
    from verify_project_api_runtime import terminate_process, wait_for_health

    def document(path, maximum=16 << 20):
        path = path_checked(path)
        need(path.is_relative_to(store), 'Evidence path escaped the accepted store')
        return parse_json(bounded_bytes(path, maximum))

    total = 0
    reads = {}

    def cas(reference, maximum=16 << 20, count=None):
        nonlocal total
        need(isinstance(reference, str) and re.fullmatch('[a-f0-9]{64}', reference), 'Invalid CAS reference')
        path = store / 'objects/sha256' / reference
        raw = bounded_bytes(path, maximum)
        need(hashlib.sha256(raw).hexdigest() == reference and (count is None or len(raw) == count),
             'Published CAS SHA/count mismatch')
        if reference not in reads:
            total += len(raw)
            need(total <= 256 << 20 and len(reads) < 4096, 'Frozen fixture aggregate CAS read budget')
            reads[reference] = {'path': str(path), 'sha256': reference, 'byte_count': len(raw)}
        return raw

    intent = document(store / 'runs' / run_id / 'run_intent.json')
    source = parse_json(cas(intent['asset_object_refs']['script-pipeline-source']))
    need(source['schema_version'] == 'script_pipeline_source.v1', 'Unexpected accepted script source')
    executions = source['executions']
    need([item['authored_step_id'] for item in executions] == list(STAGES)
         and all(item['expansion_index'] == 0 for item in executions), 'Actual source lost five ordered physical stages')
    bindings = []
    for item in executions:
        stage = item['authored_step_id']
        execution = item['execution_id']
        task = 'task-' + hashlib.sha256((run_id + '\0' + execution).encode()).hexdigest()
        need(task in task_ids, 'Actual accepted execution/task binding differs')
        bindings.append({'stage_id': stage, 'execution_id': execution, 'task_id': task,
                         'actual_execution_plan': None, 'plan_gate': 'PENDING_ACTUAL_RUNNER_METADATA'})
    receipt.update(fixture='frozen-overlap-m3', preregistered_worker_timeout_seconds=300,
                   scenario_sha256=SCENARIO_SHA, verifier_r1_sha256=VERIFIER_SHA,
                   physical_profile=DEFAULTS, publication='five_real_accepted_physical_tasks', stage_bindings=bindings)
    checkpoint()
    solve = command([str(binaries['fullmag-api-accepted-scheduler']), '--store-root', str(store), '--run-id', run_id,
        '--resource-id', 'e11-cpu-' + invocation, '--resource-kind', 'cpu', '--cpu-millis', '2000',
        '--memory-bytes', str(2 << 30), '--gpu-memory-bytes', '0', '--storage-bytes', str(budget['storage_bytes']),
        '--worker-executable', str(binaries['fullmag-api-accepted-worker']), '--max-concurrency', '1', '--max-tasks', '5',
        '--worker-timeout-seconds', '300', '--heartbeat-interval-milliseconds', '250',
        '--max-automatic-retries', '0'], 'frozen-solve', 5 * 300 + 60)
    executions = solve.get('executed', [])
    need(solve.get('scheduled_count') == len(executions) == 5
         and [item.get('task_id') for item in executions] == [item['task_id'] for item in bindings],
         'Actual scheduler did not execute the five authored dependencies in order')
    for execution in executions:
        need(execution.get('run_id') == run_id and execution.get('worker_timed_out') is False
             and execution.get('worker_cancelled') is False and execution.get('retry_scheduled') is False
             and execution.get('worker', {}).get('status') == 'completed', 'Actual accepted worker did not complete')
    receipt['solver'] = solve
    leases = durable_leases(store, run_id)
    need(len(leases) == 5 and all(item.get('state') == 'released' and item.get('released_at') for item in leases),
         'All five actual resource leases must be durably Released')
    plan_root = output / 'actual-execution-plans'
    plan_root.mkdir()
    for binding, execution in zip(bindings, executions):
        matches = [item for item in leases if item['task_id'] == binding['task_id']]
        need(len(matches) == 1, 'Each task requires one Released lease, without automatic retry')
        validate_lease(matches[0], store, run_id, binding['task_id'], execution)
        binding.update(attempt_id=execution['attempt_id'], ownership_epoch=execution['ownership_epoch'])
        attempt = store / 'runs' / run_id / 'worker-attempts' / binding['task_id'] / execution['attempt_id'] / ('epoch-' + str(execution['ownership_epoch']))
        completed = document(attempt / 'worker_execution_completed.v1.json')
        need(completed['status'] == 'completed', 'Missing completed receipt')
        binding.update(actual_artifact_root=str(attempt), completed_receipt_sha256=hashlib.sha256(bounded_bytes(attempt / 'worker_execution_completed.v1.json', 16 << 20)).hexdigest())
        metadata_path = attempt / 'metadata.json'
        metadata_raw = bounded_bytes(metadata_path, 16 << 20)
        metadata = parse_json(metadata_raw)
        need(metadata['problem_meta']['runtime_metadata']['active_stage_id'] == binding['stage_id'],
             'Actual runner metadata has another authored stage owner')
        plan_raw = extract_execution_plan(metadata)
        plan_path = plan_root / (binding['stage_id'] + '.json')
        with plan_path.open('xb') as target:
            target.write(plan_raw)
        binding.update(actual_execution_plan={'path': str(plan_path), 'sha256': hashlib.sha256(plan_raw).hexdigest(),
                        'byte_count': len(plan_raw), 'source_field': 'execution_plan',
                        'source_metadata_path': str(metadata_path), 'source_metadata_sha256': hashlib.sha256(metadata_raw).hexdigest(),
                        'source_metadata_byte_count': len(metadata_raw), 'encoding': 'derived JSON field extraction; not original nested byte identity'},
                       plan_gate='ACTUAL_RUNNER_METADATA_CAPTURED')
    receipt['released_leases'] = leases
    catalog = document(store / 'runs' / run_id / 'artifact_catalog.json')
    need(len(catalog['entries']) <= 4096, 'Artifact catalog inventory bound')
    required_public_refs = set()
    for index, binding in enumerate(bindings):
        owned = [entry for entry in catalog['entries'] if entry['task_id'] == binding['task_id']
                 and entry['attempt_id'] == binding['attempt_id'] and entry['ownership_epoch'] == binding['ownership_epoch']]
        by_id = {entry['artifact_id']: entry for entry in owned}
        need(len(by_id) == len(owned), 'Duplicate owned artifact identity')
        manifests = [entry for entry in owned if entry['artifact_type'] == 'study_output_manifest']
        need(len(manifests) == 1, 'One actual manifest is required per stage')
        def published(edge, maximum=16 << 20):
            entry = by_id[edge['artifact_id']]
            reference = edge['object_ref']
            need(entry['status'] == 'published' and entry['content_sha256'] == entry['object_ref'] == reference
                 and edge.get('content_sha256', reference) == reference, 'Published artifact/catalog ownership differs')
            return cas(reference, maximum, edge.get('byte_count'))
        manifest = parse_json(published(manifests[0]))
        required_public_refs.add(manifests[0]['object_ref'])
        need(manifest['schema_version'] == 'study_output_manifest.v' + ('3' if index == 0 else '4')
             and all(manifest[key] == binding[key] for key in ('task_id', 'attempt_id', 'ownership_epoch'))
             and manifest['run_id'] == run_id and manifest['step_id'] == binding['execution_id'], 'Manifest owner/version differs')
        states = [item for item in manifest['outputs'] if item['port_id'] == 'final_state' and item['case_id'] == 'default']
        need(len(states) == 1 and states[0]['codec_id'] == 'fullmag.runner.frozen_state_json'
             and states[0]['codec_version'] == 'v1', 'Missing explicit frozen final State codec')
        published(states[0], 64 << 20)
        required_public_refs.add(states[0]['object_ref'])
        binding.update(manifest_object_ref=manifests[0]['object_ref'], final_envelope_path=reads[states[0]['object_ref']]['path'],
                       accepted_state_ref=manifest.get('accepted_state_ref'))
        if index:
            observation = manifest['observation_source']
            need(manifest['publication_kind'] == 'completed' and manifest['historical_prefix'] is None
                 and observation['accepted_state_ref'] == manifest['accepted_state_ref']
                 and observation['schema_version'] == 'observation_source.v2', 'Terminal V4 accepted identity differs')
            carriers = observation['primary_carriers']
            need(len(carriers) == 4 and len({item['carrier_id'] for item in carriers}) == 4, 'Four actual primary carriers required')
            for carrier in carriers:
                need(carrier['preimage_sha256'] == carrier['object_ref'], 'Primary preimage differs from CAS')
                published(carrier, 64 << 20)
                required_public_refs.add(carrier['object_ref'])
            for stem in ('snapshot', 'state'):
                published({'artifact_id': observation[stem + '_artifact_id'], 'object_ref': observation[stem + '_object_ref']}, 64 << 20)
            need(manifest['coverage']['final_sample_committed'] and manifest['histories'], 'V4 history coverage missing')
            for edge in manifest['histories']:
                history = parse_json(published(edge, 4 << 20))
                need(len(history['pages']) <= 64, 'Preregistered tiny history page budget')
                for page_edge in history['pages']:
                    page = parse_json(published(page_edge, 4 << 20))
                    need(0 < len(page['samples']) <= 1024, 'Preregistered tiny history sample budget')
                    for sample in page['samples']:
                        published(sample, 4 << 20)
    receipt['cas_raw_evidence'] = reads
    need(len(bindings) == 5 and all(item['actual_execution_plan'] for item in bindings),
         'R1 requires all five actual materialized runner plans')
    r1_root = output / 'r1-artifact-relations'
    r1_root.mkdir()
    r1 = r1_root / 'verify_actual_artifacts.py'
    r1.write_bytes(owner.fixed_bytes(Path(args.repo_root) / VERIFIER, VERIFIER_SHA, 1 << 20))
    argv = [args.python, '-I', '-B', str(r1)]
    for binding in bindings:
        argv += ['--stage', binding['stage_id'] + '=' + binding['actual_artifact_root'],
                 '--plan', binding['stage_id'] + '=' + binding['actual_execution_plan']['path'],
                 '--envelope', binding['stage_id'] + '=' + binding['final_envelope_path']]
    receipt['r1_actual_artifact_relations'] = command(argv, 'frozen-r1-artifact-relations', 90)
    prefix = '/v2/persistence/projects/' + quote(project, safe='') + '/runs'
    public_reads = []
    # A new API process proves metadata discovery from durable bytes, not full raw4 cold admission.
    for cold_index in range(2):
        api = log = None
        try:
            api, log, base = owner.start_api(binaries['fullmag-api'], runtime, env,
                output / ('frozen-cold-metadata-' + str(cold_index) + '.log'), receipt, checkpoint, port=8087)
            wait_for_health(base, api)
            listing = owner.get_resource(base, prefix + '?limit=100')
            need(any(item['run_id'] == run_id for item in listing['runs']), 'Actual list-runs lost the accepted run')
            current = owner.get_resource(base, prefix + '/' + quote(run_id, safe=''))
            tasks = {item['task_id']: item for item in current['tasks']}
            need(len(tasks) == 5, 'Public GET run task inventory differs')
            for binding in bindings:
                task = tasks[binding['task_id']]
                need(task['lifecycle'] == 'succeeded' and task['attempt_id'] == binding['attempt_id']
                     and task['ownership_epoch'] == binding['ownership_epoch']
                     and task.get('accepted_state_ref') == binding['accepted_state_ref'], 'Public accepted_state_ref differs from manifest')
            solutions = owner.get_resource(base, prefix + '/' + quote(run_id, safe='') + '/solution-sets?limit=100')
            need(len(solutions['items']) == 5 and solutions.get('next_cursor') is None,
                 'Five actual task SolutionSets required')
            members_evidence = []
            public_refs = set()
            by_task = {item['task_id']: item for item in bindings}
            for solution in solutions['items']:
                revision = solution['revision']
                need(isinstance(revision, str) and re.fullmatch('[1-9][0-9]*', revision), 'Canonical solution revision required')
                route = prefix + '/' + quote(run_id, safe='') + '/solution-sets/' + quote(solution['solution_set_id'], safe='') + '/revisions/' + revision
                members = owner.get_resource(base, route + '/members?limit=100')
                need(0 < len(members['items']) <= 2 and members.get('next_after_member_id') is None
                     and members['manifest_digest'] == solution['manifest_digest'], 'Bounded actual solution members required')
                for member in members['items']:
                    binding = by_task[member['task_id']]
                    need(member['stage_id'] == binding['execution_id'] and member['attempt_id'] == binding['attempt_id']
                         and member['ownership_epoch'] == str(binding['ownership_epoch'])
                         and member['execution_status'] == 'succeeded', 'Public SolutionSet ownership differs')
                    artifacts = owner.get_resource(base, route + '/members/' + quote(member['member_id'], safe='') + '/artifacts?limit=100')
                    need(artifacts.get('next_after_artifact_id') is None
                         and artifacts['manifest_digest'] == solution['manifest_digest'], 'Public artifact page exceeded bound')
                    public_refs.update(item['object_ref'] for item in artifacts['items'])
                    members_evidence.append({'member': member, 'artifacts': artifacts})
            need(required_public_refs <= public_refs, 'Public SolutionSet inventory lost manifest, final envelope or raw4')
            public_reads.append({'list': listing, 'run': current, 'solutions': solutions, 'members': members_evidence})
        finally:
            if api is not None:
                need(terminate_process(api) is not None, 'Owned cold metadata API did not exit')
            if log is not None:
                owner.close_api_log(log)
    need(public_reads[0] == public_reads[1], 'Cold metadata reads changed the durable run projection')
    need(document(store / 'WRITER.owner.json')['released'] is True, 'Native writer ownership must be released')
    for reference, record in reads.items():
        need(hashlib.sha256(bounded_bytes(Path(record['path']), 64 << 20)).hexdigest() == reference,
             'Published CAS bytes changed across cold metadata reads')
    for binding in bindings:
        plan = binding['actual_execution_plan']
        need(hashlib.sha256(bounded_bytes(Path(plan['source_metadata_path']), 16 << 20)).hexdigest() == plan['source_metadata_sha256']
             and hashlib.sha256(bounded_bytes(Path(plan['path']), 16 << 20)).hexdigest() == plan['sha256'],
             'Actual runner metadata/extracted plan changed across verification')
    receipt.update(status='evidence_collected_gates_open', public_cold_metadata=public_reads,
        runtime_verified=False, scientific_qualification='not_verified',
        open_gates=['BLOCKED_PUBLIC_FDM_COLD_ACCEPTED_CONTEXT_ROUTE',
                    'RAM_COLD_DECODE_NOT_RUN_DURABLE_METADATA_IS_NOT_DECODE',
                    'EXACT_RESUME_UNSUPPORTED_UNCHANGED'])
    checkpoint()
