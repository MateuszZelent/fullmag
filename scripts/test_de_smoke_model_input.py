from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import hashlib
import pytest
import de_smoke_model_input as model
import run_de_100nm_pilot as pilot

SHA='a'*40


def test_model_is_read_from_exact_commit_not_working_tree(tmp_path):
    data=b'import fullmag as fm\n'
    with patch.object(model.subprocess,'run',side_effect=[SimpleNamespace(stdout=(SHA+'\n').encode()),SimpleNamespace(stdout=data)]) as run:
        content,identity=model.load_model(tmp_path,SHA)
    assert run.call_args_list[1].args[0]==['git','show',SHA+':'+model.MODEL]
    assert content==data
    assert identity['sha256']==hashlib.sha256(data).hexdigest()
    model.stage_model(tmp_path,content)
    model.verify_model(tmp_path,identity)
    with pytest.raises(FileExistsError):model.stage_model(tmp_path,content)
    (tmp_path/'model-input.py').write_bytes(b'changed')
    with pytest.raises(ValueError,match='hash mismatch'):model.verify_model(tmp_path,identity)


@pytest.mark.parametrize('ref',['master','HEAD','--help','a'*39,'A'*40])
def test_only_immutable_full_commit_is_accepted(tmp_path,ref):
    with pytest.raises(ValueError):model.load_model(tmp_path,ref)


def test_extra_model_mount_is_readonly_without_replacing_capsule():
    ctx=SimpleNamespace(source_tree=Path('/capsule'),runtime_root=Path('/runtime'),job={'job_id':'a'*32})
    cmd=pilot.compose_command(ctx,Path('/outputs'),pilot='de-smoke-two',external_model=True)
    assert str(Path('/outputs/model-input.py'))+':/workspace/benchmark-model.py:ro' in cmd
    assert str(Path('/capsule'))+':/workspace/capsule:ro' in cmd
    assert str(Path('/runtime'))+':/workspace/.fullmag/local:ro' in cmd
    assert 'source_script=/workspace/benchmark-model.py' in cmd[-1]
    assert 'PYTHONPATH=/workspace/capsule/packages/fullmag-py/src:/workspace/.fullmag/local' in cmd


def test_external_model_not_allowed_for_importing_legacy_pilot():
    with pytest.raises(pilot.managed.BenchmarkError):
        pilot.compose_command(None,Path('/outputs'),external_model=True)


def test_changed_model_after_process_exit_is_never_accepted(tmp_path):
    import json
    content=b"pass\n"
    identity={"kind":"versioned_standalone_input","commit":SHA,"path":model.MODEL,
              "sha256":hashlib.sha256(content).hexdigest()}
    model.stage_model(tmp_path,content)
    ctx=SimpleNamespace(layout={"repo_root":str(tmp_path)})
    def mutate(*args,**kwargs):
        (tmp_path/'model-input.py').write_bytes(b"changed")
        return SimpleNamespace(returncode=0)
    with patch.object(pilot.managed,'_run_request',return_value={"source":{"commit":"built"},"job":{},"runtime":{}}), \
         patch.object(pilot.managed,'_compose_environment',return_value={}), \
         patch.object(pilot.subprocess,'run',side_effect=mutate), \
         patch.object(pilot.managed,'_validate_case_artifacts',return_value={}), \
         patch.object(pilot,'validate_rows',return_value={}), \
         patch('builtins.print'):
        assert pilot.execute(ctx,tmp_path,['docker'],identity['sha256'],pilot='de-smoke-two',model_identity=identity)==1
    result=json.loads((tmp_path/'run-result.json').read_text())
    request=json.loads((tmp_path/'run-request.json').read_text())
    assert result['status']=='failed'
    assert 'hash mismatch' in result['error']
    assert request['source']['commit']=='built'
    assert request['model_source']==identity
    assert model.MODEL not in request['source']['public_model_files']
