"""Run the selected checkout's pinned Linux volume stage in its WSL host."""
from __future__ import annotations

import argparse
from contextlib import nullcontext
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

from docker_compose_identity import compose_project_identity
from docker_development_inputs import select_checkout
from docker_dev_host import validate_host_path
import fullmag_storage as storage
from fullmag_data_volume_linux_request import validate_linux_request
from fullmag_data_volume_runtime_binding import load_plan
from linux_data_volume_provision import _read, require


def _wsl_executable():
    # Same protected system interop location as the existing WSL host adapter.
    # Never execute a PATH lookalike, including one named Windows/System32.
    path = Path('/mnt/c/Windows/System32/wsl.exe')
    require(path.is_file(), 'Windows System32 WSL interop executable is unavailable')
    require(not any(p.is_symlink() for p in (path, *path.parents)),
             'Windows system interop path must not traverse a symlink')
    return str(path)


def command_for_stage(source, layout, identity, stage, distro, request_path=None,
                      request_sha256=None, formatter_sha256=None):
    require(stage in ('probe', 'preflight', 'format-mount', 'recover-mounted') and type(distro) is str and
             re.fullmatch(r'[A-Za-z0-9_-]{1,80}', distro), 'Exact Linux stage and WSL distro required')
    if stage == 'recover-mounted':
        require(formatter_sha256 is None, 'Recovery consumes its own closed component authority')
        return _recovery_command(source, layout, identity, distro, request_path, request_sha256)
    script = source/'scripts'/'linux_data_volume_provision.py'
    arguments = [stage]
    if stage == 'probe':
        require(request_path is None and request_sha256 is None and formatter_sha256 is None,
                 'Probe does not consume mutation request pins')
    else:
        require(type(request_sha256) is str and re.fullmatch(r'[0-9a-f]{64}', request_sha256),
                 'Exact request SHA required')
        require(isinstance(request_path, (str, Path)), 'Exact request path required')
        path = Path(request_path)
        require(path.is_absolute() and path.name == 'linux-provision-request.json' and
                 path.parent.parent == Path(layout['storage_root'])/'migrations/data-volumes' and
                 re.fullmatch(r'[0-9a-f]{32}', path.parent.name),
                 'Exact selected-storage request path required')
        _, value = _read(path, request_sha256)
        request = validate_linux_request(value)
        op = Path(layout['storage_root'])/'migrations/data-volumes'/request['volume_id']
        require(Path(request_path) == op/'linux-provision-request.json' and
                 request['storage_root'] == layout['storage_root'], 'Request is outside the selected storage scope')
        if 'runtime_binding_sha256' in request:
            _,plan,_binding=load_plan(op,request)
        else:
            _,plan=_read(op/'plan.json')
        require(plan.get('source_root') == str(source) and
                 plan.get('project_id') == identity['project_id'] and
                 plan.get('worktree_id') == identity['worktree_id'] and
                 plan.get('compose_project') == identity['project_name'] and
                 plan.get('provision_request', {}).get('wsl_distro') == distro,
                 'Plan belongs to another checkout, group, or WSL distro')
        roots = request['source_roots']
        expected_user = Path(layout['storage_root'])/'user-data'/identity['project_name']
        state = Path(roots['state']['canonical_root'])
        require(roots == plan.get('observation', {}).get('datasets') and
                 roots['user_data']['canonical_root'] == str(expected_user) and
                 state != Path(layout['runtime_root']) and state.is_relative_to(layout['runtime_root']),
                 'Original datasets differ from the selected group')
        require(request['controller_sha256'] == hashlib.sha256(script.read_bytes()).hexdigest(),
                 'Root qualifier source changed')
        arguments += ['--request', str(request_path), '--request-sha256', request_sha256]
        if stage == 'format-mount':
            script = source/'scripts'/'linux_data_volume_format.py'
            require(type(formatter_sha256) is str and
                     hashlib.sha256(script.read_bytes()).hexdigest() == formatter_sha256,
                     'Exact formatter source SHA required')
            arguments += ['--formatter-sha256', formatter_sha256]
        else:
            require(formatter_sha256 is None, 'Preflight cannot consume formatter authority')
    return [_wsl_executable(), '--distribution', distro, '--user', 'root', '--exec',
            '/usr/bin/python3', '-B', str(script), *arguments]


