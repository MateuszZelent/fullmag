#!/usr/bin/env python3
"""Trusted image entrypoint; never execute a command supplied by source code.

The diagnostic receipt proves capsule bytes only, not Fullmag/FEM execution.
This file intentionally has no imports from the mounted source capsule.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import stat
import sys


SCHEMA = 'fullmag.source-capsule.v1'


def is_reparse(path):
    metadata = path.lstat()
    return stat.S_ISLNK(metadata.st_mode) or bool(getattr(metadata, 'st_file_attributes', 0) & 0x400)


def canonical(value):
    return (json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True) + '\n').encode('utf-8')


def relative_parts(relative):
    if not isinstance(relative, str) or not relative or '\\' in relative or '\x00' in relative:
        raise ValueError('Unsafe capsule path')
    parts = PurePosixPath(relative)
    if parts.is_absolute() or PureWindowsPath(relative).anchor or any(p in ('..', '.') for p in relative.split('/')):
        raise ValueError('Unsafe capsule path')
    if parts.as_posix() != relative:
        raise ValueError('Noncanonical capsule path')
    return parts


def safe_path(root, relative):
    path = root.joinpath(*relative_parts(relative).parts)
    if any(is_reparse(parent) for parent in (path, *path.parents) if parent != root.parent):
        raise ValueError('Capsule symlinks are unsupported')
    return path


def verify_source(source, expected_digest=None):
    source = Path(source)
    if is_reparse(source) or {path.name for path in source.iterdir()} != {'manifest.json', 'tree'}:
        raise ValueError('Unexpected capsule root membership')
    manifest_path = source / 'manifest.json'
    if is_reparse(manifest_path) or manifest_path.stat().st_size > 32 * 1024 * 1024:
        raise ValueError('Invalid capsule manifest')
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    if not isinstance(manifest, dict) or manifest.get('schema_version') != SCHEMA:
        raise ValueError('Unsupported capsule schema')
    if not isinstance(manifest.get('files'), list) or any(not isinstance(entry, dict) for entry in manifest['files']):
        raise ValueError('Invalid capsule files')
    if manifest.get('source_mode') not in ('commit', 'snapshot') or not re.fullmatch('[a-f0-9]{40}(?:[a-f0-9]{24})?', str(manifest.get('resolved_commit', ''))):
        raise ValueError('Invalid source provenance')
    for key in ('deleted', 'included_untracked', 'excluded'):
        if not isinstance(manifest.get(key), list):
            raise ValueError('Invalid source manifest list')
    core_keys = ('schema_version', 'source_mode', 'resolved_commit', 'files', 'deleted', 'included_untracked', 'excluded')
    digest = hashlib.sha256(canonical({key: manifest[key] for key in core_keys})).hexdigest()
    if manifest.get('source_digest') != digest or (expected_digest is not None and expected_digest != digest):
        raise ValueError('Capsule identity mismatch')
    tree = source / 'tree'
    if is_reparse(tree) or not tree.is_dir():
        raise ValueError('Missing capsule tree')
    expected = set()
    expected_directories = set()
    for entry in manifest['files']:
        relative = entry['path']
        path = safe_path(tree, relative)
        if relative in expected or entry.get('type') != 'file' or entry.get('mode') not in ('100644', '100755'):
            raise ValueError('Unsupported or duplicate capsule entry')
        expected.add(relative)
        expected_directories.update(str(parent) for parent in PurePosixPath(relative).parents if str(parent) != '.')
        if not stat.S_ISREG(path.stat(follow_symlinks=False).st_mode):
            raise ValueError('Capsule entry is not a regular file')
        checksum = hashlib.sha256()
        size = 0
        with path.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                checksum.update(chunk)
                size += len(chunk)
        if size != entry['size'] or checksum.hexdigest() != entry['sha256']:
            raise ValueError(f'Capsule bytes changed: {relative}')
    actual = set()
    actual_directories = set()
    for current, directories, files in os.walk(tree, followlinks=False):
        for name in (*directories, *files):
            path = Path(current) / name
            if is_reparse(path):
                raise ValueError('Unexpected capsule symlink')
        actual.update((Path(current) / name).relative_to(tree).as_posix() for name in files)
        actual_directories.update((Path(current) / name).relative_to(tree).as_posix() for name in directories)
    if actual != expected or actual_directories != expected_directories:
        raise ValueError('Capsule tree membership mismatch')
    for key in ('deleted', 'included_untracked'):
        if any(not isinstance(relative, str) for relative in manifest[key]):
            raise ValueError('Invalid capsule metadata path')
        if len(set(manifest[key])) != len(manifest[key]):
            raise ValueError('Duplicate capsule metadata path')
        for relative in manifest[key]:
            relative_parts(relative)
    if expected.intersection(manifest['deleted']) or not set(manifest['included_untracked']).issubset(expected):
        raise ValueError('Inconsistent source membership metadata')
    external = {'external_solvers/' + name for name in ('3', 'amumax', 'neuralmag', 'oommf', 'plus', 'tetmag')}
    for excluded in manifest['excluded']:
        if isinstance(excluded, dict):
            relative = excluded.get('path')
            if (excluded.get('type') != 'gitlink' or relative not in external
                    or not re.fullmatch('[a-f0-9]{40}(?:[a-f0-9]{24})?', str(excluded.get('pinned_commit', '')))):
                raise ValueError('Unsupported external solver disclosure')
        else:
            relative = excluded
        relative_parts(relative)
        if any(path == relative or path.startswith(relative + '/') for path in expected):
            raise ValueError('An excluded path is present in source')
    for key, value in (('schema', SCHEMA), ('manifest_filename', 'manifest.json'), ('source_digest_sha256', digest)):
        if key in manifest and manifest[key] != value:
            raise ValueError('Inconsistent manifest alias')
    return manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=('verify-source',))
    parser.add_argument('--job-id', required=True)
    parser.add_argument('--source-digest', required=True)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--build', type=Path, required=True)
    parser.add_argument('--artifacts', type=Path, required=True)
    args = parser.parse_args(argv)
    if not re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}', args.job_id):
        parser.error('Invalid job ID')
    try:
        manifest = verify_source(args.source, args.source_digest)
        receipt = {'schema': 'fullmag.local-runner.source-check.v1', 'job_id': args.job_id,
                   'operation': args.operation, 'source_digest': manifest['source_digest'],
                   'resolved_commit': manifest['resolved_commit'], 'file_count': len(manifest['files']),
                   'state': 'succeeded', 'qualification': 'not_assessed'}
        # Exclusive creation: never overwrite artifacts from an earlier worker.
        with (args.artifacts / 'source-verification.json').open('x', encoding='utf-8') as stream:
            json.dump(receipt, stream, sort_keys=True)
        print(json.dumps(receipt, sort_keys=True))
        return 0
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f'worker: {error}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
