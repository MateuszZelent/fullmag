"""Fixed authoring Rust regressions in the selected healthy Compose backend."""
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
                                         'scripts/docker_authoring_contract_checks.py')]
    for directory in ('crates', '.cargo'):
        paths.extend(path for path in (selected / directory).rglob('*')
                     if path.is_file() and path.suffix in ('.rs', '.toml'))
    return {str(path.relative_to(selected)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(paths)}


def run(control, selected: Path, identity, *, scope="authoring-contracts") -> int:
    commands = {
        "authoring-contracts": (COMMAND,),
        "stl-api-contracts": tuple(
            ('/root/.cargo/bin/cargo', 'test', '--locked', '--profile', 'backend-dev',
             '-p', 'fullmag-api', '--bin', 'fullmag-api', name)
            for name in ('imported_geometry_sources::tests',
                         'model::imported_surface::tests', 'stl', 'authoring_open_tests')
        ),
    }[scope]
    backend, document = codegen._running_service(control.project, 'backend', identity, selected)
    if document.get('State', {}).get('Health', {}).get('Status') != 'healthy':
        raise BuildControlError('Authoring checks require a healthy selected backend')
    mounts = {mount['Destination']: mount for mount in document.get('Mounts', [])}
    if any(mounts.get(destination, {}).get('Type') != 'volume'
           or mounts[destination].get('Name') != control.volume
           for destination in ('/build', '/opt/fullmag/control')):
        raise BuildControlError('Authoring checks require the selected private build/control volume')
    before = _source_hashes(selected)
    inputs = {'scope': scope, 'container_id': backend,
              'image_id': document['Image'], 'source_hashes': before,
              'commands': [list(command) for command in commands]}
    with control.operation('verification', inputs) as operation:
        root = operation['root']
        operation['receipt'].update(inputs, state='running', qualification='source tests only')
        control.write(root + '/receipt.json', operation['receipt'])
        outputs = []
        exit_code = 0
        for command in commands:
            operation['daemon_pending'] = True
            result = docker_capture('exec', backend, '/usr/local/bin/python3', '-B', '-c',
                                    CHECK_SCRIPT, *command, allow_failure=True, timeout=1800)
            operation['daemon_pending'] = False
            output = result.stdout.decode('utf-8', 'replace')
            if result.returncode == 0 and ('test result: ok.' not in output or 'running 0 tests' in output):
                raise BuildControlError('Selected Rust test harness did not execute tests')
            outputs.append((result.stdout, result.stderr))
            if result.returncode:
                exit_code = result.returncode
                break
        control.write_bytes(root + '/stdout.log', b'\n'.join(value[0] for value in outputs))
        control.write_bytes(root + '/stderr.log', b'\n'.join(value[1] for value in outputs))
        after_backend, after = codegen._running_service(control.project, 'backend', identity, selected)
        if after_backend != backend or after['State']['StartedAt'] != document['State']['StartedAt']:
            raise BuildControlError('Backend identity changed during authoring tests')
        if _source_hashes(selected) != before:
            raise BuildControlError('Authoring inputs changed during tests')
        operation['receipt'].update(state='succeeded' if exit_code == 0 else 'failed-confirmed',
                                    exit_code=exit_code)
        control.write(root + '/receipt.json', operation['receipt'])
        for stdout, stderr in outputs:
            print(stdout.decode('utf-8', 'replace')[-24000:] + stderr.decode('utf-8', 'replace')[-8000:])
        print('Rust source check receipt: ' + root + '/receipt.json')
        return exit_code
