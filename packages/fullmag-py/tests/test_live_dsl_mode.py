"""Live execution mode of the DSL (ADR 0068 F3, spec python-live-client-v1 §2, §5)."""
from __future__ import annotations

from pathlib import Path

import pytest

from live_session_fake import FakeLiveSession

import fullmag as fm
from fullmag import world
from fullmag.client import ApiError, CommandFailedError, FullmagConnectionError, InputLockedError, StaleRevisionError
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


def test_equal_texture_apply_replays_the_same_request_after_losing_the_ack(server) -> None:
    session = fm.connect(server.url, events=False)
    layer = _layer()
    core = layer.add_region("core", fm.Box(20e-9, 20e-9, 10e-9))
    core.texture = fm.texture.uniform(0, 0, 1)
    fm.relax(dt=1e-13, max_steps=2)

    revision = session.revision
    commits = server.magnetization_apply_commits
    before = len(server.transactions)
    server.drop_magnetization_apply_responses = 2
    with pytest.raises(FullmagConnectionError):
        core.set_texture(fm.texture.uniform(0, 0, 1))
    assert session.revision == revision
    assert session.pending
    assert server.scene["revision"] == revision + 1

    assert fm.sync() == 1
    attempts = server.transactions[before:]
    assert len(attempts) >= 2
    assert all(attempt == attempts[0] for attempt in attempts)
    assert attempts[0]["base_revision"] == revision
    assert attempts[0]["magnetization_apply"]["scopes"] == [
        {"object_id": "layer", "region_id": core.region_id},
    ]
    assert server.magnetization_apply_commits == commits + 1
    assert session.revision == revision + 1
    assert fm.sync() == 0

    # A new deliberate assignment gets its own operation, while the
    # nested proxy/setter contributes one scope to that operation.
    layer.m.set(fm.texture.uniform(1, 0, 0))
    assert server.magnetization_apply_commits == commits + 2
    assert server.transactions[-1]["magnetization_apply"]["scopes"] == [
        {"object_id": "layer", "region_id": None},
    ]
    assert (server.transactions[-1]["magnetization_apply"]["operation_id"]
            != attempts[0]["magnetization_apply"]["operation_id"])



def test_apply_ack_lost_then_scene_advanced_preserves_other_client_edits(server) -> None:
    session = fm.connect(server.url, events=False)
    layer = _layer()
    fm.relax(dt=1e-13, max_steps=2)

    revision = session.revision
    commits = server.magnetization_apply_commits
    before = len(server.transactions)
    server.drop_magnetization_apply_responses = 2
    with pytest.raises(FullmagConnectionError):
        layer.m = fm.texture.uniform(0, 1, 0)

    server.scene["materials"][0]["properties"]["alpha"] = 0.25
    server.scene["study"]["study_pipeline"]["nodes"][0]["label"] = "Relax A from UI"
    server.scene["revision"] += 1
    with pytest.raises(ApiError, match=r"magnetization_apply_scene_advanced.*reconcile"):
        fm.sync()

    assert server.transactions[before:] == [server.transactions[before]] * 3
    with pytest.raises(ApiError, match="magnetization_apply_scene_advanced"):
        fm.relax(dt=1e-13, max_steps=2)
    assert len(server.transactions) == before + 3
    assert len(server.command_bodies("relax")) == 1
    assert server.scene["revision"] == revision + 2

    assert fm.sync(reconcile=True) == 0
    assert session.revision == revision + 2
    assert server.magnetization_apply_commits == commits + 1

    layer.Ms = 650e3
    properties = server.scene["materials"][0]["properties"]
    assert properties["alpha"] == 0.25
    assert properties["Ms"] == 650e3
    layer.m = fm.texture.uniform(0, 0, 1)
    assert server.magnetization_apply_commits == commits + 2
    assert server.scene["materials"][0]["properties"]["alpha"] == 0.25
    assert fm.relax(dt=1e-13, max_steps=2).completion_status == "succeeded"
    assert server.command_bodies("relax")[-1]["target"] == {"kind": "stage_index", "stage_index": 1}
    assert server.scene["materials"][0]["properties"]["alpha"] == 0.25
    assert server.scene["study"]["study_pipeline"]["nodes"][0]["label"] == "Relax A from UI"


