"""Pinned repair of the legacy start that lost its frontend generation before publication."""
from __future__ import annotations

from collections.abc import Mapping
import hashlib
import math
import re

from docker_build_control import BuildControlError, canonical


def validate_options(args):
    attempt = getattr(args, 'failed_frontend_start', None)
    digest = getattr(args, 'failed_frontend_start_sha256', None)
    if attempt is None and digest is None:
        return False
    if (not isinstance(attempt, str) or re.fullmatch(r'[0-9a-f]{32}', attempt) is None
            or not isinstance(digest, str) or re.fullmatch(r'[0-9a-f]{64}', digest) is None
            or not re.fullmatch(r'[0-9a-f]{32}', str(getattr(args, 'resume_recreation', '')))
            or getattr(args, 'fresh_state', False) or getattr(args, 'script', None)
            or getattr(args, 'completed_recreation_attempt', None)
            or getattr(args, 'recovery_authorization', None)):
        raise BuildControlError('Failed frontend start requires exact paired pins and plain retained recreation resume')
    return True


def validate_failed_start_boundary(args, control, selected, identity, *, current_raw, current,
                                   previous_raw, previous, operation_raw, operation_terminal,
                                   operator_probe_record):
    """Validate only the failed child; the caller must validate removal/native proof."""
    if not validate_options(args):
        raise BuildControlError('Failed frontend start pins are missing')
    if (not isinstance(current, Mapping) or current_raw != canonical(current) + b'\n'
            or hashlib.sha256(current_raw).hexdigest() != args.failed_frontend_start_sha256
            or current.get('attempt') != args.failed_frontend_start
            or current.get('attempt') == previous.get('attempt')
            or current.get('schema') != 'fullmag.docker-build-operation.v1'
            or current.get('phase') != 'development' or current.get('state') != 'failed-confirmed'
            or current.get('compose_project') != control.project
            or current.get('control_volume') != control.volume):
        raise BuildControlError('Failed frontend start terminal identity/pin differs')
    error = current.get('error')
    if (not isinstance(error, str) or re.fullmatch(
            r'Traceback \(most recent call last\):\n  File "<string>", line [1-9][0-9]*, in <module>\n'
            r'RuntimeError: Frontend metadata has unknown changes; all state retained\n?', error) is None):
        raise BuildControlError('Failed frontend start did not stop at the metadata gate')
    times = [operation_terminal.get('finished_at'), current.get('started_at'), current.get('finished_at')]
    if (any(type(value) not in (int, float) or not math.isfinite(value) for value in times)
            or not times[0] <= times[1] <= times[2]):
        raise BuildControlError('Failed frontend start/recreation time order differs')
    if (previous.get('private_group_storage') != 'group-volume-v1'
            or current.get('private_group_storage') != previous.get('private_group_storage')
            or any(current.get(key) != previous.get(key) for key in
                   ('state_root', 'backend_volumes', 'frontend_volume'))
            or current.get('ui_mode') != ('headless' if getattr(args, 'headless', False) else 'gui')):
        raise BuildControlError('Failed frontend start retained state/storage/UI intent differs')
    if ('frontend_generation_id' in current or 'frontend_generation_subpath' in current
            or isinstance(current.get('inputs'), Mapping)
            and 'frontend_start_handoff' in current['inputs']):
        raise BuildControlError('Legacy lost-generation repair cannot consume a generation-aware failed start')
    inputs = current.get('inputs')
    prior_inputs = previous.get('inputs', {})
    image = inputs.get('image_id') if isinstance(inputs, Mapping) else None
    if not isinstance(image, str) or re.fullmatch(r'sha256:[0-9a-f]{64}', image) is None:
        raise BuildControlError('Failed frontend start image is not immutable')
    expected_inputs = {
        'source_root': str(selected), 'image_id': image,
        'source_project_id': identity.get('project_id'),
        'source_worktree_id': identity.get('worktree_id'),
        'source_checkout_kind': identity.get('checkout_kind'),
        'ui_mode': current['ui_mode'],
        **{key: prior_inputs.get(key) for key in ('gpu_access_requested', 'device_access', 'gpu_preflight')},
        **operator_probe_record,
    }
    if inputs != expected_inputs or any(current.get(key) != value for key, value in operator_probe_record.items()):
        raise BuildControlError('Failed frontend start source/device/operator inputs differ')
    allowed = {
        'schema', 'phase', 'state', 'attempt', 'compose_project', 'control_volume',
        'helper_container', 'inputs', 'attempt_limit', 'log_byte_limit', 'minimum_free_bytes',
        'started_at', 'finished_at', 'error', 'build_data_qualification',
        'filesystem_before', 'filesystem_after', 'state_root', 'private_group_storage',
        'backend_volumes', 'frontend_volume', 'ui_mode', 'container_recovery',
        'container_recovery_environment', *operator_probe_record,
    }
    if getattr(control, 'namespace', ''):
        allowed.update(('control_namespace', 'namespace_registry_sha256'))
    if set(current) - allowed:
        raise BuildControlError('Failed frontend start has runtime publication or unknown receipt fields')
    root = 'development/attempts/' + args.failed_frontend_start
    expected_records = {
        'development/current.json': current_raw,
        root + '/receipt.json': current_raw, root + '/terminal.json': current_raw,
        'development/verified.json': previous_raw,
        'recreate-services/current.json': operation_raw,
        'recreate-services/verified.json': operation_raw,
    }
    for relative, expected in expected_records.items():
        if control.read_bytes(relative) != expected:
            raise BuildControlError('Failed frontend start receipt/current/verified CAS differs: ' + relative)
    # Backend cache preparation may have happened. No service, admission or
    # runtime publication is permitted at this exact metadata refusal boundary.
    for name in (
        'compose.json', 'frontend-seed.json', 'provenance.json', 'process-failure.json',
        'group-ledger.json', 'group-ledger-attestation.json', 'host-ledger.json',
        'host-ledger-attestation.json', 'host-capacity-publication.json',
        'backend-build-receipt.json', 'handoff-log.json', 'retained-containers.json',
    ):
        if control.read_bytes(root + '/' + name, optional=True) is not None:
            raise BuildControlError('Failed frontend start published an unexpected artifact: ' + name)


def validate_failed_start(args, control, selected, identity, *, capability, **evidence):
    validate_failed_start_boundary(args, control, selected, identity, **evidence)
    current = evidence['current']
    if (not isinstance(capability, Mapping) or not isinstance(capability.get('recovery_metadata'), Mapping)
            or not isinstance(capability.get('recovery_environment'), Mapping)
            or current.get('container_recovery') != capability['recovery_metadata']
            or current.get('container_recovery_environment') != sorted(capability['recovery_environment'])):
        raise BuildControlError('Failed frontend start original recovery capability differs')
