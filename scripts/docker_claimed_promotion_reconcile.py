#!/usr/bin/env python3
"""Reconcile one already published claimed repair; never retry promotion or start a runtime.

Preview writes an immutable control request. Apply verifies that exact observation,
finalizes the existing rotation, and lets the original helper release its own lease.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import uuid

from docker_build_control import BuildControl, BuildControlError, canonical, docker_capture
from docker_volume_reconcile import read_raw, fingerprint
import docker_claimed_checks_reconcile as prior
import docker_dev_recovery_build as repair

SCHEMA = 'fullmag.claimed-promotion-reconciliation.v1'
PHASE = 'recovery-promotion'
TOKEN, SHA = prior.TOKEN, prior.SHA
require = prior.require
# This is the exact original controller that failed after publication. A different
# controller needs its own diagnosis, never an operator-selected digest bypass.
ORIGINAL_CONTROLLER_SHA256 = '24a8bb4dac37ca826d8f357079cbee90ff00927863cc0644c66656660e550851'
FAILURE = b'ValueError: Diagnostic API executable differs\n'


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def helper_pin(control, operation):
    # Reuse the exact original helper authentication, with only its phase bound
    # to this adapter. No helper is started and no control operation is acquired.
    class PhaseControl:
        def __getattr__(self, key):
            return getattr(control, key)
        def operation_script(self, _phase, attempt):
            return control.operation_script(PHASE, attempt)
    pin = prior.helper_pin(PhaseControl(), operation)
    control._inspect_operation_helper({'receipt':operation}, expected_id=pin['Id'])
    return pin


def host_inactive(source, *, proc=Path('/proc')):
    for row in proc.iterdir():
        if not row.name.isdigit() or int(row.name) == os.getpid():
            continue
        try:
            argv = (row/'cmdline').read_bytes().rstrip(b'\0').split(b'\0')
            for token in argv:
                value = Path(os.fsdecode(token))
                if value.name != 'docker_dev_recovery_build.py':
                    continue
                if not value.is_absolute():
                    value = (row/'cwd').resolve(strict=True)/value
                require(value.resolve() != (source/'scripts/docker_dev_recovery_build.py').resolve(),
                        'Original or another promotion host manager is alive: '+row.name)
        except FileNotFoundError:
            require(not row.exists(), 'Live host process evidence disappeared')
        except OSError as error:
            raise BuildControlError('Host manager inactivity cannot be proven: '+str(error)) from error


def source_pins():
    return {'adapter':digest(Path(__file__).read_bytes()),
            'recovery':digest(Path(repair.__file__).read_bytes()),
            'helper_protocol':digest(Path(prior.__file__).read_bytes()),
            'inline':digest(inside_code().encode())}


RUNTIME = r'''
def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def bounded(path, limit=8*1024*1024):
    backend._assert_no_links(path, 'promotion reconciliation evidence')
    raw, metadata = backend._read_regular(path, 'promotion reconciliation evidence', limit)
    require(metadata.st_nlink == 1, 'Reconciliation evidence is not one regular file')
    return raw


def immutable(path, raw):
    backend._assert_no_links(path.parent, 'promotion reconciliation archive')
    path.parent.mkdir(parents=True, exist_ok=True)
    if os.path.lexists(path):
        require(bounded(path) == raw, 'Immutable promotion archive differs')
        return
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o640)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    backend._fsync_directory(path.parent, 'promotion reconciliation archive')


def no_promotion_writer(request):
    for row in Path('/proc').iterdir():
        if not row.name.isdigit() or int(row.name) == os.getpid():
            continue
        try:
            state = (row/'stat').read_text().rsplit(')', 1)[1].split()[0]
            if state == 'Z':
                continue
            require(int(row.name) not in request['controller_pids'], 'Original promotion controller remains alive')
            argv = (row/'cmdline').read_bytes().rstrip(b'\0').split(b'\0')
            require(not any(sha(token) == request['inputs']['controller_sha256'] for token in argv),
                    'Original inline promotion controller remains alive')
            require(not any(token.endswith((b'\ninside_promote(json.loads(sys.argv[1]))\n',
                                              b'\ninside(json.loads(sys.argv[1]))\n')) for token in argv),
                    'Another inline recovery build/promotion controller remains alive')
            require(not any(Path(os.fsdecode(token)).name == 'docker_dev_recovery_build.py' for token in argv),
                    'Another recovery build/promotion controller remains alive')
        except FileNotFoundError:
            require(not row.exists(), 'Live guest process evidence disappeared')


def observe_published(request, paths):
    inputs = request['inputs']
    root = Path(inputs['operation_root'])
    require(root.name == request['attempt'] and root.parent.name == 'attempts'
            and root.parent.parent.name == 'recovery-promotion', 'Promotion operation path differs')
    originals = {name: bounded(root/name) for name in ('receipt.json','build.log','previous-provenance.json')}
    require({name:sha(raw) for name,raw in originals.items()} == request['original_sha256'],
            'Original operation receipt/log/provenance CAS differs')
    require(originals['build.log'].endswith(b'ValueError: Diagnostic API executable differs\n'),
            'Original promotion failure differs')
    require(not os.path.lexists(root/'result.json') and not os.path.lexists(root/'terminal.json'),
            'Original operation already has result or terminal evidence')
    previous = json.loads(originals['previous-provenance.json'])
    import base64
    require(set(previous) == {'schema','sha256','base64'}
            and previous['schema'] == 'fullmag.recovery-promotion-original.v1'
            and previous['sha256'] == inputs['provenance_sha256']
            and sha(base64.b64decode(previous['base64'], validate=True)) == inputs['provenance_sha256'],
            'Archived original provenance differs')
    no_promotion_writer(request)
    evidence = pinned_evidence(inputs, paths)
    package = backend.PACKAGE_ROOT
    control = backend._ensure_package_development_root(package)
    rotation = backend._read_rotation_journal(package, control)
    require(rotation is not None and rotation['state'] == 'committed'
            and rotation['candidate'] == str(control/backend.PACKAGE_CANDIDATES_DIRNAME/inputs['candidate_basename'])
            and rotation['old_receipt_sha256'] == inputs['current_receipt_sha256']
            and rotation['new_receipt_sha256'] == inputs['candidate_receipt_sha256'],
            'Original committed rotation identity differs')
    candidate, backup = Path(rotation['candidate']), Path(rotation['backup'])
    old_names, new_names = set(rotation['old_children']), set(rotation['new_children'])
    moved_old, moved_new, _, candidate_children, backup_children = backend._rotation_validate_partitions(
        rotation, package, candidate, backup)
    require(moved_old == old_names and moved_new == new_names and candidate_children == set()
            and backup_children == old_names | {'rotation.json'}, 'Rotation is not completely published')
    # Require metadata before calling canonical validators: preview must never
    # synthesize missing rotation metadata as a side effect.
    metadata_raw = bounded(backup/'rotation.json')
    require(json.loads(metadata_raw) == backend._rotation_metadata_document(rotation), 'Rollback metadata differs')
    old, old_raw = backend._rotation_validate_full(backup, 'reconciled rollback', rotation,
        inputs['current_receipt_sha256'], old_names | {'rotation.json'}, rotation['old_identity'], backup=True)
    current, current_raw = backend._rotation_validate_full(package, 'reconciled published package', rotation,
        inputs['candidate_receipt_sha256'], new_names, rotation['new_identity'], output=True)
    marker = backend._validate_candidate_marker(candidate, package, Path('/build'), state='ready')
    require(marker['artifact_inventory_sha256'] == sha(backend._canonical(current['artifacts'])),
            'Published candidate marker inventory differs')
    provenance_raw = bounded(backend.PROVENANCE_PATH)
    provenance = json.loads(provenance_raw)
    require(provenance.get('build_receipt_sha256') == inputs['candidate_receipt_sha256']
            and provenance.get('package_root') == str(package)
            and provenance.get('backend_build_receipt') == str(package/'backend-build-receipt.json')
            and provenance.get('binary_hashes') == {item['path'][4:]:item['sha256']
                for item in current['artifacts'] if item['path'].startswith('bin/')},
            'Published provenance/package incoherent')
    permit = root.parent.parent.parent/inputs['claimed_build_pin']
    require(sha(bounded(permit)) == inputs['claimed_build_pin_sha256']
            and json.loads(bounded(permit)) == inputs['claimed_interruption_build'], 'Immutable claim permit differs')
    observation = {'runtime_evidence':evidence, 'rotation':rotation,
        'rotation_sha256':sha(bounded(Path(rotation['journal']))),
        'provenance_sha256':sha(provenance_raw), 'current_receipt_sha256':sha(current_raw),
        'rollback_receipt_sha256':sha(old_raw), 'rollback_metadata_sha256':sha(metadata_raw),
        'candidate_marker':marker}
    return observation, originals


def reconcile_published(request, apply):
    inputs = request['inputs']
    require(os.environ.get('FULLMAG_COMPOSE_PROJECT') == inputs['compose_project']
            and os.environ.get('FULLMAG_SOURCE_HOST_ROOT') == inputs['source_root'], 'Backend group/source differs')
    with runtime_locks() as paths, claimed_build_locks(inputs, paths):
        observation, originals = observe_published(request, paths)
        root = Path(inputs['operation_root'])
        require(bounded(root.parent.parent.parent/'active', 256).decode().strip() == request['attempt'],
                'Original active marker differs')
        if not apply:
            return observation
        require(observation == request['observation'], 'Reviewed promotion observation changed')
        archive = root/'reconciliation'/request['request_id']
        for name, raw in originals.items():
            immutable(archive/('original-'+name), raw)
        immutable(archive/'request.json', backend._canonical(request))
        # Recheck protected state immediately before canonical finalization.
        again, _ = observe_published(request, paths)
        require(again == observation, 'Promotion observation drifted before finalization')
        rotation = observation['rotation']
        decision = {'schema':'fullmag.claimed-promotion-reconciliation.v1',
            'request_id':request['request_id'], 'request_sha256':sha(backend._canonical(request)),
            'state':'succeeded', 'original_failure_preserved':True,
            'scientific_claim_modified':False, 'runtime_started':False, 'runtime_qualification':'NOT VERIFIED'}
        immutable(archive/'decision.json', backend._canonical(decision))
        backend._finalize_published_candidate(Path(rotation['candidate']), rotation)
        backend._clear_rotation_journal(rotation)
        require(pinned_evidence(inputs, paths) == observation['runtime_evidence'],
                'Protected runtime/claim state changed during canonical rotation finalization')
        _, current_raw, _ = backend._validated_package(backend.PACKAGE_ROOT,
            'finalized reconciled package', exclude_development_control=True)
        require(sha(current_raw) == observation['current_receipt_sha256']
                and sha(bounded(backend.PROVENANCE_PATH)) == observation['provenance_sha256'],
                'Published package/provenance changed during canonical finalization')
        result = {'schema':'fullmag.docker-recovery-promotion.v1','state':'promoted',
            'candidate':rotation['candidate'], 'receipt_sha256':inputs['candidate_receipt_sha256'],
            'provenance_sha256':observation['provenance_sha256'], 'rollback_package':rotation['backup'],
            'package_promoted':True, 'runtime_started':False, 'runtime_qualification':'NOT VERIFIED'}
        final = {**json.loads(originals['receipt.json']), 'state':'succeeded', 'result':result,
            'reconciliation':decision, 'original_failure':json.loads(originals['receipt.json']).get('failure'),
            'final_log_sha256':sha(originals['build.log']), 'final_log_size':len(originals['build.log'])}
        backend._write_json(root/'result.json', result, 'reconciled promotion result')
        backend._write_json(root/'receipt.json', final, 'reconciled promotion receipt')
        backend._write_json(root.parent.parent/'current.json', final, 'reconciled promotion phase')
        backend._write_json(root/'terminal.json', final, 'reconciled promotion terminal')
        return {'state':'succeeded', 'decision':decision}
'''


def inside_code():
    original = repair.inside_code(promote=True)
    suffix = '\ninside_promote(json.loads(sys.argv[1]))\n'
    require(original.endswith(suffix), 'Recovery controller entrypoint differs')
    return original[:-len(suffix)]+'\n'+RUNTIME+'\nprint(json.dumps(reconcile_published(json.loads(sys.argv[1]), sys.argv[2] == "apply"), sort_keys=True))\n'


def backend_call(args, request, apply=False):
    result = docker_capture('exec', args.backend_container_id, '/usr/local/bin/python3', '-B', '-c', inside_code(),
                            json.dumps(request, sort_keys=True), 'apply' if apply else 'preview', timeout=180)
    return json.loads(result.stdout)


def validate_request(request):
    require(isinstance(request, dict) and set(request) == {'schema','attempt','request_id','inputs',
        'original_sha256','helper','source_pins','controller_pids','observation'}
        and request['schema'] == SCHEMA, 'Reconciliation request schema/fields differ')
    require(all(TOKEN.fullmatch(request.get(key, '')) for key in ('attempt','request_id')), 'Invalid request identity')
    require(isinstance(request['controller_pids'], list)
            and all(type(pid) is int and pid > 1 for pid in request['controller_pids']), 'Exact original controller PIDs required')
    require(set(request['original_sha256']) == {'receipt.json','build.log','previous-provenance.json'}
            and all(SHA.fullmatch(value) for value in request['original_sha256'].values()), 'Original archive pins differ')


def run(args):
    from docker_dev import _select_source, _compose_identity
    from docker_volume_activation_reconcile import _validate_helper_logged
    require(TOKEN.fullmatch(args.attempt or ''), 'Exact attempt required')
    require(SHA.fullmatch(args.backend_container_id or '')
            and re.fullmatch(r'sha256:[0-9a-f]{64}', args.image_id or ''), 'Exact backend/image pins required')
    selected, layout = _select_source(Path(args.source_root), args.source_root)
    identity = _compose_identity(layout)
    control = BuildControl(identity, args.image_id)
    root = PHASE+'/attempts/'+args.attempt
    request = None
    if args.apply:
        require(args.request and SHA.fullmatch(args.request_sha256 or ''), 'Apply requires reviewed request and raw SHA')
        require(re.fullmatch(r'verification/claimed-promotion-reconcile/'+args.attempt+r'/[0-9a-f]{32}/request.json', args.request),
                'Canonical reconciliation request path required')
        raw = read_raw(control, args.request)
        require(digest(raw) == args.request_sha256, 'Reviewed request SHA differs')
        request = json.loads(raw); validate_request(request)
        require(request['attempt'] == args.attempt and request['source_pins'] == source_pins()
                and args.request.endswith('/'+request['request_id']+'/request.json'), 'Request/source identity differs')
    raw = read_raw(control, root+'/receipt.json')
    operation = json.loads(raw); inputs = operation['inputs']
    require(inputs.get('controller_sha256') == ORIGINAL_CONTROLLER_SHA256,
            'Unsupported original promotion controller')
    backend = repair.inspect_one('container', args.backend_container_id)
    repair.validate_backend(backend, identity, args.backend_container_id, args.image_id)
    require(inputs.get('source_root') == str(selected) and inputs.get('compose_project') == control.project
        and inputs.get('backend_container_id') == args.backend_container_id and inputs.get('image_id') == args.image_id
        and inputs.get('backend_started_at') == backend['State']['StartedAt']
        and inputs.get('container_fingerprint') == fingerprint(backend), 'Original backend/source/incarnation differs')
    require(operation.get('phase') == PHASE and operation.get('attempt') == args.attempt
        and operation.get('compose_project') == control.project and operation.get('control_volume') == control.volume
        and operation.get('control_namespace','') == control.namespace
        and operation.get('namespace_registry_sha256') == control.namespace_registry_sha256, 'Original control namespace differs')
    augmented = {**inputs, 'operation_root':repair.backend_control_path(control.path(root))}
    if operation.get('state') == 'succeeded':
        require(args.apply and request and operation.get('reconciliation',{}).get('request_id') == request['request_id']
            and operation['reconciliation'].get('request_sha256') == digest(canonical(request)+b'\n')
            and request['inputs'] == augmented, 'Terminal replay belongs to another request')
        for name, expected in request['original_sha256'].items():
            require(digest(read_raw(control, root+'/reconciliation/'+request['request_id']+'/original-'+name)) == expected,
                    'Original archive changed')
        require(json.loads(read_raw(control,root+'/terminal.json')) == operation, 'Terminal receipt differs')
        prior.wait_original_helper(control, request['helper'])
        print(json.dumps({'state':'succeeded','idempotent':True})); return
    require(operation.get('state') == 'outcome-unknown-resources-retained'
            and inputs.get('diagnostic_api_only') is True and isinstance(inputs.get('claimed_interruption_build'),dict),
            'Only the exact retained claimed diagnostic promotion may be reconciled')
    helper = helper_pin(control,operation); _validate_helper_logged(helper['Id'])
    host_inactive(selected)
    require(read_raw(control,'active').decode().strip() == args.attempt, 'Original active marker differs')
    originals = {name:digest(read_raw(control,root+'/'+name)) for name in ('receipt.json','build.log','previous-provenance.json')}
    pins = {'inputs':augmented,'original_sha256':originals,'helper':helper,'source_pins':source_pins()}
    if not args.apply:
        request = {'schema':SCHEMA,'attempt':args.attempt,'request_id':uuid.uuid4().hex,
            **pins,'controller_pids':args.controller_pid or [],'observation':{}}
        validate_request(request)
        request['observation'] = backend_call(args,request)
        relative = 'verification/claimed-promotion-reconcile/'+args.attempt+'/'+request['request_id']+'/request.json'
        control.write(relative,request)
        report = {'state':'preview','request':relative,'request_sha256':digest(canonical(request)+b'\n'),
            'observation':request['observation'],'apply_executed':False}
    else:
        require(all(request[key] == value for key,value in pins.items()), 'Reviewed promotion pins changed')
        require(helper_pin(control,operation) == helper,'Original helper incarnation changed')
        host_inactive(selected); _validate_helper_logged(helper['Id'])
        report = backend_call(args,request,True)
        prior.wait_original_helper(control,helper)
        report.update(apply_executed=True)
    print(json.dumps(report,indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('source-root','attempt','backend-container-id','image-id'):
        parser.add_argument('--'+name,required=True)
    parser.add_argument('--controller-pid',type=int,action='append')
    parser.add_argument('--request'); parser.add_argument('--request-sha256')
    parser.add_argument('--apply',action='store_true')
    try:
        run(parser.parse_args())
    except (BuildControlError,OSError,ValueError,KeyError) as error:
        print('claimed-promotion-reconcile: '+str(error),file=__import__('sys').stderr)
        raise SystemExit(2)

if __name__ == '__main__':
    main()
