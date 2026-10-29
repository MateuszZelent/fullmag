"""Managed, fail-closed recovery of one retained backend package candidate."""
import argparse
import hashlib
import json
import re
import shlex
import sys
from pathlib import Path

import fullmag_storage as storage
import docker_backend_volume_cache as cache
from docker_build_control import BuildControl, BuildControlError, bounded_capture, docker_capture, control_read_script
from docker_compose_identity import compose_project_identity, validate_source_labels
from docker_host_ledger import _same_daemon_path


def request_digest(document):
    raw = json.dumps(document, sort_keys=True, separators=(',', ':'), ensure_ascii=False) + '\n'
    return hashlib.sha256(raw.encode('utf-8')).hexdigest()


def normalized_backend(document):
    return {**document, "Mounts": sorted(document.get("Mounts", []), key=lambda m: m["Destination"])}


def inspect_one(kind, identity):
    rows = json.loads(docker_capture(kind, 'inspect', identity).stdout)
    if len(rows) != 1:
        raise BuildControlError('Recovery requires one exact inspected identity')
    return rows[0]


def validate_backend(document, control, selected, container_id, image_id):
    validate_source_labels(document, control.identity)
    labels = document.get('Config', {}).get('Labels') or {}
    state = document.get('State', {})
    if (document.get('Id') != container_id or document.get('Image') != image_id
            or state.get('Running') is not False or state.get('Status') != 'exited'
            or state.get('Restarting') is not False
            or labels.get('com.docker.compose.project') != control.project
            or labels.get('com.docker.compose.service') != 'backend'):
        raise BuildControlError('Recovery requires the exact stopped backend and image')
    mounts = document.get('Mounts', [])
    source = [m for m in mounts if m.get('Destination') == '/opt/fullmag/source']
    if (len(source) != 1 or source[0].get('Type') != 'bind'
            or source[0].get('RW') is not False
            or not _same_daemon_path(source[0].get('Source'), str(selected))):
        raise BuildControlError('Recovery source mount differs or is writable')
    fields = {'project_id': cache.LABEL_PROJECT, 'cache_key': cache.LABEL_CACHE_KEY,
              'unit_key': cache.LABEL_UNIT, 'worktree_id': cache.LABEL_WORKTREE,
              'toolchain_image_id': cache.LABEL_TOOLCHAIN, 'cargo_profile': cache.LABEL_CARGO_PROFILE,
              'owner_id': cache.LABEL_OWNER}
    profile = {key: labels.get(label) for key, label in fields.items()}
    expected = cache.cache_key(selected, control.identity['worktree_id'],
                               profile['toolchain_image_id'], profile['cargo_profile'])
    if profile['cache_key'] != expected['key'] or profile['worktree_id'] != control.identity['worktree_id']:
        raise BuildControlError('Recovery cache source identity differs')
    names = {}
    for role, target in (('build', '/build'), ('package', '/opt/fullmag/package'), ('control', '/opt/fullmag/control')):
        found = [m for m in mounts if m.get('Destination') == target]
        if len(found) != 1 or found[0].get('Type') != 'volume' or found[0].get('RW') is not True:
            raise BuildControlError('Recovery requires exact named-volume mounts')
        name = found[0].get('Name')
        if not isinstance(name, str) or re.fullmatch(r'[a-z0-9][a-z0-9_.-]*', name) is None:
            raise BuildControlError('Invalid recovery volume name')
        names[role] = name
    if names['control'] != control.volume or len(set(names.values())) != 3:
        raise BuildControlError('Recovery control volume differs or volumes alias')
    profile.update(volume_names=names, control_project=control.project)
    documents = {role: inspect_one('volume', name) for role, name in names.items()}
    cache._validate_volume_documents(documents, profile)
    # Namespaced mounts require separate namespace attestation; reject rather than widen access.
    protected_targets = {'/build', '/opt/fullmag/package', '/opt/fullmag/control'}
    if control.namespace or any(m.get('VolumeOptions', {}).get('Subpath')
            for m in document.get('HostConfig', {}).get('Mounts', [])
            if m.get('Target') in protected_targets):
        raise BuildControlError('Candidate recovery does not support namespaced mounts')
    return names


def reject_active_consumers(names):
    ids = docker_capture('ps', '--quiet', '--no-trunc').stdout.decode().split()
    rows = json.loads(docker_capture('inspect', *ids).stdout) if ids else []
    protected = {names['build'], names['package']}
    if any(m.get('Name') in protected for row in rows for m in row.get('Mounts', [])):
        raise BuildControlError('Recovery volumes have active consumers')


def helper_arguments(control, selected, names, request, digest, apply, name, source_pins=None):
    command = ['/usr/local/bin/python3', '-B', '/opt/fullmag/source/docker/all-in-one/backend_candidate_recovery.py',
               '--request', control.path(request), '--request-sha256', digest]
    if apply:
        command.append('--apply')
    arguments = control.helper_args(shlex.join(command), name=name)
    arguments.remove('--rm')  # A timeout must preserve daemon-side evidence and ownership.
    arguments[arguments.index('--memory') + 1] = '256m'
    arguments[arguments.index('--cpus') + 1] = '1'
    mounts = ['--volume', str(selected) + ':/opt/fullmag/source:ro']
    for role, target in (('build', '/build'), ('package', '/opt/fullmag/package'), ('control', '/opt/fullmag/control')):
        mount = 'type=volume,src=' + names[role] + ',dst=' + target + ',volume-nocopy'
        if role == 'package' and not apply:
            mount += ',readonly'
        mounts += ['--mount', mount]
    for key, value in (source_pins or {}).items():
        mounts += ['--env', key + '=' + value]
    anchor = arguments.index('--entrypoint')
    arguments[anchor:anchor] = mounts
    return arguments


