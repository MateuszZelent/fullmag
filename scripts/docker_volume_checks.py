"""Run interpreted control checks in the selected DEV service or offline helper."""
import argparse
import json
import re
import shlex
import uuid
from pathlib import Path, PurePosixPath
import sys

import fullmag_storage as storage
from docker_build_control import (
    BuildControl, BuildControlError, ControlOutcomeUnknown, bounded_capture, canonical, docker_capture, mirror_console,
)
from docker_compose_identity import compose_project_identity, validate_source_labels


BASE_IMPLEMENTATIONS = ('docker_build_control', 'docker_volume_dev', 'docker_volume_activate',
                        'docker_volume_stop_failed', 'docker_volume_checks')
OPTIONAL_IMPLEMENTATIONS = ('docker_volume_activation_reconcile', 'docker_volume_accepted_reattach')


def _validate_offline_result(value, modules, *, implementations=BASE_IMPLEMENTATIONS):
    expected = {'exit_code', 'source_inputs_stable', 'source_files',
                'source_mount_readonly', 'control_mount_writable', 'tmpdir', 'stdout', 'stderr'}
    if not isinstance(value, dict) or set(value) != expected:
        raise BuildControlError('Offline check result fields differ')
    code = value['exit_code']
    if type(code) is not int or not -255 <= code <= 255:
        raise BuildControlError('Offline check exit code is invalid')
    for flag in ('source_inputs_stable', 'source_mount_readonly', 'control_mount_writable'):
        if value[flag] is not True:
            raise BuildControlError('Offline check did not confirm ' + flag)
    if value['tmpdir'] != '/control/verification/offline-check-tmp':
        raise BuildControlError('Offline check temporary path differs')
    if not isinstance(value['stdout'], str) or not isinstance(value['stderr'], str):
        raise BuildControlError('Offline check diagnostics are invalid')
    files = value['source_files']
    if not isinstance(files, dict) or not 1 <= len(files) <= 64:
        raise BuildControlError('Offline check source hashes are missing or unbounded')
    for name, digest in files.items():
        if not isinstance(name, str):
            raise BuildControlError('Offline check source path is invalid')
        path = PurePosixPath(name)
        if (not name.startswith('/opt/fullmag/source/scripts/') or str(path) != name
                or '..' in path.parts or path.suffix != '.py'
                or not isinstance(digest, str) or re.fullmatch(r'[0-9a-f]{64}', digest) is None):
            raise BuildControlError('Offline check source hash is invalid')
    required = set(modules) | set(implementations)
    if any('/opt/fullmag/source/scripts/' + name + '.py' not in files for name in required):
        raise BuildControlError('Offline check source hashes omit required modules')
    return value


