"""Exercise Windows MFEM provider selection with CMake LANGUAGES NONE."""
from pathlib import Path
import shutil
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT/'native/cmake/FindFullmagMfem.cmake'


def fixture(prefix, *, shared=False, cuda=False, double=True, location=None, config='Release'):
    package = prefix/'lib/cmake/mfem'; package.mkdir(parents=True)
    library = location or prefix/('bin/mfem.dll' if shared else 'lib/mfem.lib')
    library.parent.mkdir(parents=True,exist_ok=True); library.write_bytes(b'library path fixture, not a binary')
    implib = prefix/'lib/mfem.lib'
    if shared: implib.parent.mkdir(parents=True,exist_ok=True); implib.write_bytes(b'import library fixture')
    props = f'IMPORTED_LOCATION_{config.upper()} "{library.as_posix()}"'
    if shared: props += f' IMPORTED_IMPLIB_{config.upper()} "{implib.as_posix()}"'
    (package/'MFEMConfig.cmake').write_text(f'''set(MFEM_USE_DOUBLE {'ON' if double else 'OFF'})
set(MFEM_USE_SINGLE {'OFF' if double else 'ON'})
set(MFEM_USE_CUDA {'ON' if cuda else 'OFF'})
add_library(mfem {'SHARED' if shared else 'STATIC'} IMPORTED GLOBAL)
set_target_properties(mfem PROPERTIES {props})
''',encoding='utf-8')
    return package, library, implib


def configure(tmp_path, prefix, *, windows=True, cuda=False, msvc=True, bits=8, extra=''):
    cmake=shutil.which('cmake')
    if not cmake: pytest.skip('CMake required')
    source=tmp_path/'source'; source.mkdir()
    (source/'CMakeLists.txt').write_text(f'''cmake_minimum_required(VERSION 3.18)
project(provider LANGUAGES NONE)
set(WIN32 {'ON' if windows else 'OFF'})
set(MSVC {'ON' if msvc else 'OFF'})
set(CMAKE_SIZEOF_VOID_P {bits})
set(CMAKE_BUILD_TYPE Release)
set(FULLMAG_ENABLE_CUDA {'ON' if cuda else 'OFF'})
set(FULLMAG_FEM_DEPENDENCY_PREFIX "{prefix.as_posix()}")
{extra}
include("{MODULE.as_posix()}")
fullmag_find_mfem()
''',encoding='utf-8')
    return subprocess.run([cmake,'-S',str(source),'-B',str(tmp_path/'configure')],capture_output=True,text=True,errors='replace',timeout=30)


@pytest.mark.parametrize('shared,cuda', [(False,False),(True,False),(False,True),(True,True)])
def test_pinned_static_or_shared_provider(tmp_path, shared, cuda):
    prefix=tmp_path/'sdk'; fixture(prefix,shared=shared,cuda=cuda)
    result=configure(tmp_path,prefix,cuda=cuda)
    assert result.returncode == 0, result.stdout+result.stderr


def test_no_ambient_or_cached_mfem_fallback(tmp_path):
    prefix=tmp_path/'sdk'; prefix.mkdir()
    ambient=tmp_path/'ambient'; package,*_=fixture(ambient)
    result=configure(tmp_path,prefix,extra=f'set(MFEM_DIR "{package.as_posix()}" CACHE PATH "ambient")')
    assert result.returncode != 0
    assert 'exactly one MFEMConfig.cmake' in result.stderr


def test_pinned_config_overrides_stale_cache(tmp_path):
    prefix=tmp_path/'sdk'; fixture(prefix)
    ambient=tmp_path/'ambient'; package,*_=fixture(ambient,cuda=True)
    result=configure(tmp_path,prefix,extra=f'set(MFEM_DIR "{package.as_posix()}" CACHE PATH "ambient")')
    assert result.returncode == 0, result.stdout+result.stderr


def test_ambiguous_configs_rejected(tmp_path):
    prefix=tmp_path/'sdk'; package,*_=fixture(prefix)
    shutil.copy2(package/'MFEMConfig.cmake',prefix/'MFEMConfig.cmake')
    result=configure(tmp_path,prefix)
    assert result.returncode != 0
    assert 'exactly one MFEMConfig.cmake' in result.stderr


@pytest.mark.parametrize('cuda_provider,cuda_request', [(False,True),(True,False)])
def test_cpu_gpu_provider_mismatch_rejected(tmp_path,cuda_provider,cuda_request):
    prefix=tmp_path/'sdk'; fixture(prefix,cuda=cuda_provider)
    result=configure(tmp_path,prefix,cuda=cuda_request)
    assert result.returncode != 0
    assert 'CUDA configuration differs' in result.stderr


def test_single_precision_provider_rejected(tmp_path):
    prefix=tmp_path/'sdk'; fixture(prefix,double=False)
    result=configure(tmp_path,prefix)
    assert result.returncode != 0
    assert 'must use double precision' in result.stderr


