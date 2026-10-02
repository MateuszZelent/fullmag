"""Plan DLL closure from explicit SDK roots; never search PATH or mutate staging."""
import argparse
from collections import deque
import json
from pathlib import Path
import subprocess

from verify_pe_dependencies import dump_imports, external_resolution, file_sha256, require_not_driver, require_x64_pe


def regular_image(path, parent):
    if not path.is_file() or path.is_symlink() or path.resolve().parent != parent:
        raise ValueError(f'Image must be a regular local file: {path}')
    require_x64_pe(path)


def plan_dependencies(directory, dumpbin, dependency_roots, allow_cuda_driver=False, include_pyd=False):
    directory = directory.resolve(strict=True)
    images = {}
    for path in sorted(directory.iterdir(), key=lambda p: p.name.lower()):
        if path.suffix.lower() not in (('.exe', '.dll', '.pyd') if include_pyd else ('.exe', '.dll')):
            continue
        regular_image(path, directory)
        name = path.name.lower()
        if name in images:
            raise ValueError(f'Ambiguous staged image name: {name}')
        images[name] = path
    if not any(p.suffix.lower() == '.exe' for p in images.values()):
        raise ValueError('Staged bin contains no EXE')
    roots = sorted({root.resolve(strict=True) for root in dependency_roots}, key=lambda p: str(p).lower())
    candidates = {}
    for root in roots:
        if not root.is_dir():
            raise ValueError(f'Dependency root is not a directory: {root}')
        for path in root.rglob('*'):
            if path.suffix.lower() == '.dll':
                if not path.resolve(strict=True).is_relative_to(root):
                    raise ValueError(f'Dependency escapes declared SDK root: {path}')
                require_not_driver(path)
                candidates.setdefault(path.name.lower(), []).append(path)
    queue = deque(images.values())
    sources = {}
    analyzed = {}
    while queue:
        path = queue.popleft()
        digest = file_sha256(path)
        if path.parent == directory:
            for candidate in candidates.get(path.name.lower(), []):
                regular_image(candidate, candidate.parent.resolve())
                if file_sha256(candidate) != digest:
                    raise ValueError(f'Conflicting staged/SDK dependency basename: {path.name}')
        imports = dump_imports(path, dumpbin)
        if file_sha256(path) != digest:
            raise ValueError(f'Image changed during dependency planning: {path}')
        analyzed[path.name.lower()] = digest
        for name in imports:
            if name in images or external_resolution(name, allow_cuda_driver):
                continue
            options = candidates.get(name, [])
            if not options:
                raise ValueError(f'Missing SDK dependency: {path.name} -> {name}')
            hashes = set()
            for candidate in options:
                regular_image(candidate, candidate.parent.resolve())
                hashes.add(file_sha256(candidate))
            if len(hashes) != 1:
                raise ValueError(f'Conflicting SDK dependency basename: {name}')
            selected = sorted(options, key=lambda p: str(p).lower())[0]
            images[name] = selected
            sources[name] = {'name': selected.name, 'source': str(selected), 'sha256': next(iter(hashes))}
            queue.append(selected)
    # Recheck the frozen selection, including all initial staged images.
    for name, path in images.items():
        if file_sha256(path) != analyzed[name]:
            raise ValueError(f'Image changed after dependency planning: {path}')
        if name in sources and sources[name]['sha256'] != analyzed[name]:
            raise ValueError(f'SDK dependency changed after selection: {path}')
    return {'schema_version': 1, 'scope': 'python_flat_pe_static_and_delay_imports' if include_pyd else 'bin_pe_static_and_delay_imports',
            'dependency_roots': [str(root) for root in roots],
            'sources': [sources[name] for name in sorted(sources)],
            'staged_images': {name: analyzed[name] for name in sorted(analyzed) if name not in sources}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bin', type=Path, required=True)
    parser.add_argument('--dumpbin', type=Path, required=True)
    parser.add_argument('--dependency-root', type=Path, action='append', default=[])
    parser.add_argument('--allow-cuda-driver', action='store_true')
    parser.add_argument('--include-pyd', action='store_true')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        plan = plan_dependencies(args.bin, args.dumpbin, args.dependency_root, args.allow_cuda_driver, args.include_pyd)
    except (ValueError, OSError, subprocess.TimeoutExpired) as exc:
        parser.exit(1, f'DLL closure planning failed: {exc}\n')
    args.output.write_text(json.dumps(plan, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
