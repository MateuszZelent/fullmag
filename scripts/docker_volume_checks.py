"""Run interpreted control checks in the selected DEV service or offline helper."""
import argparse
import ast
import hashlib
import stat
import json
import re
import shlex
import uuid
from pathlib import Path, PurePosixPath
import sys

import fullmag_storage as storage
from docker_build_control import (
    BuildControl, BuildControlError, ControlOutcomeUnknown, bounded_capture, canonical, docker_capture, mirror_console, require_host,
)
from docker_compose_identity import compose_project_identity, validate_source_labels


BASE_IMPLEMENTATIONS = ('docker_build_control', 'docker_volume_dev', 'docker_volume_activate',
                        'docker_volume_stop_failed', 'docker_volume_checks',
                        'docker_shared_build_storage', 'docker_backend_volume_cache',
                        'docker_volume_cache_maintenance', 'docker_cache_retirement', 'docker_worktree_finish')
OPTIONAL_IMPLEMENTATIONS = ('docker_helper_source', 'docker_volume_activation_reconcile', 'docker_volume_accepted_reattach',
                            'docker_volume_pre_admission_recreate', 'docker_volume_pre_admission_selector',
                            'docker_volume_pending_continuation', 'docker_volume_native_init_successor',
                            'docker_volume_drained_successor', 'docker_volume_reconcile',
                            'docker_volume_prestart_recovery', 'docker_volume_terminal_prestart_recovery')


_ORACLE_WHEEL_ROOT = Path('/opt/fullmag/control/verification')
_ORACLE_WHEEL_NAME = 'mpmath-1.3.0-py3-none-any.whl'


def _oracle_wheel_binding(source, reference):
    if reference is None:
        return None
    if not isinstance(reference, str) or any(char in reference for char in '\0\r\n:'):
        raise BuildControlError('Oracle wheel reference is invalid')
    path = PurePosixPath(reference)
    if (str(path) != reference or '..' in path.parts
            or not path.is_relative_to(_ORACLE_WHEEL_ROOT)
            or path.name != _ORACLE_WHEEL_NAME):
        raise BuildControlError('Oracle wheel must be a canonical group verification reference')
    pin_source = Path(source) / 'scripts/antenna_triangle_surface_oracle.py'
    try:
        raw = pin_source.read_bytes()
        pins = [ast.literal_eval(node.value) for node in ast.parse(raw).body
                if isinstance(node, ast.Assign)
                and any(isinstance(target, ast.Name) and target.id == 'WHEEL_SHA'
                        for target in node.targets)]
    except (OSError, SyntaxError, ValueError, TypeError) as error:
        raise BuildControlError('Oracle wheel source pin is unavailable') from error
    if len(pins) != 1 or not isinstance(pins[0], str) or re.fullmatch(r'[0-9a-f]{64}', pins[0]) is None:
        raise BuildControlError('Oracle wheel source pin is invalid')
    return {'path': reference, 'sha256': pins[0], 'source_sha256': hashlib.sha256(raw).hexdigest()}


def _verify_oracle_wheel(binding, source=Path('/opt/fullmag/source')):
    if not isinstance(binding, dict) or _oracle_wheel_binding(source, binding.get('path')) != binding:
        raise BuildControlError('Oracle wheel binding differs from the selected source')
    path = Path(binding['path'])
    try:
        if path.resolve(strict=True) != path:
            raise BuildControlError('Oracle wheel path is not canonical')
        before = path.stat()
        if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= 2 * 1024 * 1024:
            raise BuildControlError('Oracle wheel must be a bounded regular file')
        data = path.read_bytes()
        after = path.stat()
    except OSError as error:
        raise BuildControlError('Oracle wheel is unavailable') from error
    identity = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
    if identity(before) != identity(after) or hashlib.sha256(data).hexdigest() != binding['sha256']:
        raise BuildControlError('Oracle wheel digest or identity differs')
    return {**binding, 'file_identity': identity(after)}


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


