#!/usr/bin/env python3
"""Preview/apply reconciliation of one completed, retained claimed Rust check.

This never starts tests/builds, signals a process, releases scientific claims,
or removes an active marker. Only the original authenticated lease helper may
release its own operation after durable terminal publication.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import time
import uuid

from docker_build_control import BuildControl, BuildControlError, canonical, docker_capture
from docker_compose_identity import source_labels
from docker_volume_reconcile import read_raw, fingerprint
import docker_claimed_runtime_checks as checks

SCHEMA = 'fullmag.claimed-checks-reconciliation.v1'
PHASE = 'claimed-runtime-checks'
TOKEN = re.compile(r'[0-9a-f]{32}\Z')
SHA = re.compile(r'[0-9a-f]{64}\Z')
REQUEST_KEYS = {'schema', 'attempt', 'request_id', 'inputs', 'receipt_sha256',
                'result_sha256', 'log_sha256', 'helper', 'source_pins',
                'checker_pids', 'observation'}
require = checks.require


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def check_controller(inputs):
    require(inputs.get('controller_sha256') == digest(checks.inside_code().encode()),
            'Original inline controller SHA changed; reconciliation refused')


def require_stable_result(result):
    for stem in ('runtime_evidence', 'workspace_source'):
        require(result.get(stem+'_before_sha256') == result.get(stem+'_after_sha256')
                and isinstance(result.get(stem+'_before_sha256'), str),
                'Original '+stem+' drift refuses finalization')


def is_manager(argv, cwd, source):
    original = source / 'scripts/docker_claimed_runtime_checks.py'
    for token in argv:
        text = os.fsdecode(token)
        if Path(text).name != original.name:
            continue
        candidate = Path(text)
        if not candidate.is_absolute():
            candidate = cwd / candidate
        # Resolve relative invocations using the actual /proc cwd, not text
        # guesses about the shell command that launched the process.
        if candidate.resolve() == original.resolve():
            return True
    return False


def host_inactive(source, *, proc=Path('/proc')):
    """Fail closed on unreadable live process argv; never infer PID absence."""
    count = 0
    try:
        rows = list(proc.iterdir())
        for row in rows:
            if not row.name.isdigit() or int(row.name) == os.getpid():
                continue
            try:
                raw = (row/'cmdline').read_bytes()
                if not raw:  # kernel thread or zombie has no userspace writer
                    continue
                argv = raw.rstrip(b'\0').split(b'\0')
                # cwd is needed only for an exact relative controller token.
                cwd = Path('/')
                if any(Path(os.fsdecode(token)).name == 'docker_claimed_runtime_checks.py'
                       and not Path(os.fsdecode(token)).is_absolute() for token in argv):
                    cwd = (row/'cwd').resolve(strict=True)
                require(not is_manager(argv, cwd, source),
                        'Original or new claimed-check host manager is still alive: '+row.name)
                count += 1
            except FileNotFoundError:
                # /proc exit race: only a vanished process is absence proof.
                require(not row.exists(), 'Live host process evidence disappeared: '+row.name)
    except (OSError, RuntimeError) as error:
        raise BuildControlError('Host manager inactivity cannot be proven: '+str(error)) from error
    return {'state':'no-exact-manager', 'inspected_processes':count}


def helper_pin(control, operation):
    name = operation.get('helper_container')
    require(isinstance(name, str) and bool(name), 'Original helper name missing')
    document = checks.inspect_one('container', name)
    config = document.get('Config', {})
    state = document.get('State', {})
    expected = control.helper_args(control.operation_script(PHASE, operation['attempt']), name=name)
    index = expected.index('--entrypoint')
    labels = {'com.docker.compose.project':control.project,
              'com.docker.compose.service':'build-control', **control.labels, **source_labels(control.identity)}
    require(SHA.fullmatch(document.get('Id', ''))
            and document.get('Name') in (name, '/'+name)
            and document.get('Image') == control.image
            and config.get('Image') == control.image
            and config.get('Entrypoint') == ['/bin/bash']
            and config.get('Cmd') == expected[index+3:]
            and all(config.get('Labels', {}).get(k) == v for k,v in labels.items())
            and state.get('Running') is True and not state.get('Restarting')
            and bool(state.get('StartedAt')), 'Original helper command/image/labels/incarnation differ')
    mounts = document.get('Mounts', [])
    require(len(mounts) == (2 if control.namespace else 1), 'Original helper mounts differ')
    by_destination = {m.get('Destination'):m for m in mounts}
    require(len(by_destination) == len(mounts), 'Duplicate helper mount destination')
    for target, rw in [('/control', True)] + ([('/registry', False)] if control.namespace else []):
        mount = by_destination.get(target, {})
        require(mount.get('Type') == 'volume' and mount.get('Name') == control.volume
                and mount.get('RW') is rw, 'Original helper volume mount differs')
    if control.namespace:
        expected_mounts = [
            {'Type':'volume','Source':control.volume,'Target':'/control',
             'VolumeOptions':{'NoCopy':True,'Subpath':control.namespace}},
            {'Type':'volume','Source':control.volume,'Target':'/registry','ReadOnly':True,
             'VolumeOptions':{'NoCopy':True}},
        ]
        require(document.get('HostConfig', {}).get('Mounts') == expected_mounts,
                'Original helper namespace/control registry mounts differ')
    return {key: document[key] for key in ('Id','Image','Created')} | {'StartedAt':state['StartedAt']}


def source_pins():
    return {'adapter_sha256':digest(Path(__file__).read_bytes()),
            'checks_sha256':digest(Path(checks.__file__).read_bytes()),
            'controller_sha256':digest(checks.inside_code().encode()),
            'reconciliation_code_sha256':digest(inside_code().encode())}


def validate_request_shape(request):
    require(isinstance(request, dict) and set(request) == REQUEST_KEYS
            and request.get('schema') == SCHEMA, 'Reconciliation request fields/schema differ')
    for name in ('attempt','request_id'):
        require(isinstance(request[name], str) and TOKEN.fullmatch(request[name]), 'Invalid '+name)
    for name in ('receipt_sha256','result_sha256','log_sha256'):
        require(isinstance(request[name], str) and SHA.fullmatch(request[name]), 'Invalid '+name)
    require(isinstance(request['checker_pids'], list) and bool(request['checker_pids'])
            and all(type(pid) is int and pid > 1 for pid in request['checker_pids'])
            and len(set(request['checker_pids'])) == len(request['checker_pids']), 'Exact checker PIDs required')
    require(isinstance(request['inputs'], dict) and isinstance(request['helper'], dict)
            and isinstance(request['observation'], dict), 'Reconciliation request pins malformed')


RECONCILE_RUNTIME = r'''
def reconciliation_processes(request):
    original = request['inputs']['controller_sha256']
    for row in Path('/proc').iterdir():
        if not row.name.isdigit() or int(row.name) == os.getpid():
            continue
        try:
            raw = (row/'cmdline').read_bytes()
            status = (row/'stat').read_text().rsplit(')', 1)[1].split()[0]
            if status == 'Z':
                continue
            require(int(row.name) not in request['checker_pids'], 'Known original checker PID still alive')
            if not raw:
                continue
            argv = raw.rstrip(b'\0').split(b'\0')
            require(not any(sha_bytes(token) == original for token in argv),
                    'Original inline controller still alive')
            require(not any(Path(os.fsdecode(token)).name == 'docker_claimed_runtime_checks.py'
                            for token in argv), 'Another claimed-check controller is alive')
            # Conservatively reject all compilers in this backend namespace:
            # an unreadable target environment cannot authorize finalization.
            executable = (row/'exe').resolve(strict=True).name
            require(executable not in ('cargo', 'rustc')
                    and not any(Path(os.fsdecode(token)).name in ('cargo','rustc') for token in argv[:1]),
                    'Cargo/rustc process remains in the selected backend namespace')
        except FileNotFoundError:
            require(not row.exists(), 'Live guest process evidence disappeared')


def immutable_archive(path, raw):
    backend._assert_no_links(path.parent, 'reconciliation archive parent')
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        require(read_bounded_regular(path, 'immutable reconciliation archive', 16*1024*1024)[0] == raw,
                'Immutable reconciliation archive already differs')
        return
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o640)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except BaseException:
        raise


def reconcile_completed_checks(request, apply):
    inputs = request['inputs']
    require(os.environ.get('FULLMAG_COMPOSE_PROJECT') == inputs['compose_project']
            and os.environ.get('FULLMAG_SOURCE_HOST_ROOT') == inputs['source_root'],
            'Backend group/source identity differs')
    root = Path(inputs['operation_root'])
    require(root.name == request['attempt'] and root.parent.name == 'attempts'
            and root.parent.parent.name == 'claimed-runtime-checks', 'Operation path differs')
    runtime_request = {**inputs, 'diagnostic_api_only':True, 'result_path':str(root/'result.json')}
    with runtime_locks() as paths, claimed_build_locks(runtime_request, paths):
        reconciliation_processes(request)
        receipt_raw, _ = read_bounded_regular(root/'receipt.json', 'original operation receipt', 4*1024*1024)
        result_raw, _ = read_bounded_regular(root/'result.json', 'immutable completed result', 4*1024*1024)
        log_raw, _ = read_bounded_regular(root/'build.log', 'completed operation log', 16*1024*1024)
        require(sha_bytes(receipt_raw) == request['receipt_sha256']
                and sha_bytes(result_raw) == request['result_sha256']
                and sha_bytes(log_raw) == request['log_sha256'], 'Operation receipt/result/log CAS differs')
        result = json.loads(result_raw)
        evidence = pinned_evidence(runtime_request, paths)
        require(canonical_sha(evidence) == result['runtime_evidence_before_sha256']
                == result['runtime_evidence_after_sha256'], 'Current pinned runtime evidence changed')
        current = package_snapshot(backend.PACKAGE_ROOT, 'unchanged current package', current=True)
        source = candidate_and_workspace(runtime_request, current)
        snapshot = result_record(runtime_request, result['state'], evidence, evidence, source=source,
                                 commands=result['commands'])
        require(snapshot == result, 'Candidate/captured workspace/result evidence changed')
        require(current_candidate_workspace_matches(source, runtime_request, current),
                'Candidate/current package/captured workspace drift')
        observation = {
            'runtime_evidence_sha256':canonical_sha(evidence),
            'workspace_source_sha256':source['workspace_source_sha256'],
            'candidate_receipt_sha256':source['candidate_receipt_sha256'],
            'current_package_receipt_sha256':sha_bytes(current['receipt_raw']),
            'current_package_children':{name:list(metadata) for name, metadata in current['children'].items()},
        }
        if not apply:
            return observation
        require(observation == request['observation'], 'Reviewed reconciliation observation changed')
        require(pinned_evidence(runtime_request, paths) == evidence
                and current_candidate_workspace_matches(source, runtime_request, current),
                'Protected state changed before terminal publication')
        reconciliation_processes(request)
        active = root.parent.parent.parent/'active'
        active_raw, _ = read_bounded_regular(active, 'original active marker', 256)
        require(active_raw.decode().strip() == request['attempt'], 'Original active marker differs')
        require(read_bounded_regular(root/'receipt.json', 'receipt CAS', 4*1024*1024)[0] == receipt_raw
                and read_bounded_regular(root/'result.json', 'result CAS', 4*1024*1024)[0] == result_raw
                and read_bounded_regular(root/'build.log', 'log CAS', 16*1024*1024)[0] == log_raw,
                'Original receipt/result/log changed before finalization')
        archive = root/'reconciliation'/request['request_id']
        immutable_archive(archive/'original-receipt.json', receipt_raw)
        immutable_archive(archive/'original-result.json', result_raw)
        immutable_archive(archive/'original-build.log', log_raw)
        immutable_archive(archive/'request.json', backend._canonical(request))
        decision = {'schema':'fullmag.claimed-checks-reconciliation.v1', 'request_id':request['request_id'],
                    'request_sha256':canonical_sha(request), 'observation':observation,
                    'state':'failed-confirmed', 'scientific_claim_modified':False,
                    'runtime_qualification':'NOT VERIFIED'}
        immutable_archive(archive/'decision.json', backend._canonical(decision))
        final = {**json.loads(receipt_raw), 'state':'failed-confirmed', 'result':result,
                 'reconciliation':decision, 'runtime_qualification':'NOT VERIFIED',
                 'failure':'Completed Rust focused checks returned known nonzero exit(s)',
                 'final_log_sha256':sha_bytes(log_raw), 'final_log_size':len(log_raw)}
        # CAS succeeded with both original writers proven closed. The original
        # helper alone observes terminal.json and removes its own active marker.
        backend._write_json(root/'receipt.json', final, 'reconciled operation receipt')
        backend._write_json(root.parent.parent/'current.json', final, 'reconciled phase current')
        backend._write_json(root/'terminal.json', final, 'reconciled terminal receipt')
        return {'state':'failed-confirmed', 'decision':decision}
'''


def inside_code():
    original = checks.inside_code()
    suffix = '\nraise SystemExit(run_claimed_runtime_checks(json.loads(sys.argv[1])))\n'
    require(original.endswith(suffix), 'Original controller entrypoint differs')
    return (original[:-len(suffix)] + '\n' + RECONCILE_RUNTIME
            + '\nprint(json.dumps(reconcile_completed_checks(json.loads(sys.argv[1]), sys.argv[2] == "apply"), sort_keys=True))\n')


def backend_call(args, request, apply=False):
    result = docker_capture('exec', args.backend_container_id, '/usr/local/bin/python3', '-B',
                            '-c', inside_code(), json.dumps(request, sort_keys=True),
                            'apply' if apply else 'preview', timeout=180)
    return json.loads(result.stdout)


def wait_original_helper(control, pin):
    deadline = time.monotonic()+30
    while True:
        result = docker_capture('inspect', pin['Id'], allow_failure=True)
        if result.returncode:
            # A Docker/transport failure is not container absence proof.
            ids = docker_capture('ps', '--all', '--quiet', '--no-trunc').stdout.decode().split()
            require(pin['Id'] not in ids, 'Original helper inspection failed while still present')
            break
        row = json.loads(result.stdout)[0]
        require(row['Id'] == pin['Id'] and row['State']['StartedAt'] == pin['StartedAt'],
                'Original helper incarnation changed while waiting')
        if not row['State']['Running']:
            require(row['State'].get('ExitCode') == 0, 'Original helper did not exit successfully')
            break
        require(time.monotonic() < deadline, 'Original helper exit is not confirmed')
        time.sleep(.5)
    require(read_raw(control, 'active', optional=True) is None,
            'Original active marker remains; finalization is not complete')


def run(args):
    from docker_dev import _select_source, _compose_identity
    from docker_volume_activation_reconcile import _validate_helper_logged
    from docker_dev_recovery_build import validate_backend, backend_control_path
    require(TOKEN.fullmatch(args.attempt or ''), 'Exact operation attempt required')
    require(SHA.fullmatch(args.backend_container_id or '')
            and re.fullmatch(r'sha256:[0-9a-f]{64}', args.image_id or ''), 'Full backend/image pins required')
    selected, layout = _select_source(Path(args.source_root), args.source_root)
    identity = _compose_identity(layout)
    control = BuildControl(identity, args.image_id)
    root = PHASE+'/attempts/'+args.attempt
    request = None
    if args.apply:
        require(args.request and SHA.fullmatch(args.request_sha256 or ''), 'Apply requires request and raw SHA')
        require(re.fullmatch(r'verification/claimed-checks-reconcile/'+args.attempt
                             +r'/[0-9a-f]{32}/request.json', args.request), 'Canonical request path required')
        request_raw = read_raw(control, args.request)
        require(digest(request_raw) == args.request_sha256, 'Reviewed request raw SHA changed')
        request = json.loads(request_raw)
        validate_request_shape(request)
        require(request['attempt'] == args.attempt and args.request.endswith('/'+request['request_id']+'/request.json'),
                'Request UUID/operation differs')
        require(request['source_pins'] == source_pins(), 'Reconciliation source pins changed')
    raw = read_raw(control, root+'/receipt.json')
    operation = json.loads(raw)
    inputs = operation.get('inputs', {})
    check_controller(inputs)
    backend = checks.inspect_one('container', args.backend_container_id)
    validate_backend(backend, identity, args.backend_container_id, args.image_id)
    require(inputs.get('source_root') == str(selected) and inputs.get('compose_project') == control.project
            and inputs.get('backend_container_id') == args.backend_container_id
            and inputs.get('image_id') == args.image_id
            and inputs.get('backend_started_at') == backend['State']['StartedAt']
            and inputs.get('container_fingerprint') == fingerprint(backend), 'Original backend/source/incarnation differs')
    require(operation.get('phase') == PHASE and operation.get('attempt') == args.attempt
            and operation.get('compose_project') == control.project
            and operation.get('control_volume') == control.volume
            and operation.get('control_namespace', '') == control.namespace
            and operation.get('namespace_registry_sha256') == control.namespace_registry_sha256,
            'Retained operation namespace identity differs')
    augmented_inputs = {**inputs, 'operation_root':backend_control_path(control.path(root))}
    if operation.get('state') == 'failed-confirmed':
        require(args.apply and request is not None and operation.get('reconciliation', {}).get('request_id') == request['request_id']
                and operation['reconciliation'].get('request_sha256') == digest(canonical(request)+b'\n')
                and request['inputs'] == augmented_inputs, 'Terminal replay belongs to another request')
        archive = root+'/reconciliation/'+request['request_id']
        require(digest(read_raw(control, archive+'/original-receipt.json')) == request['receipt_sha256']
                and digest(read_raw(control, root+'/result.json')) == request['result_sha256']
                and digest(read_raw(control, root+'/build.log')) == request['log_sha256']
                and json.loads(read_raw(control, root+'/terminal.json')) == operation,
                'Idempotent replay original/terminal pins differ')
        wait_original_helper(control, request['helper'])
        print(json.dumps({'state':'failed-confirmed','idempotent':True,'request':args.request})); return
    require(operation.get('state') == 'outcome-unknown-resources-retained',
            'Only the exact unknown retained check may be reconciled')
    helper = helper_pin(control, operation)
    _validate_helper_logged(helper['Id'])
    host_inactive(selected)
    require(read_raw(control, 'active').decode().strip() == args.attempt, 'Original active marker differs')
    result_raw = read_raw(control, root+'/result.json')
    result = json.loads(result_raw)
    require_stable_result(result)
    require(result.get('state') == 'tests-failed-known', 'Only known completed test failures are supported')
    expected_identity = {key: inputs[key] for key in ('source_root','compose_project','backend_container_id',
                                                    'image_id','candidate_basename','candidate_receipt_sha256')}
    checks.validate_execution_result(44, result, expected_identity)
    require(all(row['process_started'] is True and row['wait_observed'] is True for row in result['commands']),
            'Every original test child must have an observed completed wait')
    pins = {'inputs':augmented_inputs, 'receipt_sha256':digest(raw),
            'result_sha256':digest(result_raw), 'log_sha256':digest(read_raw(control, root+'/build.log')),
            'helper':helper, 'source_pins':source_pins()}
    if not args.apply:
        require(args.checker_pid, 'Preview requires exact original checker PID(s)')
        request = {'schema':SCHEMA,'attempt':args.attempt,'request_id':uuid.uuid4().hex,
                   **pins, 'checker_pids':args.checker_pid, 'observation':{}}
        validate_request_shape(request)
        request['observation'] = backend_call(args, request)
        relative = 'verification/claimed-checks-reconcile/'+args.attempt+'/'+request['request_id']+'/request.json'
        control.write(relative, request)
        report = {'state':'preview','request':relative,'request_sha256':digest(canonical(request)+b'\n'),
                  'observation':request['observation'],'helper':helper,'apply_executed':False}
    else:
        require(all(request[key] == value for key,value in pins.items()), 'Reviewed exact reconciliation pins changed')
        host_inactive(selected)
        require(helper_pin(control, operation) == helper, 'Original helper changed before finalization')
        _validate_helper_logged(helper['Id'])
        report = backend_call(args, request, apply=True)
        wait_original_helper(control, helper)
        report.update(apply_executed=True, request=args.request)
    print(json.dumps(report, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('source-root','attempt','backend-container-id','image-id'):
        parser.add_argument('--'+name, required=True)
    parser.add_argument('--checker-pid', type=int, action='append')
    parser.add_argument('--request')
    parser.add_argument('--request-sha256')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    try:
        run(args)
    except (BuildControlError, OSError, ValueError, KeyError) as error:
        print('claimed-checks-reconcile: '+str(error), file=__import__('sys').stderr)
        raise SystemExit(2)


if __name__ == '__main__':
    main()
