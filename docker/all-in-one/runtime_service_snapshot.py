"""One-time native admission of a verified isolated retained-session copy."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat

META_ENV = 'FULLMAG_ISOLATED_SNAPSHOT_START'
SHA_ENV = 'FULLMAG_ISOLATED_SNAPSHOT_START_SHA256'
MAX_DOCUMENT = 8 * 1024 * 1024
START_META_FIELDS = frozenset({
    'schema', 'allow_script_replay', 'request_sha256', 'config_sha256',
    'source_manifest_sha256', 'copied_content_sha256', 'restore_run_id',
})


def _strict_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('Snapshot JSON contains a duplicate key')
        value[key] = item
    return value


def _reject_json_constant(value):
    raise ValueError('Snapshot JSON contains a non-standard number: ' + value)


def _json_document(raw, name):
    try:
        return json.loads(raw.decode('utf-8', 'strict'),
                          object_pairs_hook=_strict_object,
                          parse_constant=_reject_json_constant)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise ValueError(name + ' is not unambiguous UTF-8 JSON') from error


def _exact_json_equal(actual, expected):
    """Compare JSON values without Python's bool/int equality shortcut."""
    if type(actual) is not type(expected):
        return False
    if isinstance(expected, dict):
        return (actual.keys() == expected.keys()
                and all(_exact_json_equal(actual[key], value)
                        for key, value in expected.items()))
    if isinstance(expected, list):
        return (len(actual) == len(expected)
                and all(_exact_json_equal(left, right)
                        for left, right in zip(actual, expected)))
    return actual == expected


def _entry_exists(path):
    try:
        path.lstat()
    except FileNotFoundError:
        return False
    return True


