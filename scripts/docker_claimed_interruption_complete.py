#!/usr/bin/env python3
"""Explicit managed completion of one Prepared dead Started claim.

Stops only the exact authorized backend incarnation. Never removes that backend,
restarts a frontend, promotes a package, starts runtime, or replays Solve.
Unknown daemon/native outcomes retain the managed operation and all evidence.
"""
from __future__ import annotations

import argparse
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re
import time

import docker_claimed_interruption_namespace as namespace
import docker_claimed_worker_interruption as pure
import docker_dev_recovery_build as repair
import docker_volume_claimed_interruption as prepare
from docker_build_control import BuildControl, BuildControlError, canonical, docker_capture
from docker_volume_unclaimed_cancellation import _json_object, _publish_immutable


require = namespace.require


def read_pinned(control, relative, pin):
    namespace.digest(pin)
    raw = control.read_bytes(relative, maximum=256*1024, timeout=60)
    require(hashlib.sha256(raw).hexdigest() == pin, 'Immutable control document SHA differs: '+relative)
    return raw, _json_object(raw, relative, maximum=256*1024)


def prepared_authority(args, control):
    require(re.fullmatch(r'verification/claimed-interruption/[0-9a-f]{32}/request\.json', args.request_path), 'Exact request relative path required')
    require(re.fullmatch(r'claimed-interruption-prepare/attempts/[0-9a-f]{32}', args.prepared_phase_root), 'Exact Prepared operation root required')
    raw, native = read_pinned(control, args.request_path, args.request_sha256)
    interruption = pure.validate_request(native['interruption'])
    root = 'verification/claimed-interruption/'+interruption['request_id'].replace('-', '')
    require(args.request_path == root+'/request.json', 'Request path does not bind its canonical interruption UUID')
    require(args.backend_container_id == interruption['container']['container_id']
            and args.image_id == interruption['container']['image_id']
            and control.project == interruption['container']['compose_project'], 'CLI/backend/request identity differs')
    result_raw, result = read_pinned(control, args.prepared_phase_root+'/result.json', args.prepared_result_sha256)
    inputs = dict(request_sha256=args.request_sha256,
                  interruption_sha256=pure.canonical_request_sha256(interruption),
                  backend_container_id=args.backend_container_id,
                  backend_started_at=interruption['container_started_at'], verify_only=False)
    require(prepare.validate_prepare_result(result, inputs) == 'prepared', 'Only actual typed Prepared permits stop')
    receipt = _json_object(control.read_bytes(args.prepared_phase_root+'/receipt.json', maximum=256*1024, timeout=60), 'Prepared operation receipt')
    require(receipt.get('schema') == 'fullmag.docker-build-operation.v1'
            and receipt.get('attempt') == args.prepared_phase_root.rsplit('/', 1)[-1]
            and receipt.get('control_volume') == control.volume
            and receipt.get('state') == 'succeeded' and receipt.get('phase') == 'claimed-interruption-prepare'
            and receipt.get('compose_project') == control.project
            and receipt.get('inputs', {}).get('candidate_basename') == args.candidate_basename
            and receipt.get('inputs', {}).get('request_path') == args.request_path
            and receipt.get('inputs', {}).get('request_sha256') == args.request_sha256
            and receipt.get('inputs', {}).get('use_installed_package', False) is bool(args.use_installed_package)
            and receipt.get('prepare_result') == result, 'Prepared operation receipt differs')
    manifest_raw = control.read_bytes(root+'/preserved-files.json', maximum=256*1024, timeout=60)
    manifest = pure._validate_preserved_files_manifest(_json_object(manifest_raw, 'preserved manifest'), interruption)
    return dict(root=root, native=native, request_raw=raw, prepared_raw=result_raw,
                prepared_receipt=receipt, manifest=manifest, manifest_raw=manifest_raw)


def validate_target(native, engine, target, *, stopped):
    request = native['interruption']
    require(hashlib.sha256(repair_engine_id(engine).encode()).hexdigest() == request['docker_engine_id_sha256'], 'Engine identity differs')
    pure.recovery._observed_container(request['container'], target, stopped=stopped)
    require(target['State']['StartedAt'] == request['container_started_at']
            and not target['State'].get('Paused', False)
            and not target['State'].get('Restarting', False), 'Backend incarnation/transitional state differs')
    require(target['State']['Running'] is (not stopped), 'Backend running state differs')


def repair_engine_id(engine):
    return pure.recovery._engine_id(engine, 'Engine')


