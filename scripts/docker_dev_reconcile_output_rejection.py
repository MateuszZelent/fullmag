"""Close one proven pre-admission HTTP 422 output-mapping rejection.

Authenticate the original lease, archive its evidence, drain the empty API,
and let that lease's own helper release it. Never repeat the old request.
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import shlex
import sys
import time

from docker_build_control import BuildControlError, canonical, docker_capture
from docker_control_namespace import _raw
from docker_dev_up import _selected_context
from docker_volume_activation_reconcile import _validate_activation_receipt, _validate_helper, _validate_helper_logged


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def reconcile(args):
    _, _, _, identity, control = _selected_context(args)
    if not re.fullmatch('[0-9a-f]{32}', args.activation):
        raise BuildControlError('Exact activation identity required')
    previous = control.read('development/current.json')
    if previous.get('state') != 'succeeded':
        raise BuildControlError('The API start is not qualified')
    backend = previous['backend_container']; frontend = previous['frontend_container']
    from docker_compose_identity import validate_source_labels
    from docker_volume_dev import _validate_retained_service
    document = control.read('development/attempts/' + previous['attempt'] + '/compose.json')
    engine = docker_capture('info', '--format', '{{.ID}}').stdout.strip()

    def verify_containers():
        if docker_capture('info', '--format', '{{.ID}}').stdout.strip() != engine:
            raise BuildControlError('Docker engine changed')
        if control.read('development/current.json') != previous:
            raise BuildControlError('Development attempt changed')
        for service, container in [('backend', backend), ('frontend', frontend)]:
            row = json.loads(docker_capture('inspect', container).stdout)[0]
            if row['Id'] != container:
                raise BuildControlError('Full container identity required')
            labels = row['Config'].get('Labels', {})
            if (labels.get('com.docker.compose.project') != control.project
                    or labels.get('com.docker.compose.service') != service):
                raise BuildControlError('Compose project/service identity differs')
            expected_image = json.loads(docker_capture(
                'image', 'inspect', document['services'][service]['image']).stdout)[0]['Id']
            if row['Image'] != expected_image:
                raise BuildControlError('Pinned service image differs')
            validate_source_labels(row, identity)
            image = json.loads(docker_capture('image', 'inspect', row['Image']).stdout)[0]
            _validate_retained_service(document, row, service, image['Config'])
            if not row['HostConfig'].get('ReadonlyRootfs'):
                raise BuildControlError('Immutable container filesystem required')

    verify_containers()
    receipt, raw, inputs = _validate_activation_receipt(
        control, activation_attempt=args.activation, development_attempt=previous['attempt'],
        config_sha256=previous['config_sha256'], source_root=identity['source_root'],
        image_id=previous['inputs']['image_id'], backend_id=backend,
    )
    match = re.search(r'startup activation returned HTTP 422: (\{[^\n]+\})', receipt['error'])
    response = json.loads(match[1]) if match else {}
    if response.get('code') != 'docker_startup_output_mapping_required':
        raise BuildControlError('Not the exact authoritative output mapping rejection')
    if response.get('message') != 'FULLMAG_SCRIPT_OUTPUT_ROOT is required for default or relative script output paths':
        raise BuildControlError('Output mapping rejection detail differs')
    helper, helper_id = _validate_helper(control, receipt['helper_container'], args.activation)
    _validate_helper_logged(helper_id)
    active = _raw(control, 'active')
    if active.decode().strip() != args.activation or control.read('activation/unresolved.json', optional=True):
        raise BuildControlError('Activation ownership or quarantine differs')
    marker_path = inputs['activation_receipt_path']
    prefix = '/opt/fullmag/control/'
    if not marker_path.startswith(prefix):
        raise BuildControlError('Activation marker is outside control')
    marker_relative = marker_path[len(prefix):]
    marker_raw = _raw(control, marker_relative); marker = json.loads(marker_raw)
    if (marker.get('state') != 'started' or marker.get('request_id') != inputs['request_id']
            or marker.get('source_sha256') != inputs['source_sha256']
            or marker.get('provenance_sha256') != inputs['provenance_sha256']):
        raise BuildControlError('Activation marker does not match the rejected request')
    code = """import json,pathlib,urllib.request