def _read(path, expected=None):
    path = Path(path)
    if not path.is_absolute() or path.resolve() != path:
        raise ValueError('Snapshot control path is not canonical')
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > MAX_DOCUMENT:
        raise ValueError('Snapshot control document is unsafe')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        raw = bytearray()
        while len(raw) <= MAX_DOCUMENT:
            chunk = os.read(fd, min(1024 * 1024, MAX_DOCUMENT + 1 - len(raw)))
            if not chunk: break
            raw.extend(chunk)
        after = os.fstat(fd)
    finally:
        os.close(fd)
    identity = lambda s: (s.st_dev,s.st_ino,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
    if len(raw) > MAX_DOCUMENT or identity(before) != identity(info) or identity(info) != identity(after) or identity(after) != identity(path.lstat()):
        raise ValueError('Snapshot control document changed')
    raw = bytes(raw)
    if expected is not None and hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError('Snapshot control document digest differs')
    return raw


def _content(root, tree):
    """Compare actual copied payload, not merely the digest of its request."""
    root = Path(root)
    if root.resolve() != root or not root.is_dir():
        raise ValueError('Snapshot payload root is not canonical')
    if not isinstance(tree, dict) or not isinstance(tree.get('files'), list):
        raise ValueError('Snapshot payload tree has an invalid file list')
    directories = tree.get('directories')
    if not isinstance(directories, list) or len(directories) > 20000:
        raise ValueError('Snapshot payload tree has an invalid directory list')
    normalized_directories = []
    for relative in directories:
        parsed = PurePosixPath(relative) if isinstance(relative, str) else None
        if (parsed is None or not relative or parsed.is_absolute()
                or '..' in parsed.parts or str(parsed) != relative):
            raise ValueError('Snapshot payload directory path is unsafe')
        normalized_directories.append(relative)
    expected_directories = set(normalized_directories)
    if normalized_directories != sorted(expected_directories):
        raise ValueError('Snapshot payload directory list is duplicated or unsorted')
    expected = {}
    for row in tree['files']:
        if not isinstance(row, dict):
            raise ValueError('Snapshot payload file record is invalid')
        relative = row['path']; parsed = PurePosixPath(relative)
        if (not relative or parsed.is_absolute() or '..' in parsed.parts
                or str(parsed) != relative or relative in expected):
            raise ValueError('Snapshot payload entry is unsafe or duplicated')
        if type(row['size']) is not int or row['size'] < 0:
            raise ValueError('Snapshot payload file size is invalid')
        if (not isinstance(row['sha256'], str) or len(row['sha256']) != 64
                or any(character not in '0123456789abcdef' for character in row['sha256'])):
            raise ValueError('Snapshot payload file digest is invalid')
        expected[relative] = row
    if len(expected) > 20000:
        raise ValueError('Snapshot payload exceeds file count limit')
    if expected_directories & set(expected):
        raise ValueError('Snapshot payload path is both a directory and a file')
    for relative in expected_directories | set(expected):
        parent_path = PurePosixPath(relative).parent
        while str(parent_path) not in {'', '.'}:
            if str(parent_path) not in expected_directories:
                raise ValueError('Snapshot payload tree omits a parent directory')
            parent_path = parent_path.parent
    seen = set()
    seen_directories = set()
    total = 0
    for directory, dirs, files in os.walk(root, followlinks=False):
        parent = Path(directory)
        for name in dirs:
            directory_path = parent / name
            if directory_path.is_symlink():
                raise ValueError('Snapshot payload contains a linked directory')
            relative_directory = directory_path.relative_to(root).as_posix()
            if relative_directory not in expected_directories:
                raise ValueError('Snapshot payload has an unexpected directory: ' + relative_directory)
            seen_directories.add(relative_directory)
        for name in files:
            path = parent / name
            relative = path.relative_to(root).as_posix()
            row = expected.get(relative)
            if row is None:
                raise ValueError('Snapshot payload has an unexpected file: ' + relative)
            before = path.lstat()
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size != row['size']:
                raise ValueError('Snapshot payload file identity differs')
            digest = hashlib.sha256(); count = 0
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                opened = os.fstat(fd)
                while True:
                    chunk = os.read(fd, 1024 * 1024)
                    if not chunk: break
                    count += len(chunk); total += len(chunk)
                    if count > row['size'] or total > 32 * 1024**3:
                        raise ValueError('Snapshot payload exceeded byte limits')
                    digest.update(chunk)
                after = os.fstat(fd)
            finally:
                os.close(fd)
            identity = lambda s: (s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns,s.st_nlink)
            if (identity(before) != identity(opened) or identity(opened) != identity(after)
                    or identity(after) != identity(path.lstat()) or count != row['size']
                    or digest.hexdigest() != row['sha256']):
                raise ValueError('Snapshot payload bytes changed or differ: ' + relative)
            seen.add(relative)
    if seen != set(expected):
        raise ValueError('Snapshot payload is incomplete')
    if seen_directories != expected_directories:
        raise ValueError('Snapshot payload directory tree is incomplete')


def admit(paths, service):
    configured = os.environ.get(META_ENV); expected = os.environ.get(SHA_ENV)
    if configured is None and expected is None:
        return None
    if (not configured or not expected or len(expected) != 64
            or any(c not in '0123456789abcdef' for c in expected)):
        raise ValueError('Isolated snapshot startup pins are incomplete')
    path = Path(configured)
    if path != Path('/opt/fullmag/control/isolated-snapshot/start.json'):
        raise ValueError('Isolated snapshot startup path is not fixed')
    meta = _json_document(_read(path, expected), 'Snapshot start document')
    if not isinstance(meta, dict) or set(meta) != START_META_FIELDS:
        raise ValueError('Isolated snapshot start document has an unexpected field set')
    if meta.get('schema') != 'fullmag.isolated-snapshot-start.v1' or meta.get('allow_script_replay') is not False:
        raise ValueError('Invalid isolated snapshot startup contract')
    root = path.parent
    request_path = root / 'request.json'; config_path = root / 'original-config.json'
    request = _json_document(_read(request_path, meta['request_sha256']), 'Snapshot request')
    if (not isinstance(request, dict)
            or request.get('schema_version') != 'runtime_service_retained_snapshot_validation_request.v1'):
        raise ValueError('Isolated snapshot request schema differs')
    _read(config_path, meta['config_sha256'])
    source = _read(root / 'source-manifest.json', meta['source_manifest_sha256'])
    if request['source_manifest_sha256'] != hashlib.sha256(source).hexdigest():
        raise ValueError('Native request does not bind the source snapshot')
    source_document = _json_document(source, 'Snapshot source manifest')
    if (not isinstance(source_document, dict)
            or source_document.get('schema') != 'fullmag.isolated-session-snapshot-manifest.v1'):
        raise ValueError('Isolated snapshot source manifest schema differs')
    if meta.get('restore_run_id') not in {pin['run_id'] for pin in request['retained_held_manual_runs']}:
        raise ValueError('Isolated snapshot restored model is not explicitly held')
    if source_document.get('restore_run_id') != meta['restore_run_id']:
        raise ValueError('Isolated snapshot selected model differs from its source manifest')
    receipt_path = root / 'native-validation.json'
    expected_receipt = {
        'schema_version': 'runtime_service_retained_snapshot_validation.v1',
        'state': 'validated-read-only', 'request_sha256': meta['request_sha256'],
        'config_sha256': meta['config_sha256'],
        'source_manifest_sha256': meta['source_manifest_sha256'],
        'run_ids': sorted([p['run_id'] for p in request['retained_terminal_runs']] +
                          [p['run_id'] for p in request['retained_held_manual_runs']]),
        'terminal_count': len(request['retained_terminal_runs']),
        'held_count': len(request['retained_held_manual_runs']),
        'owner_changed': False, 'compute_started': False,
    }
    if _entry_exists(receipt_path):
        existing_receipt = _json_document(_read(receipt_path), 'Native admission receipt')
        if not _exact_json_equal(existing_receipt, expected_receipt):
            raise ValueError('Existing isolated snapshot native admission differs')
        return expected_receipt
    # This first admission must precede bootstrap, owner initialization and API.
    if _entry_exists(paths.store / 'runtime-services' / 'OWNER.json'):
        raise ValueError('Isolated snapshot already contains a native owner before admission')
    content = _json_document(_read(root / 'copied-content.json', meta['copied_content_sha256']),
                             'Copied snapshot content manifest')
    if not isinstance(content, dict):
        raise ValueError('Copied snapshot content manifest must be an object')
    if not _exact_json_equal(content.get('live_workspace'), source_document.get('live_workspace')):
        raise ValueError('Copied control workspace descriptor differs from the source manifest')
    _content(Path('/state/runs'), content['state'])
    _content(Path('/user-data'), content['user_data'])
    workspace=content.get('live_workspace')
    if workspace is None:
        raise ValueError('Copied control workspace is missing from admission')
    if (not isinstance(workspace, dict)
            or workspace.get('schema') != 'fullmag.isolated-control-workspace.v1'):
        raise ValueError('Copied control workspace schema differs')
    if workspace.get('present') is True and set(workspace) == {'schema', 'present', 'tree'}:
        _content(Path('/opt/fullmag/control/runtime-control/local-live'), workspace['tree'])
    elif workspace.get('present') is False and set(workspace) == {'schema', 'present'}:
        pass
    else:
        raise ValueError('Copied control workspace presence is malformed')
    result = service._run_cli(paths, (
        'runtime', 'validate-retained-snapshot', '--store', str(paths.store),
        '--config', str(config_path), '--config-sha256', meta['config_sha256'],
        '--request', str(request_path), '--request-sha256', meta['request_sha256'],
    ), timeout=300)
    if not _exact_json_equal(result, expected_receipt):
        raise ValueError('Native isolated snapshot validation returned different evidence')
    # Publish only the verified read-only native outcome. Later ordinary starts
    # retain this receipt; legitimate subsequent session edits are not replayed.
    service._atomic_json(receipt_path, result, 'isolated snapshot native validation')
    return result
