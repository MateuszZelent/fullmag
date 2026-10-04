"""Inventory recursive Python PE imports; do not infer Windows loader behavior."""
import argparse
import json
from pathlib import Path
import subprocess

from verify_pe_dependencies import dump_imports, external_resolution, file_sha256, require_x64_pe


def native_images(stage):
    images = []
    for directory in (stage / 'python', stage / 'bin'):
        if not directory.is_dir() or directory.is_symlink() or getattr(directory, 'is_junction', lambda: False)():
            raise ValueError(f'Missing regular runtime directory: {directory}')
        for path in directory.rglob('*'):
            if path.is_symlink() or getattr(path, 'is_junction', lambda: False)() or not path.resolve(strict=True).is_relative_to(directory):
                raise ValueError(f'Runtime link or escape rejected: {path}')
            if path.suffix.lower() in {'.exe', '.dll', '.pyd'}:
                if not path.is_file():
                    raise ValueError(f'Native image is not a file: {path}')
                images.append(path)
    return sorted(images, key=lambda path: path.relative_to(stage).as_posix().lower())


def audit_python_tree(stage, dumpbin, allow_cuda_driver=False):
    stage = stage.resolve(strict=True)
    paths = native_images(stage)
    if stage / 'python/python.exe' not in paths:
        raise ValueError('Bundled python.exe missing')
    inventory = {}
    names = {}
    folded = set()
    for path in paths:
        relative = path.relative_to(stage).as_posix()
        if relative.lower() in folded:
            raise ValueError(f'Case-insensitive path collision: {relative}')
        folded.add(relative.lower())
        require_x64_pe(path)
        inventory[path] = file_sha256(path)
        names.setdefault(path.name.lower(), []).append(path)
    records = []
    for path in paths:
        dependencies = []
        for name in dump_imports(path, dumpbin):
            external = external_resolution(name, allow_cuda_driver)
            if external:
                dependencies.append({'name': name, 'resolution': external})
                continue
            candidates = names.get(name, [])
            if not candidates:
                raise ValueError(f'Missing bundled dependency: {path.relative_to(stage)} -> {name}')
            # Static availability is not a claim about AddDllDirectory/order.
            # Different images with the same basename cannot be assumed interchangeable.
            if len({inventory[candidate] for candidate in candidates}) != 1:
                raise ValueError(f'Conflicting bundled dependency basename: {name}')
            local = [candidate for candidate in candidates if candidate.parent == path.parent]
            shared = [candidate for candidate in candidates
                      if candidate.parent in (stage / 'python', stage / 'bin')]
            available = local or shared or candidates
            dependencies.append({
                'name': name,
                'resolution': 'bundled_local' if local else 'bundled_runtime_directory' if shared
                              else 'bundled_package_loader_required',
                'candidates': [candidate.relative_to(stage).as_posix() for candidate in available],
            })
        records.append({'path': path.relative_to(stage).as_posix(),
                        'sha256': inventory[path], 'imports': dependencies})
    if native_images(stage) != paths:
        raise ValueError('Native image inventory changed during audit')
    for path, digest in inventory.items():
        if file_sha256(path) != digest:
            raise ValueError(f'Native image changed during audit: {path}')
    return {'schema_version': 1, 'target': 'x86_64-pc-windows-msvc',
            'scope': 'python_recursive_and_bin_pe_static_and_delay_import_availability',
            'runtime_qualified': False, 'images': records,
            'limitations': ['Bundled availability does not prove Windows loader search order or package DLL registration',
                            'Dynamic LoadLibrary imports, symbols/ABI and scientific execution require runtime qualification']}


def verify_inventory(stage, report):
    stage = stage.resolve(strict=True)
    expected = {entry['path']: entry['sha256'] for entry in report['images']}
    if len(expected) != len(report['images']):
        raise ValueError('Duplicate audited inventory path')
    actual = {path.relative_to(stage).as_posix(): file_sha256(path)
              for path in native_images(stage)}
    if actual != expected:
        raise ValueError('Native image inventory changed after audit')
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', type=Path, required=True)
    parser.add_argument('--dumpbin', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--allow-cuda-driver', action='store_true')
    parser.add_argument('--verify-inventory', type=Path)
    args = parser.parse_args()
    try:
        if args.verify_inventory:
            report = verify_inventory(args.stage, json.loads(args.verify_inventory.read_text(encoding='utf-8')))
        else:
            report = audit_python_tree(args.stage, args.dumpbin, args.allow_cuda_driver)
    except (ValueError, OSError, subprocess.TimeoutExpired) as error:
        parser.exit(1, f'Python native dependency audit failed: {error}\n')
    args.output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
