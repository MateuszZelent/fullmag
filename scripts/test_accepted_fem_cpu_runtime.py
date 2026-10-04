"""Interpreted FEM verifier regression fixtures, never solver qualification."""
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import accepted_fem_cpu_runtime as runtime


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding='utf-8')


def metadata():
    execution = {'backend': 'fem', 'device': 'cpu', 'precision': 'double', 'mode': 'strict'}
    return {'execution_provenance': {'execution_engine': 'fem_cpu_native', 'execution_resolution': {
        'authored_request': dict(execution), 'effective_request': dict(execution), 'resolved_execution': dict(execution),
        'resolution_mode': 'exact', 'fallback_occurred': False, 'fallback_reason': None}}}


def test_accept_exact_native_cpu_metadata():
    assert runtime.validate_execution(metadata())['execution_engine'] == 'fem_cpu_native'


@pytest.mark.parametrize('key,value', [('backend', 'fdm'), ('device', 'gpu'),
                                     ('precision', 'single'), ('mode', 'auto')])
@pytest.mark.parametrize('side', ['authored_request', 'effective_request', 'resolved_execution'])
def test_reject_changed_execution_lane(key, value, side):
    record = metadata()
    record['execution_provenance']['execution_resolution'][side][key] = value
    with pytest.raises(ValueError):
        runtime.validate_execution(record)


@pytest.mark.parametrize('key,value', [('resolution_mode', 'auto'), ('fallback_occurred', True),
                                     ('fallback_reason', 'cpu fallback')])
def test_reject_fallback(key, value):
    record = metadata()
    record['execution_provenance']['execution_resolution'][key] = value
    with pytest.raises(ValueError):
        runtime.validate_execution(record)


def accepted():
    return {'id': {'run_id': 'run-fixture', 'stage_id': 'step:run', 'accepted_step': 1},
            'generation': {'runtime_epoch': 7}}


def completed_fixture(root):
    state = accepted()
    lease = {'resource_id': 'host.cpu', 'lease_token': 'token-fixture', 'run_id': 'run-fixture',
             'attempt_id': 'attempt-fixture'}
    receipt = {'schema_version': 'fullmag.accepted_worker_execution.v1',
               'status': 'completed', 'completed_step_count': 1, 'accepted_state_ref': state,
               'identity': {'schema_version': 'fullmag.accepted_worker_execution.v1', 'case_id': 'case-fixture',
                'start_message_id': 'start-fixture', 'start_sequence': 2, 'plan_fingerprint': 'a' * 64,
                'claim': {'run_id': 'run-fixture', 'attempt_id': 'attempt-fixture',
                'task_id': 'task-fixture', 'ownership_epoch': 7, 'lease': lease}}, 'outputs': []}
    for port, kind, codec in [('final_state', 'state', 'fullmag.runner.field_json'),
                              ('total_energy', 'scalar', 'fullmag.study.scalar_json')]:
        raw = json.dumps({'schema_version': 'study_scalar.v1', 'quantity_id': 'E_total', 'unit': 'J',
                          'value_si': 1e-20, 'time_s': 1e-12, 'step': 1} if port == 'total_energy'
                         else {'fixture': port}).encode()
        digest = hashlib.sha256(raw).hexdigest()
        path = root / 'objects/sha256' / digest
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
        receipt['outputs'].append({'port_id': port, 'case_id': 'case-fixture', 'data_kind': kind,
                                  'codec_id': codec, 'codec_version': 'v1', 'object_ref': digest,
                                  'byte_count': len(raw)})
    attempt = root / 'runs/run-fixture/worker-attempts/attempt-fixture'
    write_json(attempt / 'worker_execution_completed.v1.json', receipt)
    write_json(attempt / 'worker_execution_started.v1.json', {'identity': receipt['identity']})
    claim = {key: receipt['identity']['claim'][key] for key in ('run_id', 'task_id', 'attempt_id', 'ownership_epoch')}
    claim['lease_token'] = lease['lease_token']
    write_json(root / 'runs/run-fixture/coordinator_journal/command/2.json',
               {'payload': {'message': {'envelope': {'command': {'kind': 'start'}, 'claim': claim,
                                                    'message_id': 'start-fixture', 'sequence': 2}}}})
    return attempt, receipt, state, lease


