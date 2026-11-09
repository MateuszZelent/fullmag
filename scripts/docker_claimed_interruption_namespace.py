"""Pure Linux administrative namespace specification; no Engine lifecycle calls.

The caller owns authoritative Engine inspection/attestation, stopped-target CAS,
container create/start/removal, bounded output and exact native acknowledgement.
This helper never stops a backend or permits ordinary native runtime startup.
"""
from __future__ import annotations

import json
from pathlib import Path, PurePosixPath
import re
from copy import deepcopy

import docker_claimed_worker_interruption as claimed
import docker_orphan_recovery as recovery

CONFIG = '/opt/fullmag/runtime-control/runtime-service/docker-all.json'
PROBE = '/state/.linux-native-probe.json'
CONTROL = '/opt/fullmag/control'
PROVENANCE_DIRECTORY = CONTROL+'/backend'
ENGINE_BIND_PARENT = '/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/'
ENGINE_BIND_RE = re.compile(re.escape(ENGINE_BIND_PARENT)+'Ubuntu2/[0-9a-f]{64}')
MOUNTS = {
    '/state': False,
    '/opt/fullmag/runtime-control': False,
    '/state/runs/docker-all/session-store/runtime-services': False,
    '/host-ledger': False,
    '/opt/fullmag/package': True,
    '/run/fullmag/linux-native-host.json': True,
}
ENV_NAMES = frozenset({
    'FULLMAG_SESSION_STORAGE_PROFILE', 'FULLMAG_RUNTIME_IMAGE_ID',
    'FULLMAG_HOST_LEDGER_PROFILE', 'FULLMAG_HOST_LEDGER_PROJECT_ID',
    'FULLMAG_HOST_LEDGER_ROOT', 'FULLMAG_GROUP_LEDGER_HOST_ID',
    'FULLMAG_DOCKER_HOST_ID', 'FULLMAG_DOCKER_HOST_EXECUTION',
    'FULLMAG_STATE_ROOT', 'FULLMAG_STATE_DIR', 'FULLMAG_PROJECT_STORAGE_ROOT',
    'FULLMAG_RUNS_ROOT', 'FULLMAG_COMPOSE_PROJECT', 'FULLMAG_WORKTREE_ID',
    'FULLMAG_TOOLCHAIN_IMAGE_ID', 'FULLMAG_BACKEND_CARGO_PROFILE',
})
FIXED_ENV = {'FULLMAG_DOCKER_ROLE': 'backend-recovery', 'FULLMAG_STARTUP_ENABLED': '0',
             'NVIDIA_VISIBLE_DEVICES': 'void', 'CUDA_VISIBLE_DEVICES': ''}


def require(value, message):
    if not value:
        raise ValueError(message)


def digest(value):
    require(isinstance(value, str) and re.fullmatch(r'[0-9a-f]{64}', value), 'Exact lowercase SHA256 required')
    return value


def safe_path(value, *, absolute=True):
    require(isinstance(value, str) and value and not any(c in value for c in ',\\\n\r\x00'), 'Unsafe mount/path syntax')
    path = PurePosixPath(value)
    require(path.is_absolute() == absolute and str(path) == value
            and '..' not in path.parts and value != '/' and value != '.', 'Path must be canonical without traversal/root')
    return path


def _bind_source(value):
    safe_path(value)
    if value.startswith(ENGINE_BIND_PARENT):
        # Docker Desktop's Engine-owned WSL bind handles live in the daemon's
        # namespace, outside the host agent's filesystem. Only this exact known
        # handle form is admitted, after _mount checks typed/resolved equality.
        # It is never treated as host filesystem proof. Native completion still
        # requires fresh actual-namespace admission and the historical certificate.
        require(ENGINE_BIND_RE.fullmatch(value), 'Invalid Engine-owned WSL bind handle')
        return
    path = Path(value)
    try:
        require(path.resolve(strict=True) == path, 'Bind source contains a symlink')
        for ancestor in (path, *path.parents):
            require(not ancestor.is_symlink(), 'Bind source contains a symlink')
    except OSError as error:
        raise ValueError('Bind source lacks accessible host filesystem proof') from error


