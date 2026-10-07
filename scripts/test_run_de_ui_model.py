import pytest
from run_de_ui_model import verify_loaded_scene, browser_spec

def test_empty_session_is_not_success():
    with pytest.raises(ValueError, match="objects"):
        verify_loaded_scene({"objects": [], "study": {}}, {"objects": [], "study": {}})

def test_changed_study_is_not_success():
    expected={"objects": [{"id": "film"}], "study": {"pipeline": ["demag", "k10"]}}
    with pytest.raises(ValueError, match="study"):
        verify_loaded_scene(expected, {**expected, "study": {"pipeline": []}})

def test_same_model_is_success():
    scene={"objects": [{"id": "film"}], "study": {"pipeline": ["demag", "k10"]}}
    verify_loaded_scene(scene, {**scene, "revision": 1})

def test_preview_state_is_explicitly_volatile(tmp_path):
    spec=browser_spec("sha256:"+"a"*64, tmp_path, tmp_path, tmp_path, 3190)
    env=spec["services"]["browser"]["environment"]
    assert env["FULLMAG_STATE_ROOT"].startswith("/tmp/")
    assert env["FULLMAG_WEB_STATIC_DIR"] == "/state/web"
    assert spec["services"]["browser"]["command"][-1].endswith("exec /package/bin/fullmag-api")


def test_nonzero_k_and_demag_changes_are_rejected():
    from copy import deepcopy
    scene={"objects":[{"id":"film"}],"study":{"demag_enabled":True,
        "study_pipeline":{"nodes":[{"payload":{"k_vector":[0,1e7,0],"include_demag":True}}]}}}
    changed=deepcopy(scene)
    changed["study"]["study_pipeline"]["nodes"][0]["payload"]["k_vector"]=[0,0,0]
    with pytest.raises(ValueError,match="study"):
        verify_loaded_scene(scene,changed)
    changed=deepcopy(scene); changed["study"]["demag_enabled"]=False
    with pytest.raises(ValueError,match="study"):
        verify_loaded_scene(scene,changed)


def test_mixed_api_and_frontend_release_is_rejected():
    from run_de_ui_model import require_matched_frontend
    api={"head_commit_full":"a"*40,"source_snapshot_sha256":"b"*64,"source_snapshot_dirty":False}
    require_matched_frontend(api, dict(api))
    with pytest.raises(ValueError,match="same managed source"):
        require_matched_frontend(api, {**api,"head_commit_full":"c"*40})
    with pytest.raises(ValueError,match="same managed source"):
        require_matched_frontend({}, {})


def test_volatile_repo_root_covers_checkpoint_paths(tmp_path):
    spec=browser_spec("sha256:"+"a"*64,tmp_path,tmp_path,tmp_path,3190)
    env=spec["services"]["browser"]["environment"]
    assert env["FULLMAG_REPO_ROOT"] == "/tmp/fullmag-workspace"
    assert env["FULLMAG_STATE_ROOT"] == env["FULLMAG_REPO_ROOT"]+"/.fullmag"
    assert 'ln -s' in spec["services"]["browser"]["command"][-1]