def observation(target, *, stopped):
    state, config = target['State'], target['Config']
    value = dict(container_id=target['Id'], image_id=target['Image'],
                 service='backend', role='backend', user=config.get('User', ''),
                 state=state['Status'], pid=state['Pid'], private_pid_namespace=True,
                 host_pid=False, device_requests=deepcopy(target['HostConfig'].get('DeviceRequests', [])))
    if stopped:
        require(state['Status'] == 'exited' and state['Running'] is False and state['Pid'] == 0,
                'Factual private namespace exit required')
        # Engine Exited+PID0 for this private incarnation is the namespace
        # authority. This never asserts a worker exit code or graceful drain.
        value.update(finished_at=state['FinishedAt'], descendant_count=0)
    return value


def make_attestation(native, before_engine, after_engine, before, after, manifest):
    validate_target(native, before_engine, before, stopped=False)
    validate_target(native, after_engine, after, stopped=True)
    request = native['interruption']
    release = dict(resource_id=request['identity']['resource_id'],
                   mapping_sha256=request['device_release_mapping_sha256'], mapping_detached=True)
    if request.get('gpu_uuid') is not None:
        release['gpu_uuid'] = request['gpu_uuid']
    document = dict(schema='docker-teardown-manifest.v1', before=observation(before, stopped=False),
                    after=observation(after, stopped=True), device_release=release)
    attestation = pure.build_teardown_attestation(request, before_engine, after_engine, before, after,
        dict(inspection_manifest=dict(document=document, sha256=pure.recovery.canonical_json_sha256(document)),
             preserved_files_manifest=manifest))
    return document, attestation


def validate_native_result(raw, native, *, verify_only=False):
    value = _json_object(raw, 'native complete output', maximum=256*1024)
    sha = pure.canonical_request_sha256(native['interruption'])
    if verify_only:
        require(value == dict(status='verified_source_protocol', request_sha256=sha, mutated=False), 'Native verify acknowledgement differs')
    else:
        require(set(value) == {'status', 'request_sha256', 'receipt_sha256', 'solve_replayed', 'final_state_available'}
                and value['status'] == 'interrupted-no-final-state'
                and value['request_sha256'] == sha and value['solve_replayed'] is False
                and value['final_state_available'] is False, 'Native complete acknowledgement differs')
        namespace.digest(value['receipt_sha256'])
    return value


def validate_maintenance(actual, spec, *, name, container_id, exited=False):
    require(re.fullmatch(r'[0-9a-f]{64}', container_id) and actual.get('Id') == container_id
            and actual.get('Name') == '/'+name and actual.get('Image') == spec['image'], 'Maintenance exact identity differs')
    config, host, state = actual['Config'], actual['HostConfig'], actual['State']
    labels = config.get('Labels', {})
    require(labels.get('com.docker.compose.project') == spec['project']
            and labels.get('com.docker.compose.service') == 'backend-recovery'
            and labels.get('fullmag.recovery.target_container') == spec['context']['container_id'], 'Maintenance ownership differs')
    require(host.get('Runtime') == 'runc' and host.get('NetworkMode') == 'none'
            and host.get('PidMode', '') in ('', 'private') and host.get('IpcMode') == 'private'
            and host.get('Privileged') is False and host.get('ReadonlyRootfs') is True
            and host.get('Init') is True and host.get('CapDrop') == ['ALL']
            and not host.get('CapAdd') and not host.get('Devices') and not host.get('DeviceRequests')
            and not host.get('Binds') and not host.get('PortBindings')
            and host.get('SecurityOpt') == ['no-new-privileges:true']
            and host.get('RestartPolicy', {}).get('Name', '') in ('', 'no'), 'Maintenance isolation differs')
    require(host.get('Tmpfs') == {'/tmp': 'rw,nosuid,nodev,size=64m'}, 'Maintenance tmpfs differs')
    expected_command = ['-B', '-c', namespace.EXECUTOR, json.dumps(spec['context'], sort_keys=True, separators=(',', ':'))]
    require(config.get('Entrypoint') == ['/usr/local/bin/python3'] and config.get('Cmd') == expected_command
            and config.get('User', '') == spec['user'], 'Maintenance command/user differs')
    environment = {}
    for entry in config.get('Env', []):
        key, separator, value = entry.partition('=')
        require(separator and key not in environment, 'Ambiguous maintenance environment')
        environment[key] = value
    require(all(environment.get(k) == v for k, v in spec['environment'].items())
            and not environment.get('LD_PRELOAD'), 'Maintenance environment differs')
    require(len(actual.get('Mounts', [])) == len(spec['mounts'])
            and len(host.get('Mounts', [])) == len(spec['mounts']), 'Maintenance mount count differs')
    for expected in spec['mounts']:
        require(namespace._mount(actual, expected['target']) == expected, 'Maintenance exact typed mount differs')
    require(state.get('Running') is False and state.get('Pid') == 0
            and state.get('Status') == ('exited' if exited else 'created'), 'Maintenance lifecycle observation differs')
    if exited:
        require(type(state.get('ExitCode')) is int and state['ExitCode'] == 0
                and not state.get('OOMKilled') and not state.get('Error'), 'Maintenance native process did not exit successfully')


