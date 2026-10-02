"""Interpreted ready-package selection checks; fixture binaries never execute."""
import hashlib
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import managed_fem_runtime_package as package
from local_runner.build_entrypoint import REQUIRED_OUTPUTS
from local_runner.worker_entrypoint import canonical

COMMIT = 'a' * 40
SNAPSHOT = 'b' * 64


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding='utf-8')


def fixture(tmp_path):
    run = tmp_path / 'runs/job-fixture'
    native = {'head_commit_full': COMMIT, 'source_snapshot_sha256': SNAPSHOT, 'source_snapshot_dirty': False}
    context = {'job_id': run.name, 'profile': 'fem-cpu-release', 'source_digest': 'c' * 64,
               'image_digest': 'sha256:' + 'd' * 64, 'native_source_identity': native}
    write_json(run / 'trusted/context.json', context)
    for name in ['build_entrypoint.py', 'worker_entrypoint.py']:
        (run / 'trusted' / name).write_text('trusted fixture', encoding='utf-8')
    journal = {key: context[key] for key in ['job_id', 'profile', 'source_digest', 'image_digest']}
    journal.update(phase='terminal', state='succeeded', exit_code=0,
                   trusted_hashes={path.name: package.artifact_sha256(path) for path in (run / 'trusted').iterdir()})
    write_json(run / 'receipt.json', journal)
    entries = []
    for name in [*REQUIRED_OUTPUTS, 'lib/libfullmag_fem.so', 'lib/libfullmag_fem.so.0',
                 'lib/libfullmag_fem.so.0.1.0']:
        relative = 'outputs/.fullmag/local/' + name
        path = run / 'artifacts' / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'nonexecutable fixture')
        entries.append({'path': relative, 'size': path.stat().st_size, 'sha256': package.artifact_sha256(path)})
    built = dict(context, state='succeeded', qualification='NOT VERIFIED', artifacts=entries,
                 native_source_identity_sha256=hashlib.sha256(canonical(native)).hexdigest(),
                 stages=[{'name': name, 'exit_code': 0} for name in ['native-build', 'frontend-dependencies', 'frontend-build']])
    write_json(run / 'artifacts/build-receipt.json', built)
    return run, journal, context, built


def test_select_ready_package_and_cli_alias(tmp_path):
    run, _, _, _ = fixture(tmp_path)
    binaries, evidence, native, libraries = package.load_package(run, tmp_path, COMMIT, SNAPSHOT,
                                                                ['fullmag', 'fullmag-api'])
    assert binaries['fullmag'].name == 'fullmag-bin'
    assert native['head_commit_full'] == COMMIT
    assert evidence['managed_package']['job_id'] == run.name
    assert libraries == run / 'artifacts/outputs/.fullmag/local/lib'


@pytest.mark.parametrize('case', ['queued', 'failed', 'boolean_exit', 'lane', 'commit', 'snapshot',
                                 'trusted_hash', 'missing_required', 'changed_binary', 'no_library'])
def test_reject_unqualified_package(tmp_path, case):
    run, journal, context, built = fixture(tmp_path)
    if case == 'queued':
        journal['phase'] = 'submitted'
    elif case == 'failed':
        journal['state'] = 'failed'
    elif case == 'boolean_exit':
        journal['exit_code'] = False
    elif case == 'lane':
        journal['profile'] = context['profile'] = 'fem-gpu-release'
        write_json(run / 'trusted/context.json', context)
    elif case == 'trusted_hash':
        journal['trusted_hashes']['build_entrypoint.py'] = 'f' * 64
    elif case == 'missing_required':
        built['artifacts'] = built['artifacts'][1:]
    elif case == 'changed_binary':
        (run / 'artifacts/outputs/.fullmag/local/bin/fullmag-bin').write_bytes(b'changed')
    elif case == 'no_library':
        built['artifacts'] = [entry for entry in built['artifacts'] if '/lib/' not in entry['path']]
    write_json(run / 'receipt.json', journal)
    write_json(run / 'artifacts/build-receipt.json', built)
    with pytest.raises(ValueError):
        package.load_package(run, tmp_path, 'e' * 40 if case == 'commit' else COMMIT,
                             'e' * 64 if case == 'snapshot' else SNAPSHOT, ['fullmag'])


@pytest.mark.parametrize('name', ['../escape', 'fullmag/escape', 'python'])
def test_reject_arbitrary_binary_selection(tmp_path, name):
    run, _, _, _ = fixture(tmp_path)
    with pytest.raises(ValueError, match='binary name'):
        package.load_package(run, tmp_path, COMMIT, SNAPSHOT, [name])


@pytest.mark.parametrize('key', ['source_digest', 'image_digest'])
def test_reject_missing_package_provenance_even_when_records_agree(tmp_path, key):
    run, journal, context, built = fixture(tmp_path)
    for record in (journal, context, built):
        record.pop(key)
    write_json(run / 'trusted/context.json', context)
    journal['trusted_hashes']['context.json'] = package.artifact_sha256(run / 'trusted/context.json')
    write_json(run / 'receipt.json', journal)
    write_json(run / 'artifacts/build-receipt.json', built)
    with pytest.raises(ValueError, match='digests required'):
        package.load_package(run, tmp_path, COMMIT, SNAPSHOT, ['fullmag'])


