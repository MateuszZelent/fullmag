"""Live execution mode of the DSL (ADR 0068 F3, spec python-live-client-v1 §2, §5)."""
from __future__ import annotations

from pathlib import Path

import pytest

from live_session_fake import FakeLiveSession

import fullmag as fm
from fullmag import world
from fullmag.client import CommandFailedError, InputLockedError, StaleRevisionError
from fullmag.live import LiveModeError
from fullmag.live._scene import build_world_scene, merge_patch_diff, plan_transactions


@pytest.fixture()
def fresh_world():
    context = fm.ExecutionContext()
    with context:
        yield
    # ExecutionContext restores the previous world; nothing leaks between tests.


@pytest.fixture()
def server(fresh_world, monkeypatch):
    monkeypatch.delenv("FULLMAG_URL", raising=False)
    with FakeLiveSession() as fake:
        yield fake
    fm.disconnect()


def _layer():
    fm.engine("fdm")
    fm.device("cpu")
    fm.cell(5e-9, 5e-9, 10e-9)
    fm.solver(fix_dt=1e-13)
    layer = fm.geometry(fm.Box(200e-9, 100e-9, 10e-9), name="layer")
    layer.Ms = 800e3
    layer.Aex = 13e-12
    layer.alpha = 0.5
    layer.m = fm.texture.uniform(1, 0, 0)
    return layer


def _authored(scene):
    return {key: value for key, value in scene.items() if key not in {"revision", "editor"}}


def test_script_builds_scene_incrementally_and_server_matches_world(server) -> None:
    fm.connect(server.url, events=False)
    assert server.transactions == [], "an empty world must not touch the server scene"
    layer = _layer()
    kinds = [transaction["kind"] for transaction in server.transactions]
    assert kinds[0] == "replace_scene", "the first complete world replaces the session scene"
    assert server.transactions[0]["base_revision"] == 3
    assert _authored(server.scene) == _authored(build_world_scene(Path("x.py")))

    before = len(server.transactions)
    layer.Ms = 600e3
    assert len(server.transactions) == before + 1
    assert server.transactions[-1] == {
        "kind": "patch_material",
        "material_id": "mat:layer",
        "patch": {"properties": {"Ms": 600000.0}},
        "base_revision": server.scene["revision"] - 1,
    }

    fm.b_ext(0.01, 0, 0)
    assert server.transactions[-1]["kind"] == "merge_patch"
    assert _authored(server.scene) == _authored(build_world_scene(Path("x.py")))


def test_nested_dsl_calls_commit_one_transaction(server) -> None:
    fm.connect(server.url, events=False)
    _layer()
    before = len(server.transactions)
    fm.b_ext(0.02, 0.0, 0.0)  # internally assigns several attributes
    assert len(server.transactions) == before + 1


def test_unchanged_call_sends_nothing(server) -> None:
    fm.connect(server.url, events=False)
    layer = _layer()
    before = len(server.transactions)
    layer.Ms = layer.Ms
    assert len(server.transactions) == before


def test_transaction_groups_calls(server) -> None:
    fm.connect(server.url, events=False)
    layer = _layer()
    before = len(server.transactions)
    with fm.transaction():
        layer.alpha = 0.02
        fm.b_ext(0.05, 0, 0)
        assert len(server.transactions) == before
    assert len(server.transactions) == before + 1
    assert _authored(server.scene) == _authored(build_world_scene(Path("x.py")))


def test_live_actions_require_an_explicit_timestep(server) -> None:
    fm.connect(server.url, events=False)
    fm.engine("fdm")
    fm.cell(5e-9, 5e-9, 10e-9)
    layer = fm.geometry(fm.Box(200e-9, 100e-9, 10e-9), name="layer")
    layer.Ms, layer.Aex, layer.alpha = 800e3, 13e-12, 0.5
    layer.m = fm.texture.uniform(1, 0, 0)
    # The accepted runner cannot execute an LLG stage without dt or dt_max.
    with pytest.raises(ValueError, match="explicit fixed or complete adaptive"):
        fm.relax(max_steps=10)
    with pytest.raises(ValueError, match="explicit timestep"):
        fm.run(1e-10)
    assert server.command_bodies("relax") == [] and server.command_bodies("run") == []