# Read-only evidence observation in the still-running diagnostic backend. Uses
# only image-local no-follow IO. It deliberately does not invoke native prepare
# again, mutate a lease, or reconstruct a worker exit/drain acknowledgement.
PREFLIGHT = r'''
import hashlib, json, os, pathlib, stat, sys
sys.path.insert(0, '/opt/fullmag')
import linux_native_probe as probe
context = json.loads(sys.argv[1])
def require(value, message):
    if not value:
        raise RuntimeError(message)
def pinned(path, sha, maximum=1024*1024):
    raw = probe.read_regular(path, maximum)
    require(hashlib.sha256(raw).hexdigest() == sha, 'Pre-stop exact bytes differ: '+str(path))
    return raw
raw = pinned(context['request_path'], context['request_sha256'])
native = json.loads(raw)
request = native['interruption']
owner = native['expected_owner']
config = json.loads(pinned('/opt/fullmag/runtime-control/runtime-service/docker-all.json', request['pins']['config_sha256']))
store = pathlib.Path('/state/runs/docker-all/session-store')
require(config['store_root'] == str(store), 'Pre-stop canonical store differs')
owner_path = store/'runtime-services/OWNER.json'
owner_raw = pinned(owner_path, request['pins']['owner_sha256'])
require(json.loads(owner_raw) == owner and owner['state'] == 'unknown', 'Pre-stop exact Unknown owner differs')
process_path = pathlib.Path(native['process_receipt_path'])
require(process_path == pathlib.Path('/opt/fullmag/runtime-control/runtime-service/process-tree.json'), 'Process receipt path differs')
pinned(process_path, request['pins']['process_receipt_sha256'])
pinned(store/('runtime-services/claimed-interruption-'+context['request_sha256']+'.process-tree.json'), request['pins']['process_receipt_sha256'])
require(pathlib.Path('/proc/self/ns/pid').readlink().as_posix() == native['pid_namespace']
        and pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip() == native['boot_id']
        and os.environ.get('HOSTNAME') == owner['host'], 'Pre-stop original process namespace differs')
for pid in [owner['pid'], *[child['pid'] for child in owner['children']]]:
    require(not pathlib.Path('/proc', str(pid)).exists(), 'Known native process still exists')
certificate = pinned('/run/fullmag/linux-native-host.json', request['pins']['mount_attestation_sha256'])
require(certificate == probe.read_regular('/state/.fullmag-linux-native-owner.json'), 'Pre-stop historical storage certificate differs')
manifest = json.loads(probe.read_regular(context['manifest_path']))
canonical = lambda value: json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()
require(hashlib.sha256(canonical(manifest)).hexdigest() == request['pins']['preserved_files_manifest_sha256'], 'Pre-stop preserve manifest differs')
package = (pathlib.Path('/opt/fullmag/package') if context['use_installed_package']
           else pathlib.Path('/opt/fullmag/package/.development/candidates')/context['candidate_basename'])
receipt = json.loads(pinned(package/'backend-build-receipt.json', request['pins']['package_receipt_sha256'], 8*1024*1024))
executable = pinned(package/'bin/fullmag-runtime-service', request['pins']['executable_sha256'], 512*1024*1024)
artifacts = [a for a in receipt.get('artifacts', []) if a.get('path') == 'bin/fullmag-runtime-service']
require(receipt.get('schema') == 'fullmag.direct-compose.backend-build-receipt.v1'
        and receipt.get('state') == 'succeeded'
        and receipt.get('source', {}).get('resolved_commit') == native['build_commit']
        and receipt.get('source', {}).get('source_snapshot_sha256') == request['pins']['source_snapshot_sha256']
        and len(artifacts) == 1 and artifacts[0].get('sha256') == request['pins']['executable_sha256']
        and artifacts[0].get('size') == len(executable), 'Pre-stop candidate package differs')

provenance = json.loads(probe.read_regular('/opt/fullmag/control/backend/runtime-provenance.json', 8*1024*1024))
require(provenance.get('schema') == 'fullmag.docker-all-image.v1'
        and provenance.get('state') == 'succeeded' and provenance.get('source_mode') == 'live-shadow-v1'
        and provenance.get('commit') == native['build_commit']
        and provenance.get('source_snapshot_sha256') == request['pins']['source_snapshot_sha256']
        and provenance.get('build_receipt_sha256') == request['pins']['package_receipt_sha256']
        and provenance.get('package_root') == '/opt/fullmag/package'
        and provenance.get('backend_build_receipt') == '/opt/fullmag/package/backend-build-receipt.json'
        and provenance.get('cargo_profile') == os.environ.get('FULLMAG_BACKEND_CARGO_PROFILE') == 'backend-dev'
        and provenance.get('toolchain_image_id') == os.environ.get('FULLMAG_TOOLCHAIN_IMAGE_ID')
        and receipt.get('toolchain', {}).get('image_id') == provenance['toolchain_image_id']
        and receipt.get('build', {}).get('cargo_profile') == 'backend-dev', 'Canonical runtime provenance/development identity differs')
root = store/manifest['root_relative']
found = {}
for directory, directories, files in os.walk(root, followlinks=False):
    for child in directories:
        require(not pathlib.Path(directory, child).is_symlink(), 'Private epoch symlink directory')
    for name in files:
        path = pathlib.Path(directory, name)
        fd = probe._open_nofollow(path, os.O_RDONLY | os.O_NONBLOCK)
        try:
            before = os.fstat(fd)
            require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1, 'Private epoch requires one regular inode')
            digest = hashlib.sha256()
            count = 0
            while True:
                chunk = os.read(fd, 65536)
                if not chunk:
                    break
                digest.update(chunk); count += len(chunk)
            after = os.fstat(fd)
            require((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)
                    == (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns)
                    and count == before.st_size, 'Private epoch changed during pre-stop read')
            found[path.relative_to(root).as_posix()] = dict(bytes=count, sha256=digest.hexdigest())
            require(len(found) <= 100000, 'Private epoch exceeds manifest bound')
        finally:
            os.close(fd)
require(found == manifest['files'], 'Private epoch inventory differs')
sdk = pathlib.Path('/usr/local/cuda').resolve(strict=True)
stub = next((p.resolve(strict=True) for p in (sdk/'targets/x86_64-linux/lib/stubs/libcuda.so', sdk/'lib64/stubs/libcuda.so') if p.is_file()), None)
require(stub is not None and 'stubs' in stub.relative_to(sdk).parts, 'Image SDK administrative loader unavailable')
stub_raw = probe.read_regular(stub, 2*1024*1024)
require(stub_raw, 'Empty SDK administrative loader')
pinned(owner_path, request['pins']['owner_sha256'])
pinned(context['request_path'], context['request_sha256'])
print(json.dumps(dict(schema_version='fullmag.claimed-interruption-prestop.v1',
    request_sha256=context['request_sha256'], owner_sha256=request['pins']['owner_sha256'],
    preserved_files_manifest_sha256=request['pins']['preserved_files_manifest_sha256'],
    stub_sha256=hashlib.sha256(stub_raw).hexdigest(), mutated=False), sort_keys=True))
'''


