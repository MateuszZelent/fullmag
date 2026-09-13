"""Small Docker Engine adapter over the coordinator-only Unix socket."""
import http.client
import json
import socket
import struct
from urllib.parse import urlencode, quote

from local_runner.coordinator import CoordinatorError


class UnixConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect('/var/run/docker.sock')


def engine(method, path, payload=None):
    connection = UnixConnection('localhost', timeout=60)
    try:
        body = json.dumps(payload).encode() if payload is not None else None
        connection.request(method, '/v1.41' + path, body=body, headers={'Content-Type': 'application/json'})
        response = connection.getresponse()
        content = response.read(16 * 1024**2 + 1)
        if len(content) > 16 * 1024**2:
            raise CoordinatorError('Docker response exceeded bound')
        if not 200 <= response.status < 300:
            raise CoordinatorError(f'Docker API {method} {path.split("?")[0]} failed: {response.status} {content[:500].decode(errors="replace")}')
        return content
    finally:
        connection.close()


def create_payload(argv):
    config = {'Env': [], 'Labels': {}, 'HostConfig': {'Mounts': []}}
    host = config['HostConfig']
    name = None
    index = 0
    while index < len(argv) and argv[index].startswith('--'):
        option = argv[index]
        index += 1
        if option in ('--init', '--read-only'):
            host['Init' if option == '--init' else 'ReadonlyRootfs'] = True
            continue
        if index >= len(argv):
            raise ValueError('Missing Docker option value')
        value = argv[index]
        index += 1
        if option == '--name': name = value
        elif option == '--label':
            key, value = value.split('=', 1)
            config['Labels'][key] = value
        elif option == '--env': config['Env'].append(value)
        elif option == '--user': config['User'] = value
        elif option == '--workdir': config['WorkingDir'] = value
        elif option == '--entrypoint': config['Entrypoint'] = [value]
        elif option == '--cap-drop': host.setdefault('CapDrop', []).append(value)
        elif option == '--security-opt': host.setdefault('SecurityOpt', []).append(value)
        elif option == '--cpus': host['NanoCpus'] = int(float(value) * 10**9)
        elif option in ('--memory', '--memory-swap', '--pids-limit'):
            host[{'--memory': 'Memory', '--memory-swap': 'MemorySwap', '--pids-limit': 'PidsLimit'}[option]] = int(value)
        elif option == '--network': host['NetworkMode'] = value
        elif option == '--tmpfs':
            destination, options = value.split(':', 1)
            host.setdefault('Tmpfs', {})[destination] = options
        elif option == '--gpus' and value == 'all':
            host['DeviceRequests'] = [{'Driver': 'nvidia', 'Count': -1, 'Capabilities': [['gpu']]}]
        elif option == '--mount':
            parts = value.split(',')
            if any(part != 'readonly' and '=' not in part for part in parts):
                raise ValueError('Invalid mount syntax')
            fields = dict(part.split('=', 1) for part in parts if '=' in part)
            if set(fields) != {'type', 'source', 'target'} or fields['type'] != 'bind':
                raise ValueError('Only exact bind mounts are supported')
            host['Mounts'].append({'Type': 'bind', 'Source': fields['source'], 'Target': fields['target'],
                                   'ReadOnly': 'readonly' in parts, 'BindOptions': {'Propagation': 'rprivate'}})
        else:
            raise ValueError('Unsupported Docker worker option: ' + option)
    if index >= len(argv) or not name:
        raise ValueError('Missing Docker image/name')
    config['Image'] = argv[index]
    config['Cmd'] = argv[index + 1:]
    return name, config


def decode_logs(content):
    output = bytearray()
    while content:
        if len(content) < 8 or content[0] not in (0, 1, 2) or content[1:4] != b'\0\0\0':
            raise CoordinatorError('Unexpected Docker log framing')
        length = struct.unpack('>I', content[4:8])[0]
        if len(content) < 8 + length:
            raise CoordinatorError('Truncated Docker log frame')
        output.extend(content[8:8 + length])
        content = content[8 + length:]
    return output.decode('utf-8', errors='replace')