def test_verify_real_fixture_cas_hashes(tmp_path):
    attempt, receipt, state, lease = completed_fixture(tmp_path)
    assert runtime.validate_completed_outputs(tmp_path, attempt, state, 'task-fixture', lease) == receipt


@pytest.mark.parametrize('case', ['cas_bytes', 'missing_output', 'codec', 'case', 'epoch', 'lease', 'accepted', 'steps'])
def test_reject_inconsistent_completed_output(tmp_path, case):
    attempt, receipt, state, lease = completed_fixture(tmp_path)
    expected_lease = copy.deepcopy(lease)
    if case == 'cas_bytes':
        (tmp_path / 'objects/sha256' / receipt['outputs'][0]['object_ref']).write_bytes(b'corrupt')
    elif case == 'missing_output':
        receipt['outputs'].pop()
    elif case in ('codec', 'case'):
        receipt['outputs'][0]['codec_id' if case == 'codec' else 'case_id'] = 'foreign'
    elif case == 'epoch':
        receipt['identity']['claim']['ownership_epoch'] = 8
    elif case == 'lease':
        receipt['identity']['claim']['lease']['lease_token'] = 'foreign'
    elif case == 'steps':
        receipt['completed_step_count'] = 0
    else:
        receipt['accepted_state_ref']['id']['run_id'] = 'foreign'
        state = accepted()
    write_json(attempt / 'worker_execution_completed.v1.json', receipt)
    with pytest.raises(ValueError):
        runtime.validate_completed_outputs(tmp_path, attempt, state, 'task-fixture', expected_lease)


def public_fixture():
    owner = {'project_id': 'project-fixture', 'run_id': 'run-fixture', 'solution_set_id': 'solution',
             'revision': '9007199254740993', 'manifest_digest': 'sha256:' + 'a' * 64}
    member = {'member_id': 'member', 'task_id': 'task-fixture', 'stage_id': 'step:run',
              'attempt_id': 'attempt-fixture', 'case_id': 'case-fixture',
              'ownership_epoch': '7', 'execution_status': 'succeeded'}
    state = {'artifact_id': 'field', 'object_ref': 'b' * 64, 'kind': 'state', 'byte_length': '10',
             'schema_id': 'fullmag.runner.field_json@v1', 'accepted_state': dict(accepted()['id'], accepted_step='1')}
    energy = {'artifact_id': 'energy', 'object_ref': 'e' * 64, 'kind': 'table', 'byte_length': '20',
              'schema_id': 'fullmag.study.scalar_json@v1', 'accepted_state': None}
    materialized = {'artifact_id': 'dataset', 'schema_id': 'fullmag.materialized_dataset.v1'}
    source = {'run_id': 'run-fixture', 'solution_set_id': 'solution', 'member_id': 'member',
              'solution_revision': owner['revision'], 'artifact_id': 'tensor', 'tensor_object_ref': 'c' * 64,
              'run_spec_digest': 'sha256:' + 'd' * 64}
    docs = [dict(project_id='project-fixture', run_id='run-fixture', items=[
                  {'solution_set_id': 'solution', 'revision': owner['revision'],
                   'manifest_digest': owner['manifest_digest']}], next_cursor=None),
            dict(owner, items=[member], next_after_member_id=None),
            dict(owner, member_id='member', items=[state, energy, materialized], next_after_artifact_id=None),
            {'integrity': 'verified', 'project_id': 'project-fixture', 'run_id': 'run-fixture', 'source': source,
             'solution_set_id': 'solution', 'member_id': 'member', 'containing_solution_revision': owner['revision'],
             'artifact_id': 'dataset'}]
    return docs, {'identity': {'claim': {'attempt_id': 'attempt-fixture'}, 'case_id': 'case-fixture'},
                 'outputs': [{'port_id': 'final_state', 'object_ref': 'b' * 64,
                               'codec_id': 'fullmag.runner.field_json', 'codec_version': 'v1', 'byte_count': 10},
                              {'port_id': 'total_energy', 'object_ref': 'e' * 64,
                               'codec_id': 'fullmag.study.scalar_json', 'codec_version': 'v1', 'byte_count': 20}]}