def _inspect(kind, target):
    rows = json.loads(docker_capture(kind, 'inspect', target, timeout=60).stdout)
    require(isinstance(rows, list) and len(rows) == 1 and isinstance(rows[0], dict), 'Exactly one inspect identity required')
    return rows[0]


def _engine():
    return _json_object(docker_capture('info', '--format', '{{json .}}', timeout=60).stdout, 'Engine')


def _publish(control, relative, value):
    raw = canonical(value)+b'\n'
    _publish_immutable(control, relative, raw)
    return hashlib.sha256(raw).hexdigest()


def _maintenance(control, operation, *, spec, name, native, phase):
    args = namespace.create_args(spec, name=name)
    # The operation is already daemon_pending before any side-effecting call.
    created = docker_capture(*args, timeout=60).stdout.decode().strip()
    require(re.fullmatch(r'[0-9a-f]{64}', created), 'Maintenance create returned no exact ID')
    operation['receipt'][phase+'_container_id'] = created
    control.write(operation['root']+'/receipt.json', operation['receipt'])
    actual = _inspect('container', created)
    validate_maintenance(actual, spec, name=name, container_id=created)
    _publish(control, operation['root']+'/'+phase+'-created-inspect.json', actual)
    validate_target(native, _engine(), _inspect('container', native['interruption']['container']['container_id']), stopped=True)
    docker_capture('start', created, timeout=60)
    deadline = time.monotonic()+300
    while True:
        actual = _inspect('container', created)
        if actual['State'].get('Status') == 'exited':
            break
        require(actual.get('Id') == created and actual.get('Image') == spec['image']
                and actual['State'].get('Running') is True and time.monotonic() < deadline, 'Maintenance process outcome uncertain')
        # Docker wait has bounded calls. Timeout is uncertain and retains all
        # evidence/lease; there is deliberately no start or native retry.
        docker_capture('wait', created, timeout=60)
    _publish(control, operation['root']+'/'+phase+'-exited-inspect.json', actual)
    output = docker_capture('logs', created, timeout=60)
    require(len(output.stdout)+len(output.stderr) <= 64*1024, 'Maintenance output exceeds durable observation budget')
    _publish(control, operation['root']+'/'+phase+'-native-output.json',
             dict(stdout=output.stdout.decode('utf-8', 'replace'), stderr=output.stderr.decode('utf-8', 'replace')))
    validate_maintenance(actual, spec, name=name, container_id=created, exited=True)
    require(not output.stderr, 'Maintenance stderr is not an exact native acknowledgement')
    acknowledgement = validate_native_result(output.stdout, native, verify_only=spec['context']['verify_only'])
    _publish(control, operation['root']+'/'+phase+'-native-ack.json', acknowledgement)
    # Check ownership and factual exit again immediately before exact cleanup.
    validate_maintenance(_inspect('container', created), spec, name=name, container_id=created, exited=True)
    docker_capture('rm', created, timeout=60)
    return acknowledgement