def test_relax_and_run_become_commands_bound_to_scene_revision(server) -> None:
    fm.connect(server.url, events=False)
    _layer()
    result = fm.relax(dt=1e-13, tolT=1e-5, max_steps=1000)
    assert result.kind == "relax" and result.completion_status == "succeeded"
    relax = server.command_bodies("relax")[0]
    # Docker accepted runs execute one authored stage: the action is authored first, then targeted.
    assert relax["target"] == {"kind": "stage_index", "stage_index": 0}
    assert [stage["kind"] for stage in server.scene["study"]["stages"]] == ["relax"]
    assert relax["precondition"] == {"scene_revision": server.scene["revision"]}
    assert relax["max_steps"] == 1000 and relax["relax_algorithm"] == "llg_overdamped"
    assert relax["torque_tolerance_apm"] == pytest.approx(1e-5 / (4e-7 * 3.141592653589793), rel=1e-6)
    fm.run(1e-9)
    run = server.command_bodies("run")[0]
    assert run["until_seconds"] == 1e-9
    assert run["target"] == {"kind": "stage_index", "stage_index": 1}
    assert [stage["kind"] for stage in server.scene["study"]["stages"]] == ["relax", "run"]
    fm.minimize(method="ncg", tolA=1.0)
    assert server.command_bodies("relax")[-1]["relax_algorithm"] == "nonlinear_cg"


def test_paused_block_pauses_applies_and_resumes(server) -> None:
    fm.connect(server.url, events=False)
    layer = _layer()
    before = len(server.transactions)
    with fm.paused():
        layer.alpha = 0.1
        fm.b_ext(0.03, 0, 0)
    kinds = [body["kind"] for body in server.command_bodies()]
    assert kinds == ["pause", "resume"]
    assert server.command_bodies("pause")[0]["target"] == {"kind": "current_stage"}
    assert len(server.transactions) == before + 1


def test_paused_block_resumes_after_an_error(server) -> None:
    fm.connect(server.url, events=False)
    _layer()
    with pytest.raises(ZeroDivisionError):
        with fm.paused():
            1 / 0
    assert [body["kind"] for body in server.command_bodies()] == ["pause", "resume"]


def test_locked_inputs_raise_typed_error(server) -> None:
    fm.connect(server.url, events=False)
    layer = _layer()
    server.lock_inputs = True
    with pytest.raises(InputLockedError):
        layer.Ms = 500e3


def test_concurrent_edit_raises_stale_revision(server) -> None:
    fm.connect(server.url, events=False)
    layer = _layer()
    server.scene["revision"] += 1  # Control Room committed in between
    with pytest.raises(StaleRevisionError):
        layer.Ms = 700e3


def test_failed_command_raises(fresh_world) -> None:
    with FakeLiveSession(completion="failed") as fake:
        fm.connect(fake.url, events=False)
        _layer()
        with pytest.raises(CommandFailedError):
            fm.run(1e-10)
        fm.disconnect()


def test_connect_creates_session_when_none_exists(fresh_world) -> None:
    with FakeLiveSession(session_exists=False) as fake:
        fm.connect(fake.url, backend="fem", events=False)
        created = fake.api.find("POST", "/v2/sessions")[0].json()
        assert created["backend"] == "fem" and created["device"] == "cpu"
        fm.disconnect()


def test_export_script_renders_the_current_scene(server) -> None:
    fm.connect(server.url, events=False)
    _layer()
    source = fm.export_script()
    assert source.startswith("import fullmag as fm")
    rendered = server.api.find("POST", "/v2/sessions/current/model/syncs")[-1].json()
    # Bound to the revision the script just committed.
    assert rendered["expected_scene_revision"] == server.scene["revision"]


