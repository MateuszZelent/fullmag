"""PE packaging gate regressions; fixture images are not executable artifacts."""
import importlib.util
from pathlib import Path
import struct
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('pe_audit', ROOT / 'scripts/windows/verify_pe_dependencies.py')
pe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pe)


def image(path, machine=0x8664, magic=0x20b):
    data = bytearray(90)
    data[:2] = b'MZ'
    struct.pack_into('<I', data, 60, 64)
    data[64:68] = b'PE\0\0'
    struct.pack_into('<H', data, 68, machine)
    struct.pack_into('<H', data, 88, magic)
    path.write_bytes(data)
    return path


def test_parse_regular_delay_and_driver():
    output = '''File Type: EXECUTABLE IMAGE
  Image has the following dependencies:
    KERNEL32.dll
    solver.dll
  Image has the following delay load dependencies:
    SOLVER.dll
    WINSPOOL.DRV
  Summary
        1000 .text
'''
    assert pe.parse_dependents(output) == ['kernel32.dll', 'solver.dll', 'winspool.drv']


@pytest.mark.parametrize('case', ['valid', 'missing', 'wrong_architecture'])
def test_python_flat_audit_includes_native_extensions(tmp_path, monkeypatch, case):
    image(tmp_path / 'python.exe')
    image(tmp_path / 'python312.dll')
    image(tmp_path / '_socket.pyd', machine=0x14c if case == 'wrong_architecture' else 0x8664)
    deps = {'python.exe': ['python312.dll'], 'python312.dll': ['kernel32.dll'],
            '_socket.pyd': ['missing.dll'] if case == 'missing' else ['python312.dll']}
    monkeypatch.setattr(pe, 'dump_imports', lambda path, tool: deps[path.name])
    if case != 'valid':
        with pytest.raises(ValueError):
            pe.audit_bin(tmp_path, Path('unused'), include_pyd=True)
    else:
        report = pe.audit_bin(tmp_path, Path('unused'), include_pyd=True)
        assert report['scope'] == 'python_flat_pe_static_and_delay_imports'
        assert {entry['path'] for entry in report['images']} == {'python/python.exe', 'python/python312.dll', 'python/_socket.pyd'}


@pytest.mark.parametrize('output', ['garbage', 'File Type: EXECUTABLE IMAGE',
    'File Type: DLL\nImage has the following dependencies:\n../solver.dll\nSummary'])
def test_reject_unrecognized_or_incomplete_dump(output):
    with pytest.raises(ValueError):
        pe.parse_dependents(output)


@pytest.mark.parametrize('machine,magic', [(0x14c, 0x10b), (0xaa64, 0x20b), (0x8664, 0x10b)])
def test_reject_wrong_target(tmp_path, machine, magic):
    with pytest.raises(ValueError):
        pe.require_x64_pe(image(tmp_path / 'wrong.exe', machine, magic))


def test_reject_truncated_pe(tmp_path):
    path = tmp_path / 'bad.exe'
    path.write_bytes(b'MZ')
    with pytest.raises(ValueError):
        pe.require_x64_pe(path)


def test_bundle_closure_includes_transitive_imports(tmp_path, monkeypatch):
    image(tmp_path / 'app.exe')
    image(tmp_path / 'solver.dll')
    deps = {'app.exe': ['solver.dll'], 'solver.dll': ['kernel32.dll', 'api-ms-win-core-file-l1-1-0.dll']}
    monkeypatch.setattr(pe, 'dump_imports', lambda path, tool: deps[path.name])
    report = pe.audit_bin(tmp_path, Path('unused'))
    assert len(report['images']) == 2
    assert report['images'][0]['imports'][0]['resolution'] == 'bundled'
    import hashlib
    assert report['images'][0]['sha256'] == hashlib.sha256((tmp_path / 'app.exe').read_bytes()).hexdigest()
    deps['solver.dll'] = ['hypre.dll']
    with pytest.raises(ValueError, match='solver.dll -> hypre.dll'):
        pe.audit_bin(tmp_path, Path('unused'))


@pytest.mark.parametrize('dependency', ['vcruntime140.dll', 'msvcp140.dll', 'cudart64_12.dll', 'mfem.dll', 'unrecognized.dll', 'nvcuda.dll'])
def test_external_build_machine_dlls_do_not_qualify_bundle(tmp_path, monkeypatch, dependency):
    image(tmp_path / 'app.exe')
    monkeypatch.setattr(pe, 'dump_imports', lambda path, tool: [dependency])
    with pytest.raises(ValueError, match='Missing staged dependency'):
        pe.audit_bin(tmp_path, Path('unused'))


