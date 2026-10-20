"""Offline, recoverable removal of the operator's BORIS profile."""
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import uuid

from fullmag_storage import file_lock, validate_path

NAMES = ('local-runner-container-secret.json', 'local-runner-container.json', 'local-runner-build-config.json')
JOURNAL_SCHEMA = 'fullmag.boris.offline-profile-transition.v1'
RECONCILE_SCHEMA = 'fullmag.runner.desired-profile-reconcile.v1'
MAX_CONFIG_BYTES = 65536


def _journal_path(storage):
    return validate_path(Path(storage) / 'index' / 'local-runner-boris-transition' / 'pending.json', Path(storage))


def assert_no_pending(storage):
    from local_runner.container_client import ContainerClientError
    if _journal_path(storage).exists():
        raise ContainerClientError('A BORIS profile transaction requires explicit offline recovery')


def _private_directory(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if os.name == 'nt':
        # This command handles only a path; no secret enters the process arguments.
        script = "& { param($p) $id=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true,$false); foreach($sid in @($id,(New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-18'))) { $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule) }; Set-Acl -LiteralPath $p -AclObject $acl -ErrorAction Stop }"
        completed = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script, str(path)], capture_output=True)
        if completed.returncode:
            raise OSError('Cannot protect private transition directory')
    else:
        os.chmod(path, 0o700)


def _sync_directory(path):
    if os.name != 'nt':
        descriptor = os.open(path, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def _write_bytes(path, data, *, mode=None):
    temporary = path.with_name('.' + path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode or 0o600)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if os.name == 'nt' and path.exists():
            script = '& { param($source,$target) Set-Acl -LiteralPath $target -AclObject (Get-Acl -LiteralPath $source -ErrorAction Stop) -ErrorAction Stop }'
            done = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script, str(path), str(temporary)], capture_output=True)
            if done.returncode:
                raise OSError('Cannot preserve transition file ACL')
        os.replace(temporary, path)
        _sync_directory(path.parent)
    finally:
        if temporary.exists():
            temporary.unlink()


def _read_bytes(path):
    from local_runner.container_client import ContainerClientError
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_CONFIG_BYTES:
        raise ContainerClientError('Transition input is not a bounded regular config file')
    return path.read_bytes()


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def entry_sha(entry):
    return _sha(json.dumps(entry, sort_keys=True, separators=(',', ':'), allow_nan=False).encode())


def _validate_pair(storage, owner, blobs):
    from local_runner import container_client as client
    try:
        secret, public, catalog = (json.loads(blob) for blob in blobs)
    except (ValueError, TypeError) as error:
        raise client.ContainerClientError('Transition input JSON is invalid') from error
    public = client._validate_public(public, storage, owner)
    client._validate_secret(secret, storage, owner, public['port'])
    if public['allowed_profiles'] != secret['allowed_profiles']:
        raise client.ContainerClientError('Transition input profile pair differs')
    if (not isinstance(catalog, dict) or set(catalog) != {'schema', 'operator', 'profiles'}
            or catalog['schema'] != 'fullmag.runner-build-config.v1' or catalog['operator'] != owner
            or not isinstance(catalog['profiles'], dict)):
        raise client.ContainerClientError('Transition catalogue identity mismatch')
    return secret, public, catalog


def _offline_guard(layout, owner, public, docker_call):
    from local_runner import container_client as client
    storage = client._storage_root(layout)
    _, secret_path, _ = client._config_paths(layout)
    identifier = client._find_container(docker_call)
    if identifier is None:
        raise client.ContainerClientError('An exact exited coordinator is required')
    current = client._attest(client._inspect_container(docker_call, identifier), storage=storage,
                             secret_path=secret_path, public=public, operator=owner)
    if current['running'] or current['state'] != 'exited':
        raise client.ContainerClientError('Profile transition requires an exited coordinator')
    ids = client._docker_text(docker_call, ['ps', '-a', '--no-trunc', '--format', '{{.ID}}']).split()
    if any(not client._CONTAINER_ID_RE.fullmatch(value) for value in ids):
        raise client.ContainerClientError('Worker inventory contains an invalid container ID')
    containers = client._docker_json(docker_call, ['inspect', *ids]) if ids else []
    if len(set(ids)) != len(ids) or not isinstance(containers, list) or len(containers) != len(ids) or {item.get('Id') for item in containers if isinstance(item, dict)} != set(ids):
        raise client.ContainerClientError('Worker inventory is incomplete')
    for item in containers:
        if not isinstance(item, dict) or item.get('Id') not in ids:
            raise client.ContainerClientError('Worker inventory identity mismatch')
        state = item.get('State', {})
        if not isinstance(state, dict) or not isinstance(state.get('Running'), bool) or state.get('Status') not in {'created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead'}:
            raise client.ContainerClientError('Worker inventory state is incomplete')
        active = state.get('Running') is True or state.get('Paused') is True or state.get('Restarting') is True or state.get('Status') in {'running', 'paused', 'restarting'}
        name = str(item.get('Name', '')).lower()
        labels = item.get('Config', {}).get('Labels') or {}
        fullmag = 'fullmag' in name or any(str(key).startswith('com.fullmag.') for key in labels)
        if active and fullmag and item.get('Id') != current['container_id'] and 'buildx_buildkit' not in name:
            raise client.ContainerClientError('An active Fullmag worker prevents profile transition')
    db_path = validate_path(storage / 'index' / 'runner-jobs.sqlite', storage)
    if db_path.is_symlink() or not db_path.is_file():
        raise client.ContainerClientError('Complete queue inventory is required')
    with closing(sqlite3.connect(db_path.as_uri() + '?mode=ro', uri=True, timeout=5)) as db:
        if db.execute('PRAGMA user_version').fetchone()[0] != 1:
            raise client.ContainerClientError('Queue schema is not supported')
        if db.execute("SELECT 1 FROM jobs WHERE state NOT IN ('queued','succeeded','failed','cancelled') OR (profile='boris-cpu-v1' AND state='queued') LIMIT 1").fetchone():
            raise client.ContainerClientError('Active leases or nonterminal BORIS jobs prevent profile transition')
    return current['container_id']