def _mount(target, destination):
    declared = [m for m in target['HostConfig'].get('Mounts', []) if m.get('Target') == destination]
    observed = [m for m in target.get('Mounts', []) if m.get('Destination') == destination]
    require(len(declared) == len(observed) == 1, 'Required mount missing or duplicated: '+destination)
    declaration, actual = declared[0], observed[0]
    require(declaration.get('Type') == actual.get('Type') in {'volume', 'bind'}, 'Mount type differs')
    require(declaration.get('ReadOnly', False) is (not actual.get('RW')), 'Mount access differs')
    item = {'type': actual['Type'], 'target': destination, 'read_only': declaration.get('ReadOnly', False)}
    if actual['Type'] == 'volume':
        source = declaration.get('Source')
        require(isinstance(source, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]+', source)
                and actual.get('Name') == source and actual.get('Driver') == 'local', 'Volume source/driver differs')
        options = declaration.get('VolumeOptions', {})
        require(isinstance(options, dict) and set(options) <= {'NoCopy', 'Subpath'}, 'Ambiguous volume options')
        subpath = options.get('Subpath')
        require(subpath is not None or destination == CONTROL, 'Root volume exposes an ambiguous/shared namespace')
        if subpath is not None:
            safe_path(subpath, absolute=False)
        item.update(source=source, subpath=subpath)
    else:
        source = declaration.get('Source')
        require(actual.get('Source') == source, 'Bind source differs')
        require(set(declaration.get('BindOptions', {})) <= {'Propagation', 'NonRecursive', 'CreateMountpoint'}
                and not declaration.get('BindOptions', {}).get('CreateMountpoint', False)
                and not declaration.get('BindOptions', {}).get('NonRecursive', False)
                and declaration.get('BindOptions', {}).get('Propagation', 'rprivate') == 'rprivate', 'Unsafe bind options')
        _bind_source(source)
        item.update(source=source, subpath=None)
    return item