FRONTEND_APP = '/state/development/workspace/apps/control-room'
IMPORT_FILES = (
    'src/kernel/persistence/ScriptProjectActivation.ts',
    'src/kernel/persistence/ScriptProjectActivation.test.ts',
    'src/kernel/persistence/ProjectDocumentController.ts',
    'src/kernel/persistence/ProjectDocumentController.test.ts',
    'src/modules/start/StartScreen.tsx',
    'src/modules/start/model/scriptProject.ts',
    'src/modules/start/model/pythonImport.ts',
    'src/modules/start/model/pythonImport.test.ts',
    'src/modules/start/model/importFormats.ts',
    'src/modules/start/model/importFormats.test.ts',
    'src/modules/start/sections/ImportSection.tsx',
    'src/modules/start/sections/ImportSection.test.tsx',
    'src/modules/start/ui/CreateProjectAction.tsx',
    'src/modules/start/ui/CreateProjectAction.test.tsx',
    'src/kernel/layout/shellCommands.ts',
    'src/kernel/layout/shellCommands.test.ts',
    'next.config.ts',
    'next.config.test.ts',
)
IMPORT_TESTS = (
    'src/kernel/persistence/ScriptProjectActivation.test.ts',
    'src/kernel/persistence/ProjectDocumentController.test.ts',
    'src/modules/start/model/pythonImport.test.ts',
    'src/modules/start/model/importFormats.test.ts',
    'src/modules/start/sections/ImportSection.test.tsx',
    'src/modules/start/ui/CreateProjectAction.test.tsx',
    'src/kernel/layout/shellCommands.test.ts',
    'next.config.test.ts',
)
FRONTEND_COMMANDS = (
    ('prepare', ('/bin/mkdir', '-p', '/state/development/cache/tsbuildinfo', '/state/development/tmp')),
    ('typecheck', ('/usr/local/bin/pnpm', '--dir', FRONTEND_APP, 'run', 'typecheck')),
    ('vitest', ('/usr/local/bin/pnpm', '--dir', FRONTEND_APP, 'exec', 'vitest', 'run',
                *IMPORT_TESTS, '--pool=threads', '--maxWorkers=1')),
    ('eslint', ('/usr/local/bin/pnpm', '--dir', FRONTEND_APP, 'exec', 'eslint', *IMPORT_FILES, '--max-warnings=0')),
)

ANTENNA_FILES = (
    'src/modules/inspector/panels/antenna/MicrostripGeometryEditorModel.ts',
    'src/modules/inspector/panels/antenna/MicrostripGeometryEditor.tsx',
    'src/modules/inspector/panels/antenna/MicrostripGeometryEditorModel.test.ts',
    'src/kernel/authoring/geometryLifecycleCommandContributions.test.ts',
)
ANTENNA_TESTS = (ANTENNA_FILES[2], ANTENNA_FILES[3])
ANTENNA_COMMANDS = (
    *FRONTEND_COMMANDS[:2],
    ('vitest', ('/usr/local/bin/pnpm', '--dir', FRONTEND_APP, 'exec', 'vitest', 'run',
                *ANTENNA_TESTS, '--pool=threads', '--maxWorkers=1')),
    ('eslint', ('/usr/local/bin/pnpm', '--dir', FRONTEND_APP, 'exec', 'eslint', *ANTENNA_FILES, '--max-warnings=0')),
)