def _locks(layout):
    from contextlib import ExitStack
    from local_runner import container_client as client
    storage = client._storage_root(layout)
    _, _, container_lock = client._config_paths(layout)
    stack = ExitStack()
    try:
        stack.enter_context(file_lock(container_lock, 'offline BORIS profile', blocking=True))
        stack.enter_context(file_lock(storage / 'locks' / 'local-runner-coordinator.lock', 'offline BORIS catalogue', blocking=True))
        from local_runner.coordinator_replacement import assert_no_pending
        assert_no_pending(storage)
        return stack
    except BaseException:
        stack.close()
        raise


def _apply(storage, journal, direction):
    from local_runner.container_client import ContainerClientError
    paths = [validate_path(storage / 'index' / name, storage) for name in NAMES]
    # Validate every member before writing any member during recovery.
    for path, item in zip(paths, journal['files']):
        if _read_bytes(path).hex() not in (item['before'], item['after']):
            raise ContainerClientError('Foreign config changes prevent transaction recovery')
    for path, item in zip(paths, journal['files']):
        desired = bytes.fromhex(item[direction])
        current = _read_bytes(path)
        if current.hex() not in (item['before'], item['after']):
            raise ContainerClientError('Foreign config changes prevent transaction recovery')
        if current != desired:
            _write_bytes(path, desired, mode=path.stat().st_mode & 0o777)
        if _read_bytes(path) != desired:
            raise ContainerClientError('Transaction config readback differs')


def _finish(storage, journal, direction):
    path = _journal_path(storage)
    result = {'schema': journal['schema'], 'transaction_id': journal['transaction_id'], 'state': 'completed',
              'direction': direction, 'container_id': journal['container_id'],
              'public_sha256': _sha(_read_bytes(storage / 'index' / NAMES[1])),
              'catalog_sha256': _sha(_read_bytes(storage / 'index' / NAMES[2]))}
    _write_bytes(path.parent / (journal['transaction_id'] + '.receipt.json'), (json.dumps(result, indent=2) + '\n').encode())
    path.unlink()
    _sync_directory(path.parent)
    return result


