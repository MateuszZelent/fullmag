import fullmag as fm
import fullmag.runtime.loader as loader
import fullmag.world as flat_world
from fullmag.runtime.loader import LoadedStage


def _problem() -> fm.Problem:
    fm.reset()
    study = fm.study("action_stage_autosave")
    body = study.geometry(fm.Box(100e-9, 40e-9, 5e-9), name="magnet_1")
    body.Ms = 800e3
    body.Aex = 13e-12
    body.alpha = 0.02
    body.m = fm.texture.uniform(1, 0, 0)
    study.stages.add_run(1e-12, stage_id="run")
    return flat_world._build_problem()


def _lower(stage: LoadedStage) -> dict[str, object]:
    return stage.to_ir(
        requested_backend="fdm",
        execution_mode="strict",
        execution_precision="double",
        script_source="",
        include_geometry_assets=False,
    )


def test_action_stages_get_no_autosave_policy(monkeypatch) -> None:
    calls: list[object] = []
    monkeypatch.setattr(
        loader, "configure_problem_ir_autosave", lambda ir, *args, **kwargs: calls.append(ir)
    )
    problem = _problem()

    _lower(LoadedStage(problem=problem, entrypoint_kind="flat_sequence", default_until_seconds=1e-12))
    assert len(calls) == 1

    _lower(
        LoadedStage(
            problem=problem,
            entrypoint_kind="flat_sequence",
            action={"kind": "add_field_drive"},
        )
    )
    assert len(calls) == 1
