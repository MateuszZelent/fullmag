"""Read-only host inventory. Discovery is not qualification or a GPU lease."""
import json
from pathlib import Path
import re
import shutil

from local_runner.coordinator import CoordinatorError, docker


def inspect_host(layout, *, call=docker):
    info = json.loads(call(['info', '--format', '{{json .}}']))
    if not isinstance(info, dict) or info.get('OSType') != 'linux' or info.get('OperatingSystem') != 'Docker Desktop':
        raise CoordinatorError('Expected Docker Desktop Linux engine')
    identifiers = call(['ps', '-q', '--no-trunc']).split()
    if len(identifiers) > 256 or any(not re.fullmatch('[a-f0-9]{64}', value) for value in identifiers):
        raise CoordinatorError('Unexpected active-container inventory')
    containers = json.loads(call(['inspect', *identifiers])) if identifiers else []
    gpu_containers = []
    for container in containers:
        requests = container.get('HostConfig', {}).get('DeviceRequests') or []
        if any('gpu' in capability for request in requests for capability in request.get('Capabilities', [])):
            gpu_containers.append({'container_id': container['Id'], 'name': container.get('Name', '').lstrip('/'),
                                   'running': container.get('State', {}).get('Running')})
    storage = Path(layout['storage_root'])
    disk = shutil.disk_usage(storage)
    return {'schema': 'fullmag.local-runner.host-check.v1', 'docker_context': 'desktop-linux',
            'engine_id': info.get('ID'), 'engine_cpus': info.get('NCPU'),
            'engine_memory_bytes': info.get('MemTotal'), 'storage_free_bytes': disk.free,
            'active_gpu_containers': gpu_containers,
            'gpu_scheduling': 'defer-existing-workload' if gpu_containers else 'requires-lease-and-device-attestation',
            'qualification': 'not_assessed'}