def test_public_pin_preserves_u64_revision(monkeypatch):
    docs, completed = public_fixture()
    monkeypatch.setattr(runtime, 'get_resource', lambda *args: docs.pop(0))
    pinned, artifact, _ = runtime.saved_source('http://fixture', 'project-fixture', 'run-fixture',
                                              'task-fixture', accepted(), completed)
    assert pinned['solution_revision'] == 9007199254740993
    assert artifact == 'field'


@pytest.mark.parametrize('case', ['discovery_owner', 'member_owner', 'artifact_digest', 'task', 'epoch',
                                 'state_cas', 'dataset_integrity', 'source_owner', 'revision_overflow',
                                 'missing_energy', 'energy_codec', 'energy_length', 'energy_state'])
def test_reject_foreign_public_result(monkeypatch, case):
    docs, completed = public_fixture()
    if case == 'discovery_owner':
        docs[0]['run_id'] = 'foreign'
    elif case == 'member_owner':
        docs[1]['project_id'] = 'foreign'
    elif case == 'artifact_digest':
        docs[2]['manifest_digest'] = 'foreign'
    elif case in ('task', 'epoch'):
        docs[1]['items'][0]['task_id' if case == 'task' else 'ownership_epoch'] = 'foreign'
    elif case == 'state_cas':
        docs[2]['items'][0]['object_ref'] = 'foreign'
    elif case == 'dataset_integrity':
        docs[3]['integrity'] = 'not_verified'
    elif case == 'source_owner':
        docs[3]['source']['member_id'] = 'foreign'
    elif case == 'missing_energy':
        docs[2]['items'].pop(1)
    elif case in ('energy_codec', 'energy_length', 'energy_state'):
        key = {'energy_codec': 'schema_id', 'energy_length': 'byte_length', 'energy_state': 'accepted_state'}[case]
        docs[2]['items'][1][key] = 'foreign'
    else:
        docs[3]['source']['solution_revision'] = str(2**64)
    monkeypatch.setattr(runtime, 'get_resource', lambda *args: docs.pop(0))
    with pytest.raises(ValueError):
        runtime.saved_source('http://fixture', 'project-fixture', 'run-fixture',
                             'task-fixture', accepted(), completed)


def test_observation_timeout_retains_process_and_receipt(tmp_path, monkeypatch):
    class Process:
        pid = 123
        def wait(self, timeout):
            raise subprocess.TimeoutExpired('fixture-process', timeout)
    monkeypatch.setattr(runtime, 'subprocess', SimpleNamespace(Popen=lambda *args, **kwargs: Process(),
                                                              TimeoutExpired=subprocess.TimeoutExpired))
    evidence, checkpoints = {}, []
    with pytest.raises(ValueError, match='process retained pid=123'):
        runtime.run_process(['nonexecuted-fixture'], cwd=tmp_path, env={}, log_path=tmp_path / 'process.log',
                            timeout=1, evidence=evidence, checkpoint=lambda: checkpoints.append(copy.deepcopy(evidence)))
    assert evidence['commands'][0]['state'] == 'observation_timeout_process_retained'
    assert checkpoints[-1] == evidence


@pytest.mark.parametrize('case', ['schema', 'task', 'attempt', 'epoch', 'alias', 'bytes', 'ready'])
def test_lease_identity_and_filename_are_one_fenced_owner(tmp_path, case):
    execution = {'attempt_id': 'attempt-fixture', 'ownership_epoch': 7, 'resource_id': 'host.cpu'}
    lease = dict(execution, schema_version='resource_lease.v1', run_id='run-fixture', task_id='task-fixture',
                 lease_token='token-fixture')
    if case in ('schema', 'task', 'attempt', 'epoch'):
        key = {'schema': 'schema_version', 'task': 'task_id', 'attempt': 'attempt_id', 'epoch': 'ownership_epoch'}[case]
        lease[key] = 'foreign'
    path = tmp_path / 'runs/run-fixture/resource_leases/host.cpu' / (
        'foreign-token.json' if case == 'alias' else 'token-fixture.json')
    write_json(path, lease)
    lease.update(path=str(path), sha256=runtime.artifact_sha256(path))
    if case == 'bytes':
        path.write_text('{}', encoding='utf-8')
    if case == 'ready':
        runtime.validate_lease(lease, tmp_path, 'run-fixture', 'task-fixture', execution)
    else:
        with pytest.raises(ValueError):
            runtime.validate_lease(lease, tmp_path, 'run-fixture', 'task-fixture', execution)