def _offline_checks(control, selected, observed, modules):
    """Verify source contracts without starting a stopped application service.

    The short helper is part of the selected Compose group. It has no network,
    daemon socket, GPU, or user-data mount. Only its control volume is writable.
    """
    if observed.get('State', {}).get('Running') is not False:
        raise BuildControlError('Offline checks require a stopped selected backend')
    validate_source_labels(observed, control.identity)
    image = observed.get('Image')
    if not isinstance(image, str) or re.fullmatch(r'sha256:[0-9a-f]{64}', image) is None:
        raise BuildControlError('Offline checks require the immutable retained backend image')
    images = json.loads(docker_capture('image', 'inspect', image).stdout)
    if len(images) != 1 or images[0].get('Id') != image:
        raise BuildControlError('Offline check image identity differs')
    probe = BuildControl(control.identity, image)
    # The volume was validated/prepared above. The probe changes only its
    # executable image, not the project, source identity, or control volume.
    if probe.volume != control.volume:
        raise BuildControlError('Offline checks changed the control volume')
    implementations = list(BASE_IMPLEMENTATIONS)
    implementations += [name for name in OPTIONAL_IMPLEMENTATIONS
                        if (selected / 'scripts' / (name + '.py')).is_file()]
    code = r'''import hashlib,json,os,pathlib,subprocess,sys
root=pathlib.Path('/control/verification/offline-check-tmp')
root.mkdir(parents=True,exist_ok=True)
mounts=[line.split() for line in pathlib.Path('/proc/self/mountinfo').read_text().splitlines()]
source_ro=any(parts[4]=='/opt/fullmag/source' and 'ro' in parts[5].split(',') for parts in mounts)
control_rw=any(parts[4]=='/control' and 'rw' in parts[5].split(',') for parts in mounts)
if not source_ro or not control_rw:
    raise RuntimeError('Offline check source/control mount boundaries differ')
environment={key:value for key,value in os.environ.items() if not key.startswith('FULLMAG_')}
environment.update(TMPDIR=str(root),PYTHONDONTWRITEBYTECODE='1',HOME=str(root/'home'),USER='fullmag-checks',LOGNAME='fullmag-checks')
pathlib.Path(environment['HOME']).mkdir(exist_ok=True)
modules=json.loads(sys.argv[1])
paths=[pathlib.Path('/opt/fullmag/source/scripts')/(name+'.py') for name in modules]
paths += [pathlib.Path('/opt/fullmag/source/scripts')/(name+'.py') for name in json.loads(sys.argv[2])]
def hashes():
    return {str(path):hashlib.sha256(path.read_bytes()).hexdigest() for path in paths}
before=hashes()
result=subprocess.run([sys.executable,'-B','-m','unittest',*modules],cwd='/opt/fullmag/source/scripts',env=environment,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=150)
after=hashes()
print(json.dumps({'exit_code':result.returncode if before==after else 2,'source_inputs_stable':before==after,'source_files':before,'source_mount_readonly':source_ro,'control_mount_writable':control_rw,'tmpdir':str(root),'stdout':result.stdout.decode('utf8','replace'),'stderr':result.stderr.decode('utf8','replace')}))
'''
    command = ('/usr/local/bin/python3 -B -c ' + shlex.quote(code) + ' ' + shlex.quote(json.dumps(modules))
               + ' ' + shlex.quote(json.dumps(implementations)))
    helper_name = 'fullmag-checks-' + uuid.uuid4().hex
    arguments = probe.helper_args(command, name=helper_name)
    # Windows Docker accepts the native drive path as a single argv value.
    # --volume avoids CSV interpolation of source paths containing commas.
    anchor = arguments.index('--entrypoint')
    arguments[anchor:anchor] = ['--volume', str(selected) + ':/opt/fullmag/source:ro']
    # Interpreted Python contracts need more headroom than a shell-only probe.
    arguments[arguments.index('--memory') + 1] = '256m'
    receipt = {'schema': 'fullmag.volume-dev-offline-interpreted-checks.v1',
               'container_id': observed['Id'], 'image_id': image,
               'compose_project': control.project, 'modules': modules,
               'helper_container': helper_name, 'state': 'starting',
               'runtime_qualification': 'NOT VERIFIED'}
    control.write('verification/offline-interpreted-checks.json', receipt)
    try:
        result = bounded_capture(arguments, data=b'', timeout=180, maximum=1024*1024)
    except ControlOutcomeUnknown as error:
        receipt.update(state='outcome-unknown-resources-retained', error=str(error))
        control.write('verification/offline-interpreted-checks.json', receipt)
        raise
    receipt['probe_exit_code'] = result.returncode
    if result.returncode:
        receipt.update(exit_code=result.returncode, stdout=result.stdout.decode('utf8','replace')[-4096:],
                       stderr=result.stderr.decode('utf8','replace')[-4096:])
    else:
        try:
            receipt.update(_validate_offline_result(json.loads(result.stdout), modules, implementations=implementations))
        except (ValueError, UnicodeError, BuildControlError) as error:
            receipt.update(exit_code=2, error=str(error),
                           helper_stdout=result.stdout.decode('utf8','replace')[-4096:],
                           helper_stderr=result.stderr.decode('utf8','replace')[-4096:])
    receipt['state'] = 'succeeded' if receipt['exit_code'] == 0 else 'failed-confirmed'
    control.write('verification/offline-interpreted-checks.json', receipt)
    mirror_console(json.dumps(receipt, ensure_ascii=True) + '\n')
    return receipt['exit_code']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', type=Path, required=True)
    parser.add_argument('--offline', action='store_true', help='Run interpreted checks in a private group helper when backend is stopped')
    parser.add_argument('--modules', nargs='+', help='Explicit unittest modules (offline mode only)')
    args = parser.parse_args()
    if args.offline:
        if sys.platform != 'win32':
            raise BuildControlError('Offline Docker checks require native Windows Python')
        if not args.modules or len(args.modules) > 32 or any(re.fullmatch(r'test_[A-Za-z0-9_]+', module) is None for module in args.modules):
            raise BuildControlError('Offline checks require 1-32 explicit test modules')
    elif args.modules:
        raise BuildControlError('--modules requires the explicit --offline mode')
    selected = args.source_root.resolve(strict=True)
    identity = compose_project_identity(storage.resolve_layout(selected, 'docker-all-gpu'))
    from docker_build_control import toolchain_configuration
    configured = toolchain_configuration(selected, identity)
    helper = configured["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"]
    control = BuildControl(identity, helper)
    control.prepare()
    ids = docker_capture('ps', *(['--all'] if args.offline else []), '--quiet', '--no-trunc', '--filter', 'label=com.docker.compose.project='+control.project,
                         '--filter', 'label=com.docker.compose.service=backend').stdout.decode().split()
    if len(ids) != 1:
        raise BuildControlError('Checks require exactly one selected backend')
    observed = json.loads(docker_capture('inspect', ids[0]).stdout)[0]
    labels = observed.get('Config', {}).get('Labels', {})
    if labels.get('org.fullmag.source.worktree-id') != identity['worktree_id']:
        raise BuildControlError('Backend worktree ownership differs')
    if args.offline:
        return _offline_checks(control, selected, observed, args.modules)
    mounts = [m for m in observed.get('Mounts', []) if m['Destination']=='/build']
    if len(mounts)!=1 or mounts[0]['Type']!='volume':
        raise BuildControlError('Checks require the persistent build volume')
    script = '''import os, pathlib, subprocess, sys
pathlib.Path('/build/verification-tmp').mkdir(exist_ok=True)
environment = {key:value for key,value in os.environ.items() if not key.startswith('FULLMAG_')}
environment.update(TMPDIR='/build/verification-tmp', PYTHONDONTWRITEBYTECODE='1', HOME='/build/verification-tmp/home', USER='fullmag-checks', LOGNAME='fullmag-checks')
pathlib.Path(environment['HOME']).mkdir(exist_ok=True)
command=[sys.executable,'-B','-m','unittest','test_docker_dev_defaults','test_docker_dev_owned_control','test_docker_dev_codegen','test_docker_volume_activate','test_docker_volume_container_recovery','test_docker_volume_stop_unadmitted','test_docker_volume_dev_runtime_state','test_docker_runtime_control_volume','test_docker_container_runtime_recovery','test_runtime_service_recovery_busy_retry','test_docker_backend_volume_cache','test_bootstrap_docker_toolchain','test_docker_compose_identity','test_docker_host_ledger','test_docker_volume_receipts','test_docker_dev_host','test_docker_volume_wsl','test_docker_wsl_bind','test_linux_native_host','test_linux_native_probe','test_docker_python_no_test_build','test_mfem_cuda_fast_compile','test_docker_frontend_dev','test_docker_dev_browser_qa','test_docker_development_inputs_linux','test_docker_backend_dev','test_docker_startup_script','test_backend_volume_cache_maintenance','test_docker_cpu_access','test_docker_dev_storage','test_docker_dev_image_context','test_docker_dev_recreate','test_docker_frontend_cache','test_docker_frontend_cache_named_volume','test_fullmag_docker_runtime','test_docker_orphan_recovery','test_recover_docker_orphan','test_just_orphan_recovery_shell']
sys.exit(subprocess.call(command,cwd='/opt/fullmag/source/scripts',env=environment))
'''
    result = docker_capture('exec', '--workdir', '/opt/fullmag/source/scripts', ids[0],
                           '/usr/local/bin/python3', '-B', '-c', script, allow_failure=True, timeout=180)
    receipt={'schema':'fullmag.volume-dev-interpreted-checks.v1','exit_code':result.returncode,
             'container_id':ids[0], 'image_id':observed['Image'], 'compose_project':control.project,
             'stdout':result.stdout.decode('utf-8','replace'), 'stderr':result.stderr.decode('utf-8','replace')}
    control.write('verification/interpreted-checks.json',receipt)
    print(receipt['stdout']+receipt['stderr'])
    return result.returncode


if __name__=='__main__':
    raise SystemExit(main())
