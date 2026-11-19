"""Retire exact inactive worktree package namespaces under a host-held group lease."""
import json
import os
from pathlib import Path
import uuid

from backend_shared_store import StoreError, HEX, canonical, fsync_dir, locked, safe_path

SCHEMA = 'fullmag.shared-group-retirement.v1'
MARKER = Path('.development/cache-maintenance/.fullmag-backend-cache-owner.json')


def _inventory(root):
    expected = safe_path(root, directory=True)
    files, directories = [], []
    for base, names, leaves in os.walk(root, followlinks=False):
        for name, directory in [(n, True) for n in names] + [(n, False) for n in leaves]:
            path = Path(base) / name
            info = safe_path(path, directory=directory)
            if info.st_dev != expected.st_dev or info.st_uid != expected.st_uid:
                raise StoreError('group retirement found foreign ownership or a nested mount')
            (directories if directory else files).append(path)
    return expected, files, directories


def retire(root, unit_keys, volume_name, archive):
    root, archive = Path(root), Path(archive)
    if (unit_keys != sorted(set(unit_keys)) or any(not isinstance(k, str) or HEX.fullmatch(k) is None for k in unit_keys)):
        raise StoreError('retirement unit keys are invalid')
    safe_path(root, directory=True)
    safe_path(archive, directory=True)
    fsync_dir(archive.parent)  # Persist a newly-created intent directory before unlinking payload.
    records = []
    # Other groups may keep their own claims: removing this group's hardlinks
    # does not mutate shared payload. The host proves this group has no users.
    with locked(root / '.gc.lock', exclusive=False, timeout=0):
        for key in unit_keys:
            group = root / 'groups' / key
            intent_path = archive / (key + '.json')
            if not group.exists() and not group.is_symlink():
                records.append({'unit_key': key, 'state': 'absent'})
                continue
            metadata, files, directories = _inventory(group)
            intent = None
            if intent_path.exists() or intent_path.is_symlink():
                info = safe_path(intent_path)
                if info.st_nlink != 1 or info.st_size > 128 * 1024:
                    raise StoreError('group retirement intent is unsafe')
                intent = json.loads(intent_path.read_bytes())
                if (intent.get('schema') != SCHEMA or intent.get('unit_key') != key
                        or intent.get('volume_name') != volume_name
                        or intent.get('directory_identity') != [metadata.st_dev, metadata.st_ino]):
                    raise StoreError('group retirement intent differs')
            if intent is None:
                marker_path = group / MARKER
                if files or directories:
                    marker_info = safe_path(marker_path)
                    if marker_info.st_nlink != 1 or marker_info.st_size > 16384:
                        raise StoreError('group owner marker is unsafe')
                    marker = json.loads(marker_path.read_bytes())
                    expected = dict(schema='fullmag.backend-build-cache-owner.v2', state='owned',
                        unit_key=key, owner_id=key, role='package', volume_name=volume_name, uid=65532, gid=65532)
                    if marker != expected:
                        raise StoreError('group owner marker differs')
                    development = group / '.development'
                    for entry in development.iterdir():
                        if entry.name == 'rotation.pending.json':
                            raise StoreError('group has pending package rotation; retirement refused')
                    candidates = development / 'candidates'
                    if candidates.exists() and any(candidates.iterdir()):
                        raise StoreError('group has pending candidates; retirement refused')
                else:
                    marker = None
                intent = dict(schema=SCHEMA, unit_key=key, volume_name=volume_name,
                    directory_identity=[metadata.st_dev, metadata.st_ino], marker=marker,
                    file_count=len(files), logical_bytes=sum(p.stat().st_size for p in files))
                temporary = intent_path.with_name(key + '.' + uuid.uuid4().hex + '.tmp')
                with temporary.open('xb') as stream:
                    stream.write(canonical(intent))
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, intent_path)
                fsync_dir(archive)
            # Keep the ownership marker until every other regular file is gone.
            marker_path = group / MARKER
            for path in files:
                if path != marker_path:
                    path.unlink()
            for path in sorted(directories, key=lambda p: len(p.parts), reverse=True):
                if path not in marker_path.parents:
                    fsync_dir(path)
                    path.rmdir()
            for parent in (marker_path.parent, marker_path.parent.parent, group):
                if parent.exists():
                    fsync_dir(parent)
            if marker_path.exists():
                marker_path.unlink()
            for path in sorted(directories, key=lambda p: len(p.parts), reverse=True):
                if path.exists():
                    path.rmdir()
            group.rmdir()
            fsync_dir(group.parent)
            records.append({'unit_key': key, 'state': 'removed', 'file_count': intent['file_count']})
    return {'schema': SCHEMA, 'state': 'succeeded', 'unit_keys': unit_keys, 'groups': records}