def test_connect_replaces_a_terminal_session(fresh_world) -> None:
    with FakeLiveSession() as fake:
        fake.session_status = "failed"
        fm.connect(fake.url, events=False)
        # A failed session rejects every command; the script gets a new one.
        assert fake.create_bodies and fake.create_bodies[0]["replace_current"] is True
        fm.disconnect()


def test_unsupported_operations_raise_in_live_mode(server) -> None:
    fm.connect(server.url, events=False)
    _layer()
    with pytest.raises(LiveModeError, match="fm.snapshot"):
        fm.snapshot()
    with pytest.raises(LiveModeError, match="fm.relax_stage"):
        fm.relax_stage()


def test_reset_keeps_session_and_replaces_scene(server) -> None:
    fm.connect(server.url, events=False)
    _layer()
    before = len(server.transactions)
    fm.reset()
    assert len(server.transactions) == before, "an empty world after reset is kept pending"
    _layer()
    assert server.transactions[before]["kind"] == "replace_scene"
    assert _authored(server.scene) == _authored(build_world_scene(Path("x.py")))


def test_env_url_connects_automatically(fresh_world, monkeypatch) -> None:
    with FakeLiveSession() as fake:
        monkeypatch.setenv("FULLMAG_URL", fake.url)
        _layer()
        assert fake.transactions and fake.transactions[0]["kind"] == "replace_scene"
        fm.disconnect()


def test_without_connection_dsl_stays_local(fresh_world, monkeypatch) -> None:
    monkeypatch.delenv("FULLMAG_URL", raising=False)
    _layer()
    assert world._state._live_session is None
    with pytest.raises(LiveModeError):
        fm.sync()


def test_connect_is_rejected_during_capture(tmp_path) -> None:
    from fullmag.runtime.loader import load_problem_from_script

    script = tmp_path / "captured.py"
    script.write_text("import fullmag as fm\nfm.connect('http://127.0.0.1:9')\n", encoding="utf-8")
    with pytest.raises(LiveModeError, match="fullmag script.py"):
        load_problem_from_script(script)


def test_plan_transactions_rules() -> None:
    before = {"revision": 1, "materials": [{"id": "m", "properties": {"Ms": 1.0, "Ku1": 2.0}}], "study": {"a": 1}}
    after = {"revision": 1, "materials": [{"id": "m", "properties": {"Ms": 1.0, "Ku1": 3.0}}], "study": {"a": 1}}
    # Ku1 is not part of MaterialPropertiesPatchRequest: falls back to merge_patch.
    assert [t["kind"] for t in plan_transactions(before, after, 1)] == ["merge_patch"]
    assert plan_transactions(before, before, 1) == []
    nulled = {**after, "study": {"a": None}}
    assert [t["kind"] for t in plan_transactions(after, nulled, 1)] == ["replace_scene"]
    assert merge_patch_diff({"a": 1, "b": 2}, {"a": 1, "c": 3}) == {"b": None, "c": 3}


def test_rerunning_geometry_cell_updates_the_same_object(server) -> None:
    fm.connect(server.url, events=False)
    layer = _layer()
    again = fm.geometry(fm.Box(300e-9, 100e-9, 10e-9), name="layer")
    assert again is layer
    objects = server.scene["objects"]
    assert [item["id"] for item in objects] == ["layer"]
    assert objects[0]["geometry"]["geometry_params"]["size"][0] == pytest.approx(300e-9)


def test_live_run_stage_sends_only_the_run_primitive_keys(server) -> None:
    fm.connect(server.url, events=False)
    _layer()
    fm.run(1e-10)
    nodes = server.scene["study"]["study_pipeline"]["nodes"]
    run_payload = next(node["payload"] for node in nodes if node["stage_kind"] == "run")
    # The shared primitive also carries the exact execution-control snapshot.
    assert set(run_payload) <= {"kind", "entrypoint_kind", "stage_id", "until_seconds", "output_every_seconds", "autosave", "interactive_session_requested", "wait_for_solve"}
    assert run_payload["interactive_session_requested"] is False
    assert run_payload["wait_for_solve"] is False
    assert float(run_payload["until_seconds"]) == pytest.approx(1e-10)