VISUALIZATION_FILES = (
    'src/kernel/visualization/ObjectVisualizationController.ts',
    'src/kernel/visualization/ObjectVisualizationController.test.ts',
    'src/shared/domain/physics/objectMagneticModel.ts',
    'src/kernel/visualization/primitiveSurfaceColor.ts',
    'src/modules/field-map/FieldMapModule.tsx',
    'src/modules/inspector/panels/ObjectGeneralPanel.tsx',
    'src/modules/inspector/panels/region/ObjectRegionMagneticParametersPanel.tsx',
    'src/modules/viewport-3d/Viewport3DModule.tsx',
    'src/modules/viewport-3d/viewport3dPrimitiveModel.ts',
    'src/modules/viewport-3d/layers/PrimitiveObjectLayerModel.ts',
    'src/modules/inspector/panels/ObjectVisualizationPanel.tsx',
    'src/modules/inspector/panels/ObjectVisualizationPanelModel.ts',
    'src/modules/inspector/panels/ObjectVisualizationTargetSection.tsx',
    'src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts',
    'src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts',
)
# Type checking and source gates do not compile or execute native unit tests.
VISUALIZATION_COMMANDS = (
    *FRONTEND_COMMANDS[:2],
    *((f'eslint-{index:02}', ('/usr/bin/env', 'NODE_OPTIONS=--max-old-space-size=4096',
                '/usr/local/bin/pnpm', '--dir', FRONTEND_APP, 'exec', 'eslint',
                source, '--max-warnings=0')) for index, source in enumerate(VISUALIZATION_FILES, 1)),
    ('architecture', ('/usr/local/bin/pnpm', '--dir', FRONTEND_APP, 'run', 'check:architecture-hygiene')),
    ('api-hygiene', ('/usr/local/bin/pnpm', '--dir', FRONTEND_APP, 'run', 'check:api-hygiene')),
)


