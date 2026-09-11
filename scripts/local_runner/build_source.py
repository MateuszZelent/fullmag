"""Bind the existing native v2 identity to the runner's exact-byte capsule."""
import hashlib
import subprocess

from capture_source_snapshot_identity import capture, _canonical_bytes


def native_identity(repo, mode, commit=None):
    if mode == 'snapshot':
        return capture(repo, ignore_non_runtime_dirty=True)
    tree = subprocess.check_output(['git', 'ls-tree', '-r', '--full-tree', commit], cwd=repo)
    payload = {'schema': 'fullmag.source-snapshot.v2', 'head_commit_full': commit,
               'head_tree_sha256': hashlib.sha256(tree).hexdigest(),
               'git_status_porcelain_v1': [], 'dirty_path_content': [], 'ignored_non_runtime_dirty': True}
    return {**payload, 'source_snapshot_dirty': False,
            'dirty_content_sha256': hashlib.sha256(_canonical_bytes([])).hexdigest(),
            'source_snapshot_sha256': hashlib.sha256(_canonical_bytes(payload)).hexdigest()}


def bind_identity(identity, manifest):
    if identity['head_commit_full'] != manifest['resolved_commit']:
        raise ValueError('Source HEAD changed during capture')
    entries = {entry['path']: entry for entry in manifest['files']}
    for dirty in identity['dirty_path_content']:
        path = dirty['path']
        if dirty['kind'] == 'missing':
            if path in entries:
                raise ValueError('Deleted native input present in capsule')
        elif dirty['kind'] != 'regular_file' or path not in entries or entries[path]['sha256'] != dirty['sha256']:
            raise ValueError('Native input absent/changed in capsule; explicitly include untracked input: ' + path)
    return identity
