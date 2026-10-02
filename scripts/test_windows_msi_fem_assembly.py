"""Execute native FEM MSI assembly control flow without compiler or solver runs."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / 'scripts/windows/native_fem_package.ps1'
INSTALLER = ROOT / 'scripts/windows/build_windows_msi.ps1'
POWERSHELL = shutil.which('pwsh') or shutil.which('powershell')
pytestmark = pytest.mark.skipif(os.name != 'nt' or not POWERSHELL, reason='Windows PowerShell required')


def run_driver(tmp_path, text, *arguments, tool=None):
    driver = tmp_path/'driver.ps1'
    driver.write_text("param($Module,$Fixture,$Case)\n$ErrorActionPreference='Stop'\n. $Module\n"+text, encoding='utf-8')
    result = subprocess.run([tool or POWERSHELL, '-NoProfile', '-File', str(driver), str(MODULE), str(tmp_path), *map(str, arguments)],
                            capture_output=True, text=True, errors='replace', timeout=25)
    return result


@pytest.mark.parametrize('mode,cuda,profile,features', [
    ('none',False,'windows-msi-cpu',[]), ('none',True,'windows-msi-gpu',['cuda']),
    ('cpu',False,'windows-msi-fem-cpu',['fem-gpu']),
    ('cpu',True,'windows-msi-fem-cpu-cuda',['cuda','fem-gpu']),
    ('gpu',True,'windows-msi-fem-gpu',['cuda','fem-gpu']),
])
def test_build_modes_are_explicit_and_use_separate_profiles(tmp_path,mode,cuda,profile,features):
    result = run_driver(tmp_path, f'''
Get-FullmagMsiBuildPlan -FemMode '{mode}' -Cuda:${str(cuda).lower()} -DependencyPrefix $Fixture | ConvertTo-Json -Compress
''')
    assert result.returncode == 0, result.stderr
    data=json.loads(result.stdout)
    assert data['storage_profile'] == profile and data['features'] == features
    assert data['fem_enabled'] == (mode != 'none') and data['fem_cuda'] == (mode == 'gpu')


@pytest.mark.parametrize('case,expected', [
    ('invalid_mode','mode must be'), ('gpu_without_cuda','requires FULLMAG_WINDOWS_MSI_CUDA'),
    ('missing_prefix','absolute existing'), ('relative_prefix','absolute existing'),
    ('prefix_file','absolute existing'), ('prebuilt','remove FULLMAG_FEM_LIB_DIR'),
])
def test_unconfigured_or_incompatible_fem_cannot_degrade_to_fdm(tmp_path,case,expected):
    result=run_driver(tmp_path, '''
$mode=if ($Case -eq 'invalid_mode') {'auto'} elseif ($Case -eq 'gpu_without_cuda') {'gpu'} else {'cpu'}
$prefix=if ($Case -eq 'missing_prefix') {''} elseif ($Case -eq 'relative_prefix') {'.'} elseif ($Case -eq 'prefix_file') {$Module} else {$Fixture}
$prebuilt=if ($Case -eq 'prebuilt') {$Fixture} else {''}
Get-FullmagMsiBuildPlan -FemMode $mode -DependencyPrefix $prefix -PrebuiltFemDirectory $prebuilt
''',case)
    assert result.returncode != 0 and expected in result.stderr


@pytest.mark.parametrize('case', ['release','flat','missing','ambiguous','dll_only','lib_only','empty','directory'])
def test_fem_output_requires_current_profile_dll_and_import_library_pair(tmp_path,case):
    root=tmp_path/'backends/fem'
    for sub in (['Release','.'] if case=='ambiguous' else ['.'] if case=='flat' else ['Release']):
        directory=root/sub; directory.mkdir(parents=True,exist_ok=True)
        for suffix in ['dll','lib']:
            path=directory/f'fullmag_fem.{suffix}'
            if case=='missing' or case==('dll_only' if suffix=='lib' else 'lib_only'): continue
            if case=='directory' and suffix=='dll': path.mkdir()
            else: path.write_bytes(b'' if case=='empty' else b'path fixture, not a native image')
    result=run_driver(tmp_path,'Find-FullmagMsiFemOutput -BuildRoot $Fixture | ConvertTo-Json -Compress',case)
    if case in ('release','flat'):
        assert result.returncode == 0, result.stderr
        data=json.loads(result.stdout)
        expected=root/('Release' if case=='release' else '.')
        assert Path(data['directory']) == expected
        assert Path(data['dll']) == expected/'fullmag_fem.dll'
        assert Path(data['import_library']) == expected/'fullmag_fem.lib'
    else:
        assert result.returncode != 0 and ('pair' in result.stderr)


@pytest.mark.parametrize('case', ['cpu','gpu','configure_failure','build_failure','slepc_override','slepc_off_gpu','config_changed','modal_changed'])
def test_native_build_invokes_only_production_target_and_preserves_failures(tmp_path,case):
    result=run_driver(tmp_path, '''
$script:calls=@()
$env:FULLMAG_CMAKE='fixture-cmake'
$env:FULLMAG_CUDA_ARCHITECTURES='89'
$env:FULLMAG_FEM_WITH_SLEPC=if ($Case -in @('slepc_override','modal_changed')) {'ON'} elseif ($Case -eq 'slepc_off_gpu') {'OFF'} else {$null}
[System.IO.File]::WriteAllText((Join-Path $Fixture 'MFEMConfig.cmake'),'provider config fixture')
function fixture-cmake {
  $script:calls+=,@($args)
  Write-Output 'CMake output fixture'
  $global:LASTEXITCODE=if (($Case -eq 'configure_failure' -and $args[0] -eq '-S') -or
    ($Case -eq 'build_failure' -and $args[0] -eq '--build')) {19} else {0}
  if ($args[0] -eq '-S' -and $global:LASTEXITCODE -eq 0) {
    $build=Join-Path $Fixture 'build'; New-Item -ItemType Directory -Force $build | Out-Null
    $config=Join-Path $Fixture 'ModalConfig.cmake'; $library=Join-Path $Fixture 'modal.lib'
    [System.IO.File]::WriteAllText($config,'modal config fixture')
    [System.IO.File]::WriteAllBytes($library,[byte[]](3,4))
    @("FULLMAG_WINDOWS_MODAL_PROVIDER_RECEIPT_SCHEMA:INTERNAL=fullmag.windows.modal-provider.v1",
      "FULLMAG_WINDOWS_MODAL_PROVIDER_PROFILE:INTERNAL=Release",
      "FULLMAG_WINDOWS_MODAL_PROVIDER_RECEIPT_FILES:INTERNAL=$config;$library",
      "FULLMAG_WINDOWS_MODAL_PROVIDER_RECEIPT_CONFIGS:INTERNAL=$config",
      "FULLMAG_WINDOWS_MODAL_PROVIDER_RECEIPT_TARGETS:INTERNAL=MPI::MPI_CXX;PETSC::petsc;SLEPC::slepc") |
      Set-Content (Join-Path $build 'CMakeCache.txt')
  }
  if ($args[0] -eq '--build' -and $global:LASTEXITCODE -eq 0) {
    $dir=Join-Path $Fixture 'build/backends/fem/Release'; New-Item -ItemType Directory -Force $dir | Out-Null
    foreach ($ext in @('dll','lib')) { [System.IO.File]::WriteAllBytes((Join-Path $dir "fullmag_fem.$ext"),[byte[]](1,2)) }
    if ($Case -eq 'config_changed') { [System.IO.File]::WriteAllText((Join-Path $Fixture 'MFEMConfig.cmake'),'changed config') }
    if ($Case -eq 'modal_changed') { [System.IO.File]::WriteAllBytes((Join-Path $Fixture 'modal.lib'),[byte[]](9,10)) }
  }
}
$gpu=$Case -in @('gpu','slepc_off_gpu')
$plan=Get-FullmagMsiBuildPlan -FemMode $(if ($gpu) {'gpu'} else {'cpu'}) -Cuda:$gpu -DependencyPrefix $Fixture
try {
  $output=Invoke-FullmagMsiFemBuild -Plan $plan -RepoRoot $Fixture -BuildRoot (Join-Path $Fixture 'build')
  'FM_JSON='+(@{calls=$script:calls; output=$output; error=$null} | ConvertTo-Json -Depth 8 -Compress)
} catch {
  'FM_JSON='+(@{calls=$script:calls; error=$_.Exception.Message} | ConvertTo-Json -Depth 8 -Compress)
}
''',case)
    assert result.returncode == 0, result.stderr
    data=json.loads(next(line.removeprefix('FM_JSON=') for line in result.stdout.splitlines() if line.startswith('FM_JSON=')))
    calls=data['calls']; configure=calls[0]
    assert f'-DFULLMAG_FEM_REQUIRE_GPU={"ON" if case in ("gpu","slepc_off_gpu") else "OFF"}' in configure
    assert f'-DFULLMAG_ENABLE_CUDA={"ON" if case in ("gpu","slepc_off_gpu") else "OFF"}' in configure
    assert f'-DFULLMAG_FEM_WITH_SLEPC={"ON" if case in ("gpu","slepc_override","modal_changed") else "OFF"}' in configure
    assert f'-DFULLMAG_FEM_DEPENDENCY_PREFIX={tmp_path}' in configure
    assert '-DCMAKE_CUDA_ARCHITECTURES=89' in configure
    if case=='configure_failure':
        assert len(calls)==1 and 'configure failed' in data['error']
    else:
        assert calls[1]==['--build',str(tmp_path/'build'),'--config','Release','--target','fullmag_fem']
        if case=='build_failure': assert 'build failed' in data['error']
        elif case=='config_changed': assert 'config changed during build' in data['error']
        elif case=='modal_changed': assert 'input changed after configure' in data['error']
        else:
            assert isinstance(data['output'],dict) and data['error'] is None
            for key,file in [('dll_sha256','dll'),('import_library_sha256','import_library'),('provider_config_sha256','provider_config')]:
                assert data['output'][key] == hashlib.sha256(Path(data['output'][file]).read_bytes()).hexdigest()
            inventory=data['output']['modal_provider']
            assert inventory['enabled'] == (case in ('gpu','slepc_override'))
            if inventory['enabled']:
                for item in inventory['files']:
                    assert item['sha256'] == hashlib.sha256(Path(item['path']).read_bytes()).hexdigest()


@pytest.mark.parametrize('case', ['valid','disabled_stale','no_cache','no_field','duplicate_field','schema','profile',
                                 'empty_files','missing_target','omitted_config','empty_library','outside_prefix','mutated','deleted'])
def test_modal_inventory_requires_pinned_inputs_and_rejects_changes(tmp_path,case):
    build=tmp_path/'build'; build.mkdir()
    config=tmp_path/'ModalConfig.cmake'; config.write_bytes(b'config fixture')
    library=tmp_path/'modal.lib'; library.write_bytes(b'' if case=='empty_library' else b'library fixture')
    outside=tmp_path.parent/'outside-modal.lib'
    if case=='outside_prefix':
        outside.write_bytes(b'outside SDK fixture'); library=outside
    values={
        'SCHEMA': 'wrong.v1' if case=='schema' else 'fullmag.windows.modal-provider.v1',
        'PROFILE':'Debug' if case=='profile' else 'Release',
        'FILES':'' if case=='empty_files' else str(library) if case=='omitted_config' else f'{config};{library}',
        'CONFIGS':str(config),
        'TARGETS':'MPI::MPI_CXX;PETSC::petsc' if case=='missing_target' else 'MPI::MPI_CXX;PETSC::petsc;SLEPC::slepc',
    }
    entries=[]
    for field,value in values.items():
        if case=='no_field' and field=='FILES': continue
        key='FULLMAG_WINDOWS_MODAL_PROVIDER_'+('PROFILE' if field=='PROFILE' else 'RECEIPT_'+field)
        entries.append(f'{key}:INTERNAL={value}')
    if case=='duplicate_field': entries.append(entries[0])
    if case!='no_cache': (build/'CMakeCache.txt').write_text('\n'.join(entries)+'\n')
    result=run_driver(tmp_path, '''
$inventory=Get-FullmagMsiModalProviderInventory -BuildRoot (Join-Path $Fixture 'build') -DependencyPrefix $Fixture -Enabled:($Case -ne 'disabled_stale')
if ($Case -eq 'mutated') { [System.IO.File]::WriteAllText((Join-Path $Fixture 'modal.lib'),'changed') }
if ($Case -eq 'deleted') { Remove-Item -LiteralPath (Join-Path $Fixture 'modal.lib') }
Assert-FullmagMsiModalProviderInventory -Inventory $inventory
$inventory | ConvertTo-Json -Depth 8 -Compress
''',case)
    assert (result.returncode==0) == (case in ('valid','disabled_stale')),result.stderr
    if case=='valid':
        data=json.loads(result.stdout)
        assert data['enabled'] is True and data['profile']=='Release' and len(data['files'])==2
    elif case=='disabled_stale': assert json.loads(result.stdout)=={'enabled':False}


@pytest.mark.parametrize('payload,accepted', [
    ('not JSON',False), ('null',False), ('[]',False), ('{}',False),
    ('{"native_fem_cpu_available":false,"native_fem_gpu_available":false}',False),
    ('[{"native_fem_cpu_available":true,"native_fem_gpu_available":false}]',False),
    ('{"native_fem_cpu_available":true,"native_fem_gpu_available":false}',True),
])
def test_probe_payload_must_be_valid_object_with_available_cpu(tmp_path,payload,accepted):
    (tmp_path/'probe.json').write_text(payload)
    result=run_driver(tmp_path, '''
$plan=Get-FullmagMsiBuildPlan -FemMode cpu -DependencyPrefix $Fixture
$text=Get-Content -LiteralPath (Join-Path $Fixture 'probe.json') -Raw
Convert-FullmagMsiFemAvailability -Plan $plan -JsonOutput $text
''')
    assert (result.returncode==0)==accepted,result.stderr


def test_fdm_only_does_not_link_or_publish_inherited_fem_runtime(tmp_path):
    result=run_driver(tmp_path, '''
$plan=Get-FullmagMsiBuildPlan -FemMode none -PrebuiltFemDirectory $Fixture
if ($plan.features -contains 'fem-gpu') { throw 'Unexpected FEM feature' }
$out=Invoke-FullmagMsiFemBuild -Plan $plan -RepoRoot $Fixture -BuildRoot (Join-Path $Fixture 'build')
if ($null -ne $out) { throw 'Unexpected FEM build output' }
Write-FullmagMsiFemRuntimeManifests -Plan $plan -RuntimesRoot (Join-Path $Fixture 'runtimes') -Version '0.1.0'
if (Test-Path (Join-Path $Fixture 'runtimes')) { throw 'Unexpected FEM manifests' }
''')
    assert result.returncode==0,result.stderr


@pytest.mark.parametrize('case', ['cpu','gpu_no_device','unavailable','missing','cpu_gpu_mismatch'])
def test_availability_probe_is_required_but_not_a_gpu_execution_claim(tmp_path,case):
    result=run_driver(tmp_path, '''
$plan=Get-FullmagMsiBuildPlan -FemMode $(if ($Case -eq 'gpu_no_device') {'gpu'} else {'cpu'}) -Cuda:($Case -eq 'gpu_no_device') -DependencyPrefix $Fixture
$status=[pscustomobject]@{native_fem_cpu_available=($Case -ne 'unavailable'); native_fem_gpu_available=($Case -eq 'cpu_gpu_mismatch')}
if ($Case -eq 'missing') { $status.native_fem_cpu_available=$null }
Assert-FullmagMsiFemAvailability -Plan $plan -Status $status
''',case)
    assert (result.returncode==0) == (case in ('cpu','gpu_no_device')),result.stderr


@pytest.mark.parametrize('mode', ['none','cpu','gpu'])
def test_fem_manifests_and_sdk_roots_follow_actual_assembly_scope(tmp_path,mode):
    for sub in ('bin','lib'): (tmp_path/sub).mkdir()
    result=run_driver(tmp_path, f'''
$plan=Get-FullmagMsiBuildPlan -FemMode '{mode}' -Cuda:('{mode}' -eq 'gpu') -DependencyPrefix $Fixture
$root=Join-Path $Fixture 'runtimes'
Write-FullmagMsiFemRuntimeManifests -Plan $plan -RuntimesRoot $root -Version '0.1.0'
@{{roots=@(Get-FullmagMsiFemDependencyRoots -Plan $plan); files=@(Get-ChildItem $root -Filter manifest.json -Recurse -ErrorAction SilentlyContinue | ForEach-Object {{ Get-Content $_.FullName -Raw | ConvertFrom-Json }})}} | ConvertTo-Json -Depth 8 -Compress
''')
    assert result.returncode == 0,result.stderr
    data=json.loads(result.stdout)
    assert {Path(p) for p in data['roots']} == (set() if mode=='none' else {tmp_path,tmp_path/'bin',tmp_path/'lib'})
    assert [f['family'] for f in data['files']] == ([] if mode=='none' else ['fem-cpu-native'] if mode=='cpu' else ['fem-cpu-native','fem-gpu'])
    for file in data['files']:
        assert file['worker']=='../../bin/fullmag-bin.exe'
        assert file['engines'][0]['public'] is False and file['engines'][0]['stability']=='experimental'


def test_packager_uses_same_features_for_cli_api_and_stages_fem_before_probe():
    text=INSTALLER.read_text(encoding='utf-8')
    assert text.count('($BuildFeatures -join ",")')==2
    assert text.index('$nativeFemOutput = Invoke-FullmagMsiFemBuild') < text.index('& cargo @launcherBuildArgs')
    assert '$env:FULLMAG_FEM_LIB_DIR = $nativeFemOutput.directory' in text
    assert '$runtimeDllSources += $nativeFemOutput.dll' in text
    assert text.index('$peDependencyAudit = Get-Content') < text.index('runtime fem-availability --json')
    assert 'qualification="not_verified"' in text


def test_native_ci_uses_operator_prefixes_and_explicit_fem_cuda_inputs():
    import yaml
    workflow=yaml.load((ROOT/'.github/workflows/windows-msi-container.yml').read_text(),Loader=yaml.BaseLoader)
    inputs=workflow['on']['workflow_dispatch']['inputs']
    assert inputs['fem_mode']['default']=='cpu' and inputs['fem_mode']['options']==['cpu','gpu','none']
    assert inputs['cuda']['default']=='false'
    env=workflow['jobs']['build-windows-msi']['env']
    assert env['FULLMAG_FEM_DEPENDENCY_PREFIX']=='${{ vars.FULLMAG_WINDOWS_FEM_CPU_PREFIX }}'
    assert env['FULLMAG_WINDOWS_FEM_GPU_PREFIX']=='${{ vars.FULLMAG_WINDOWS_FEM_GPU_PREFIX }}'
    assert 'native/**' in workflow['on']['push']['paths'] and 'backends/**' in workflow['on']['push']['paths']


@pytest.mark.parametrize('engine', ['pwsh','powershell'])
def test_json_manifests_are_utf8_without_bom_on_both_windows_shells(tmp_path,engine):
    tool=shutil.which(engine)
    if not tool: pytest.skip(f'{engine} unavailable')
    result=run_driver(tmp_path, '''
$RepoRoot=(Resolve-Path (Join-Path (Split-Path $Module -Parent) '../..')).Path
$installer=Join-Path $RepoRoot 'scripts/windows/build_windows_msi.ps1'
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($installer,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($name in @('Ensure-Dir','Write-VersionMetadata','Write-StageManifest','Write-RuntimeManifests')) {
  $fn=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
  Invoke-Expression $fn.Extent.Text
}
$BuildCuda=$true; $BuildPlan=Get-FullmagMsiBuildPlan -FemMode gpu -Cuda -DependencyPrefix $Fixture
$BuildFeatures=$BuildPlan.features; $ProductVersion='0.1.0'; $StageRoot='fixture-stage'
$sourceIdentity=@{fixture=$true}; $runtimeDllInventory=@(); $nativeFemAssembly=$null
$peDependencyAudit=@{images=@()}; $peDependencyPlan=@{sources=@()}
$nodeRuntimeInventory=@{schema_version=1; kind='bundled-windows-x64-node'; version='v24.19.0'; files=@(@{path='bin/node.exe';sha256='fixture-node-hash'})}
$pythonPackageInventory=@{schema_version=1;scope='locked-windows-python-packages';requirements_sha256='fixture-requirements-hash';qualification='not_verified'}
$pythonRuntimeInventory=@{kind='bundled-windows-x64-cpython-embed';host=@{version=@(3,12,10)};qualification='not_verified'}
$pythonPeDependencyAudit=@{scope='python_flat_pe_static_and_delay_imports';images=@()}
Write-RuntimeManifests -RuntimesRoot (Join-Path $Fixture 'runtimes')
Write-VersionMetadata -Path (Join-Path $Fixture 'version.json')
Write-StageManifest -Path (Join-Path $Fixture 'stage.json')
''',tool=tool)
    assert result.returncode==0,result.stderr
    files=sorted(tmp_path.rglob('*.json'))
    assert len(files)==6
    for file in files:
        data=file.read_bytes()
        assert not data.startswith(b'\xef\xbb\xbf'),file
        assert isinstance(json.loads(data.decode('utf-8')),dict)
    for name in ('version.json', 'stage.json'):
        payload=json.loads((tmp_path/name).read_text(encoding='utf-8'))
        assert payload['node_runtime']['version']=='v24.19.0'
        assert payload['node_runtime']['files'][0]['sha256']=='fixture-node-hash'
        assert payload['python_packages']['requirements_sha256']=='fixture-requirements-hash'
        assert payload['python_packages']['qualification']=='not_verified'
        assert payload['python_runtime']['host']['version']==[3,12,10]
        assert payload['python_pe_dependency_audit']['scope']=='python_flat_pe_static_and_delay_imports'
    stage=json.loads((tmp_path/'stage.json').read_text(encoding='utf-8'))
    assert 'bin/node.exe' in stage['bin']
    assert 'share/licenses/node-LICENSE.txt' in stage['share']
    assert 'share/licenses/python-LICENSE.txt' in stage['share']