@pytest.mark.parametrize('case', ['outside','linux','empty','missing','debug_only','missing_implib'])
def test_wrong_or_missing_library_rejected(tmp_path,case):
    prefix=tmp_path/'sdk'
    location=tmp_path/'outside/mfem.lib' if case=='outside' else prefix/'lib/mfem.so' if case=='linux' else None
    package,library,implib=fixture(prefix,location=location,config='Debug' if case=='debug_only' else 'Release',shared=case=='missing_implib')
    if case=='empty': library.write_bytes(b'')
    if case=='missing': library.unlink()
    if case=='missing_implib': implib.unlink()
    result=configure(tmp_path,prefix)
    assert result.returncode != 0
    assert 'Windows MFEM' in result.stderr


@pytest.mark.parametrize('msvc,bits', [(False,8),(True,4)])
def test_wrong_target_rejected(tmp_path,msvc,bits):
    prefix=tmp_path/'sdk'; fixture(prefix)
    result=configure(tmp_path,prefix,msvc=msvc,bits=bits)
    assert result.returncode != 0
    assert 'x64 MSVC target' in result.stderr


def test_preexisting_target_rejected(tmp_path):
    prefix=tmp_path/'sdk'; fixture(prefix)
    result=configure(tmp_path,prefix,extra='add_library(mfem INTERFACE IMPORTED GLOBAL)')
    assert result.returncode != 0
    assert 'already defined' in result.stderr


def test_linux_discovery_unchanged(tmp_path):
    prefix=tmp_path/'sdk'; package,*_=fixture(prefix)
    result=configure(tmp_path,Path(''),windows=False,extra=f'set(MFEM_DIR "{package.as_posix()}")')
    assert result.returncode == 0, result.stdout+result.stderr


def test_cargo_tracks_and_forwards_provider_prefix():
    fem=(ROOT/'crates/fullmag-fem-sys/build.rs').read_text()
    fdm=(ROOT/'crates/fullmag-fdm-sys/build.rs').read_text()
    assert 'cargo:rerun-if-env-changed=FULLMAG_FEM_DEPENDENCY_PREFIX' in fem
    assert '-DFULLMAG_FEM_DEPENDENCY_PREFIX={prefix}' in fem
    assert 'std::env::var("FULLMAG_FEM_DEPENDENCY_PREFIX").unwrap_or_default()' in fem
    assert 'FindFullmagMfem.cmake' in fem and 'FindFullmagMfem.cmake' in fdm
    backend=(ROOT/'backends/fem/CMakeLists.txt').read_text()
    assert 'fullmag_find_mfem()' in backend


def test_package_redirect_cannot_override_pinned_config(tmp_path):
    prefix=tmp_path/'sdk'; package,*_=fixture(prefix)
    redirect=tmp_path/'redirect'; redirect.mkdir()
    shutil.copy2(package/'MFEMConfig.cmake',redirect/'MFEMConfig.cmake')
    result=configure(tmp_path,prefix,extra=f'set(CMAKE_FIND_PACKAGE_REDIRECTS_DIR "{redirect.as_posix()}")')
    assert result.returncode != 0
    assert 'redirected outside the pinned config' in result.stderr


@pytest.mark.parametrize('flag', ['MFEM_USE_DOUBLE','MFEM_USE_SINGLE','MFEM_USE_CUDA'])
@pytest.mark.parametrize('invalid', ['missing','UNKNOWN'])
def test_provider_flags_cannot_be_inferred_from_caller(tmp_path,flag,invalid):
    prefix=tmp_path/'sdk'; package,*_=fixture(prefix)
    path=package/'MFEMConfig.cmake'
    value='ON' if flag=='MFEM_USE_DOUBLE' else 'OFF'
    replacement='# missing capability export' if invalid=='missing' else f'set({flag} UNKNOWN)'
    path.write_text(path.read_text().replace(f'set({flag} {value})',replacement))
    result=configure(tmp_path,prefix,extra=f'set({flag} {value} CACHE BOOL "stale caller")')
    assert result.returncode != 0
    assert f'must export a boolean {flag}' in result.stderr


def test_removed_prefix_clears_cached_provider(tmp_path):
    prefix=tmp_path/'sdk'; fixture(prefix)
    result=configure(tmp_path,prefix)
    assert result.returncode == 0, result.stderr
    path=tmp_path/'source/CMakeLists.txt'
    path.write_text(path.read_text().replace(f'set(FULLMAG_FEM_DEPENDENCY_PREFIX "{prefix.as_posix()}")',''))
    command=[shutil.which('cmake'),'-S',str(tmp_path/'source'),'-B',str(tmp_path/'configure')]
    first=subprocess.run(command+[f'-DFULLMAG_FEM_DEPENDENCY_PREFIX={prefix}'],capture_output=True,text=True,timeout=30)
    assert first.returncode == 0, first.stderr
    removed=subprocess.run(command+['-DFULLMAG_FEM_DEPENDENCY_PREFIX='],capture_output=True,text=True,timeout=30)
    assert removed.returncode != 0
    assert 'requires FULLMAG_FEM_DEPENDENCY_PREFIX' in removed.stderr


def test_multiconfig_requires_explicit_profile_configuration(tmp_path):
    prefix=tmp_path/'sdk'; fixture(prefix)
    result=configure(tmp_path,prefix,extra='set(CMAKE_BUILD_TYPE "")')
    assert result.returncode != 0
    assert 'requires an explicit CMAKE_BUILD_TYPE' in result.stderr
