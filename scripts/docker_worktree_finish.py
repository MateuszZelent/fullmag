"""Docker cache retirement required before a registered worktree is completed."""
import hashlib
import json
from pathlib import Path
import re
import shlex
import uuid

from docker_build_control import (BuildControl, BuildControlError, ControlOutcomeUnknown,
    MIN_FREE_CONTROL_BYTES, bounded_capture, docker_capture, toolchain_configuration)
from docker_compose_identity import compose_project_identity
from docker_named_volume_safety import validate_local_named_volume
import docker_shared_build_storage as shared


def _retire_groups(control, selected, unit_keys, operation):
    if not unit_keys:
        return {'state': 'succeeded', 'unit_keys': []}
    receipt = (control.read('image-backend/verified.json', optional=True)
               or control.read('image-backend/current.json', optional=True))
    if (not isinstance(receipt, dict) or receipt.get('state') != 'succeeded'
            or receipt.get('compose_project') != control.project or receipt.get('control_volume') != control.volume
            or re.fullmatch(r'sha256:[a-f0-9]{64}', receipt.get('image_id', '')) is None):
        raise BuildControlError('Retirement requires the retained immutable backend helper image')
    image = json.loads(docker_capture('image', 'inspect', receipt['image_id']).stdout)
    if len(image) != 1 or image[0]['Id'] != receipt['image_id']:
        raise BuildControlError('Retirement helper image differs')
    names = shared.shared_volume_names(control.identity['project_id'])
    volume = names[shared.PACKAGE_ROLE]
    observed = json.loads(docker_capture('volume', 'inspect', volume).stdout)
    if len(observed) != 1:
        raise BuildControlError('Shared package volume is ambiguous')
    validate_local_named_volume(observed[0], volume)
    if any(observed[0].get('Labels', {}).get(k) != v for k, v in shared.shared_volume_labels(control.identity['project_id'], shared.PACKAGE_ROLE).items()):
        raise BuildControlError('Shared package labels differ before retirement')
    helpers = selected / 'docker/all-in-one'
    hashes = {name: hashlib.sha256((helpers / name).read_bytes()).hexdigest()
              for name in ('backend_shared_store.py', 'backend_group_retirement.py')}
    code = '''import hashlib,json,pathlib,sys
source=pathlib.Path('/opt/fullmag/retirement-helpers')
expected=json.loads(sys.argv[1])
def hashes(): return {name:hashlib.sha256((source/name).read_bytes()).hexdigest() for name in expected}
if hashes()!=expected: raise RuntimeError('retirement helper sources changed')
sys.path.insert(0,str(source))
from backend_group_retirement import retire
archive=pathlib.Path('/control/cache-retirement/group-intents')
archive.mkdir(parents=True,exist_ok=True)
result=retire(pathlib.Path('/opt/fullmag/shared-backend'),json.loads(sys.argv[2]),sys.argv[3],archive)
if hashes()!=expected: raise RuntimeError('retirement helper sources changed during execution')
print(json.dumps(result))
'''
    command = '/usr/local/bin/python3 -B -c ' + shlex.quote(code) + ' ' + shlex.quote(json.dumps(hashes)) + ' ' + shlex.quote(json.dumps(unit_keys)) + ' ' + shlex.quote(volume)
    probe = BuildControl(control.identity, receipt['image_id'])
    name = 'fullmag-group-retirement-' + uuid.uuid4().hex
    args = probe.helper_args(command, name=name)
    args[args.index('--entrypoint'):args.index('--entrypoint')] = [
        '--volume', str(helpers)+':/opt/fullmag/retirement-helpers:ro',
        '--mount', 'type=volume,src='+volume+',dst=/opt/fullmag/shared-backend,volume-nocopy']
    args[args.index('--memory')+1] = '256m'
    operation['daemon_pending'] = True
    result = bounded_capture(args, data=b'', timeout=600, maximum=1024*1024)
    if result.returncode:
        raise ControlOutcomeUnknown('Group retirement did not confirm completion; preserve plan and retry after inspecting helper '+name+': '+result.stderr.decode(errors='replace')[-2048:])
    proof = json.loads(result.stdout)
    if proof.get('state') != 'succeeded' or proof.get('unit_keys') != unit_keys:
        raise ControlOutcomeUnknown('Group retirement returned an unbound receipt')
    operation['daemon_pending'] = False
    proof['helper_source_sha256'] = hashes
    return proof


def finish(layout, task_id, owner):
    """Called under storage's worktree lock after exact registry owner validation."""
    from docker_cache_retirement import retire
    identity = compose_project_identity(layout)
    if identity['checkout_kind'] != 'worktree':
        raise BuildControlError('Automatic worktree completion cannot retire the main checkout')
    selected = Path(identity['source_root'])
    configured = toolchain_configuration(selected, identity)
    control = BuildControl(identity, configured['services']['fem-gpu-toolchain']['build']['args']['FULLMAG_CUDA_BASE_IMAGE'])
    control.prepare(minimum_free_bytes=MIN_FREE_CONTROL_BYTES)
    result = retire(control, layout, task_id, owner,
        retire_namespaces=lambda keys, operation: _retire_groups(control, selected, keys, operation))
    return {'state': result['state'], 'compose_project': control.project,
            'receipt': 'docker-volume://'+control.volume+'/'+control.subpath('cache-retirement/result.json')}