# Executed exclusively in the immutable selected image. All Python helpers are
# image-local; no checkout, backend cache, shared root, or GPU is mounted.
EXECUTOR = r'''
import hashlib, json, os, pathlib, re, sys, tempfile
sys.path.insert(0, '/opt/fullmag')
import linux_native_probe
context = json.loads(sys.argv[1])
def require(value, message):
    if not value:
        raise RuntimeError(message)
def read(path, maximum=1024*1024):
    return linux_native_probe.read_regular(path, maximum)
def pinned(path, expected, maximum=1024*1024):
    raw = read(path, maximum)
    require(hashlib.sha256(raw).hexdigest() == expected, 'Pinned bytes differ: '+str(path))
    return raw
require(not any(pathlib.Path('/dev').glob('nvidia*')) and not pathlib.Path('/dev/dxg').exists(),
        'Administrative namespace must not receive GPU devices')
raw = pinned(context['request_path'], context['request_sha256'])
request = json.loads(raw)
interruption = request['interruption']
pins = interruption['pins']
require(interruption['container']['container_id'] == context['container_id']
        and interruption['container']['image_id'] == context['image_id']
        and interruption['container_started_at'] == context['started_at'], 'Request incarnation differs')
pinned(context['config_path'], pins['config_sha256'])
pinned(context['attestation_path'], context['attestation_sha256'])
package = (pathlib.Path('/opt/fullmag/package') if context['use_installed_package']
           else pathlib.Path('/opt/fullmag/package/.development/candidates') / context['candidate_basename'])
receipt = json.loads(pinned(package/'backend-build-receipt.json', pins['package_receipt_sha256'], 8*1024*1024))
binary = package/'bin/fullmag-runtime-service'
executable = pinned(binary, pins['executable_sha256'], 512*1024*1024)
artifacts = [a for a in receipt.get('artifacts', []) if a.get('path') == 'bin/fullmag-runtime-service']
require(receipt.get('schema') == 'fullmag.direct-compose.backend-build-receipt.v1'
        and receipt.get('state') == 'succeeded'
        and receipt.get('source', {}).get('resolved_commit') == request['build_commit']
        and receipt.get('source', {}).get('source_snapshot_sha256') == pins['source_snapshot_sha256']
        and len(artifacts) == 1 and artifacts[0].get('sha256') == pins['executable_sha256']
        and artifacts[0].get('size') == len(executable), 'Candidate receipt/executable lineage differs')

provenance = json.loads(read('/opt/fullmag/control/backend/runtime-provenance.json', 8*1024*1024))
require(provenance.get('schema') == 'fullmag.docker-all-image.v1'
        and provenance.get('state') == 'succeeded' and provenance.get('source_mode') == 'live-shadow-v1'
        and provenance.get('commit') == request['build_commit']
        and provenance.get('source_snapshot_sha256') == pins['source_snapshot_sha256']
        and provenance.get('build_receipt_sha256') == pins['package_receipt_sha256']
        and provenance.get('package_root') == '/opt/fullmag/package'
        and provenance.get('backend_build_receipt') == '/opt/fullmag/package/backend-build-receipt.json'
        and provenance.get('cargo_profile') == os.environ.get('FULLMAG_BACKEND_CARGO_PROFILE') == 'backend-dev'
        and provenance.get('toolchain_image_id') == os.environ.get('FULLMAG_TOOLCHAIN_IMAGE_ID')
        and receipt.get('toolchain', {}).get('image_id') == provenance['toolchain_image_id']
        and receipt.get('build', {}).get('cargo_profile') == 'backend-dev', 'Canonical runtime provenance/development identity differs')
root = pathlib.Path('/usr/local/cuda').resolve(strict=True)
stub = next((p.resolve(strict=True) for p in (
    root/'targets/x86_64-linux/lib/stubs/libcuda.so', root/'lib64/stubs/libcuda.so'
) if p.is_file()), None)
require(stub is not None and 'stubs' in stub.relative_to(root).parts, 'CUDA SDK stub unavailable')
pinned(stub, context['stub_sha256'], 2*1024*1024)
temporary = pathlib.Path(tempfile.mkdtemp(prefix='fullmag-claimed-admin-', dir='/tmp'))
(temporary/'libcuda.so.1').symlink_to(stub)
environment = dict(os.environ)
environment['LD_LIBRARY_PATH'] = str(temporary)+':/usr/local/cuda/lib64:/usr/local/cuda/targets/x86_64-linux/lib'
environment['FULLMAG_RECOVERY_NONCOMPUTE_LOADER'] = 'cuda-sdk-stub'
fresh = linux_native_probe.run(require_restart=True)
probe = read('/state/.linux-native-probe.json')
require(json.loads(probe) == fresh, 'Fresh actual-namespace storage probe readback differs')
pinned(context['request_path'], context['request_sha256'])
pinned(context['attestation_path'], context['attestation_sha256'])
arguments = [str(binary), '--complete-claimed-interruption', '--config', context['config_path'],
    '--request', context['request_path'], '--request-sha256', context['request_sha256'],
    '--attestation', context['attestation_path'], '--attestation-sha256', context['attestation_sha256'],
    '--storage-probe', '/state/.linux-native-probe.json',
    '--storage-probe-sha256', hashlib.sha256(probe).hexdigest()]
if context['verify_only']:
    arguments.append('--verify-only')
os.execve(binary, arguments, environment)
'''


