#!/usr/bin/env python3
"""Bind CTest and runtime FEM bytes without replacing a runtime library."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess


def identity(path: Path) -> dict:
    resolved = path.resolve(strict=True)
    if not resolved.is_file():
        raise ValueError(f'library is not a regular file: {resolved}')
    digest = hashlib.sha256()
    with resolved.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return {'path': str(resolved), 'sha256': digest.hexdigest(), 'size_bytes': resolved.stat().st_size}


def resolve_runtime_library(directory: Path) -> Path:
    candidates = {path.resolve(strict=True) for path in directory.glob('libfullmag_fem.so*')}
    if len(candidates) != 1:
        raise ValueError(f'expected exactly one runtime FEM library, got {len(candidates)} in {directory}')
    return next(iter(candidates))


def require_equal(left: dict, right: dict) -> None:
    if (left['sha256'], left['size_bytes']) != (right['sha256'], right['size_bytes']):
        raise ValueError('private CTest FEM library differs from runtime FEM library')


def loader_resolution(binary: Path, expected: Path, *, required: bool = True) -> dict:
    result = subprocess.run(['ldd', str(binary)], capture_output=True, text=True, check=False, timeout=30)
    if result.returncode:
        raise ValueError(f'ldd failed for {binary}: {result.stderr.strip()}')
    matches = re.findall(r'^\s*libfullmag_fem[^\s]*\s+=>\s+(\S+)', result.stdout, re.MULTILINE)
    if required and not matches:
        raise ValueError(f'missing required FEM loader dependency for {binary}')
    if len(matches) > 1:
        raise ValueError(f'ambiguous FEM loader resolution for {binary}')
    if matches and Path(matches[0]).resolve(strict=True) != expected.resolve(strict=True):
        raise ValueError(f'wrong FEM loader resolution for {binary}: {matches[0]}')
    return {'binary': str(binary.resolve(strict=True)), 'fem_dependency': str(Path(matches[0]).resolve(strict=True)) if matches else None,
            'binding': 'dynamic_dependency' if matches else 'no_linked_fem_dependency',
            'ldd_stdout': result.stdout}


def capture(manifest: Path, runtime_directory: Path, binaries: list[Path], runtime_binaries: list[Path] | None = None) -> dict:
    paths = [line.strip() for line in manifest.read_text(encoding='utf-8').splitlines() if line.strip()]
    if len(paths) != 1:
        raise ValueError('CMake target manifest must contain exactly one library path')
    private = identity(Path(paths[0]))
    runtime = identity(resolve_runtime_library(runtime_directory))
    try:
        require_equal(private, runtime)
    except ValueError as error:
        error.observation = {'private': private, 'runtime': runtime}
        raise
    return {'private': private, 'runtime': runtime,
            'loader_path': os.environ.get('LD_LIBRARY_PATH', ''),
            'loader_resolutions': [loader_resolution(binary, Path(private['path'])) for binary in binaries]
                + [loader_resolution(binary, Path(private['path']), required=False) for binary in (runtime_binaries or [])]}


def verify_unchanged(before: dict, after: dict) -> None:
    for key in ('private', 'runtime', 'loader_path'):
        if before[key] != after[key]:
            raise ValueError(f'FEM library or loader evidence changed during contract: {key}')
    stable_keys = ('binary', 'fem_dependency', 'binding')
    stable = lambda observations: [
        {key: observation[key] for key in stable_keys} for observation in observations
    ]
    if stable(before['loader_resolutions']) != stable(after['loader_resolutions']):
        raise ValueError('FEM loader resolution changed during contract')


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('phase', choices=('pre', 'post'))
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--runtime-directory', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--binary', action='append', default=[], type=Path)
    parser.add_argument('--runtime-binary', action='append', default=[], type=Path)
    args = parser.parse_args()
    evidence = {'schema': 'fullmag.fem.slepc_modal.library_identity.v1', 'status': 'fail'}
    try:
        if args.phase == 'post':
            previous = json.loads(args.output.read_text(encoding='utf-8'))
            if not isinstance(previous, dict):
                raise ValueError('pre attestation is not an object')
            evidence = previous
            evidence['status'] = 'fail'
        observed = capture(args.manifest, args.runtime_directory, args.binary, args.runtime_binary)
        evidence[args.phase] = observed
        if args.phase == 'post':
            verify_unchanged(evidence['pre'], observed)
            evidence['status'] = 'pass'
        else:
            evidence['status'] = 'pending_post_verification'
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        evidence['error'] = str(error)
        if hasattr(error, 'observation'):
            evidence[args.phase] = error.observation
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(evidence, indent=2, sort_keys=True)+'\n', encoding='utf-8')
        print(str(error), file=__import__('sys').stderr)
        return 1
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(evidence, indent=2, sort_keys=True)+'\n', encoding='utf-8')
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
