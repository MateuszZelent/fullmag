"""Select an immutable, terminal managed FEM CPU package for runtime checks."""
import json
from pathlib import Path
import re

import fullmag_storage as storage
from local_runner.build_executor import artifact_sha256, validate_build_receipt


def read_record(path, root):
    path = storage.validate_path(path, root, 'managed package record')
    if not path.is_file() or path.stat().st_size > 64 * 1024:
        raise ValueError('Managed package record missing or oversized')
    value = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(value, dict):
        raise ValueError('Managed package record must be an object')
    return value


def runtime_runs_root(repo_root, storage_root, worktree_id):
    """Match the production Submit adapter's canonical managed layout."""
    root = storage.absolute(storage_root, 'runtime project storage')
    repo = storage.absolute(repo_root, 'runtime source checkout')
    marker = read_record(root / '.fullmag-storage.json', root)
    project = storage.absolute(marker.get('project_root', ''), 'declared storage project')
    if (marker.get('schema') != 'fullmag_storage_v1' or not project.is_dir() or not repo.is_dir() or
            repo == project or project not in repo.parents or
            root == repo or root in repo.parents or repo in root.parents):
        raise ValueError('Runtime storage marker and source checkout are incompatible')
    if not re.fullmatch('[a-zA-Z0-9_-]+', worktree_id):
        raise ValueError('Invalid managed runtime worktree identity')
    return storage.validate_path(root / 'runs' / worktree_id, root, 'runtime runs root')


def load_package(run_root, storage_root, expected_commit, expected_snapshot, binary_names):
    if not re.fullmatch('[a-f0-9]{40}', expected_commit) or not re.fullmatch('[a-f0-9]{64}', expected_snapshot):
        raise ValueError('Full canonical managed source identities required')
    run_root = storage.validate_path(Path(run_root), Path(storage_root), 'managed build run')
    frozen_documents = {}
    for relative in ['receipt.json', 'trusted/context.json', 'trusted/build_entrypoint.py',
                     'trusted/worker_entrypoint.py', 'artifacts/build-receipt.json']:
        path = storage.validate_path(run_root / relative, run_root)
        if not path.is_file() or path.stat().st_size > 4 * 1024 * 1024:
            raise ValueError('Managed package document missing or oversized')
        frozen_documents[path] = artifact_sha256(path)
    journal = read_record(run_root / 'receipt.json', run_root)
    context = read_record(run_root / 'trusted/context.json', run_root / 'trusted')
    if (not re.fullmatch('[a-f0-9]{64}', str(context.get('source_digest', ''))) or
            not re.fullmatch('sha256:[a-f0-9]{64}', str(context.get('image_digest', '')))):
        raise ValueError('Canonical managed source and image digests required')
    if (run_root.name != context.get('job_id') or
            any(journal.get(key) != context.get(key)
                for key in ('job_id', 'profile', 'source_digest', 'image_digest'))):
        raise ValueError('Managed coordinator/context identity mismatch')
    if (journal.get('phase') != 'terminal' or journal.get('state') != 'succeeded' or
            type(journal.get('exit_code')) is not int or journal['exit_code'] != 0 or
            journal.get('profile') != 'fem-cpu-release'):
        raise ValueError('Managed FEM CPU package is not terminal and successful')
    hashes = journal.get('trusted_hashes', {})
    if set(hashes) != {'context.json', 'build_entrypoint.py', 'worker_entrypoint.py'}:
        raise ValueError('Incomplete managed trusted documents')
    for name, expected in hashes.items():
        path = storage.validate_path(run_root / 'trusted' / name, run_root / 'trusted')
        if artifact_sha256(path) != expected:
            raise ValueError('Managed trusted document hash mismatch')
    native = context.get('native_source_identity', {})
    if (native.get('head_commit_full') != expected_commit or
            native.get('source_snapshot_sha256') != expected_snapshot or
            native.get('source_snapshot_dirty') is not False):
        raise ValueError('Managed package source identity mismatch')
    job = {'job_id': context['job_id'], 'source_digest': context['source_digest'],
           'profile': context['profile'], 'payload': {'native_source_identity': native}}
    artifacts = run_root / 'artifacts'
    built = validate_build_receipt(artifacts, job, journal)
    entries = {entry['path']: entry for entry in built['artifacts']}
    prefix = 'outputs/.fullmag/local/'
    binaries = {}
    evidence = {}
    for name in binary_names:
        if not re.fullmatch('fullmag(?:-[a-z0-9-]+)?', name):
            raise ValueError('Invalid managed binary name')
        relative = prefix + 'bin/' + ('fullmag-bin' if name == 'fullmag' else name)
        entry = entries.get(relative)
        if not entry or entry['size'] <= 0:
            raise ValueError('Missing managed runtime binary: ' + name)
        path = storage.validate_path(artifacts / relative, artifacts)
        binaries[name] = path
        evidence[name] = {'path': str(path), 'size_bytes': entry['size'], 'sha256': entry['sha256']}
    library_names = ['libfullmag_fem.so', 'libfullmag_fem.so.0', 'libfullmag_fem.so.0.1.0']
    libraries = [entries.get(prefix + 'lib/' + name) for name in library_names]
    if any(not entry or entry['size'] <= 0 for entry in libraries):
        raise ValueError('Missing canonical managed native FEM shared library group')
    if len({entry['sha256'] for entry in libraries}) != 1:
        raise ValueError('Managed native FEM shared library aliases differ')
    for path, digest in frozen_documents.items():
        if artifact_sha256(path) != digest:
            raise ValueError('Managed package document changed during validation')
    evidence['native_fem'] = libraries
    evidence['managed_package'] = {
        'run_root': str(run_root), 'job_id': context['job_id'],
        'source_digest': context['source_digest'], 'image_digest': context['image_digest'],
        'coordinator_receipt_sha256': frozen_documents[run_root / 'receipt.json'],
        'build_receipt_sha256': frozen_documents[artifacts / 'build-receipt.json'],
    }
    return binaries, evidence, native, artifacts / prefix / 'lib'