def frontend_import_checks(control, selected, identity, *, scope='frontend-import'):
    import hashlib
    import time
    import docker_dev_codegen as codegen
    if scope not in ('frontend-import', 'frontend-antenna', 'frontend-visualization'):
        raise BuildControlError('Unknown frontend verification scope')
    source_files, commands = {
        'frontend-import': (IMPORT_FILES, FRONTEND_COMMANDS),
        'frontend-antenna': (ANTENNA_FILES, ANTENNA_COMMANDS),
        'frontend-visualization': (VISUALIZATION_FILES, VISUALIZATION_COMMANDS),
    }[scope]
    receipt = {'schema': f'fullmag.volume-dev-{scope}-checks.v1', 'scope': scope,
               'compose_project': control.project, 'state': 'running', 'commands': [],
               'source_head': storage.git(selected, 'rev-parse', 'HEAD'),
               'driver_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    root = f'verification/{scope}-checks'
    def services():
        result = {}
        for name in ('backend', 'frontend'):
            _identifier, document = codegen._running_service(control.project, name, identity, selected)
            if document.get('State', {}).get('Health', {}).get('Status') != 'healthy':
                raise codegen.CodegenError('Frontend checks require healthy existing services')
            result[name] = (document['Id'], document)
        return result
    def service_pins(values):
        return {name: {**codegen._service_identity(identifier, document),
                       'started_at': document['State']['StartedAt']} for name, (identifier, document) in values.items()}
    def input_hashes():
        files = (*source_files, 'scripts/typecheck-control-room.mjs', 'tsconfig.typecheck.json',
                 'tsconfig.json', 'next.config.ts', 'next.config.test.ts', 'vitest.config.ts', 'eslint.config.mjs', 'package.json',
                 'src/kernel/api/generated/openapi-v2.json', 'src/kernel/api/generated/openapi-v2-types.ts',
                 'src/kernel/api/generated/openapi-v2-client.ts', 'src/kernel/api/generated/openapi-v2-paths.ts')
        return {name: hashlib.sha256((selected / 'apps/control-room' / name).read_bytes()).hexdigest() for name in files}
    try:
        before = services()
        pins = receipt['services_before'] = service_pins(before)
        volumes = codegen._inspect_technical_volumes(control.project, before['backend'][1], before['frontend'][1])
        receipt['technical_volumes'] = volumes
        inputs = receipt['selected_frontend_input_hashes'] = input_hashes()
        import docker_development_inputs as frontend_inputs
        port = int(codegen._environment(before['frontend'][1])['FULLMAG_FRONTEND_HOST_PORT'])
        metadata = frontend_inputs.describe(selected, port)
        receipt['frontend_source_view_before'] = frontend_inputs.frontend_view(
            before['frontend'][0], selected, port, inputs=metadata)
        for name, arguments in commands:
            item = {'name': name, 'arguments': list(arguments), 'state': 'running'}
            receipt['commands'].append(item)
            started = time.monotonic()
            # Reuse codegen's existing fixed frontend executor. All mutable paths stay in its named volume.
            command = ('/usr/bin/flock', '-n', '/state/development/cache/.fullmag-frontend-import-checks.lock',
                '/usr/bin/env', 'FULLMAG_FRONTEND_ROOT=/state/development/cache', 'FULLMAG_NEXT_DIST_DIR=.next',
                'TMPDIR=/state/development/tmp', 'TMP=/state/development/tmp', 'TEMP=/state/development/tmp',
                'CI=1', *arguments)
            try:
                stdout, stderr = codegen._run_frontend(before['frontend'][0], command, timeout=600,
                                                       stdout_limit=1024 * 1024)
                for stream, raw in (('stdout', stdout), ('stderr', stderr)):
                    relative = root + '/' + name + '.' + stream + '.log'
                    control.write_bytes(relative, raw)
                    item[stream] = {'path': relative, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
                item.update(state='succeeded', exit_code=0)
            except codegen.CodegenError as error:
                # A timed-out Docker exec may still own the per-command flock; never continue or retry it.
                unknown = bool(error.reconciliation_required)
                raw = str(error).encode('utf-8')
                control.write_bytes(root + '/' + name + '.error.log', raw[:65536])
                for stream, output in (('stdout', error.stdout), ('stderr', error.stderr)):
                    relative = root + '/' + name + '.' + stream + '.log'
                    control.write_bytes(relative, output)
                    item[stream] = {'path': relative, 'bytes': len(output), 'sha256': hashlib.sha256(output).hexdigest()}
                item.update(state='outcome-unknown' if unknown else 'failed', exit_code=error.exit_code,
                            error=str(error)[:4096], error_log_truncated=len(raw)>65536,
                            reconciliation_required=unknown)
                if unknown or name == 'prepare':
                    break
            finally:
                item['duration_ms'] = round((time.monotonic()-started)*1000)
        after = services()
        if service_pins(after) != pins or codegen._inspect_technical_volumes(
                control.project, after['backend'][1], after['frontend'][1]) != volumes or input_hashes() != inputs:
            raise codegen.CodegenError('Services, technical volumes or selected frontend inputs changed during checks')
        if frontend_inputs.describe(selected, port)['files'] != metadata['files']:
            raise codegen.CodegenError('Selected frontend metadata changed during checks')
        receipt['frontend_source_view_after'] = frontend_inputs.frontend_view(
            after['frontend'][0], selected, port, inputs=metadata)
        receipt['services_after'] = service_pins(after)
        unknown = any(item.get('reconciliation_required') for item in receipt['commands'])
        receipt.update(state='outcome-unknown' if unknown else 'succeeded' if all(
            item['state']=='succeeded' for item in receipt['commands']) and len(receipt['commands'])==len(commands)
            else 'failed', exit_code=2 if unknown else 0 if all(item['state']=='succeeded' for item in receipt['commands']) else 1)
    except Exception as error:
        unknown = bool(getattr(error, 'reconciliation_required', False)) or any(
            item.get('reconciliation_required') for item in receipt['commands'])
        receipt.update(state='outcome-unknown' if unknown else 'failed', exit_code=2 if unknown else 1,
                       error=str(error)[:4096], reconciliation_required=unknown)
    control.write(root + '/receipt.json', receipt)
    print(json.dumps(receipt, indent=2))
    return receipt['exit_code']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', type=Path, required=True)
    parser.add_argument('--oracle-wheel', help='Explicit registered mpmath wheel in the group verification volume (all scope only)')
    parser.add_argument('--offline', action='store_true', help='Run interpreted checks in a private group helper when backend is stopped')
    parser.add_argument('--modules', nargs='+', help='Explicit unittest modules (offline mode only)')
    parser.add_argument('--scope', choices=('all', 'source-capture', 'frontend-import', 'frontend-antenna', 'frontend-visualization', 'frontend-tools', 'field-only'), default='all')
    args = parser.parse_args()
    if args.oracle_wheel is not None and (args.offline or args.scope != 'all'):
        raise BuildControlError('Oracle wheel is supported only for live all checks')
    if args.offline:
        if args.scope != 'all':
            raise BuildControlError('Offline module checks cannot combine with a service-specific scope')
        require_host()
        if not args.modules or len(args.modules) > 32 or any(re.fullmatch(r'test_[A-Za-z0-9_]+', module) is None for module in args.modules):
            raise BuildControlError('Offline checks require 1-32 explicit test modules')
    elif args.modules:
        raise BuildControlError('--modules requires the explicit --offline mode')
    selected = args.source_root.resolve(strict=True)
    oracle_dependency = _oracle_wheel_binding(selected, args.oracle_wheel)
    identity = compose_project_identity(storage.resolve_layout(selected, 'docker-all-gpu'))
    from docker_build_control import toolchain_configuration
    configured = toolchain_configuration(selected, identity)
    helper = configured["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"]
    control = BuildControl(identity, helper)
    control.prepare()
    if args.scope in ('frontend-import', 'frontend-antenna', 'frontend-visualization'):
        return frontend_import_checks(control, selected, identity, scope=args.scope)
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
    if oracle_dependency is not None:
        control_mounts = [mount for mount in observed.get('Mounts', [])
                          if mount['Destination'] == '/opt/fullmag/control']
        if (len(control_mounts) != 1 or control_mounts[0]['Type'] != 'volume'
                or control_mounts[0].get('Name') != control.volume):
            raise BuildControlError('Oracle wheel requires the selected group control volume')
    script = '''import json, os, pathlib, subprocess, sys
pathlib.Path('/build/verification-tmp').mkdir(exist_ok=True)
environment = {key:value for key,value in os.environ.items() if not key.startswith('FULLMAG_')}
environment.update(TMPDIR='/build/verification-tmp', PYTHONDONTWRITEBYTECODE='1', HOME='/build/verification-tmp/home', USER='fullmag-checks', LOGNAME='fullmag-checks')
pathlib.Path(environment['HOME']).mkdir(exist_ok=True)
oracle_binding = json.loads(sys.argv[2]) if len(sys.argv) > 2 else None
if oracle_binding is not None:
    from docker_volume_checks import _verify_oracle_wheel
    oracle_before = _verify_oracle_wheel(oracle_binding)
    environment['PYTHONPATH'] = oracle_binding['path'] + (os.pathsep + environment['PYTHONPATH'] if environment.get('PYTHONPATH') else '')
command=[sys.executable,'-B','-m','unittest','test_docker_dev_defaults','test_docker_dev_up','test_docker_dev_owned_control','test_docker_dev_codegen','test_docker_volume_activate','test_docker_volume_reconcile','test_docker_activation_preflight','test_antenna_rt0_surface_oracle','test_docker_volume_container_recovery','test_docker_volume_stop_unadmitted','test_docker_volume_dev_runtime_state','test_docker_runtime_control_volume','test_docker_container_runtime_recovery','test_runtime_service_recovery_busy_retry','test_docker_backend_volume_cache','test_bootstrap_docker_toolchain','test_docker_toolchain_host_inputs','test_docker_compose_identity','test_docker_host_ledger','test_docker_group_ledger','test_docker_volume_receipts','test_docker_volume_device_access','test_docker_volume_retained_device_lifecycle','test_docker_volume_native_init_successor','test_docker_dev_host','test_docker_volume_wsl','test_docker_wsl_bind','test_linux_native_host','test_linux_native_probe','test_docker_python_no_test_build','test_mfem_cuda_fast_compile','test_docker_frontend_dev','test_docker_dev_browser_qa','test_docker_development_inputs_linux','test_docker_backend_dev','test_docker_dev_fast_loop','test_docker_backend_live_source','test_docker_candidate_retirement','test_docker_startup_script','test_backend_volume_cache_maintenance','test_docker_cpu_access','test_docker_dev_storage','test_docker_dev_image_context','test_docker_dev_recreate','test_docker_volume_pre_admission_recreate','test_docker_volume_pre_admission_selector','test_docker_volume_pre_admission_integration','test_docker_volume_post_build_generation','test_docker_volume_post_build_integration','test_docker_volume_pending_continuation','test_docker_volume_pending_resume','test_docker_native_failed_recreate','test_docker_prestart_resume','test_docker_frontend_cache','test_docker_frontend_cache_named_volume','test_fullmag_docker_runtime','test_docker_orphan_recovery','test_recover_docker_orphan','test_just_orphan_recovery_shell','test_docker_volume_checks','test_docker_shared_build_storage','test_backend_shared_store','test_backend_shared_integration','test_backend_shared_recovery','test_backend_group_retirement','test_backend_compiler_cache','test_docker_cache_retirement','test_docker_worktree_finish','test_backend_auto_maintenance','test_docker_helper_source','test_backend_package_backup_retirement']
if sys.argv[1] == 'frontend-tools':
    command = [sys.executable, '-B', '-m', 'unittest', 'test_docker_dev_codegen', 'test_docker_volume_checks', 'test_docker_volume_frontend_recovery', 'test_docker_volume_dev_runtime_state', 'test_docker_volume_receipts', 'test_docker_dev_browser_qa']
if sys.argv[1] == 'field-only':
    environment.update(PYTHONPATH='/opt/fullmag/source/packages/fullmag-py/src', FULLMAG_TEST_TEMP_ROOT='/build/verification-tmp')
    result = subprocess.call([sys.executable, '-B', '-m', 'unittest', 'discover',
        '-s', '/opt/fullmag/source/packages/fullmag-py/tests', '-p', 'test_antenna_field_only_nonmagnetic.py', '-v'],
        cwd='/opt/fullmag/source', env=environment)
else:
    result = subprocess.call(command,cwd='/opt/fullmag/source/scripts',env=environment) if sys.argv[1] in ('all', 'frontend-tools') else 0
if result == 0 and sys.argv[1] not in ('field-only', 'frontend-tools'):
    result = subprocess.call([sys.executable, '-B', '/opt/fullmag/source/scripts/verify_accepted_source_scene_capture.py',
                              '--fullmag-root', '/opt/fullmag/source/packages/fullmag-py/src/fullmag',
                              '--output-dir', '/build/verification-tmp'], env=environment)
if oracle_binding is not None and _verify_oracle_wheel(oracle_binding) != oracle_before:
    raise RuntimeError('Oracle wheel changed during checks')
sys.exit(result)
'''
    result = docker_capture('exec', '--workdir', '/opt/fullmag/source/scripts', ids[0],
                           '/usr/local/bin/python3', '-B', '-c', script, args.scope,
                           *([json.dumps(oracle_dependency, sort_keys=True)] if oracle_dependency is not None else []),
                           allow_failure=True, timeout=900)
    receipt={'schema':'fullmag.volume-dev-interpreted-checks.v1','exit_code':result.returncode,
             'scope':args.scope, 'container_id':ids[0], 'image_id':observed['Image'], 'compose_project':control.project,
             'stdout':result.stdout.decode('utf-8','replace'), 'stderr':result.stderr.decode('utf-8','replace')}
    if oracle_dependency is not None:
        receipt['oracle_dependency'] = oracle_dependency
    control.write('verification/interpreted-frontend-tools-checks.json' if args.scope == 'frontend-tools' else
                  'verification/interpreted-checks.json' if args.scope == 'all' else
                  'verification/interpreted-field-only-checks.json' if args.scope == 'field-only' else
                  'verification/interpreted-source-capture-checks.json',receipt)
    print(receipt['stderr'] if args.scope == 'frontend-tools' else receipt['stdout']+receipt['stderr'])
    return result.returncode


if __name__=='__main__':
    raise SystemExit(main())
