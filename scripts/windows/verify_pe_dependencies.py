"""Audit staged x64 Windows PE imports without loading or executing images."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import struct
import subprocess

# OS components only: redistributable CRT, solver and CUDA runtime DLLs must be staged.
SYSTEM_IMPORTS = frozenset('''advapi32.dll bcrypt.dll bcryptprimitives.dll cabinet.dll
cfgmgr32.dll comctl32.dll comdlg32.dll crypt32.dll cryptbase.dll cryptnet.dll
cryptsp.dll dbghelp.dll dnsapi.dll dwmapi.dll dxgi.dll d3d11.dll d3d12.dll
fwpuclnt.dll gdi32.dll gdi32full.dll imm32.dll iphlpapi.dll kernel32.dll
kernelbase.dll mpr.dll msimg32.dll msvcrt.dll ncrypt.dll netapi32.dll normaliz.dll
ntdll.dll ole32.dll oleaut32.dll opengl32.dll powrprof.dll profapi.dll propsys.dll
psapi.dll rpcrt4.dll secur32.dll setupapi.dll shell32.dll shlwapi.dll shcore.dll
sspicli.dll ucrtbase.dll user32.dll userenv.dll usp10.dll uxtheme.dll version.dll
winhttp.dll wininet.dll winmm.dll winspool.drv wintrust.dll wldap32.dll ws2_32.dll
wtsapi32.dll urlmon.dll'''.split())
API_SET = re.compile(r'^(?:api-ms-win-|ext-ms-win-)[a-z0-9-]+\.dll$')


def require_not_driver(path):
    if path.name.lower() == 'nvcuda.dll':
        raise ValueError('NVIDIA driver nvcuda.dll must not be bundled or sourced from SDK roots')


def require_x64_pe(path):
    require_not_driver(path)
    with path.open('rb') as stream:
        dos = stream.read(64)
        if len(dos) != 64 or dos[:2] != b'MZ':
            raise ValueError(f'Not a PE image: {path.name}')
        offset = struct.unpack_from('<I', dos, 60)[0]
        if offset < 64 or offset > path.stat().st_size - 26:
            raise ValueError(f'Invalid PE header offset: {path.name}')
        stream.seek(offset)
        header = stream.read(26)
    if header[:4] != b'PE\0\0' or struct.unpack_from('<H', header, 4)[0] != 0x8664:
        raise ValueError(f'Expected AMD64 PE image: {path.name}')
    if struct.unpack_from('<H', header, 24)[0] != 0x20b:
        raise ValueError(f'Expected PE32+ image: {path.name}')


def parse_dependents(output):
    if not re.search(r'^File Type: (?:EXECUTABLE IMAGE|DLL)\s*$', output, re.M):
        raise ValueError('Unrecognized dumpbin image output')
    imports = set()
    in_group = False
    summary = False
    for line in output.splitlines():
        text = line.strip()
        if text in ('Image has the following dependencies:', 'Image has the following delay load dependencies:'):
            in_group = True
        elif text == 'Summary':
            in_group = False
            summary = True
        elif in_group and text:
            if not re.fullmatch(r'[A-Za-z0-9_.+-]+\.(?:dll|drv)', text, re.I):
                raise ValueError(f'Unrecognized dependency entry: {text}')
            imports.add(text.lower())
    if not summary:
        raise ValueError('Incomplete dumpbin output')
    return sorted(imports)


def dump_imports(path, dumpbin):
    result = subprocess.run([str(dumpbin), '/nologo', '/dependents', str(path)],
                            capture_output=True, text=True, errors='replace', timeout=30)
    if result.returncode:
        raise ValueError(f'dumpbin failed for {path.name}: exit {result.returncode}')
    return parse_dependents(result.stdout)


def file_sha256(path):
    hasher = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            hasher.update(chunk)
    return hasher.hexdigest()


def external_resolution(name, allow_cuda_driver=False):
    if API_SET.fullmatch(name):
        return 'windows_api_set'
    if name in SYSTEM_IMPORTS:
        return 'windows_component'
    if name == 'nvcuda.dll' and allow_cuda_driver:
        return 'external_nvidia_driver'
    return None


def audit_bin(directory, dumpbin, allow_cuda_driver=False, include_pyd=False):
    directory = directory.resolve(strict=True)
    extensions = ('.exe', '.dll', '.pyd') if include_pyd else ('.exe', '.dll')
    images = sorted((p for p in directory.iterdir() if p.suffix.lower() in extensions), key=lambda p: p.name.lower())
    if not images or not any(p.suffix.lower() == '.exe' for p in images):
        raise ValueError('Staged bin contains no EXE')
    names = {}
    for path in images:
        if not path.is_file() or path.is_symlink() or path.resolve().parent != directory:
            raise ValueError(f'Image must be a regular local file: {path.name}')
        name = path.name.lower()
        if name in names:
            raise ValueError(f'Ambiguous image name: {path.name}')
        names[name] = path
        require_x64_pe(path)
    records = []
    for path in images:
        dependencies = []
        for name in dump_imports(path, dumpbin):
            if name in names:
                kind = 'bundled'
            elif external_resolution(name, allow_cuda_driver):
                kind = external_resolution(name, allow_cuda_driver)
            else:
                raise ValueError(f'Missing staged dependency: {path.name} -> {name}')
            dependencies.append({'name': name, 'resolution': kind})
        digest = file_sha256(path)
        records.append({'path': ('python/' if include_pyd else 'bin/') + path.name,
                        'sha256': digest,
                        'imports': dependencies})
    return {'schema_version': 1, 'target': 'x86_64-pc-windows-msvc',
            'scope': 'python_flat_pe_static_and_delay_imports' if include_pyd else 'bin_pe_static_and_delay_imports', 'images': records,
            'limitations': ['dynamic LoadLibrary imports, symbol/ABI compatibility and OS availability require runtime qualification',
                            'Nested Python package native extensions are outside this flat directory audit' if include_pyd else
                            'Python native extensions and external Python/Node are outside this bin audit']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bin', type=Path, required=True)
    parser.add_argument('--dumpbin', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--allow-cuda-driver', action='store_true')
    parser.add_argument('--include-pyd', action='store_true')
    args = parser.parse_args()
    try:
        report = audit_bin(args.bin, args.dumpbin, args.allow_cuda_driver, args.include_pyd)
    except (ValueError, OSError, subprocess.TimeoutExpired) as exc:
        parser.exit(1, f'PE dependency audit failed: {exc}\n')
    args.output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