def disable(layout, owner, expected_public_sha256, expected_catalog_sha256, expected_boris_sha256, *, docker_call=None):
    from local_runner import container_client as client
    owner = client._owner(owner)
    if any(not isinstance(value, str) or not re.fullmatch('[a-f0-9]{64}', value) for value in
           (expected_public_sha256, expected_catalog_sha256, expected_boris_sha256)):
        raise client.ContainerClientError('Three exact public compare-and-swap digests are required')
    docker_call = docker_call or client.coordinator.docker
    storage = client._storage_root(layout)
    with _locks(layout):
        assert_no_pending(storage)
        before = [_read_bytes(storage / 'index' / name) for name in NAMES]
        secret, public, catalog = _validate_pair(storage, owner, before)
        if _sha(before[1]) != expected_public_sha256 or _sha(before[2]) != expected_catalog_sha256:
            raise client.ContainerClientError('Public config compare-and-swap failed')
        profile = client.BORIS_CPU_PROFILE
        if profile not in public['allowed_profiles'] or profile not in catalog['profiles'] or entry_sha(catalog['profiles'][profile]) != expected_boris_sha256:
            raise client.ContainerClientError('Expected BORIS activation does not match')
        identifier = _offline_guard(layout, owner, public, docker_call)
        for value in (secret, public):
            value['allowed_profiles'] = [name for name in value['allowed_profiles'] if name != profile]
        del catalog['profiles'][profile]
        after = [(json.dumps(value, indent=2, ensure_ascii=False) + '\n').encode() for value in (secret, public, catalog)]
        if any(len(blob) > MAX_CONFIG_BYTES for blob in after):
            raise client.ContainerClientError('Transition output config exceeds the recovery bound')
        journal = {'schema': JOURNAL_SCHEMA, 'transaction_id': uuid.uuid4().hex, 'operator': owner,
                   'container_id': identifier, 'files': [{'name': name, 'before': old.hex(), 'after': new.hex()} for name, old, new in zip(NAMES, before, after)]}
        path = _journal_path(storage)
        _private_directory(path.parent)
        if any(_read_bytes(storage / 'index' / name) != blob for name, blob in zip(NAMES, before)):
            raise client.ContainerClientError('Config changed before transition journal commit')
        _write_bytes(path, (json.dumps(journal, indent=2) + '\n').encode())
        try:
            _apply(storage, journal, 'after')
        except Exception:
            # A failed rollback retains pending and refuses later starts.
            _apply(storage, journal, 'before')
            _finish(storage, journal, 'before')
            raise
        return _finish(storage, journal, 'after')


def reconcile_desired(layout, owner, *, expected_container_id, expected_image_id,
                      expected_public_sha256, expected_catalog_sha256,
                      expected_observed_sha256, expected_instance_id,
                      docker_call=None, health_call=None):
    """Copy only the exact attested, paused runtime allow-list to desired state."""
    from local_runner import container_client as client, coordinator_lifecycle as lifecycle
    owner = client._owner(owner)
    client._image_id(expected_image_id)
    if (not client._CONTAINER_ID_RE.fullmatch(expected_container_id or '')
            or not re.fullmatch('[a-f0-9]{32}', expected_instance_id or '')
            or any(not re.fullmatch('[a-f0-9]{64}', value or '') for value in
                   (expected_public_sha256, expected_catalog_sha256, expected_observed_sha256))):
        raise client.ContainerClientError('Exact reconciliation identity and public digests required')
    docker_call = docker_call or client.coordinator.docker
    health_call = health_call or client.request
    storage = client._storage_root(layout)
    with _locks(layout):
        assert_no_pending(storage)
        paths = [validate_path(storage / 'index' / name, storage) for name in NAMES]
        before = [_read_bytes(path) for path in paths]
        secret, public, catalog = _validate_pair(storage, owner, before)
        if (_sha(before[1]) != expected_public_sha256 or _sha(before[2]) != expected_catalog_sha256
                or public['image_id'] != expected_image_id):
            raise client.ContainerClientError('Reconciliation public configuration compare-and-swap failed')

        def guard():
            observed_health = []
            def observe(*args):
                health = health_call(*args)
                observed_health.append(health)
                return health
            state = lifecycle._guard(layout, owner, public, expected_container_id, docker_call, observe)
            health = observed_health[0]
            profiles = client._observed_profile_list(health.get('allowed_profiles'))
            if (profiles is None or health['coordinator'].get('instance_id') != expected_instance_id
                    or _sha(json.dumps(profiles, separators=(',', ':')).encode()) != expected_observed_sha256
                    or not set(public['allowed_profiles']).issubset(profiles)):
                raise client.ContainerClientError('Attested observed profile identity differs from reviewed reconciliation')
            # _observed_profile_list checks every name against the source-owned CATALOG_PROFILES.
            ordered = list(client.ALLOWED_PROFILES) + [name for name in profiles if name not in client.ALLOWED_PROFILES]
            return state, ordered

        initial, profiles = guard()
        for value in (secret, public):
            value['allowed_profiles'] = profiles
        # Preserve the catalogue byte-for-byte, not a reserialized equivalent.
        after = [(json.dumps(value, indent=2, ensure_ascii=False) + '\n').encode() for value in (secret, public)] + [before[2]]
        if any(len(blob) > MAX_CONFIG_BYTES for blob in after):
            raise client.ContainerClientError('Reconciliation output exceeds bound')
        # Recheck the baseline using its original public contract before journalling.
        public = json.loads(before[1])
        final, repeated = guard()
        if final != initial or repeated != profiles or any(_read_bytes(path) != blob for path, blob in zip(paths, before)):
            raise client.ContainerClientError('Reconciliation baseline changed')
        journal = {'schema': RECONCILE_SCHEMA, 'transaction_id': uuid.uuid4().hex, 'operator': owner,
                   'container_id': expected_container_id,
                   'files': [{'name': name, 'before': old.hex(), 'after': new.hex()} for name, old, new in zip(NAMES, before, after)]}
        path = _journal_path(storage)
        _private_directory(path.parent)
        _write_bytes(path, (json.dumps(journal, indent=2) + '\n').encode())
        try:
            _apply(storage, journal, 'after')
        except Exception:
            _apply(storage, journal, 'before')
            _finish(storage, journal, 'before')
            raise
        return _finish(storage, journal, 'after')


