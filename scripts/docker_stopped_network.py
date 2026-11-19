"""Read-only proof for the retained private bridge of an exact stopped DEV pair.

Callers authenticate container incarnations, mounts and stopped private PID/IPC
namespaces before calling. A daemon failure never becomes absence evidence.
"""
from __future__ import annotations

from collections.abc import Mapping
import json
import re

from docker_build_control import BuildControlError, docker_capture
from docker_compose_identity import compose_network_name


_HEX64 = re.compile(r'[0-9a-f]{64}\Z')
_PROJECT = re.compile(r'[a-z0-9][a-z0-9_-]*\Z')


def _network(container):
    networks = container.get('NetworkSettings', {}).get('Networks')
    if not isinstance(networks, Mapping) or len(networks) != 1:
        raise BuildControlError('Stopped DEV service must retain exactly one network identity')
    name, endpoint = next(iter(networks.items()))
    if not isinstance(name, str) or not isinstance(endpoint, Mapping):
        raise BuildControlError('Stopped DEV network identity is malformed')
    identifier = endpoint.get('NetworkID')
    if not isinstance(identifier, str) or _HEX64.fullmatch(identifier) is None:
        raise BuildControlError('Stopped DEV network requires its exact historical ID')
    return name, identifier


def authoritative_network_not_found(result, identifier):
    """Accept only an exact full ID or qualified Compose bridge name."""
    if (not isinstance(identifier, str) or (_HEX64.fullmatch(identifier) is None
            and re.fullmatch(r'(?:[a-z0-9][a-z0-9_-]*_fullmag|fullmag-net-[0-9a-f]{16})', identifier) is None)):
        return False
    if result.returncode != 1:
        return False
    try:
        message = result.stderr.decode('utf-8').strip().lower()
        output = result.stdout.decode('utf-8').strip()
    except (UnicodeDecodeError, AttributeError):
        return False
    return output in {'', '[]'} and message in {
        'error response from daemon: network ' + identifier + ' not found',
        'error response from daemon: no such network: ' + identifier,
        'error: no such network: ' + identifier,
        'no such network: ' + identifier,
    }


def observe_stopped_bridge(backend, frontend, project, *, capture=None, validate_owned_bridge=None):
    capture = capture or docker_capture
    if not isinstance(project, str) or _PROJECT.fullmatch(project) is None:
        raise BuildControlError('Stopped bridge requires an exact Compose project')
    name, identifier = _network(backend)
    if _network(frontend) != (name, identifier):
        raise BuildControlError('Stopped services do not pin the same old network')
    if name != compose_network_name(project):
        raise BuildControlError('Retained private bridge name does not belong to the selected project')
    if backend.get('HostConfig', {}).get('PortBindings'):
        raise BuildControlError('Stopped recovery requires an unpublished backend')

    def inventory():
        result = capture('network', 'ls', '--no-trunc', '--format', '{{json .}}', timeout=60)
        if result.returncode != 0:
            raise BuildControlError('Docker network inventory failed; absence is unknown')
        try:
            rows = [json.loads(line) for line in result.stdout.decode('utf-8').splitlines() if line.strip()]
        except (UnicodeDecodeError, ValueError) as error:
            raise BuildControlError('Docker network inventory is invalid') from error
        if any(not isinstance(row, dict) or not isinstance(row.get('Name'), str)
               or not isinstance(row.get('ID'), str) or _HEX64.fullmatch(row['ID']) is None for row in rows):
            raise BuildControlError('Docker network inventory has incomplete identities')
        return rows

    before = inventory()
    matching = [row for row in before if row['Name'] == name or row['ID'] == identifier]
    if matching:
        if len(matching) != 1 or matching[0]['ID'] != identifier or matching[0]['Name'] != name:
            raise BuildControlError('Old bridge name or immutable ID changed')
        if validate_owned_bridge is None:
            from docker_volume_dev import _assert_private_restart_network
            validate_owned_bridge = _assert_private_restart_network
        validate_owned_bridge({'backend': backend, 'frontend': frontend},
                              {'backend': backend['Id'], 'frontend': frontend['Id']}, project)
        # The legacy owner validator inspects by name. Bind its result to the
        # old immutable ID so name reuse during that RPC cannot pass as history.
        inspected = capture('network', 'inspect', identifier, timeout=60)
        try:
            documents = json.loads(inspected.stdout)
        except (UnicodeDecodeError, ValueError) as error:
            raise BuildControlError('Old bridge ID inspection is invalid') from error
        if (inspected.returncode != 0 or not isinstance(documents, list) or len(documents) != 1
                or not isinstance(documents[0], dict) or documents[0].get('Id') != identifier
                or documents[0].get('Name') != name):
            raise BuildControlError('Old bridge immutable identity changed during validation')
        return {'name': name, 'network_id': identifier, 'state': 'owned-bridge'}
    missing = capture('network', 'inspect', identifier, allow_failure=True, timeout=60)
    if not authoritative_network_not_found(missing, identifier):
        raise BuildControlError('Old private network absence is not authoritative')
    if any(row['Name'] == name or row['ID'] == identifier for row in inventory()):
        raise BuildControlError('Old private network changed during absence observation')
    return {'name': name, 'network_id': identifier, 'state': 'absent'}