@pytest.mark.parametrize('case', ['start_id', 'start_sequence', 'schema', 'attempt'])
def test_receipt_cannot_be_spliced_from_another_start(tmp_path, case):
    attempt, receipt, state, lease = completed_fixture(tmp_path)
    lease = copy.deepcopy(lease)
    if case == 'attempt':
        receipt['identity']['claim']['attempt_id'] = 'foreign'
    else:
        key = {'start_id': 'start_message_id', 'start_sequence': 'start_sequence', 'schema': 'schema_version'}[case]
        receipt['identity'][key] = 3 if case == 'start_sequence' else 'foreign'
    write_json(attempt / 'worker_execution_completed.v1.json', receipt)
    write_json(attempt / 'worker_execution_started.v1.json', {'identity': receipt['identity']})
    with pytest.raises(ValueError):
        runtime.validate_completed_outputs(tmp_path, attempt, state, 'task-fixture', lease)


@pytest.mark.parametrize('case', ['unit', 'value', 'clock'])
def test_scalar_is_decoded_after_valid_cas_hash(tmp_path, case):
    attempt, receipt, state, lease = completed_fixture(tmp_path)
    output = receipt['outputs'][1]
    path = tmp_path / 'objects/sha256' / output['object_ref']
    scalar = json.loads(path.read_text(encoding='utf-8'))
    scalar[{'unit': 'unit', 'value': 'value_si', 'clock': 'step'}[case]] = {
        'unit': 'eV', 'value': float('nan'), 'clock': 2}[case]
    raw = json.dumps(scalar).encode()
    digest = hashlib.sha256(raw).hexdigest()
    (path.parent / digest).write_bytes(raw)
    output.update(object_ref=digest, byte_count=len(raw))
    write_json(attempt / 'worker_execution_completed.v1.json', receipt)
    with pytest.raises(ValueError, match='total_energy scalar'):
        runtime.validate_completed_outputs(tmp_path, attempt, state, 'task-fixture', lease)


def test_native_plan_hash_preserves_serde_exponent_spelling(tmp_path):
    path = tmp_path / 'metadata.json'
    path.write_text('{"plan": {"z": 1.0, "a": 1e-9}}', encoding='utf-8')
    assert runtime.native_plan_digest(path, tmp_path) == hashlib.sha256(b'{"a":1e-9,"z":1.0}').hexdigest()


@pytest.mark.parametrize('raw', ['{"plan":{"x":1,"x":2}}', '{"plan":{"x":NaN}}', '{"not_plan":1}'])
def test_reject_ambiguous_native_plan_json(tmp_path, raw):
    path = tmp_path / 'metadata.json'
    path.write_text(raw, encoding='utf-8')
    with pytest.raises(ValueError):
        runtime.native_plan_digest(path, tmp_path)


@pytest.mark.parametrize('exit_code', [0, 2])
def test_real_interpreter_process_keeps_terminal_logs(tmp_path, exit_code):
    evidence, checkpoints = {}, []
    command = [sys.executable, '-I', '-c',
               'print("{\\\"fixture\\\": true}"); raise SystemExit(' + str(exit_code) + ')']
    call = lambda: runtime.run_process(command, cwd=tmp_path, env={}, log_path=tmp_path / 'process.log',
                                      timeout=10, evidence=evidence,
                                      checkpoint=lambda: checkpoints.append(copy.deepcopy(evidence)))
    if exit_code:
        with pytest.raises(ValueError, match='process failed'):
            call()
    else:
        assert call() == {'fixture': True}
    record = evidence['commands'][0]
    assert record['state'] == 'terminal' and record['exit_code'] == exit_code
    assert Path(record['stdout']).is_file() and Path(record['stderr']).is_file()
    assert record['stdout_sha256'] == runtime.artifact_sha256(Path(record['stdout']))
    assert checkpoints[-1] == evidence
