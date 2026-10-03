"""Inspect hash-bound raw FEM samples; never certify or resume a campaign."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat

SCHEMA = 'fullmag.single_k_checkpoint.internal.v1'
SHA256 = re.compile(r'[0-9a-f]{64}\Z')
RESERVED = {'con', 'prn', 'aux', 'nul', *(f'com{i}' for i in range(1, 10)), *(f'lpt{i}' for i in range(1, 10))}


def portable_parts(value: object) -> tuple[str, ...]:
    if not isinstance(value, str) or not value or '\\' in value or ':' in value:
        raise ValueError('nonportable checkpoint relative path')
    parts = value.split('/')
    for part in parts:
        if (not part or part in {'.', '..'} or part.endswith(('.', ' '))
                or any(ord(c) < 32 or c in '<>"|?*' for c in part)
                or part.split('.')[0].rstrip(' .').lower() in RESERVED):
            raise ValueError('unsafe checkpoint relative path')
    return tuple(parts)


def regular_file(root: Path, relative: object) -> Path:
    path = root
    for part in portable_parts(relative):
        path = path / part
        try:
            info = path.lstat()
        except OSError as error:
            raise ValueError('checkpoint file or parent is unavailable') from error
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError('checkpoint symlink/junction is forbidden')
    if not path.is_file() or not path.resolve().is_relative_to(root):
        raise ValueError('checkpoint file absent or outside namespace')
    return path


def identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def checked_read(root, relative, limit, *, retain=False):
    """Read one stable regular file; retained bytes are the ones hashed."""
    path = regular_file(root, relative)
    before = path.lstat()
    ancestors = (path.parent, *path.parent.parents)
    before_dirs = []
    for directory in ancestors:
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError('checkpoint directory is linked or not regular')
        before_dirs.append((info.st_dev, info.st_ino))
    if not stat.S_ISREG(before.st_mode) or before.st_size > limit:
        raise ValueError('checkpoint artifact exceeds size limit or is not regular')
    flags = os.O_RDONLY | getattr(os, 'O_BINARY', 0) | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0)
    state, count, chunks = hashlib.sha256(), 0, [] if retain else None
    with os.fdopen(os.open(path, flags), 'rb') as stream:
        opened = os.fstat(stream.fileno())
        if (not stat.S_ISREG(opened.st_mode) or getattr(opened, 'st_file_attributes', 0) & 0x400
                or identity(opened)[:4] != identity(before)[:4]):
            raise ValueError('checkpoint artifact changed while opening')
        current = path.lstat()
        if (not stat.S_ISREG(current.st_mode) or getattr(current, 'st_file_attributes', 0) & 0x400
                or identity(current)[:4] != identity(opened)[:4]):
            raise ValueError('checkpoint path changed before reading')
        for directory, expected in zip(ancestors, before_dirs):
            info = directory.lstat()
            if ((info.st_dev, info.st_ino) != expected or not stat.S_ISDIR(info.st_mode)
                    or getattr(info, 'st_file_attributes', 0) & 0x400):
                raise ValueError('checkpoint directory changed while opening')
        while chunk := stream.read(1024**2):
            count += len(chunk)
            if count > limit or count > before.st_size:
                raise ValueError('checkpoint artifact grew while reading')
            state.update(chunk)
            if chunks is not None:
                chunks.append(chunk)
        after = os.fstat(stream.fileno())
    regular_file(root, relative)
    if count != before.st_size or identity(after) != identity(opened) or identity(path.lstat()) != identity(before):
        raise ValueError('checkpoint artifact changed while reading')
    for directory, expected in zip(ancestors, before_dirs):
        info = directory.lstat()
        if ((info.st_dev, info.st_ino) != expected or not stat.S_ISDIR(info.st_mode)
                or getattr(info, 'st_file_attributes', 0) & 0x400):
            raise ValueError('checkpoint directory changed while reading')
    return count, state.hexdigest(), b''.join(chunks) if chunks is not None else None


def decode_json(data: bytes) -> dict:
    def bad_constant(value):
        raise ValueError(f'nonfinite JSON constant: {value}')
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f'duplicate JSON key: {key}')
            result[key] = value
        return result
    try:
        result = json.loads(data.decode('utf-8'), parse_constant=bad_constant,
                            object_pairs_hook=unique_object)
    except RecursionError as error:
        raise ValueError('checkpoint JSON exceeds parser nesting limit') from error
    if not isinstance(result, dict):
        raise ValueError('checkpoint JSON must be an object')
    return result


def finite_number(value: object) -> bool:
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def inspect_checkpoint(directory: Path, *, max_json_bytes: int = 64 * 1024**2,
                       max_artifact_bytes: int = 1024**3, max_total_bytes: int = 4 * 1024**3,
                       max_artifacts: int = 4096) -> dict:
    if any(type(x) is not int or x <= 0 for x in (max_json_bytes, max_artifact_bytes, max_total_bytes, max_artifacts)):
        raise ValueError('inspection limits must be positive integers')
    supplied = directory.absolute()
    for component in (supplied, *supplied.parents):
        info = component.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError('checkpoint namespace has a symlink/junction ancestor')
    root = supplied.resolve(strict=True)
    if not root.is_dir():
        raise ValueError('checkpoint namespace is not a directory')
    manifest_size, _, manifest_bytes = checked_read(root, 'manifest.json', max_json_bytes, retain=True)
    manifest = decode_json(manifest_bytes)
    if (manifest.get('schema') != SCHEMA or manifest.get('result_disposition') != 'raw_native_returned'
            or manifest.get('requires_postsolve') is not True
            or manifest.get('campaign_complete') is not False
            or manifest.get('branch_tracking_complete') is not False
            or manifest.get('scientific_qualification') != 'NOT VERIFIED'):
        raise ValueError('unsupported checkpoint disposition; scientific acceptance is forbidden')
    index = manifest.get('sample_index')
    k = manifest.get('requested_global_k_rad_per_m')
    if type(index) is not int or index < 0 or not isinstance(k, list) or len(k) != 3:
        raise ValueError('invalid checkpoint sample descriptor')
    if any(not finite_number(x) for x in k):
        raise ValueError('invalid nonfinite checkpoint k')
    if root.name != f'sample-{index:04d}':
        raise ValueError('checkpoint namespace and sample index disagree')
    plan = manifest.get('point_plan')
    artifacts = manifest.get('artifacts')
    if not isinstance(plan, dict) or plan.get('relative_path') != 'point-plan.json':
        raise ValueError('checkpoint point-plan preimage is missing')
    if not isinstance(artifacts, list) or not artifacts:
        raise ValueError('checkpoint artifact closure is empty')
    if len(artifacts) > max_artifacts:
        raise ValueError('checkpoint artifact count exceeds inspection limit')
    seen = set()
    spellings = {}
    spectrum_bytes = None
    point_plan_bytes = None
    total_bytes = manifest_size
    for reference in [plan, *artifacts]:
        if not isinstance(reference, dict):
            raise ValueError('invalid checkpoint artifact reference')
        relative = reference.get('relative_path')
        parts = portable_parts(relative)
        for length in range(1, len(parts) + 1):
            spelling = '/'.join(parts[:length])
            previous = spellings.setdefault(spelling.lower(), spelling)
            if previous != spelling:
                raise ValueError('checkpoint directory spelling has a case alias')
        folded = '/'.join(parts).lower()
        if folded in seen or any(folded.startswith(p + '/') or p.startswith(folded + '/') for p in seen):
            raise ValueError('checkpoint artifact aliases or path prefix collision')
        seen.add(folded)
        if reference is not plan:
            source = reference.get('source_relative_path')
            portable_parts(source)
            if relative != 'artifacts/' + source:
                raise ValueError('checkpoint source artifact mapping mismatch')
        is_spectrum = reference.get('source_relative_path') == 'eigen/spectrum.json'
        size, digest = reference.get('size_bytes'), reference.get('sha256')
        if type(size) is not int or size < 0 or not isinstance(digest, str) or not SHA256.fullmatch(digest):
            raise ValueError('invalid checkpoint size/digest')
        if is_spectrum and size > max_json_bytes:
            raise ValueError('checkpoint spectrum exceeds inspection size limit')
        total_bytes += size
        limit = min(max_artifact_bytes, max_json_bytes) if reference is plan or is_spectrum else max_artifact_bytes
        if total_bytes > max_total_bytes or size > limit:
            raise ValueError('checkpoint closure exceeds inspection byte limit')
        count, actual_digest, data = checked_read(root, relative, min(limit, size), retain=is_spectrum or reference is plan)
        if count != size or actual_digest != digest:
            raise ValueError('checkpoint artifact integrity mismatch')
        if is_spectrum:
            spectrum_bytes = data
        if reference is plan:
            point_plan_bytes = data
    point_plan = decode_json(point_plan_bytes)
    sampling = point_plan.get('k_sampling')
    if sampling is None:
        if k != [0, 0, 0]:
            raise ValueError('point plan with implicit Gamma disagrees with checkpoint k')
    elif (not isinstance(sampling, dict) or sampling.get('kind') != 'single'
          or not isinstance(sampling.get('k_vector'), list) or len(sampling['k_vector']) != 3
          or any(not finite_number(x) for x in sampling['k_vector']) or sampling['k_vector'] != k):
        raise ValueError('point plan is not the matching single-k input')
    if spectrum_bytes is None:
        raise ValueError('checkpoint raw spectrum is missing')
    # Decode the exact bytes that were hashed, never a second mutable file read.
    spectrum = decode_json(spectrum_bytes)
    modes = spectrum.get('modes')
    if not isinstance(modes, list):
        raise ValueError('checkpoint spectrum modes are missing')
    rows, indices = [], set()
    for mode in modes:
        if not isinstance(mode, dict):
            raise ValueError('invalid raw mode')
        mode_index, frequency = mode.get('index'), mode.get('frequency_real_hz')
        if type(mode_index) is not int or mode_index < 0 or mode_index in indices:
            raise ValueError('invalid or duplicate raw mode index')
        if not finite_number(frequency):
            raise ValueError('invalid raw mode frequency')
        indices.add(mode_index)
        rows.append({'raw_mode_index': mode_index, 'frequency_real_hz': frequency})
    return {'schema': 'fullmag.single_k_checkpoint.inspection.v1', 'sample_index': index,
            'requested_global_k_rad_per_m': k, 'integrity': 'PASS',
            'point_plan_sha256': plan['sha256'], 'raw_modes': rows,
            'requires_postsolve': True, 'campaign_complete': False,
            'branch_tracking_complete': False, 'scientific_qualification': 'NOT VERIFIED'}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('checkpoint', type=Path)
    parser.add_argument('--max-json-bytes', type=int, default=64 * 1024**2)
    parser.add_argument('--max-artifact-bytes', type=int, default=1024**3)
    parser.add_argument('--max-total-bytes', type=int, default=4 * 1024**3)
    parser.add_argument('--max-artifacts', type=int, default=4096)
    args = parser.parse_args(argv)
    try:
        result = inspect_checkpoint(args.checkpoint, max_json_bytes=args.max_json_bytes,
                                    max_artifact_bytes=args.max_artifact_bytes,
                                    max_total_bytes=args.max_total_bytes, max_artifacts=args.max_artifacts)
    except (ValueError, OSError, OverflowError, RecursionError) as error:
        parser.exit(2, f'checkpoint inspection failed: {error}\n')
    print(json.dumps(result, indent=2, allow_nan=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