def run(args):
    from docker_dev import _select_source, _compose_identity
    from docker_dev_host import require_host
    from docker_volume_reconcile import fingerprint
    require_host()
    require(re.fullmatch(r'[0-9a-f]{64}', args.backend_container_id)
            and re.fullmatch(r'sha256:[0-9a-f]{64}', args.image_id), 'Exact backend/image pins required')
    require(re.fullmatch(r'\.backend-package-candidate-[A-Za-z0-9_-][A-Za-z0-9._-]*', args.candidate_basename), 'Exact candidate basename required')
    selected, layout = _select_source(Path(args.source_root), str(args.source_root))
    identity = _compose_identity(layout)
    control = BuildControl(identity, args.image_id)
    _inspect('volume', control.volume)  # Never allocate/prepare a group.
    authority = prepared_authority(args, control)
    native, root = authority['native'], authority['root']
    guest_request = repair.backend_control_path(control.path(args.request_path))
    guest_manifest = repair.backend_control_path(control.path(root+'/preserved-files.json'))
    inputs = {key: str(getattr(args, key)) for key in ('source_root', 'backend_container_id', 'image_id',
              'request_path', 'request_sha256', 'candidate_basename', 'prepared_phase_root', 'prepared_result_sha256')}
    inputs['use_installed_package'] = bool(args.use_installed_package)
    inputs['source_root'] = str(selected)
    inputs['interruption_sha256'] = pure.canonical_request_sha256(native['interruption'])
    source_hashes = {Path(module.__file__).name: hashlib.sha256(Path(module.__file__).read_bytes()).hexdigest()
                     for module in (namespace, pure, prepare, repair)}
    source_hashes[Path(__file__).name] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    with control.operation('claimed-interruption-complete', inputs) as operation:
        authority_again = prepared_authority(args, control)
        require(authority_again == authority, 'Prepared authority changed under operation')
        before_engine = _engine()
        before = _inspect('container', args.backend_container_id)
        repair.validate_backend(before, identity, args.backend_container_id, args.image_id)
        validate_target(native, before_engine, before, stopped=False)
        context = dict(request_path=guest_request, request_sha256=args.request_sha256, manifest_path=guest_manifest,
                       candidate_basename=args.candidate_basename, use_installed_package=bool(args.use_installed_package))
        preflight = docker_capture('exec', args.backend_container_id, '/usr/local/bin/python3', '-B', '-c',
                                   PREFLIGHT, json.dumps(context), timeout=60)
        proof = _json_object(preflight.stdout, 'pre-stop proof')
        expected = dict(schema_version='fullmag.claimed-interruption-prestop.v1', request_sha256=args.request_sha256,
                        owner_sha256=native['interruption']['pins']['owner_sha256'],
                        preserved_files_manifest_sha256=native['interruption']['pins']['preserved_files_manifest_sha256'],
                        stub_sha256=proof.get('stub_sha256'), mutated=False)
        require(proof == expected, 'Pre-stop exact proof differs')
        namespace.digest(proof['stub_sha256'])
        fresh = _inspect('container', args.backend_container_id)
        validate_target(native, _engine(), fresh, stopped=False)
        require(fingerprint(fresh) == fingerprint(before), 'Backend changed during pre-stop observation')
        # Check every required mount before a real stop. No synthetic Engine
        # terminal state or hypothetical namespace-exit proof is constructed.
        for destination in [*namespace.MOUNTS, namespace.CONTROL]:
            namespace._mount(before, destination)
        require(re.fullmatch(r'/opt/fullmag/control/verification/claimed-interruption/[0-9a-f]{32}/request\.json', guest_request),
                'Backend request mount path is not the canonical verified namespace')
        attestation_relative = root+'/attestation.json'
        helper_kwargs = dict(project=control.project, request_path=guest_request, config_path=namespace.CONFIG,
                             attestation_path=repair.backend_control_path(control.path(attestation_relative)),
                             request_sha256=args.request_sha256, attestation_sha256='0'*64,
                             stub_sha256=proof['stub_sha256'], candidate_basename=args.candidate_basename,
                             use_installed_package=bool(args.use_installed_package))
        for suffix, value in [('before-inspect', before), ('before-engine', before_engine),
                              ('prepared-proof', json.loads(authority['prepared_raw'])),
                              ('prestop-proof', proof), ('source-helpers', source_hashes)]:
            _publish(control, operation['root']+'/'+suffix+'.json', value)
        operation['daemon_pending'] = True
        operation['receipt'].update(state='stopping-exact-backend', backend_container_id=args.backend_container_id)
        control.write(operation['root']+'/receipt.json', operation['receipt'])
        docker_capture('stop', '--time', '30', args.backend_container_id, timeout=60)
        after_engine = _engine()
        after = _inspect('container', args.backend_container_id)
        document, attestation = make_attestation(native, before_engine, after_engine, before, after, authority['manifest'])
        _publish(control, operation['root']+'/after-inspect.json', after)
        _publish(control, operation['root']+'/after-engine.json', after_engine)
        _publish(control, operation['root']+'/inspection-document.json', document)
        helper_kwargs['attestation_sha256'] = _publish(control, attestation_relative, attestation)
        spec = namespace.maintenance_spec(after, native, **helper_kwargs)
        _publish(control, operation['root']+'/maintenance-spec.json', spec)
        stem = 'fullmag-claimed-'+operation['receipt']['attempt']
        result = _maintenance(control, operation, spec=spec, name=stem+'-complete', native=native, phase='complete')
        spec['context']['verify_only'] = True
        verified = _maintenance(control, operation, spec=spec, name=stem+'-verify', native=native, phase='verify')
        validate_target(native, _engine(), _inspect('container', args.backend_container_id), stopped=True)
        terminal = dict(schema_version='fullmag.claimed-interruption-complete.v1', state='interrupted-no-final-state',
                        request_path=args.request_path, request_sha256=args.request_sha256,
                        interruption_sha256=inputs['interruption_sha256'], native_result=result, native_verification=verified,
                        attestation_path=attestation_relative, attestation_sha256=helper_kwargs['attestation_sha256'],
                        backend_container_id=args.backend_container_id, runtime_started=False, solve_replayed=False,
                        final_state_available=False, operation_root=operation['root'])
        _publish(control, operation['root']+'/result.json', terminal)
        operation['receipt'].update(state='succeeded', complete_result=terminal)
        operation['daemon_pending'] = False
        return terminal


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', type=Path, required=True)
    parser.add_argument('--use-installed-package', action='store_true')
    for key in ('backend-container-id', 'image-id', 'request-path', 'request-sha256', 'candidate-basename',
                'prepared-phase-root', 'prepared-result-sha256'):
        parser.add_argument('--'+key, required=True)
    args = parser.parse_args(argv)
    try:
        print(json.dumps(run(args), sort_keys=True))
        return 0
    except (BuildControlError, ValueError, KeyError, OSError) as error:
        parser.exit(1, 'claimed-interruption-complete: '+str(error)+'\n')


if __name__ == '__main__':
    raise SystemExit(main())
