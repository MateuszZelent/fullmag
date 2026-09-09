from pathlib import Path

import fullmag as fm
import fullmag.world as flat_world
from fullmag.runtime.loader import LoadedProblem, LoadedStage
from fullmag.runtime.scene_document import (
    build_builder_from_scene_document,
    build_scene_document_from_builder,
    builder_overrides_from_scene_document,
)
from fullmag.runtime.script_builder import export_builder_draft


def _configure_study() -> fm.StudyBuilder:
    study = fm.study("antenna_stage_workflow")
    body = study.geometry(fm.Box(100e-9, 40e-9, 5e-9), name="magnet_1")
    body.Ms = 800e3
    body.Aex = 13e-12
    body.alpha = 0.02
    body.m = fm.texture.uniform(1, 0, 0)
    return study


def _field_solve_definition() -> fm.AntennaFieldSolveStage:
    return fm.AntennaFieldSolveStage(
        id="definition_id",
        source_object_id="antenna_1",
        current_transport_id="transport_1",
        port_mode_ids=("port_1",),
        conservative_current_view_ref="transport_1:rt0",
        field_sampling_domain=fm.FieldTarget.global_domain(),
        target_refs=(fm.FieldTarget.object("magnet_1"),),
        outputs=(fm.AntennaNamedOutput("basis", "H_ant_basis"),),
    )


def test_antenna_solve_returns_symbolic_output_and_preserves_authoring_intent() -> None:
    fm.reset()
    study = _configure_study()
    output_ref = study.stages.add_antenna_field_solve(
        id="solve_antenna_1",
        definition=_field_solve_definition(),
    )
    assert output_ref == fm.AntennaStageOutputRef(
        stage_id="solve_antenna_1", output_id="basis"
    )

    projection = fm.AntennaTargetProjection(
        id="projection_1",
        solution=output_ref,
        target=fm.FieldTarget.object("magnet_1"),
        output_id="projected",
    )
    drive = fm.SolvedAntennaDrive(
        id="drive_1",
        name="1 GHz antenna drive",
        projection_ref=projection.id,
        port_mode_id="port_1",
        peak_current_a=0.01,
        waveform=fm.Sinusoidal(frequency_hz=1e9),
    )
    study.add_solved_antenna_drive(drive=drive, projection=projection)

    problem = flat_world._build_problem()
    payload = problem.to_ir(include_geometry_assets=False)
    assert payload["antenna_field_solve_stages"][0]["id"] == "solve_antenna_1"
    assert payload["antenna_target_projections"][0]["solution"] == {
        "kind": "stage_output",
        "stage_id": "solve_antenna_1",
        "output_id": "basis",
    }
    assert payload["solved_antenna_drives"][0]["projection_ref"] == "projection_1"


def test_antenna_solve_is_exported_as_one_pipeline_node() -> None:
    fm.reset()
    study = _configure_study()
    study.stages.add_antenna_field_solve(
        id="solve_antenna_1",
        definition=_field_solve_definition(),
    )
    problem = flat_world._build_problem()
    captured = tuple(
        LoadedStage(
            problem=stage.problem,
            entrypoint_kind=stage.entrypoint_kind,
            action=stage.action,
            stage_id=stage.stage_id,
        )
        for stage in flat_world._state._declared_stages
    )
    loaded = LoadedProblem(
        problem=problem,
        source_path=Path("antenna_stage_workflow.py"),
        script_source="",
        entrypoint_kind="flat_sequence",
        stages=captured,
    )

    pipeline = loaded.study_pipeline_document()
    assert pipeline is not None
    assert len(pipeline["nodes"]) == 1
    node = pipeline["nodes"][0]
    assert node["id"] == "solve_antenna_1"
    assert node["stage_kind"] == "antenna_field_solve"
    assert node["payload"]["kind"] == "antenna_field_solve"
    assert node["payload"]["definition"]["id"] == "solve_antenna_1"
    draft = export_builder_draft(loaded)
    assert draft["antenna_field_solve_stages"][0]["id"] == "solve_antenna_1"


def test_antenna_stage_ids_share_the_flat_pipeline_namespace() -> None:
    fm.reset()
    study = _configure_study()
    study.stages.add_run(1e-12, stage_id="shared_stage")
    try:
        study.stages.add_antenna_field_solve(
            id="shared_stage",
            definition=_field_solve_definition(),
        )
    except ValueError as exc:
        assert "duplicate stage_id" in str(exc)
    else:
        raise AssertionError("antenna solve must reject a duplicate flat stage id")


def test_antenna_projection_rejects_unknown_symbolic_output() -> None:
    fm.reset()
    study = _configure_study()
    projection = fm.AntennaTargetProjection(
        id="projection_1",
        solution=fm.AntennaStageOutputRef(stage_id="missing", output_id="basis"),
        target=fm.FieldTarget.object("magnet_1"),
        output_id="projected",
    )
    drive = fm.SolvedAntennaDrive(
        id="drive_1",
        name="1 GHz antenna drive",
        projection_ref=projection.id,
        port_mode_id="port_1",
        peak_current_a=0.01,
        waveform=fm.Sinusoidal(frequency_hz=1e9),
    )
    try:
        study.add_solved_antenna_drive(drive=drive, projection=projection)
    except ValueError as exc:
        assert "unknown antenna field solve" in str(exc)
    else:
        raise AssertionError("dangling symbolic projection must be rejected")


def test_scene_document_adapters_preserve_all_antenna_collections() -> None:
    builder = {
        "antenna_port_modes": [{"id": "port_1"}],
        "antenna_field_solve_stages": [{"id": "solve_1"}],
        "antenna_target_projections": [{"id": "projection_1"}],
        "solved_antenna_drives": [{"id": "drive_1"}],
        "antenna_spectrum_requests": [{"id": "spectrum_1"}],
    }
    scene = build_scene_document_from_builder(builder)
    rebuilt = build_builder_from_scene_document(scene)
    overrides = builder_overrides_from_scene_document(scene)

    for collection, item_id in (
        ("antenna_port_modes", "port_1"),
        ("antenna_field_solve_stages", "solve_1"),
        ("antenna_target_projections", "projection_1"),
        ("solved_antenna_drives", "drive_1"),
        ("antenna_spectrum_requests", "spectrum_1"),
    ):
        assert scene[collection][0]["id"] == item_id
        assert rebuilt[collection][0]["id"] == item_id
        assert overrides[collection][0]["id"] == item_id