@pytest.mark.parametrize('case', ['wrong_soname', 'different_alias'])
def test_reject_incompatible_native_library_group(tmp_path, case):
    run, _, _, built = fixture(tmp_path)
    if case == 'wrong_soname':
        built['artifacts'] = [entry for entry in built['artifacts']
                              if not entry['path'].endswith('libfullmag_fem.so.0')]
    else:
        entry = next(entry for entry in built['artifacts']
                     if entry['path'].endswith('libfullmag_fem.so.0'))
        path = run / 'artifacts' / entry['path']
        path.write_bytes(b'other library')
        entry.update(size=path.stat().st_size, sha256=package.artifact_sha256(path))
    write_json(run / 'artifacts/build-receipt.json', built)
    with pytest.raises(ValueError, match='library'):
        package.load_package(run, tmp_path, COMMIT, SNAPSHOT, ['fullmag'])


@pytest.mark.parametrize('case', ['schema', 'project', 'worktree'])
def test_reject_unconfigured_submit_storage_layout(tmp_path, case):
    repo = tmp_path / 'project' / 'checkout'
    repo.mkdir(parents=True)
    root = tmp_path / 'storage'
    write_json(root / '.fullmag-storage.json',
               {'schema': 'other' if case == 'schema' else 'fullmag_storage_v1',
                'project_root': str(root if case == 'project' else repo.parent)})
    with pytest.raises(ValueError):
        package.runtime_runs_root(repo, root, '../escape' if case == 'worktree' else 'private-run')
    assert not (root / 'runs').exists()


def test_reject_document_changed_during_artifact_validation(tmp_path, monkeypatch):
    run, _, _, _ = fixture(tmp_path)
    validator = package.validate_build_receipt
    def change_after_validation(*args):
        result = validator(*args)
        (run / 'receipt.json').write_text('{}', encoding='utf-8')
        return result
    monkeypatch.setattr(package, 'validate_build_receipt', change_after_validation)
    with pytest.raises(ValueError, match='document changed'):
        package.load_package(run, tmp_path, COMMIT, SNAPSHOT, ['fullmag'])


@pytest.mark.parametrize('execute_solver', [False, True])
def test_managed_preparation_path_never_builds(tmp_path, monkeypatch, execute_solver):
    import verify_accepted_fem_preparation_runtime as preparation
    repo_root = Path(__file__).resolve().parents[1]
    write_json(tmp_path / '.fullmag-storage.json',
               {'schema': 'fullmag_storage_v1', 'project_root': str(repo_root.parent)})
    identity = {'head_commit_full': COMMIT, 'source_snapshot_sha256': SNAPSHOT, 'source_snapshot_dirty': False}
    from accepted_fem_cpu_runtime import BINARIES as SOLVER_BINARIES
    names = (*preparation.BINARIES, *SOLVER_BINARIES) if execute_solver else preparation.BINARIES
    binaries = {name: tmp_path / name for name in names}
    def select_package(*args):
        assert tuple(args[-1]) == names
        return binaries, {}, identity, tmp_path / 'lib'
    monkeypatch.setattr(package, 'load_package', select_package)
    monkeypatch.setattr(preparation, 'os', SimpleNamespace(name='posix', environ=os.environ, pathsep=os.pathsep))
    monkeypatch.setattr(preparation.source_identity, 'capture', lambda *args, **kwargs: identity)
    monkeypatch.setenv('LD_LIBRARY_PATH', '/foreign/lib')
    monkeypatch.setenv('LD_PRELOAD', '/foreign/preload.so')
    monkeypatch.setenv('FULLMAG_FEM_RUNTIME', '/foreign/runtime')
    def forbidden(*args, **kwargs):
        pytest.fail('managed route attempted compilation')
    monkeypatch.setattr(preparation, 'build_runtime', forbidden)
    def stop_before_process(*args, **kwargs):
        assert args[2]['FULLMAG_FEM_EXECUTION'] == 'cpu'
        assert args[2]['FULLMAG_DISABLE_MANAGED_FEM_GPU_RUNTIME'] == '1'
        assert args[2]['LD_LIBRARY_PATH'] == str(tmp_path / 'lib')
        assert 'LD_PRELOAD' not in args[2]
        assert 'FULLMAG_FEM_RUNTIME' not in args[2]
        assert args[2]['PATH'] == '/usr/bin:/bin'
        assert args[2]['FULLMAG_PROJECT_STORAGE_ROOT'] == str(tmp_path)
        assert args[2]['FULLMAG_REPO_ROOT'] == str(repo_root)
        assert Path(args[2]['FULLMAG_RUNS_ROOT']) == tmp_path / 'runs' / args[2]['FULLMAG_WORKTREE_ID']
        assert Path(args[2]['FULLMAG_RUNS_ROOT']).is_dir()
        raise RuntimeError('intentional boundary before process')
    monkeypatch.setattr(preparation, 'start_api', stop_before_process)
    code, receipt = preparation.run(repo_root, None, tmp_path / 'evidence',
                                   managed_build_run_root=tmp_path / 'package', storage_root=tmp_path,
                                   expected_commit=COMMIT, expected_snapshot=SNAPSHOT,
                                   execute_solver=execute_solver)
    assert code == 1
    assert receipt['build_commands'] == []
    assert 'intentional boundary before process' in receipt['error']


def test_full_cpu_verifier_rejects_legacy_build_before_any_write(tmp_path):
    import verify_accepted_fem_preparation_runtime as preparation
    with pytest.raises(preparation.AcceptedFemPreparationRuntimeError, match='existing managed package'):
        preparation.run(Path(__file__).resolve().parents[1], tmp_path / 'build', tmp_path / 'evidence',
                        execute_solver=True)
    assert not (tmp_path / 'build').exists()
    assert not (tmp_path / 'evidence').exists()