def recover(layout, owner, transaction_id, direction, *, docker_call=None):
    from local_runner import container_client as client
    owner = client._owner(owner)
    if not re.fullmatch('[a-f0-9]{32}', transaction_id or '') or direction not in {'before', 'after'}:
        raise client.ContainerClientError('Exact transaction ID and recovery direction are required')
    storage = client._storage_root(layout)
    docker_call = docker_call or client.coordinator.docker
    with _locks(layout):
        path = _journal_path(storage)
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 1024 * 1024:
            raise client.ContainerClientError('A bounded pending transaction is required')
        journal = json.loads(path.read_bytes())
        if (set(journal) != {'schema', 'transaction_id', 'operator', 'container_id', 'files'}
                or journal['schema'] not in (JOURNAL_SCHEMA, RECONCILE_SCHEMA) or journal['transaction_id'] != transaction_id
                or journal['operator'] != owner or not isinstance(journal['files'], list)
                or len(journal['files']) != len(NAMES)):
            raise client.ContainerClientError('Pending transaction identity mismatch')
        for item, name in zip(journal['files'], NAMES):
            if set(item) != {'name', 'before', 'after'} or item['name'] != name:
                raise client.ContainerClientError('Pending transaction file set mismatch')
            for key in ('before', 'after'):
                if not isinstance(item[key], str) or len(item[key]) > 2 * MAX_CONFIG_BYTES or not re.fullmatch('[a-f0-9]+', item[key]) or len(item[key]) % 2:
                    raise client.ContainerClientError('Pending transaction config bytes are invalid')
        if journal['schema'] == RECONCILE_SCHEMA:
            if direction != 'before':
                raise client.ContainerClientError('Desired-profile reconciliation recovery permits rollback only')
            old = _validate_pair(storage, owner, [bytes.fromhex(item['before']) for item in journal['files']])
            new = _validate_pair(storage, owner, [bytes.fromhex(item['after']) for item in journal['files']])
            profiles = new[1]['allowed_profiles']
            expected = [dict(value) for value in old]
            for value in expected[:2]:
                value['allowed_profiles'] = profiles
            if (list(new) != expected or journal['files'][2]['before'] != journal['files'][2]['after']
                    or not set(old[1]['allowed_profiles']).issubset(profiles)):
                raise client.ContainerClientError('Reconciliation journal changes protected fields')
            from local_runner import coordinator_lifecycle as lifecycle
            current = lifecycle._attested(layout, owner, old[1], journal['container_id'], docker_call)
            if current['state'] not in ('running', 'exited'):
                raise client.ContainerClientError('Reconciliation rollback coordinator state is uncertain')
            lifecycle._inventory(docker_call, journal['container_id'])
            lifecycle._queue_guard(storage)
            from local_runner.service import ServicePaths, read_stop_request
            if read_stop_request(ServicePaths.from_storage(storage)) is None:
                raise client.ContainerClientError('Reconciliation rollback requires durable pause')
            _apply(storage, journal, 'before')
            return _finish(storage, journal, 'before')
        _, original_public, _ = _validate_pair(storage, owner, [bytes.fromhex(item['before']) for item in journal['files']])
        old_secret, old_public, old_catalog = _validate_pair(storage, owner, [bytes.fromhex(item['before']) for item in journal['files']])
        expected = [old_secret, old_public, old_catalog]
        for config in expected[:2]:
            if client.BORIS_CPU_PROFILE not in config['allowed_profiles']:
                raise client.ContainerClientError('Journal does not describe a BORIS removal')
            config['allowed_profiles'] = [value for value in config['allowed_profiles'] if value != client.BORIS_CPU_PROFILE]
        if client.BORIS_CPU_PROFILE not in old_catalog['profiles']:
            raise client.ContainerClientError('Journal does not describe a BORIS removal')
        del old_catalog['profiles'][client.BORIS_CPU_PROFILE]
        actual = [json.loads(bytes.fromhex(item['after'])) for item in journal['files']]
        if actual != expected:
            raise client.ContainerClientError('Journal changes fields outside BORIS activation')
        _validate_pair(storage, owner, [bytes.fromhex(item['after']) for item in journal['files']])
        if _offline_guard(layout, owner, original_public, docker_call) != journal['container_id']:
            raise client.ContainerClientError('Recovery coordinator incarnation differs')
        _apply(storage, journal, direction)
        return _finish(storage, journal, direction)