def test_apply_reconciliation_preserves_conflicting_local_draft(server) -> None:
    session = fm.connect(server.url, events=False)
    layer = _layer()
    fm.relax(dt=1e-13, max_steps=2)
    server.drop_magnetization_apply_responses = 2
    with pytest.raises(FullmagConnectionError):
        layer.m = fm.texture.uniform(0, 1, 0)
    server.scene["materials"][0]["properties"]["alpha"] = 0.25
    server.scene["revision"] += 1
    with pytest.raises(ApiError, match="magnetization_apply_scene_advanced"):
        fm.sync()

    layer.alpha = 0.75
    before = len(server.transactions)
    with pytest.raises(ValueError, match=r"materials.*changed"):
        fm.sync(reconcile=True)
    assert session.pending
    assert layer.alpha == 0.75
    assert len(server.transactions) == before
    assert server.scene["materials"][0]["properties"]["alpha"] == 0.25

    layer.alpha = 0.25
    assert fm.sync(reconcile=True) == 0
    assert not session.pending
    assert session.revision == server.scene["revision"]


def test_apply_reconciliation_checks_pending_stage_texture_scope(server) -> None:
    session = fm.connect(server.url, events=False)
    layer = _layer()
    fm.relax(dt=1e-13, max_steps=2)
    server.drop_magnetization_apply_responses = 2
    with pytest.raises(FullmagConnectionError):
        layer.m = fm.texture.uniform(0, 1, 0)
    server.scene["magnetization_assets"][0]["preset_params"]["direction"] = [0, 0, 1]
    server.scene["revision"] += 1
    with pytest.raises(ApiError, match="magnetization_apply_scene_advanced"):
        fm.sync()

    commits = server.magnetization_apply_commits
    with pytest.raises(ValueError, match="texture changed in the current scene"):
        fm.sync(reconcile=True)
    assert session.pending
    assert len(server.command_bodies("relax")) == 1
    assert server.magnetization_apply_commits == commits

    layer.m = fm.texture.uniform(0, 0, 1)
    assert fm.sync(reconcile=True) == 1
    fm.relax(dt=1e-13, max_steps=2)
    nodes = server.scene["study"]["study_pipeline"]["nodes"]
    assignments = nodes[1]["payload"]["magnetization_assignments"]["assignments"]
    assert assignments[-1]["initializer"]["preset_params"]["direction"] == [0, 0, 1]
    assert server.magnetization_apply_commits == commits + 1


def test_live_magnetization_assignments_belong_to_the_next_stage(server) -> None:
    fm.connect(server.url, events=False)
    layer = _layer()
    core = layer.add_region("core", fm.Box(20e-9, 20e-9, 10e-9))
    core.texture = fm.texture.uniform(0, 0, 1)
    fm.relax(dt=1e-13, max_steps=2)
    first = server.scene["study"]["study_pipeline"]["nodes"][0]

    layer.m.set(fm.texture.uniform(1, 0, 0))
    fm.run(1e-10)
    before = len(server.transactions)
    core.texture = fm.texture.uniform(0, 1, 0)
    assert len(server.transactions) == before + 1
    fm.relax(dt=1e-13, max_steps=2)
    fm.run(1e-10)

    pipeline = server.scene["study"]["study_pipeline"]
    assert pipeline["version"] == "study_pipeline.v2"
    a, b, c, d = pipeline["nodes"]
    assert a == first, "the saved first stage keeps its captured texture"
    first_scopes = a["payload"]["magnetization_assignments"]["assignments"]
    assert [(event["object_id"], event["region_id"]) for event in first_scopes] == [
        ("layer", None), ("layer", core.region_id),
    ]
    for node, region_id, direction in (
        (b, None, [1, 0, 0]), (c, core.region_id, [0, 1, 0]),
    ):
        event, = node["payload"]["magnetization_assignments"]["assignments"]
        assert event["object_id"] == "layer"
        assert event["region_id"] == region_id
        assert event["initializer"]["preset_params"]["direction"] == direction
    assert "magnetization_assignments" not in d["payload"]


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
    assert set(run_payload) <= {
        "kind", "entrypoint_kind", "stage_id", "until_seconds",
        "output_every_seconds", "autosave", "magnetization_assignments",
    }
    assert float(run_payload["until_seconds"]) == pytest.approx(1e-10)