h=json.load(urllib.request.urlopen('http://127.0.0.1:8081/v2/platform/health',timeout=5))
if h.get('status')!='ok' or h.get('active_session') is not False: raise RuntimeError('API is not empty')
p=pathlib.Path('/state/runs/docker-all/session-store/runs')
if p.is_symlink() or (p.exists() and any(p.iterdir())): raise RuntimeError('accepted run exists')
print(json.dumps({'health':h,'accepted_runs':0}))
"""
    proof = json.loads(docker_capture('exec', backend, '/usr/local/bin/python3', '-I', '-B', '-c', code).stdout)
    root = 'activation/attempts/' + args.activation
    control.write(root + '/output-rejection-proof.json', {
        'receipt_sha256': sha(raw), 'marker_sha256': sha(marker_raw), 'response': response,
        'proof': proof, 'backend': backend, 'frontend': frontend,
        'authorization': 'repair-and-restart-requested-by-operator',
    })
    # Drain before final evidence; the backend cannot admit a later run afterward.
    verify_containers()
    docker_capture('stop', '--time', '60', backend, timeout=90)
    docker_capture('stop', '--time', '30', frontend, timeout=60)
    stopped = json.loads(docker_capture('inspect', backend).stdout)[0]
    if (stopped['State'].get('Running') or stopped['State'].get('ExitCode') != 0
            or stopped['State'].get('OOMKilled')):
        raise BuildControlError('Backend drain was not graceful; original lease retained')
    process = control.read('runtime-control/runtime-service/process-tree.json')
    if process.get('state') != 'drained':
        raise BuildControlError('Native process tree is not drained')
    runs = Path(previous['state_root']) / 'runs/docker-all/session-store/runs'
    if runs.is_symlink() or (runs.exists() and any(runs.iterdir())):
        raise BuildControlError('A run was admitted before drain; original lease retained')
    _validate_helper(control, receipt['helper_container'], args.activation)
    result = {'schema': 'fullmag.docker-startup-response.v1', 'state': 'rejected',
              'request_id': inputs['request_id'], 'source_sha256': inputs['source_sha256'],
              'source_relative': inputs['source_relative'],
              'rejection': {'http_status': 422, 'code': response['code'], 'message': response['message']}}
    from docker_startup_script import RESPONSE_SCHEMA
    result['schema'] = RESPONSE_SCHEMA
    terminal = {**receipt, 'state': 'failed-confirmed', 'activation_state': 'rejected',
                'reconciliation': 'output-mapping-pre-admission-rejection', 'finished_at': time.time()}
    rejected = {**marker, 'state': 'rejected', 'result': result}
    publications = [(marker_relative, canonical(rejected) + b'\n'),
                    ('activation/current.json', canonical(terminal) + b'\n'),
                    (root + '/terminal.json', canonical(terminal) + b'\n')]
    script = 'set -euo pipefail; umask 027; '
    for path, expected in [('active', sha(active)), (root + '/receipt.json', sha(raw)),
                           (marker_relative, sha(marker_raw))]:
        actual = shlex.quote(control.path(path))
        script += f'test ! -L {actual}; test "$(sha256sum {actual} | cut -d" " -f1)" = {shlex.quote(expected)}; '
    for path, data in publications:
        destination = shlex.quote(control.path(path))
        # The original helper alone watches terminal.json and removes active.
        script += f'test ! -L {destination}; t=$(mktemp {shlex.quote(control.path(root))}/.rejection.XXXXXX); '
        script += f'printf %s {shlex.quote(base64.b64encode(data).decode())} | base64 -d > "$t"; sync "$t"; mv -T "$t" {destination}; '
    script += 'sync /control; printf "RECONCILED\\n"'
    observed = docker_capture('exec', helper_id, '/bin/bash', '-c', script)
    if observed.stdout.strip() != b'RECONCILED':
        raise BuildControlError('Rejection publication not acknowledged; inspect retained evidence')
    for _ in range(10):
        if _raw(control, 'active', optional=True) is None:
            print(json.dumps({'state': 'rejected-confirmed', 'activation': args.activation, 'replayed': False})); return
        time.sleep(1)
    raise BuildControlError('Original helper has not yet released its lease')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--repo-root', type=Path, required=True)
    p.add_argument('--source-root', type=Path, required=True)
    p.add_argument('--activation', required=True)
    try:
        reconcile(p.parse_args()); return 0
    except (BuildControlError, OSError, ValueError, KeyError) as error:
        print('output-rejection: ' + str(error), file=sys.stderr); return 1


if __name__ == '__main__':
    raise SystemExit(main())
