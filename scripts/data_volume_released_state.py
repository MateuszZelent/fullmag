"""Read released ledger/lease state while the caller holds writer fences.

This validator neither acquires nor releases locks, grants admission, nor
changes owner/lease records. The short observation route and the long copy
fence must call the same validator under their respective held guards.
"""


def collect_released_state(store_root, ledger_root):
    # Self-contained so an immutable backend image can execute this exact
    # source under its retained mounts without importing host dependencies.
    import hashlib
    import json
    import os
    from pathlib import Path
    import re
    import stat

    store, ledger = Path(store_root), Path(ledger_root)
    if not all(p.is_absolute() and '..' not in p.parts for p in (store, ledger)):
        raise ValueError('Released-state roots must be absolute without traversal')

    def open_existing(path, flags):
        fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
        try:
            for part in path.parts[1:-1]:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd); fd = child
            return os.open(path.name, flags | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        finally:
            os.close(fd)

    def unique(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError('Duplicate released-state JSON key')
            value[key] = item
        return value

    def decode(raw):
        def reject(_value):
            raise ValueError('Nonfinite released-state JSON value')
        value = json.loads(raw, object_pairs_hook=unique, parse_constant=reject)
        if type(value) is not dict:
            raise ValueError('Released-state record is not an object')
        return value

    def read(path, limit=16777216):
        fd = open_existing(path, os.O_RDONLY)
        try:
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > limit:
                raise ValueError('Unbounded or nonregular released-state observation')
            data = bytearray()
            while len(data) <= limit:
                chunk = os.read(fd, min(65536, limit+1-len(data)))
                if not chunk:
                    break
                data.extend(chunk)
            after = os.fstat(fd)
            identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
            if len(data) != before.st_size or len(data) > limit or identity(before) != identity(after):
                raise ValueError('Released-state observation changed during read')
            return bytes(data)
        finally:
            os.close(fd)

    # Authenticate the roots themselves before any os.scandir pathname walk.
    for path in (store, ledger):
        fd = open_existing(path, os.O_RDONLY | os.O_DIRECTORY)
        os.close(fd)
    doc = decode(read(ledger/'HOST_RESOURCE_LEDGER.json'))
    rows = doc.get('reservations')
    if type(rows) is not list or len(rows) > 8192 or any(
            type(row) is not dict or row.get('state') != 'released' for row in rows):
        raise ValueError('Host reservation is not released')
    refs = []
    for row in rows:
        digest = row.get('release_proof_sha256')
        if type(digest) is not str or re.fullmatch('[0-9a-f]{64}', digest) is None:
            raise ValueError('Invalid release proof digest')
        raw = read(ledger/'proofs'/(digest+'.json'), 65536)
        if hashlib.sha256(raw).hexdigest() != digest:
            raise ValueError('Release proof digest differs')
        proof = decode(raw)
        if (proof.get('schema_version') not in ['host_resource_release_proof.v1', 'host_resource_release_proof.v2']
                or proof.get('host_id') != doc['policy']['host_id']
                or proof.get('store_id') != row['identity']['store_id']
                or proof.get('request_sha256') != row['request_sha256']):
            raise ValueError('Release proof identity differs')
        refs.append([row['identity'], row['request_sha256'], digest])
    leases = []; count = 0; runs = store/'runs'
    fd = open_existing(runs, os.O_RDONLY | os.O_DIRECTORY); os.close(fd)
    with os.scandir(runs) as run_entries:
        for run in run_entries:
            count += 1
            if count > 8192 or run.is_symlink() or not run.is_dir(follow_symlinks=False):
                raise ValueError('Invalid or unbounded run inventory')
            for directory in ('resource_leases', 'preparation_resource_leases'):
                lease_root = Path(run.path)/directory
                try:
                    metadata = os.lstat(lease_root)
                except FileNotFoundError:
                    continue
                if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
                    raise ValueError('Lease root is not a real directory')
                with os.scandir(lease_root) as resource_entries:
                    for resource in resource_entries:
                        count += 1
                        if count > 8192 or resource.is_symlink() or not resource.is_dir(follow_symlinks=False):
                            raise ValueError('Invalid or unbounded resource inventory')
                        with os.scandir(resource.path) as lease_entries:
                            for entry in lease_entries:
                                count += 1
                                if count > 8192 or entry.is_symlink() or not entry.is_file(follow_symlinks=False) or not entry.name.endswith('.json'):
                                    raise ValueError('Invalid or unbounded lease entry')
                                raw = read(Path(entry.path), 262144)
                                if decode(raw).get('state') != 'released':
                                    raise ValueError('Local lease is not released')
                                leases.append([str(Path(entry.path).relative_to(store)), hashlib.sha256(raw).hexdigest()])
    return {'schema': 'fullmag.pre-ack-released-observation.v1',
            'reservations': sorted(refs, key=lambda row: json.dumps(row[0], sort_keys=True)),
            'leases': sorted(leases), 'active_count': 0}