def recover(args):
    for value, pattern in ((args.backend_container_id, r'[0-9a-f]{64}'),
                           (args.image_id, r'sha256:[0-9a-f]{64}'), (args.request_sha256, r'[0-9a-f]{64}')):
        if re.fullmatch(pattern, value) is None:
            raise BuildControlError('Recovery requires full immutable pins')
    if str(Path(args.source_root).resolve()) != args.source_root:
        raise BuildControlError('Recovery requires a canonical source root')
    selected = Path(args.source_root)
    identity = compose_project_identity(storage.resolve_layout(selected, 'docker-all-gpu'))
    control = BuildControl(identity, args.image_id)
    if control.path(args.request) != '/control/' + args.request:
        raise BuildControlError('Recovery request path must be canonical')
    if inspect_one('image', args.image_id).get('Id') != args.image_id:
        raise BuildControlError('Recovery image changed')
    original = inspect_one('container', args.backend_container_id)
    names = validate_backend(original, control, selected, args.backend_container_id, args.image_id)
    reject_active_consumers(names)
    read = bounded_capture(control.helper_args(control_read_script(control.path(args.request))), data=b'')
    if read.returncode:
        raise BuildControlError('Recovery request read failed')
    raw = read.stdout
    if hashlib.sha256(raw).hexdigest() != args.request_sha256:
        raise BuildControlError('Recovery request digest differs')
    source_paths = {'FULLMAG_RECOVERY_HELPER_SHA256': selected / 'docker/all-in-one/backend_candidate_recovery.py',
                    'FULLMAG_RECOVERY_BACKEND_SHA256': selected / 'docker/all-in-one/backend_dev.py'}
    source_pins = {key: hashlib.sha256(path.read_bytes()).hexdigest() for key, path in source_paths.items()}
    request_document = json.loads(raw)
    inputs = dict(source_pins=source_pins, source_root=str(selected), backend_container_id=args.backend_container_id,
                  image_id=args.image_id, request=args.request, request_sha256=args.request_sha256, apply=args.apply)
    with control.operation('package-recovery', inputs) as operation:
        root = operation['root']
        control.write_bytes(root + '/request.json', raw)
        helper = 'fullmag-candidate-recovery-' + operation['receipt']['attempt']
        operation['receipt'].update(helper_container=helper, volumes=names)
        arguments = helper_arguments(control, selected, names, root + '/request.json', args.request_sha256, args.apply, helper, source_pins)
        # Revalidate immediately before starting the sole writer under the operation lease.
        again = inspect_one('container', args.backend_container_id)
        if normalized_backend(again) != normalized_backend(original) or validate_backend(again, control, selected, args.backend_container_id, args.image_id) != names:
            raise BuildControlError('Backend changed during recovery admission')
        reject_active_consumers(names)
        if {key: hashlib.sha256(path.read_bytes()).hexdigest() for key, path in source_paths.items()} != source_pins:
            raise BuildControlError('Recovery helper sources changed before launch')
        operation['daemon_pending'] = True
        result = bounded_capture(arguments, data=b'', timeout=180, maximum=1024 * 1024)
        terminal = inspect_one('container', helper)
        state = terminal.get('State', {})
        labels = terminal.get('Config', {}).get('Labels') or {}
        if (terminal.get('Image') != args.image_id or terminal.get('Name') != '/' + helper
                or labels.get('com.docker.compose.project') != control.project
                or labels.get('com.docker.compose.service') != 'build-control'
                or state.get('Running') is not False or state.get('Status') != 'exited'
                or state.get('ExitCode') != result.returncode):
            raise BuildControlError('Recovery helper termination is unconfirmed')
        operation['daemon_pending'] = False
        control.write(root + '/output.json', dict(exit_code=result.returncode,
                      stdout=result.stdout.decode('utf8', 'replace'), stderr=result.stderr.decode('utf8', 'replace')))
        if result.returncode == 0:
            value = json.loads(result.stdout)
            expected = {'schema': 'fullmag.backend-candidate-recovery.v1',
                'request_sha256': request_digest(request_document),
                'source': '/opt/fullmag/package/.development/candidates/' + request_document['candidate_basename'],
                'destination': '/opt/fullmag/package/.development/quarantine/' + request_document['candidate_basename']}
            if (set(value) != set(expected) | {'state'} or any(value.get(k) != v for k, v in expected.items())
                    or value.get('state') not in ({'quarantined'} if args.apply else {'dry-run', 'quarantined'})):
                raise BuildControlError('Recovery result differs from pinned request')
            if {key: hashlib.sha256(path.read_bytes()).hexdigest() for key, path in source_paths.items()} != source_pins:
                raise BuildControlError('Recovery source inputs changed during operation')
            control.write(root + '/result.json', value)
        operation['receipt'].update(state='succeeded' if result.returncode == 0 else 'failed-confirmed', exit_code=result.returncode)
        return result.returncode


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('source-root', 'backend-container-id', 'image-id', 'request', 'request-sha256'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--apply', action='store_true')
    return recover(parser.parse_args())


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (BuildControlError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(2)
