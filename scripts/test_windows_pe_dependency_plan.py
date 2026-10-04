"""Plan imported DLL closure on fixtures without compiling or executing images."""
import importlib
from pathlib import Path
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts/windows'))
planner = importlib.import_module('plan_pe_dependencies')
from scripts.test_windows_pe_dependencies import image


def setup(tmp_path):
    stage = tmp_path / 'bin'; stage.mkdir()
    sdk = tmp_path / 'sdk'; sdk.mkdir()
    image(stage / 'app.exe')
    return stage, sdk


def imports(monkeypatch, dependencies):
    monkeypatch.setattr(planner, 'dump_imports', lambda path, tool: dependencies[path.name.lower()])


def test_python_pyd_imports_participate_in_closure(tmp_path, monkeypatch):
    stage, sdk = setup(tmp_path)
    image(stage / '_socket.pyd')
    image(sdk / 'python312.dll')
    imports(monkeypatch, {'app.exe': ['kernel32.dll'], '_socket.pyd': ['python312.dll'],
                         'python312.dll': ['kernel32.dll']})
    plan = planner.plan_dependencies(stage, Path('unused'), [sdk], include_pyd=True)
    assert plan['scope'] == 'python_flat_pe_static_and_delay_imports'
    assert [entry['name'] for entry in plan['sources']] == ['python312.dll']
    assert '_socket.pyd' in plan['staged_images']


def test_transitive_closure_and_no_copy(tmp_path, monkeypatch):
    stage, sdk = setup(tmp_path)
    image(sdk / 'solver.dll'); image(sdk / 'runtime.dll'); image(sdk / 'unused.dll')
    imports(monkeypatch, {'app.exe':['solver.dll'], 'solver.dll':['runtime.dll'], 'runtime.dll':['kernel32.dll']})
    plan = planner.plan_dependencies(stage, Path('unused'), [sdk])
    assert [s['name'] for s in plan['sources']] == ['runtime.dll', 'solver.dll']
    assert {p.name for p in stage.iterdir()} == {'app.exe'}
    assert all(s['sha256'] == planner.file_sha256(Path(s['source'])) for s in plan['sources'])


def test_nested_sdk_layout_is_bundled_without_prefix_at_runtime(tmp_path, monkeypatch):
    stage,sdk=setup(tmp_path)
    for sub,name in [('lib/Release','mfem.dll'),('hypre/bin/Release','hypre.dll')]:
        directory=sdk/sub; directory.mkdir(parents=True)
        image(directory/name)
    imports(monkeypatch, {'app.exe':['mfem.dll'], 'mfem.dll':['hypre.dll'], 'hypre.dll':[]})
    plan=planner.plan_dependencies(stage,Path('unused'),[sdk])
    assert [s['name'] for s in plan['sources']] == ['hypre.dll','mfem.dll']
    assert {Path(s['source']).parent for s in plan['sources']} == {sdk/'lib/Release',sdk/'hypre/bin/Release'}


def test_conflicting_nested_sdk_versions_are_rejected(tmp_path, monkeypatch):
    stage,sdk=setup(tmp_path)
    for sub in ('bin/Release','bin/Debug'):
        directory=sdk/sub; directory.mkdir(parents=True); image(directory/'mfem.dll')
    other=sdk/'bin/Debug/mfem.dll'; other.write_bytes(other.read_bytes()+b'other version')
    imports(monkeypatch, {'app.exe':['mfem.dll'], 'mfem.dll':[]})
    with pytest.raises(ValueError,match='Conflicting SDK dependency basename'):
        planner.plan_dependencies(stage,Path('unused'),[sdk])


def test_nested_driver_cannot_be_sourced(tmp_path, monkeypatch):
    stage,sdk=setup(tmp_path)
    directory=sdk/'nested'; directory.mkdir(); image(directory/'nvcuda.dll')
    imports(monkeypatch, {'app.exe':[]})
    with pytest.raises(ValueError,match='NVIDIA driver'):
        planner.plan_dependencies(stage,Path('unused'),[sdk],True)


def test_cycle_is_bounded(tmp_path, monkeypatch):
    stage, sdk = setup(tmp_path)
    image(sdk / 'a.dll'); image(sdk / 'b.dll')
    imports(monkeypatch, {'app.exe':['a.dll'], 'a.dll':['b.dll'], 'b.dll':['a.dll']})
    plan = planner.plan_dependencies(stage, Path('unused'), [sdk])
    assert len(plan['sources']) == 2


def test_missing_transitive_dependency_does_not_modify_stage(tmp_path, monkeypatch):
    stage, sdk = setup(tmp_path); image(sdk / 'solver.dll')
    imports(monkeypatch, {'app.exe':['solver.dll'], 'solver.dll':['missing.dll']})
    with pytest.raises(ValueError, match='solver.dll -> missing.dll'):
        planner.plan_dependencies(stage, Path('unused'), [sdk])
    assert len(list(stage.iterdir())) == 1


