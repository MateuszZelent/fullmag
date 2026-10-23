"""Retire an exact fresh DEV start that failed capture before any API/run.

Preserves volumes and state; refuses accepted or ambiguous activation. This
route does not use the recovery protocol for a previously accepted session.
"""
import argparse
import json
from pathlib import Path
import re
import shlex
import sys

from docker_build_control import BuildControlError, bounded_capture, docker_capture
from docker_dev_source_transfer import inventory, stopped
from docker_dev_up import _selected_context
from docker_volume_capture_failure_reconcile import (
    _capture_logs, _container_state, _mount_arg, validate_timestamped_log_streams,
)


PROBE = r'''
import os,pathlib
p=pathlib.Path('/retained')
for rel in ['.fullmag/docker-startup/activation.json','runs/docker-all/session-store']:
    q=p/rel
    if q.is_symlink(): raise RuntimeError('linked state marker')
    if q.exists():
        if rel.endswith('activation.json'): raise RuntimeError('activation marker exists')
        if not q.is_dir(): raise RuntimeError('activation marker exists: '+rel)
        for child in q.iterdir():
            # Compose prepares this empty mount point before the backend runs.
            if child.name!='runtime-services' or child.is_symlink() or not child.is_dir() or any(child.iterdir()):
                raise RuntimeError('state is not an unadmitted fresh start: '+rel)
print('EMPTY')
'''


def retire(args):
    _, _, _, identity, control = _selected_context(args)
    if not re.fullmatch('[0-9a-f]{32}', args.attempt):
        raise BuildControlError('Exact attempt required')
    previous = control.read('development/current.json')
    if (previous.get('attempt') != args.attempt or previous.get('state') != 'failed-confirmed'
            or previous.get('inputs', {}).get('source_root') != identity['source_root']):
        raise BuildControlError('Current attempt does not match the fresh failed start')
    document = control.read('development/attempts/' + args.attempt + '/compose.json')
    rows = inventory(control.project)
    services = {r['Config']['Labels'].get('com.docker.compose.service'): r for r in rows}
    if len(rows) != 2 or set(services) != {'backend', 'frontend'}:
        raise BuildControlError('Expected exactly two stopped services')
    from docker_compose_identity import validate_source_labels
    from docker_volume_dev import _validate_retained_service
    for service, row in services.items():
        if service == 'backend' or not row['State'].get('Running'):
            stopped(row)
        validate_source_labels(row, identity)
        image = json.loads(docker_capture('image', 'inspect', row['Image']).stdout)[0]
        _validate_retained_service(document, row, service, image['Config'])
        if not row['HostConfig'].get('ReadonlyRootfs'):
            raise BuildControlError('Retirement requires immutable container filesystems')
    backend = services['backend']
    control.image = backend['Image']  # This verified image supplies Python for the read-only probe.
    state = _container_state(backend)
    if args.failure_kind == 'capture':
        logs = _capture_logs(backend['Id'], state)
    else:
        result = docker_capture('logs', '--timestamps', '--since', state['started_at'], backend['Id'])
        logs = validate_timestamped_log_streams({'stdout': result.stdout, 'stderr': result.stderr}, state)
        text = (logs['stdout'] + logs['stderr']).decode('utf-8', 'replace')
        required = ('phase=make state=complete exit_code=0', 'phase=start state=handoff',
                    'phase=gate state=complete profile=linux-native-v1',
                    "backend-dev: [Errno 13] Permission denied: '/opt/fullmag/worker_cgroup_gate.py'")
        forbidden = ('profile=worker-cgroup', 'Starting API', 'native runtime', 'phase=api')
        if any(text.count(value) != 1 for value in required) or any(value in text for value in forbidden):
            raise BuildControlError('Logs do not prove the exact helper import failure before API')
    engine = docker_capture('info', '--format', '{{.ID}}').stdout.decode().strip()
    def verify():
        if docker_capture('info', '--format', '{{.ID}}').stdout.decode().strip() != engine:
            raise BuildControlError('Docker engine changed')
        if control.read('development/current.json') != previous:
            raise BuildControlError('Development attempt changed')
        for path in ('activation/unresolved.json', 'runtime-control/runtime-service/process-tree.json'):
            if control.read(path, optional=True) is not None:
                raise BuildControlError('Activation or native runtime evidence exists; use explicit recovery')
        command = control.helper_args('exec python3 -I -B -c ' + shlex.quote(PROBE))
        mount = _mount_arg(backend, '/state').replace('dst=/state', 'dst=/retained')
        command[command.index('--entrypoint'):command.index('--entrypoint')] = ['--mount', mount]
        result = bounded_capture(command, data=b'', timeout=60)
        if result.returncode or result.stdout.strip() != b'EMPTY':
            raise BuildControlError('Fresh-state proof failed: ' + result.stderr.decode()[-2048:])
    verify()
    with control.operation('retire-empty-capture', {'attempt': args.attempt, 'containers': [r['Id'] for r in rows]}) as op:
        verify()
        current = inventory(control.project, op['receipt']['helper_container'])
        if {r['Id'] for r in current} != {r['Id'] for r in rows}:
            raise BuildControlError('Group inventory changed')
        if services['frontend']['State'].get('Running'):
            # Only the UI can still run; the backend has already failed before API.
            op['daemon_pending'] = True
            docker_capture('stop', '--time', '30', services['frontend']['Id'])
            op['daemon_pending'] = False
            current = inventory(control.project, op['receipt']['helper_container'])
        for row in current: stopped(row)
        control.write(op['root'] + '/containers.json', rows)
        for service, row in services.items():
            streams = logs if service == 'backend' else vars(docker_capture('logs', '--timestamps', row['Id']))
            for name in ('stdout', 'stderr'):
                control.write_bytes(op['root'] + '/' + service + '.' + name + '.log', streams[name])
        network = json.loads(docker_capture('network', 'inspect', identity['network_name']).stdout)[0]
        if network.get('Containers') or network.get('Labels', {}).get('com.docker.compose.project') != control.project:
            raise BuildControlError('Network is not empty and owned')
        control.write(op['root'] + '/network.json', network)
        verify()
        op['daemon_pending'] = True
        for row in current: docker_capture('rm', row['Id'])
        docker_capture('network', 'rm', network['Id'])
        op['daemon_pending'] = False
        op['receipt'].update(state='succeeded', retained_state=previous.get('state_root'),
                             no_activation=True, docker_engine_id=engine)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--repo-root', type=Path, required=True)
    p.add_argument('--source-root', type=Path, required=True)
    p.add_argument('--attempt', required=True)
    p.add_argument('--failure-kind', choices=('capture', 'helper-import'), default='capture')
    try:
        retire(p.parse_args()); return 0
    except (BuildControlError, OSError, ValueError, KeyError) as error:
        print('retire-empty-capture: ' + str(error), file=sys.stderr); return 1


if __name__ == '__main__':
    raise SystemExit(main())