def maintenance_spec(target, native_request, *, project, request_path, config_path,
                     attestation_path, request_sha256, attestation_sha256,
                     stub_sha256, candidate_basename, verify_only=False, use_installed_package=False):
    """Derive a closed spec from exact stopped inspect and pinned native request.

    Native request bytes are authenticated by the guest, not reserialized here.
    Bind sources require host filesystem proof, except exact Engine-owned WSL
    handles matched by typed/resolved inspection. Native fresh admission remains
    mandatory for those handles; this builder supplies no host filesystem proof.
    HostConfig.Mounts is mandatory: legacy Binds cannot hide volume subpaths.
    """
    interruption = claimed.validate_request(native_request['interruption'])
    require(project == interruption['container']['compose_project']
            and re.fullmatch(r'fullmag-(?:master|worktree-[a-z0-9._-]+)', project), 'Compose project differs')
    recovery._observed_container(interruption['container'], target, stopped=True)
    require(target['State']['StartedAt'] == interruption['container_started_at'], 'Stopped target StartedAt differs')
    require(not target['State'].get('Paused', False) and not target['State'].get('Restarting', False), 'Stopped target is transitional')
    require(config_path == CONFIG and type(verify_only) is bool and type(use_installed_package) is bool, 'Only canonical native complete options permitted')
    require(re.fullmatch(r'\.backend-package-candidate-[A-Za-z0-9_-][A-Za-z0-9._-]*', candidate_basename), 'Unsafe candidate basename')
    request_file = safe_path(request_path)
    request_dir = request_file.parent
    require(re.fullmatch(r'/opt/fullmag/control/verification/claimed-interruption/[0-9a-f]{32}', str(request_dir)), 'Request must use its exact control verification directory')
    require(safe_path(attestation_path).parent == request_dir and attestation_path != request_path, 'Attestation must be separate in request directory')
    typed = target['HostConfig'].get('Mounts')
    require(isinstance(typed, list) and all(isinstance(m, dict) for m in typed), 'Typed backend mounts required')
    require(len({m.get('Target') for m in typed}) == len(typed), 'Duplicate typed mount target')
    require(len({m.get('Destination') for m in target.get('Mounts', [])}) == len(target.get('Mounts', [])), 'Duplicate resolved mount target')
    mounts = []
    for destination, readonly in MOUNTS.items():
        item = _mount(target, destination)
        require(readonly or item['read_only'] is False, 'Writable native metadata mount required')
        item['read_only'] = readonly
        mounts.append(item)
    control = _mount(target, CONTROL)
    # Expose only the two required metadata directories, never the control
    # namespace root or private backend compiler/cache storage.
    for destination in (str(request_dir), PROVENANCE_DIRECTORY):
        derived = deepcopy(control)
        suffix = str(PurePosixPath(destination).relative_to(CONTROL))
        if derived['type'] == 'volume':
            derived['subpath'] = '/'.join(part for part in (derived['subpath'], suffix) if part)
            safe_path(derived['subpath'], absolute=False)
        else:
            derived['source'] = str(Path(derived['source']) / suffix)
            _bind_source(derived['source'])
        derived.update(target=destination, read_only=True)
        mounts.append(derived)
    environment = {}
    for entry in target['Config'].get('Env', []):
        key, separator, value = entry.partition('=')
        if separator and key in ENV_NAMES:
            require(key not in environment, 'Duplicate inherited environment key')
            environment[key] = value
    require(environment.get('FULLMAG_SESSION_STORAGE_PROFILE') == 'linux-native-v1'
            and environment.get('FULLMAG_COMPOSE_PROJECT') == project
            and environment.get('FULLMAG_BACKEND_CARGO_PROFILE') == 'backend-dev'
            and re.fullmatch(r'sha256:[0-9a-f]{64}', environment.get('FULLMAG_TOOLCHAIN_IMAGE_ID', '')), 'Linux group/development identity environment differs')
    environment.update(FIXED_ENV)
    context = dict(request_path=request_path, request_sha256=digest(request_sha256),
                   config_path=config_path, attestation_path=attestation_path,
                   attestation_sha256=digest(attestation_sha256), stub_sha256=digest(stub_sha256),
                   candidate_basename=candidate_basename, verify_only=verify_only,
                   use_installed_package=use_installed_package,
                   container_id=target['Id'], image_id=target['Image'], started_at=target['State']['StartedAt'])
    return dict(project=project, image=target['Image'], user=target['Config'].get('User', ''),
                package_role='installed' if use_installed_package else 'candidate',
                environment=environment, mounts=mounts, context=context)


