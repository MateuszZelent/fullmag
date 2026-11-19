"""Fixed Rust source regressions in the selected healthy Compose backend."""
from __future__ import annotations

import hashlib
from pathlib import Path

from docker_build_control import BuildControlError, docker_capture
import docker_dev_codegen as codegen

COMMAND = ('/root/.cargo/bin/cargo', 'test', '--locked', '--profile', 'backend-dev',
           '-p', 'fullmag-authoring', '--lib')

# A separate private target prevents unit-test compilation from changing the
# published runtime package. The backend's normal build lock serializes Cargo.
CHECK_SCRIPT = r'''import fcntl, os, pathlib, stat, subprocess, sys
root = pathlib.Path('/build')
fd = os.open(root / '.fullmag-backend-runtime.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o660)
try:
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise RuntimeError('invalid backend build lock')
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    temp = root / 'verification' / 'authoring-contracts' / 'tmp'
    temp.mkdir(parents=True, exist_ok=True)
    environment = dict(os.environ)
    if environment.get('CARGO_HOME') != '/build/cargo':
        raise RuntimeError('authoring checks require the admitted private Cargo home')
    environment.update(CARGO_TARGET_DIR='/build/verification/authoring-contracts/target',
                       TMPDIR=str(temp), CARGO_BUILD_JOBS='2')
    result = subprocess.call(sys.argv[1:], cwd='/opt/fullmag/source', env=environment)
finally:
    os.close(fd)
sys.exit(result)
'''