def docker(argv):
    if argv[:2] == ['image', 'inspect'] and len(argv) == 3:
        return '[' + engine('GET', '/images/' + quote(argv[2], safe='') + '/json').decode() + ']'
    if argv[0] == 'inspect':
        return json.dumps([json.loads(engine('GET', '/containers/' + quote(value, safe='') + '/json')) for value in argv[1:]])
    if argv[0] == 'ps':
        filters = {}
        for index, value in enumerate(argv):
            if value == '--filter':
                key, item = argv[index + 1].split('=', 1)
                filters.setdefault(key, []).append(item)
        values = json.loads(engine('GET', '/containers/json?' + urlencode({'all': int('-a' in argv), 'filters': json.dumps(filters)})))
        return '\n'.join(value['Id'] for value in values)
    if argv[0] == 'create':
        name, payload = create_payload(argv[1:])
        return json.loads(engine('POST', '/containers/create?' + urlencode({'name': name}), payload))['Id']
    if argv[0] == 'start' and len(argv) == 2:
        engine('POST', '/containers/' + quote(argv[1], safe='') + '/start')
        return argv[1]
    if argv[0] == 'stop' and argv[1:3] == ['--time', '10'] and len(argv) == 4:
        engine('POST', '/containers/' + quote(argv[3], safe='') + '/stop?t=10')
        return argv[3]
    if argv[0] == 'logs' and argv[1] == '--tail' and len(argv) == 4 and argv[2].isdigit():
        return decode_logs(engine('GET', '/containers/' + quote(argv[3], safe='') + '/logs?' + urlencode({'stdout': 1, 'stderr': 1, 'tail': min(int(argv[2]), 3000)})))
    if argv[0] == 'info':
        return engine('GET', '/info').decode()
    if argv[0] == 'stats':
        container_id = next((arg for arg in reversed(argv[1:]) if not arg.startswith('-')), argv[-1])
        raw_stats = engine('GET', '/containers/' + quote(container_id, safe='') + '/stats?stream=false')
        stats = json.loads(raw_stats) if isinstance(raw_stats, (bytes, str)) else {}
        if not isinstance(stats, dict):
            stats = {}
        mem_stats = stats.get('memory_stats') or {}
        mem_usage = mem_stats.get('usage') or 0
        mem_limit = mem_stats.get('limit') or 0
        cpu_stats = stats.get('cpu_stats') or {}
        precpu_stats = stats.get('precpu_stats') or {}
        cpu_usage = cpu_stats.get('cpu_usage') or {}
        precpu_usage = precpu_stats.get('cpu_usage') or {}
        cpu_delta = (cpu_usage.get('total_usage') or 0) - (precpu_usage.get('total_usage') or 0)
        system_delta = (cpu_stats.get('system_cpu_usage') or 0) - (precpu_stats.get('system_cpu_usage') or 0)
        online_cpus = cpu_stats.get('online_cpus') or len(cpu_usage.get('percpu_usage') or [1])
        cpu_pct = 0.0
        if system_delta > 0 and cpu_delta > 0:
            cpu_pct = (cpu_delta / system_delta) * online_cpus * 100.0
        blkio_stats = stats.get('blkio_stats') or {}
        bio_bytes = blkio_stats.get('io_service_bytes_recursive') or []
        read_bytes = sum(item.get('value', 0) for item in bio_bytes if isinstance(item, dict) and item.get('op') == 'Read')
        write_bytes = sum(item.get('value', 0) for item in bio_bytes if isinstance(item, dict) and item.get('op') == 'Write')
        return f"{mem_usage}B / {mem_limit}B|{cpu_pct:.1f}%|{read_bytes}B / {write_bytes}B"
    raise ValueError('Docker operation not supported by container coordinator')