@pytest.mark.parametrize('identical', [True, False])
def test_same_name_candidates_require_identical_content(tmp_path, monkeypatch, identical):
    stage, sdk = setup(tmp_path)
    other = tmp_path / 'other'; other.mkdir()
    image(sdk / 'solver.dll'); image(other / 'solver.dll')
    if not identical:
        with (other / 'solver.dll').open('ab') as stream: stream.write(b'different version')
    imports(monkeypatch, {'app.exe':['solver.dll'], 'solver.dll':[]})
    if identical:
        plan = planner.plan_dependencies(stage, Path('unused'), [sdk, other, sdk])
        assert len(plan['sources']) == 1
        assert len(plan['dependency_roots']) == 2
    else:
        with pytest.raises(ValueError, match='Conflicting SDK dependency basename'):
            planner.plan_dependencies(stage, Path('unused'), [sdk, other])


def test_wrong_architecture_source_rejected(tmp_path, monkeypatch):
    stage, sdk = setup(tmp_path); image(sdk / 'solver.dll', 0x14c, 0x10b)
    imports(monkeypatch, {'app.exe':['solver.dll']})
    with pytest.raises(ValueError, match='AMD64'):
        planner.plan_dependencies(stage, Path('unused'), [sdk])


def test_source_changes_during_analysis_rejected(tmp_path, monkeypatch):
    stage, sdk = setup(tmp_path); image(sdk / 'solver.dll')
    def changed(path, tool):
        if path.name == 'app.exe': return ['solver.dll']
        with path.open('ab') as stream: stream.write(b'changed')
        return []
    monkeypatch.setattr(planner, 'dump_imports', changed)
    with pytest.raises(ValueError, match='changed during dependency planning'):
        planner.plan_dependencies(stage, Path('unused'), [sdk])


@pytest.mark.parametrize('cuda', [True, False])
def test_driver_is_explicit_external_requirement(tmp_path, monkeypatch, cuda):
    stage, sdk = setup(tmp_path)
    imports(monkeypatch, {'app.exe':['nvcuda.dll']})
    if cuda:
        assert planner.plan_dependencies(stage, Path('unused'), [sdk], True)['sources'] == []
    else:
        with pytest.raises(ValueError, match='Missing SDK dependency'):
            planner.plan_dependencies(stage, Path('unused'), [sdk])


def test_no_implicit_path_search(tmp_path, monkeypatch):
    stage, sdk = setup(tmp_path); image(sdk / 'solver.dll')
    monkeypatch.setenv('PATH', str(sdk))
    imports(monkeypatch, {'app.exe':['solver.dll']})
    with pytest.raises(ValueError, match='Missing SDK dependency'):
        planner.plan_dependencies(stage, Path('unused'), [])


def test_cli_failure_does_not_write_plan(tmp_path):
    stage, sdk = setup(tmp_path)
    result = subprocess.run([sys.executable,str(ROOT/'scripts/windows/plan_pe_dependencies.py'),
        '--bin',str(stage),'--dumpbin',str(tmp_path/'missing.exe'),'--output',str(tmp_path/'plan.json')],
        capture_output=True,text=True,timeout=20)
    assert result.returncode == 1
    assert not (tmp_path/'plan.json').exists()


@pytest.mark.parametrize('case', ['valid', 'redist_missing', 'extra_missing', 'cuda_missing'])
def test_powershell_explicit_root_selection(tmp_path, case):
    import json, shutil
    tool = shutil.which('pwsh') or shutil.which('powershell')
    if not tool: pytest.skip('PowerShell required')
    redist = tmp_path/'redist'
    crt = redist/'x64/Microsoft.VC143.CRT'; crt.mkdir(parents=True)
    (redist/'x86/Microsoft.VC143.CRT').mkdir(parents=True)
    (redist/'x64/unrelated').mkdir(parents=True)
    cuda = tmp_path/'cuda/bin'; cuda.mkdir(parents=True)
    (cuda/'nvcc.exe').write_bytes(b'path fixture only')
    (cuda/'x64').mkdir()
    extra = tmp_path/'extra'; extra.mkdir()
    driver = tmp_path/'driver.ps1'
    driver.write_text(r'''param($Installer,$Redist,$Compiler,$Extra)
$ErrorActionPreference='Stop'
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($Installer,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$fn=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-MsiDependencyRoots'},$true)
Invoke-Expression $fn.Extent.Text
@{cpu=@(Get-MsiDependencyRoots -RedistRoot $Redist -ExtraRoots @($Extra)); gpu=@(Get-MsiDependencyRoots -RedistRoot $Redist -CudaCompiler $Compiler -ExtraRoots @($Extra) -Cuda)} | ConvertTo-Json -Compress
''',encoding='utf-8')
    redist_arg = redist if case != 'redist_missing' else tmp_path/'missing-redist'
    compiler_arg = cuda/'nvcc.exe' if case != 'cuda_missing' else tmp_path/'missing-nvcc.exe'
    extra_arg = extra if case != 'extra_missing' else tmp_path/'missing-extra'
    result=subprocess.run([tool,'-NoProfile','-File',str(driver),str(ROOT/'scripts/windows/build_windows_msi.ps1'),str(redist_arg),str(compiler_arg),str(extra_arg)],capture_output=True,text=True,timeout=20)
    if case != 'valid':
        assert result.returncode != 0
        assert 'missing' in result.stderr.lower() or 'required' in result.stderr.lower()
        return
    assert result.returncode == 0, result.stderr
    data=json.loads(result.stdout)
    assert {Path(p) for p in data['cpu']} == {crt, extra}
    assert {Path(p) for p in data['gpu']} == {crt, extra, cuda, cuda/'x64'}


