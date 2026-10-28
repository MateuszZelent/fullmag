"""Read-only qualification of daemon aliases owned by another registered DEV group.

Labels only locate evidence. The current control receipt must authenticate the
exact container incarnation and its immutable retained Compose mount mapping.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re

from docker_build_control import BuildControl, BuildControlError, canonical, docker_capture, toolchain_configuration
from docker_compose_identity import compose_project_identity
from docker_development_inputs import select_checkout
import fullmag_storage as storage


WSL_ALIAS = '/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/'


def canonical_bind_sources(container, *, repo_root=None):
    """Return authenticated alias -> canonical source mappings, or refuse.

    This never calls initialize_runtime/prepare and never enters an application's
    process namespace. Unknown applications and stale receipts remain blocked.
    """
    from docker_volume_dev import _validate_retained_service
    config = container.get('Config', {})
    labels = config.get('Labels', {})
    role = labels.get('com.docker.compose.service')
    candidate = labels.get('com.docker.compose.project.working_dir')
    if role not in {'backend', 'frontend'} or not isinstance(candidate, str) or not candidate.startswith('/'):
        raise BuildControlError('Foreign alias has no registered Linux DEV source evidence')
    repo = Path(repo_root) if repo_root is not None else Path(__file__).resolve().parents[1]
    source = select_checkout(repo.resolve(strict=True), Path(candidate)).resolve(strict=True)
    if source != Path(candidate):
        raise BuildControlError('Foreign DEV source is not its registered canonical path')
    identity = compose_project_identity(storage.resolve_layout(source))
    expected_labels = {
        'com.docker.compose.project': identity['project_name'],
        'org.fullmag.compose.project': identity['project_name'],
        'org.fullmag.source.project-id': identity['project_id'],
        'org.fullmag.source.worktree-id': identity['worktree_id'],
        'org.fullmag.source.checkout-kind': identity['checkout_kind'],
    }
    if any(labels.get(key) != value for key, value in expected_labels.items()):
        raise BuildControlError('Foreign DEV labels do not identify its registered source/group')
    configured = toolchain_configuration(source, identity)
    control = BuildControl(identity, configured['services']['fem-gpu-toolchain']['build']['args']['FULLMAG_CUDA_BASE_IMAGE'])
    current_raw = control.read_bytes('development/current.json')
    current = json.loads(current_raw)
    attempt = current.get('attempt')
    if not isinstance(attempt, str) or re.fullmatch(r'[0-9a-f]{32}', attempt) is None:
        raise BuildControlError('Foreign current DEV receipt has no exact attempt')
    identifier = container.get('Id')
    inputs = current.get('inputs', {})
    if (current.get('state') != 'succeeded' or current.get('phase') != 'development'
            or current.get('compose_project') != identity['project_name']
            or current.get('control_volume') != control.volume
            or current.get(role + '_container') != identifier
            or inputs.get('source_root') != str(source)
            or inputs.get('source_project_id') != identity['project_id']
            or inputs.get('source_worktree_id') != identity['worktree_id']
            or inputs.get('source_checkout_kind') != identity['checkout_kind']
            or inputs.get('image_id') != container.get('Image')):
        raise BuildControlError('Foreign alias is not the admitted exact DEV incarnation')
    if role == 'backend' and current.get('backend_started_at') != container.get('State', {}).get('StartedAt'):
        raise BuildControlError('Foreign backend incarnation changed since admission')
    compose_raw = control.read_bytes('development/attempts/' + attempt + '/compose.json')
    compose = json.loads(compose_raw)
    if (compose.get('name') != identity['project_name']
            or hashlib.sha256(canonical(compose)).hexdigest() != current.get('config_sha256')):
        raise BuildControlError('Foreign retained Compose is not pinned by its current receipt')
    images = json.loads(docker_capture('image', 'inspect', container['Image']).stdout)
    if len(images) != 1 or images[0].get('Id') != container['Image']:
        raise BuildControlError('Foreign immutable image evidence is unavailable')
    _validate_retained_service(compose, container, role, images[0].get('Config', {}))
    expected = compose['services'][role]
    observed = {item['Destination']: item for item in container.get('Mounts', [])}
    mapping = {}
    for mount in expected['volumes']:
        if mount.get('type') != 'bind':
            continue
        target = mount['target']
        alias = observed[target].get('Source')
        if not isinstance(alias, str) or not alias.startswith(WSL_ALIAS):
            continue
        if expected.get('x-fullmag-daemon-binds', {}).get(target) != alias:
            raise BuildControlError('Foreign alias has no exact historical daemon bind pin')
        host_source = mount.get('source')
        if not isinstance(host_source, str) or not host_source.startswith('/'):
            raise BuildControlError('Foreign alias has no canonical Linux host source')
        host = Path(host_source)
        if '..' in host.parts or any(storage.is_link(part) for part in (host, *host.parents)):
            raise BuildControlError('Foreign canonical host source traverses a link')
        canonical_source = str(host.resolve(strict=True))
        if canonical_source != host_source:
            raise BuildControlError('Foreign host source is not canonical')
        if alias in mapping and mapping[alias] != canonical_source:
            raise BuildControlError('Foreign alias has conflicting canonical source pins')
        mapping[alias] = canonical_source
    # A concurrent restart/recreation must invalidate this observation. The
    # caller also repeats live container inventory at its destructive boundary.
    if control.read_bytes('development/current.json') != current_raw or control.read_bytes('development/attempts/' + attempt + '/compose.json') != compose_raw:
        raise BuildControlError('Foreign DEV evidence changed during alias qualification')
    return mapping