def _recovery_command(source, layout, identity, distro, path, expected_sha256):
    from linux_data_volume_recover import validate_request, COMPONENTS
    from docker_data_volume_root_bootstrap import bootstrap
    require(type(expected_sha256) is str and re.fullmatch('[0-9a-f]{64}', expected_sha256) and
            isinstance(path, (str, Path)), 'Exact root recovery request path and SHA required')
    _, raw = _read(Path(path), expected_sha256)
    request = validate_request(raw)
    op = Path(layout['storage_root'])/'migrations/data-volumes'/request['volume_id']
    require(request['storage_root'] == layout['storage_root'] and
            Path(path) == op/'recovery'/request['token']/'mounted-recovery-request.json',
            'Recovery request is outside the selected storage')
    _, raw_linux = _read(op/'linux-provision-request.json', request['linux_request_sha256'])
    linux = validate_linux_request(raw_linux)
    _, plan, _binding = load_plan(op, linux)
    require(plan.get('source_root') == str(source) and
        plan.get('project_id') == identity['project_id'] and
        plan.get('worktree_id') == identity['worktree_id'] and
        plan.get('compose_project') == identity['project_name'] and
        plan.get('provision_request', {}).get('wsl_distro') == distro and
        linux['volume_id'] == request['volume_id'] and linux['storage_root'] == layout['storage_root'] and
        linux['source_roots'] == plan.get('observation', {}).get('datasets'),
        'Recovery belongs to another checkout, group, original dataset or distro')
    expected_user = Path(layout['storage_root'])/'user-data'/identity['project_name']
    state = Path(linux['source_roots']['state']['canonical_root'])
    require(linux['source_roots']['user_data']['canonical_root'] == str(expected_user) and
        state != Path(layout['runtime_root']) and state.is_relative_to(layout['runtime_root']),
        'Recovery original datasets differ from the selected group')
    for name in COMPONENTS:
        raw = _read_optional_component(source/'scripts'/name)
        require(hashlib.sha256(raw).hexdigest() == request['components'][name],
                'Root recovery component source changed: '+name)
    return [_wsl_executable(), '--distribution', distro, '--user', 'root', '--exec',
            '/usr/bin/python3', '-I', '-B', '-c', bootstrap('recover-mounted'), str(source), str(path),
            expected_sha256, json.dumps(request['components'], sort_keys=True, separators=(',', ':'))]


def _read_optional_component(path):
    from fullmag_data_volume_guard import _read_optional_regular
    raw = _read_optional_regular(path, 'root recovery component', maximum=4*1024**2)
    require(raw is not None, 'Root recovery component is absent')
    return raw


def run_stage(source_root, stage, distro, *, request_path=None, request_sha256=None,
              formatter_sha256=None):
    require(os.name == 'posix', 'The WSL data-volume bridge requires the Linux host adapter')
    source = select_checkout(Path(source_root), str(source_root))
    validate_host_path(source, 'data-volume checkout')
    layout = storage.resolve_layout(source, profile='docker-all-gpu')
    identity = compose_project_identity(layout)
    context = storage.build_lock(layout) if stage in ('format-mount', 'recover-mounted') else nullcontext()
    with context:
        command = command_for_stage(source, layout, identity, stage, distro,
                                     request_path, request_sha256, formatter_sha256)
        # Keep the exact root stage attached. A caller interruption must never
        # be treated as evidence that its filesystem mutation stopped.
        return subprocess.run(command, check=False).returncode


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('stage', choices=['probe', 'preflight', 'format-mount', 'recover-mounted'])
    parser.add_argument('--source-root', required=True)
    parser.add_argument('--wsl-distro', required=True)
    parser.add_argument('--request')
    parser.add_argument('--request-sha256')
    parser.add_argument('--formatter-sha256')
    args = parser.parse_args(argv)
    raise SystemExit(run_stage(args.source_root, args.stage, args.wsl_distro,
                              request_path=args.request, request_sha256=args.request_sha256,
                              formatter_sha256=args.formatter_sha256))


if __name__ == '__main__':
    main()