def test_cuda_driver_exception_is_explicit(tmp_path, monkeypatch):
    image(tmp_path / 'app.exe')
    monkeypatch.setattr(pe, 'dump_imports', lambda path, tool: ['nvcuda.dll'])
    report = pe.audit_bin(tmp_path, Path('unused'), allow_cuda_driver=True)
    assert report['images'][0]['imports'][0]['resolution'] == 'external_nvidia_driver'


def test_empty_bin_rejected(tmp_path):
    with pytest.raises(ValueError, match='no EXE'):
        pe.audit_bin(tmp_path, Path('unused'))


def test_dumpbin_failure_not_empty_success(tmp_path, monkeypatch):
    monkeypatch.setattr(subprocess, 'run', lambda *a, **kw: subprocess.CompletedProcess(a, 1, '', 'error'))
    with pytest.raises(ValueError, match='dumpbin failed'):
        pe.dump_imports(tmp_path / 'bad.exe', Path('dumpbin'))


def test_gate_precedes_version_and_stage_manifests():
    source = (ROOT / 'scripts/windows/build_windows_msi.ps1').read_text()
    assert source.index('& python @peAuditArgs') < source.index('  Write-VersionMetadata ')
    assert source.count('pe_dependency_audit = $peDependencyAudit') == 2
    assert '-requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64' in source


def test_stage_manifest_keeps_nested_dependency_inventory(tmp_path):
    import shutil
    tool = shutil.which('pwsh') or shutil.which('powershell')
    if not tool:
        pytest.skip('PowerShell required')
    driver = tmp_path / 'manifest.ps1'
    output = tmp_path / 'manifest.json'
    driver.write_text(r'''param($Installer,$Output)
$ErrorActionPreference='Stop'
$StageRoot='fixture-stage'; $ProductVersion='0.1.0'; $BuildCuda=$false
$sourceIdentity=@{fixture=$true}; $runtimeDllInventory=@()
$peDependencyAudit=@{images=@(@{path='bin/app.exe';imports=@(@{name='solver.dll';resolution='bundled'})})}
$pythonNativeDependencyAudit=@{runtime_qualified=$false;images=@(@{path='python/site-packages/example/core.pyd';imports=@(@{name='vendor.dll';resolution='bundled_package_loader_required';candidates=@('python/site-packages/example.libs/vendor.dll')})})}
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($Installer,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$fn=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Write-StageManifest'},$true)
Invoke-Expression $fn.Extent.Text
Write-StageManifest $Output
''',encoding='utf-8')
    result=subprocess.run([tool,'-NoProfile','-File',str(driver),str(ROOT/'scripts/windows/build_windows_msi.ps1'),str(output)],capture_output=True,text=True,timeout=20)
    assert result.returncode == 0, result.stderr
    import json
    report=json.loads(output.read_text(encoding='utf-8-sig'))
    assert report['pe_dependency_audit']['images'][0]['imports'][0]['resolution'] == 'bundled'
    native = report['python_native_dependency_audit']
    assert native['runtime_qualified'] is False
    assert native['images'][0]['imports'][0]['candidates'] == ['python/site-packages/example.libs/vendor.dll']


def test_cli_failure_emits_no_report(tmp_path):
    import sys
    result = subprocess.run([sys.executable, str(ROOT/'scripts/windows/verify_pe_dependencies.py'),
        '--bin',str(tmp_path),'--dumpbin',str(tmp_path/'missing-tool.exe'),
        '--output',str(tmp_path/'audit.json')],capture_output=True,text=True,timeout=20)
    assert result.returncode == 1
    assert 'Staged bin contains no EXE' in result.stderr
    assert not (tmp_path/'audit.json').exists()


@pytest.mark.parametrize('cuda', [False, True])
def test_staged_nvidia_driver_is_never_redistributed(tmp_path, monkeypatch, cuda):
    image(tmp_path/'app.exe'); image(tmp_path/'nvcuda.dll')
    monkeypatch.setattr(pe,'dump_imports',lambda path, tool: ['nvcuda.dll'] if path.name == 'app.exe' else [])
    with pytest.raises(ValueError,match='NVIDIA driver nvcuda.dll must not be bundled'):
        pe.audit_bin(tmp_path,Path('unused'),cuda)
