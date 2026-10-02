"""Interpreted packaging regressions with non-executable PE/dumpbin fixtures."""
import importlib.util
import json
from pathlib import Path
import struct
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts/windows'))
spec = importlib.util.spec_from_file_location('python_native', ROOT / 'scripts/windows/verify_python_native_dependencies.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


def image(path, machine=0x8664):
    path.parent.mkdir(parents=True, exist_ok=True)
    data = bytearray(90)
    data[:2] = b'MZ'
    struct.pack_into('<I', data, 60, 64)
    data[64:68] = b'PE\0\0'
    struct.pack_into('<H', data, 68, machine)
    struct.pack_into('<H', data, 88, 0x20b)
    path.write_bytes(data)
    return path


def fixture(tmp_path, monkeypatch):
    (tmp_path / 'bin').mkdir()
    image(tmp_path / 'python/python.exe')
    image(tmp_path / 'python/python312.dll')
    image(tmp_path / 'python/site-packages/numpy/core.pyd')
    image(tmp_path / 'python/site-packages/numpy.libs/blas.dll')
    deps = {'python.exe': ['python312.dll'], 'python312.dll': ['kernel32.dll'],
            'core.pyd': ['python312.dll', 'blas.dll'], 'blas.dll': ['kernel32.dll']}
    monkeypatch.setattr(audit, 'dump_imports', lambda path, tool: deps[path.name])
    return deps


def test_recursive_inventory_reports_package_loader_obligation(tmp_path, monkeypatch):
    fixture(tmp_path, monkeypatch)
    report = audit.audit_python_tree(tmp_path, Path('fixture'))
    assert len(report['images']) == 4
    assert report['runtime_qualified'] is False
    core = next(record for record in report['images'] if record['path'].endswith('core.pyd'))
    assert core['imports'][1] == {'name': 'blas.dll', 'resolution': 'bundled_package_loader_required',
                                 'candidates': ['python/site-packages/numpy.libs/blas.dll']}


@pytest.mark.parametrize('case', ['missing', 'transitive_missing', 'x86', 'driver', 'conflict'])
def test_reject_incomplete_or_conflicting_wheel_dependencies(tmp_path, monkeypatch, case):
    deps = fixture(tmp_path, monkeypatch)
    if case == 'missing':
        (tmp_path / 'python/site-packages/numpy.libs/blas.dll').unlink()
    elif case == 'transitive_missing':
        deps['blas.dll'] = ['not_staged.dll']
    elif case == 'x86':
        image(tmp_path / 'python/site-packages/numpy/core.pyd', machine=0x14c)
    elif case == 'driver':
        image(tmp_path / 'bin/nvcuda.dll')
    else:
        other = image(tmp_path / 'python/site-packages/other/blas.dll')
        other.write_bytes(other.read_bytes() + b'different')
    with pytest.raises(ValueError):
        audit.audit_python_tree(tmp_path, Path('fixture'))


@pytest.mark.parametrize('mutation', ['change', 'add', 'remove'])
def test_reject_inventory_races(tmp_path, monkeypatch, mutation):
    deps = fixture(tmp_path, monkeypatch)
    changed = False

    def imports(path, tool):
        nonlocal changed
        if not changed:
            changed = True
            target = tmp_path / 'python/python312.dll'
            if mutation == 'change':
                target.write_bytes(target.read_bytes() + b'changed')
            elif mutation == 'add':
                image(tmp_path / 'bin/added.dll')
            else:
                target.unlink()
        return deps[path.name]

    monkeypatch.setattr(audit, 'dump_imports', imports)
    with pytest.raises((ValueError, OSError)):
        audit.audit_python_tree(tmp_path, Path('fixture'))


def test_reject_linked_native_file(tmp_path, monkeypatch):
    fixture(tmp_path, monkeypatch)
    link = tmp_path / 'python/linked.dll'
    try:
        link.symlink_to(tmp_path / 'python/python312.dll')
    except OSError:
        pytest.skip('Host cannot create symlinks')
    with pytest.raises(ValueError, match='link or escape'):
        audit.audit_python_tree(tmp_path, Path('fixture'))


def test_cuda_driver_is_external_only_when_explicit(tmp_path, monkeypatch):
    deps = fixture(tmp_path, monkeypatch)
    deps['core.pyd'] += ['nvcuda.dll']
    with pytest.raises(ValueError, match='Missing bundled'):
        audit.audit_python_tree(tmp_path, Path('fixture'))
    report = audit.audit_python_tree(tmp_path, Path('fixture'), allow_cuda_driver=True)
    assert any(dependency['resolution'] == 'external_nvidia_driver'
               for record in report['images'] for dependency in record['imports'])


def test_local_and_shared_directory_dependencies_remain_distinct(tmp_path, monkeypatch):
    deps = fixture(tmp_path, monkeypatch)
    image(tmp_path / 'python/site-packages/numpy/local.dll')
    image(tmp_path / 'bin/vcruntime140.dll')
    deps['local.dll'] = ['kernel32.dll']
    deps['vcruntime140.dll'] = ['kernel32.dll']
    deps['core.pyd'] = ['local.dll', 'vcruntime140.dll']
    report = audit.audit_python_tree(tmp_path, Path('fixture'))
    core = next(record for record in report['images'] if record['path'].endswith('core.pyd'))
    assert [entry['resolution'] for entry in core['imports']] == ['bundled_local', 'bundled_runtime_directory']


@pytest.mark.parametrize('mutation', ['none', 'add', 'remove', 'change'])
def test_post_smoke_matches_full_frozen_inventory(tmp_path, monkeypatch, mutation):
    fixture(tmp_path, monkeypatch)
    report = audit.audit_python_tree(tmp_path, Path('fixture'))
    path = tmp_path / 'python/site-packages/numpy/core.pyd'
    if mutation == 'add':
        image(tmp_path / 'python/site-packages/numpy/added.dll')
    elif mutation == 'remove':
        path.unlink()
    elif mutation == 'change':
        path.write_bytes(path.read_bytes() + b'changed')
    if mutation == 'none':
        assert audit.verify_inventory(tmp_path, report) is report
    else:
        with pytest.raises(ValueError, match='inventory changed'):
            audit.verify_inventory(tmp_path, report)


@pytest.mark.parametrize('added', [False, True])
def test_post_smoke_cli_rejects_added_image_before_writing_report(tmp_path, monkeypatch, added):
    fixture(tmp_path, monkeypatch)
    inventory = tmp_path / 'inventory.json'
    inventory.write_text(json.dumps(audit.audit_python_tree(tmp_path, Path('fixture'))))
    output = tmp_path / 'verified.json'
    if added:
        image(tmp_path / 'python/site-packages/numpy/added.dll')
    result = subprocess.run([sys.executable, str(ROOT / 'scripts/windows/verify_python_native_dependencies.py'),
                             '--stage', str(tmp_path), '--dumpbin', 'unused',
                             '--verify-inventory', str(inventory), '--output', str(output)],
                            capture_output=True, text=True, timeout=10)
    assert result.returncode == (1 if added else 0), result.stderr
    assert output.exists() is (not added)


def test_installer_runs_recursive_gate_before_import_smoke_and_captures_it():
    source = (ROOT / 'scripts/windows/build_windows_msi.ps1').read_text()
    assert source.index('& python @pythonNativeAuditArgs') < source.index('-c "import fullmag, numpy')
    assert source.count('python_native_dependency_audit = $pythonNativeDependencyAudit') == 2
    assert 'foreach ($pythonImage in $pythonNativeDependencyAudit.images)' in source
    assert source.index('--verify-inventory $pythonNativeAuditPath') > source.index('-c "import fullmag, numpy')