def create_args(spec, *, name):
    """Return docker create arguments only. Never calls Docker or accepts native flags."""
    require(set(spec) == {'project', 'image', 'user', 'environment', 'mounts', 'context', 'package_role'}, 'Unknown maintenance fields/devices')
    require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', name), 'Unsafe maintenance name')
    require(re.fullmatch(r'sha256:[0-9a-f]{64}', spec['image']), 'Immutable image required')
    require(re.fullmatch(r'fullmag-(?:master|worktree-[a-z0-9._-]+)', spec['project']), 'Invalid Compose project')
    context = spec['context']
    require(set(context) == {'request_path', 'request_sha256', 'config_path', 'attestation_path',
                            'attestation_sha256', 'stub_sha256', 'candidate_basename', 'verify_only',
                            'container_id', 'image_id', 'started_at', 'use_installed_package'}, 'Arbitrary native flags forbidden')
    require(type(context['use_installed_package']) is bool
            and spec['package_role'] == ('installed' if context['use_installed_package'] else 'candidate'), 'Package role/context disagreement')
    require(context['image_id'] == spec['image'] and type(context['verify_only']) is bool
            and context['config_path'] == CONFIG, 'Complete command context differs')
    for key in ('request_sha256', 'attestation_sha256', 'stub_sha256'):
        digest(context[key])
    require(re.fullmatch(r'[0-9a-f]{64}', context['container_id'])
            and isinstance(context['started_at'], str) and context['started_at'], 'Exact container incarnation required')
    require(re.fullmatch(r'\.backend-package-candidate-[A-Za-z0-9_-][A-Za-z0-9._-]*', context['candidate_basename']), 'Unsafe candidate basename')
    request_dir = safe_path(context['request_path']).parent
    require(re.fullmatch(r'/opt/fullmag/control/verification/claimed-interruption/[0-9a-f]{32}', str(request_dir))
            and safe_path(context['attestation_path']).parent == request_dir
            and context['attestation_path'] != context['request_path'], 'Complete request/attestation scope differs')
    args = ['create', '--name', name, '--pull', 'never', '--network', 'none', '--ipc', 'private',
            '--pid', 'private', '--runtime', 'runc', '--read-only', '--init', '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges:true', '--no-healthcheck',
            '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m']
    if spec['user']:
        args += ['--user', spec['user']]
    environment = spec['environment']
    require(set(environment) <= ENV_NAMES | FIXED_ENV.keys()
            and all(environment.get(k) == v for k, v in FIXED_ENV.items())
            and environment.get('FULLMAG_BACKEND_CARGO_PROFILE') == 'backend-dev'
            and re.fullmatch(r'sha256:[0-9a-f]{64}', environment.get('FULLMAG_TOOLCHAIN_IMAGE_ID', '')), 'Unsafe maintenance environment')
    for key, value in sorted(environment.items()):
        args += ['--env', key+'='+value]
    args += ['--label', 'com.docker.compose.project='+spec['project'],
             '--label', 'com.docker.compose.service=backend-recovery',
             '--label', 'fullmag.recovery.target_container='+context['container_id']]
    expected = set(MOUNTS) | {str(safe_path(context['request_path']).parent), PROVENANCE_DIRECTORY}
    require(len(spec['mounts']) == len(expected) and {m['target'] for m in spec['mounts']} == expected, 'Maintenance mount scope differs')
    for item in spec['mounts']:
        require(set(item) == {'type', 'source', 'target', 'read_only', 'subpath'}, 'Ambiguous typed mount')
        safe_path(item['target'])
        require(item['read_only'] is MOUNTS.get(item['target'], True), 'Maintenance mount access differs')
        if item['type'] == 'volume':
            require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]+', item['source']), 'Unsafe volume name')
            mount = f"type=volume,src={item['source']},dst={item['target']},volume-nocopy"
            if item['subpath'] is not None:
                safe_path(item['subpath'], absolute=False)
                mount += ',volume-subpath='+item['subpath']
        else:
            require(item['type'] == 'bind' and item['subpath'] is None, 'Unsafe mount type')
            _bind_source(item['source'])
            mount = f"type=bind,src={item['source']},dst={item['target']}"
        if item['read_only']:
            mount += ',readonly'
        args += ['--mount', mount]
    args += ['--entrypoint', '/usr/local/bin/python3', spec['image'], '-B', '-c', EXECUTOR,
             json.dumps(context, sort_keys=True, separators=(',', ':'))]
    return args