@pytest.mark.parametrize('case', ['valid', 'source_changed', 'staged_changed'])
def test_powershell_checks_frozen_plan_before_copy(tmp_path, case):
    import json, shutil
    tool=shutil.which('pwsh') or shutil.which('powershell')
    if not tool: pytest.skip('PowerShell required')
    stage,sdk=setup(tmp_path)
    source=image(sdk/'solver.dll')
    plan={'sources':[{'name':'solver.dll','source':str(source),'sha256':planner.file_sha256(source)}],
          'staged_images':{'app.exe':planner.file_sha256(stage/'app.exe')}}
    if case == 'source_changed': source.write_bytes(source.read_bytes()+b'changed')
    if case == 'staged_changed': (stage/'app.exe').write_bytes(b'changed')
    plan_path=tmp_path/'plan.json'; plan_path.write_text(json.dumps(plan))
    driver=tmp_path/'copy.ps1'
    driver.write_text(r'''param($Installer,$Plan,$Bin)
$ErrorActionPreference='Stop'
$peDependencyPlan=Get-Content -LiteralPath $Plan -Raw | ConvertFrom-Json
$binDir=$Bin; $runtimeDllInventory=@()
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($Installer,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$fn=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Copy-RuntimeDllSet'},$true)
Invoke-Expression $fn.Extent.Text
$text=Get-Content -LiteralPath $Installer -Raw
$start=$text.IndexOf('  foreach ($entry in $peDependencyPlan.staged_images')
$end=$text.IndexOf('  $peAuditPath = ', $start)
if ($start -lt 0 -or $end -le $start) { throw 'Frozen plan check missing' }
Invoke-Expression $text.Substring($start,$end-$start)
@($runtimeDllInventory) | ConvertTo-Json -Compress
''',encoding='utf-8')
    result=subprocess.run([tool,'-NoProfile','-File',str(driver),str(ROOT/'scripts/windows/build_windows_msi.ps1'),str(plan_path),str(stage)],capture_output=True,text=True,timeout=20)
    if case == 'valid':
        assert result.returncode == 0, result.stderr
        assert planner.file_sha256(stage/'solver.dll') == plan['sources'][0]['sha256']
    else:
        assert result.returncode != 0
        assert 'changed' in result.stderr
        assert not (stage/'solver.dll').exists()


@pytest.mark.parametrize('cuda,staged', [(False,False),(False,True),(True,True),(True,False)])
def test_nvidia_driver_cannot_be_bundled_or_sourced(tmp_path, monkeypatch, cuda, staged):
    stage,sdk=setup(tmp_path)
    image((stage if staged else sdk)/'nvcuda.dll')
    imports(monkeypatch, {'app.exe':['nvcuda.dll'],'nvcuda.dll':[]})
    with pytest.raises(ValueError, match='NVIDIA driver nvcuda.dll must not be bundled'):
        planner.plan_dependencies(stage,Path('unused'),[sdk],cuda)


@pytest.mark.parametrize('identical', [False,True])
def test_staged_sdk_same_name_conflict(tmp_path, monkeypatch, identical):
    stage,sdk=setup(tmp_path)
    image(stage/'solver.dll'); image(sdk/'solver.dll')
    if not identical: (sdk/'solver.dll').write_bytes((sdk/'solver.dll').read_bytes()+b'other SDK version')
    imports(monkeypatch, {'app.exe':['solver.dll'],'solver.dll':[]})
    if identical:
        assert planner.plan_dependencies(stage,Path('unused'),[sdk])['sources'] == []
    else:
        with pytest.raises(ValueError,match='Conflicting staged/SDK dependency basename'):
            planner.plan_dependencies(stage,Path('unused'),[sdk])