def _source_hashes(selected: Path) -> dict[str, str]:
    paths = [selected / name for name in ('Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml',
                                         'scripts/docker_authoring_contract_checks.py',
                                         'scripts/docker_diagnostic_source_checks.py',
                                         'scripts/docker_volume_checks.py',
                                         'scripts/just_storage_shell.sh')]
    for directory in ('crates', '.cargo'):
        paths.extend(path for path in (selected / directory).rglob('*')
                     if path.is_file() and path.suffix in ('.rs', '.toml'))
    for directory in ('packages/fullmag-py/src', 'packages/fullmag-py/tests'):
        paths.extend(path for path in (selected / directory).rglob('*.py') if path.is_file())
    return {str(path.relative_to(selected)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(paths)}


def run(control, selected: Path, identity, *, scope="authoring-contracts") -> int:
    commands = {
        "authoring-contracts": (
            COMMAND,
            ('/usr/bin/env', 'CARGO_INCREMENTAL=0', 'CARGO_PROFILE_BACKEND_DEV_DEBUG=0',
             '/root/.cargo/bin/cargo', 'test', '--locked', '--profile', 'backend-dev',
             '-p', 'fullmag-application', '--lib', 'script_imported_run'),
        ),
        "gpu-temperature-contracts": (
            ('/usr/bin/env', 'CARGO_INCREMENTAL=0', 'CARGO_PROFILE_BACKEND_DEV_DEBUG=0',
             '/root/.cargo/bin/cargo', 'test', '--locked', '--profile', 'backend-dev',
             '-p', 'fullmag-runtime-control', '--lib', 'gpu_temperature'),
        ),
        "material-library-python-contracts": (
            ('/usr/bin/env', 'PYTHONPATH=/opt/fullmag/source/packages/fullmag-py/src',
             '/usr/local/bin/python3', '-B', '-m', 'unittest', 'discover',
             '-s', '/opt/fullmag/source/packages/fullmag-py/tests',
             '-p', 'test_material_assets_roundtrip.py', '-v'),
        ),
        "material-library-contracts": (
            ('/usr/bin/env', 'CARGO_BUILD_JOBS=1', 'CARGO_INCREMENTAL=0', 'CARGO_PROFILE_BACKEND_DEV_DEBUG=0',
             '/root/.cargo/bin/cargo', 'test', '--locked', '--profile', 'backend-dev',
             '-p', 'fullmag-api', '--bin', 'fullmag-api', 'material_library'),
        ),
        # Source-only tests keep native solver/runtime packages untouched.
        # Disable debug output and incremental duplication in this private target.
        "live-observation-contracts": (
            ('/usr/bin/env', 'CARGO_INCREMENTAL=0',
             'CARGO_PROFILE_BACKEND_DEV_DEBUG=0',
             '/root/.cargo/bin/cargo', 'test', '--locked', '--profile', 'backend-dev',
             '-p', 'fullmag-api', '--bin', 'fullmag-api-accepted-worker',
             'accepted_live_layout_tests'),
            ('/usr/bin/env', 'CARGO_INCREMENTAL=0',
             'CARGO_PROFILE_BACKEND_DEV_DEBUG=0',
             '/root/.cargo/bin/cargo', 'test', '--locked', '--profile', 'backend-dev',
             '-p', 'fullmag-api', '--bin', 'fullmag-api', 'live_view_continuity'),
        ),
        "accepted-runtime-ownership-contracts": tuple(
            # These tests allocate private native SessionStores under TMPDIR.
            # The live service's /state mount profile belongs to user sessions.
            ('/usr/bin/env', '-u', 'FULLMAG_SESSION_STORAGE_PROFILE', 'CARGO_INCREMENTAL=0',
             'CARGO_PROFILE_BACKEND_DEV_DEBUG=0',
             '/root/.cargo/bin/cargo', 'test', '--locked', '--profile', 'backend-dev', *test)
            for test in (
                ('-p', 'fullmag-runtime-control', '--lib', 'store_retry_repeats_transient_enomem'),
                ('-p', 'fullmag-runtime-control', '--lib', 'closes_portable_solution_after_transient'),
                ('-p', 'fullmag-runtime-control', '--lib', 'missing_gpu_sample_does_not_change'),
                ('-p', 'fullmag-session', '--lib', 'durable_prestart_stop_fences'),
                ('-p', 'fullmag-api', '--bin', 'fullmag-api-accepted-scheduler',
                 'transient_pre_spawn_read_releases_slot'),
            )
        ),
        "fem-response-worker-contracts": (
            ('/usr/bin/env', 'CARGO_INCREMENTAL=0', 'CARGO_PROFILE_BACKEND_DEV_DEBUG=0',
             '/root/.cargo/bin/cargo', 'test', '--locked', '--profile', 'backend-dev',
             '-p', 'fullmag-api', '--bin', 'fullmag-api-accepted-worker',
             'accepted_fem_frequency_response_worker::tests'),
        ),
        "fem-response-descriptor-contracts": (
            ('/usr/bin/env', 'CARGO_INCREMENTAL=0', 'CARGO_PROFILE_BACKEND_DEV_DEBUG=0',
             '/root/.cargo/bin/cargo', 'test', '--locked', '--profile', 'backend-dev',
             '-p', 'fullmag-runner', '--lib', 'accepted_input::tests'),
        ),
        "fem-response-preparer-contracts": (
            ('/usr/bin/env', 'CARGO_INCREMENTAL=0', 'CARGO_PROFILE_BACKEND_DEV_DEBUG=0',
             '/root/.cargo/bin/cargo', 'test', '--locked', '--profile', 'backend-dev',
             '-p', 'fullmag-api', '--bin', 'fullmag-api-accepted-fem-preparer',
             'accepted_fem_preparer::tests'),
        ),
        "fem-response-input-contracts": (
            ('/usr/bin/env', 'CARGO_INCREMENTAL=0', 'CARGO_PROFILE_BACKEND_DEV_DEBUG=0',
             '/root/.cargo/bin/cargo', 'test', '--locked', '--profile', 'backend-dev',
             '-p', 'fullmag-runner', '--lib',
             'fem_frequency_response_'),
        ),
        "fem-response-preparation-contracts": (
            ('/usr/bin/env', 'CARGO_INCREMENTAL=0', 'CARGO_PROFILE_BACKEND_DEV_DEBUG=0',
             '/root/.cargo/bin/cargo', 'test', '--locked', '--profile', 'backend-dev',
             '-p', 'fullmag-runtime-control', '--lib',
             'accepted_frequency_response_preparation_binds_native_evidence_to_exact_run_problem_and_step'),
        ),
        "fem-response-codec-contracts": (
            ('/usr/bin/env', 'CARGO_INCREMENTAL=0', 'CARGO_PROFILE_BACKEND_DEV_DEBUG=0',
             '/root/.cargo/bin/cargo', 'test', '--locked', '--profile', 'backend-dev',
             '-p', 'fullmag-application', '--lib', 'study_frequency_response_artifact'),
        ),
        "fem-live-control-contracts": tuple(
            ('/usr/bin/env', 'CARGO_INCREMENTAL=0', 'CARGO_PROFILE_BACKEND_DEV_DEBUG=0',
             '/root/.cargo/bin/cargo', 'test', '--locked', '--profile', 'backend-dev',
             '-p', 'fullmag-runner', '--lib', name)
            for name in ('fem_live_control_tests',
                         'fdm_multilayer_interrupt_publishes_accepted_update_before_stop')
        ),
        "fem-preparation-contracts": (
            ('/usr/bin/env', 'CARGO_INCREMENTAL=0', 'CARGO_PROFILE_BACKEND_DEV_DEBUG=0',
             '/root/.cargo/bin/cargo', 'test', '--locked', '--profile', 'backend-dev',
             '-p', 'fullmag-api', '--bin', 'fullmag-api', 'imported_geometry_sources::tests'),
            ('/usr/bin/env', 'CARGO_INCREMENTAL=0',
             'CARGO_PROFILE_BACKEND_DEV_DEBUG=0', '/usr/bin/timeout', '--kill-after=5', '60',
             '/root/.cargo/bin/cargo', 'test', '--locked', '--profile', 'backend-dev',
             '-p', 'fullmag-api', '--bin', 'fullmag-api',
             'script::tests::accepted_fem_preparation_resolves_imported_asset_from_source_root',
             '--', '--exact', '--nocapture'),
        ),
        "stl-classification-contracts": (
            ('/usr/bin/env', 'PYTHONPATH=/opt/fullmag/source/packages/fullmag-py/src',
             '/usr/local/bin/python3', '-B', '-m', 'unittest', 'discover',
             '-s', '/opt/fullmag/source/packages/fullmag-py/tests',
             '-p', 'test_stl_shell_domains.py', '-v'),
            ('/usr/bin/env', 'PYTHONPATH=/opt/fullmag/source/packages/fullmag-py/src',
             '/usr/local/bin/python3', '-B', '-m', 'unittest', 'discover',
             '-s', '/opt/fullmag/source/packages/fullmag-py/tests',
             '-p', 'test_frozen_boundary_stl_export.py', '-v'),
        ),
        "stl-meshing-contracts": tuple(
            ('/usr/bin/env', 'PYTHONPATH=/opt/fullmag/source/packages/fullmag-py/src',
             '/usr/local/bin/python3', '-B', '-m', 'unittest', 'discover',
             '-s', '/opt/fullmag/source/packages/fullmag-py/tests', '-p', module, '-v')
            for module in ('test_meshing.py', 'test_stl_shell_domains.py',
                           'test_frozen_boundary_stl_export.py')
        ),
        "stl-api-contracts": tuple(
            ('/root/.cargo/bin/cargo', 'test', '--locked', '--profile', 'backend-dev',
             '-p', 'fullmag-api', '--bin', 'fullmag-api', name)
            for name in ('imported_geometry_sources::tests',
                         'model::imported_surface::tests', 'stl', 'authoring_open_tests')
        ),
    }[scope]
    backend, document = codegen._running_service(control.project, 'backend', identity, selected)
    diagnostic = None
    if document.get('State', {}).get('Health', {}).get('Status') != 'healthy':
        if scope not in ('material-library-contracts', 'material-library-python-contracts', 'gpu-temperature-contracts'):
            raise BuildControlError('Authoring checks require a healthy selected backend')
        from docker_diagnostic_source_checks import admit_diagnostic_source_checks
        diagnostic = admit_diagnostic_source_checks(backend, document, control.volume)
    mounts = {mount['Destination']: mount for mount in document.get('Mounts', [])}
    if any(mounts.get(destination, {}).get('Type') != 'volume'
           or mounts[destination].get('Name') != control.volume
           for destination in ('/build', '/opt/fullmag/control')):
        raise BuildControlError('Authoring checks require the selected private build/control volume')
    before = _source_hashes(selected)
    inputs = {'scope': scope, 'container_id': backend,
              'image_id': document['Image'], 'source_hashes': before,
              'commands': [list(command) for command in commands],
              'diagnostic_source_admission': diagnostic, 'runtime_qualification': 'NOT VERIFIED'}
    with control.operation('verification', inputs) as operation:
        root = operation['root']
        operation['receipt'].update(inputs, state='running', qualification='source tests only')
        control.write(root + '/receipt.json', operation['receipt'])
        outputs = []
        exit_code = 0
        harness_error = None
        for command in commands:
            operation['daemon_pending'] = True
            result = docker_capture('exec', backend, '/usr/local/bin/python3', '-B', '-c',
                                    CHECK_SCRIPT, *command, allow_failure=True, timeout=1800)
            operation['daemon_pending'] = False
            outputs.append((result.stdout, result.stderr))
            if result.returncode:
                exit_code = result.returncode
                break
            output = result.stdout.decode('utf-8', 'replace')
            if ('/root/.cargo/bin/cargo' in command
                    and ('test result: ok.' not in output or 'running 0 tests' in output)):
                harness_error = 'Selected Rust test harness did not execute tests'
                break
            if 'unittest' in command:
                test_diagnostic = result.stderr.decode('utf-8', 'replace')
                if 'Ran ' not in test_diagnostic or 'Ran 0 tests' in test_diagnostic:
                    harness_error = 'Selected Python test harness did not execute tests'
                    break
        control.write_bytes(root + '/stdout.log', b'\n'.join(value[0] for value in outputs))
        control.write_bytes(root + '/stderr.log', b'\n'.join(value[1] for value in outputs))
        after_backend, after = codegen._running_service(control.project, 'backend', identity, selected)
        if after_backend != backend or after['State']['StartedAt'] != document['State']['StartedAt']:
            raise BuildControlError('Backend identity changed during authoring tests')
        if diagnostic is not None and admit_diagnostic_source_checks(backend, after, control.volume) != diagnostic:
            raise BuildControlError('Diagnostic source-check authority changed during tests')
        if _source_hashes(selected) != before:
            raise BuildControlError('Authoring inputs changed during tests')
        for stdout, stderr in outputs:
            print(stdout.decode('utf-8', 'replace')[-24000:] + stderr.decode('utf-8', 'replace')[-8000:])
        print('Source check receipt: ' + root + '/receipt.json')
        if harness_error is not None:
            print(harness_error)
            exit_code = 1
            operation['receipt']['error'] = harness_error
        operation['receipt'].update(state='succeeded' if exit_code == 0 else 'failed-confirmed',
                                    exit_code=exit_code)
        control.write(root + '/receipt.json', operation['receipt'])
        return exit_code
