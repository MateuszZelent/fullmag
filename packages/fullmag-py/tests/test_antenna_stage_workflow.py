from pathlib import Path
from dataclasses import replace
from tempfile import TemporaryDirectory

import fullmag as fm
import fullmag.world as flat_world
from fullmag.runtime.loader import LoadedProblem, LoadedStage, load_problem_from_script
from fullmag.runtime.scene_document import (
    build_builder_from_scene_document,
    build_scene_document_from_builder,
    builder_overrides_from_scene_document,
)
from fullmag.runtime.script_builder import export_builder_draft, render_loaded_problem_as_script


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


def test_antenna_solve_rejects_multiple_ports_in_one_executable_stage() -> None:
    try:
        replace(_field_solve_definition(), port_mode_ids=("port_1", "port_2"))
    except ValueError as exc:
        assert "exactly one port_mode_id" in str(exc)
    else:
        raise AssertionError("multi-port solve must use separate executable stages")


def test_spectrum_component_matches_the_canonical_ir_allow_list() -> None:
    request = fm.AntennaSpectrumRequest(
        id="source_k",
        solution_ref=fm.AntennaStageOutputRef("solve_1", "basis"),
        target=fm.FieldTarget.global_domain(),
        transform="spatial_fft",
        sampling_plane=fm.AntennaSpectrumSamplingPlane(
            origin_m=(0.0, 0.0, 0.0),
            axis_u=(1.0, 0.0, 0.0),
            axis_v=(0.0, 1.0, 0.0),
            extent_u_m=1e-6,
            extent_v_m=1e-6,
            sample_count_u=8,
            sample_count_v=8,
        ),
        window="rectangular",
        normalization="integral_si",
        component="u",
        output_id="spectrum",
    )
    assert request.to_ir()["component"] == "u"
    try:
        replace(request, component="amplitude")
    except ValueError as exc:
        assert "component must be one of" in str(exc)
    else:
        raise AssertionError("unsupported spectrum component must fail in Python authoring")


def test_complete_antenna_authoring_round_trips_through_stage_script() -> None:
    fm.reset()
    study = _configure_study()
    study.engine("fem")
    study.device("cpu", precision="double")
    study.mode("strict")
    study.antenna_object(fm.Box(200e-9, 20e-9, 10e-9), name="antenna_1")
    study.field_drives.add(fm.RegionalFieldDrive(
        id="regional-bias",
        name="Independent regional drive",
        target=fm.FieldTarget.object("magnet_1"),
        amplitude_B_T=0.001,
        direction=(0, 1, 0),
        spatial_profile=fm.UniformFieldProfile(),
        waveform=fm.Constant(),
    ))
    conductor = fm.RegionRef("antenna_1")

    # These pinned identities exercise authoring only; they are not a mesh or
    # a qualified current/field solution for the geometric box above.
    identity = fm.ConservativeCurrentIdentity(
        source_module_id="transport_1",
        source_state_revision="state-1",
        source_field_digest="field-1",
        conductivity_digest="sigma-1",
        mesh_revision="mesh-1",
        topology_revision="topology-1",
        geometry_digest="geometry-1",
        envelope_revision="envelope-1",
        envelope_digest="envelope-digest-1",
        evaluated_envelope_multiplier=1.0,
        evaluation_time_s=0.0,
        stage_identity=1,
    )
    current_view = fm.ConservativeCurrentView(
        stable_vertex_ids=(10, 20, 30, 40),
        boundary_faces=(
            fm.ConservativeCurrentBoundaryFace((10, 20, 30), "source_cut", "cut"),
            fm.ConservativeCurrentBoundaryFace((10, 20, 40), "source_cut", "cut"),
            fm.ConservativeCurrentBoundaryFace((10, 30, 40), "insulating_outer"),
            fm.ConservativeCurrentBoundaryFace((20, 30, 40), "insulating_outer"),
        ),
        identity=identity,
        pins=fm.ConservativeCurrentPins(
            required_source_state_revision="state-1",
            required_source_field_digest="field-1",
            required_mesh_revision="mesh-1",
            required_topology_revision="topology-1",
        ),
        closure=fm.ConservativeCurrentClosedGeometry(
            "fem_closed_current_geometry.v1",
            "closure-1",
            "closure-digest-1",
            (
                fm.ConservativeCurrentSourceCut(
                    "cut",
                    (1.0, 0.0, 0.0),
                    0.1,
                    (fm.ConservativeCurrentSourceCutFacePair((10, 20, 30), (10, 20, 40)),),
                ),
            ),
        ),
        algebraic_relative_tolerance=1e-10,
        physical_relative_gate=1e-8,
        physical_absolute_gate_a=1e-12,
    )
    study.current_transport(
        name="transport_1",
        model="ohmic_poisson",
        domain=(conductor,),
        materials=(
            fm.ChargeTransportMaterialAssignment(
                conductor, fm.ChargeTransportMaterial(sigma_Spm=5.8e7)
            ),
        ),
        boundaries=(
            fm.VoltageElectrode(
                "signal_in", (fm.SurfaceRef("antenna_1", "x-", (-1, 0, 0)),), potential_V=0.1
            ),
            fm.VoltageElectrode(
                "signal_out", (fm.SurfaceRef("antenna_1", "x+", (1, 0, 0)),), potential_V=0.0
            ),
            fm.VoltageElectrode(
                "return_in", (fm.SurfaceRef("antenna_1", "y-", (0, -1, 0)),), potential_V=0.1
            ),
            fm.VoltageElectrode(
                "return_out", (fm.SurfaceRef("antenna_1", "y+", (0, 1, 0)),), potential_V=0.0
            ),
        ),
        gauge=fm.ChargePotentialGauge("dirichlet_reference"),
        solver=fm.ChargeSolverPolicy(),
        conservative_current_view=current_view,
    )
    study.add_antenna_port_mode(
        port_mode=fm.AntennaPortMode(
            id="port_1",
            source_object_id="antenna_1",
            current_transport_id="transport_1",
            branches=(
                fm.AntennaPortBranch("signal", "signal_in", "signal_out", 1.0),
                fm.AntennaPortBranch("return", "return_in", "return_out", -1.0),
            ),
        )
    )
    basis = study.stages.add_antenna_field_solve(
        id="solve_antenna_1", definition=_field_solve_definition()
    )
    study.add_antenna_spectrum_request(
        request=fm.AntennaSpectrumRequest(
            id="source_k",
            solution_ref=basis,
            port_mode_id="port_1",
            target=fm.FieldTarget.global_domain(),
            transform="spatial_fft",
            sampling_plane=fm.AntennaSpectrumSamplingPlane(
                origin_m=(0, 0, 0),
                axis_u=(1, 0, 0),
                axis_v=(0, 1, 0),
                extent_u_m=200e-9,
                extent_v_m=100e-9,
                sample_count_u=8,
                sample_count_v=8,
            ),
            window="rectangular",
            normalization="integral_si",
            component="u",
            output_id="source_k_output",
        )
    )
    projection = fm.AntennaTargetProjection(
        id="projection_1",
        solution=basis,
        target=fm.FieldTarget.object("magnet_1"),
        output_id="projected",
    )
    study.add_solved_antenna_drive(
        drive=fm.SolvedAntennaDrive(
            id="drive_1",
            name="1 GHz antenna drive",
            projection_ref=projection.id,
            port_mode_id="port_1",
            peak_current_a=0.01,
            waveform=fm.Sinusoidal(frequency_hz=1e9),
        ),
        projection=projection,
    )
    study.stages.add_run(1e-12, stage_id="run")
    authored = flat_world._build_problem().to_ir(include_geometry_assets=False)
    assert authored["antenna_target_projections"][0]["solution"] == basis.to_ir()
    assert authored["antenna_spectrum_requests"][0]["solution_ref"] == basis.to_ir()
    captured = tuple(
        LoadedStage(
            problem=stage.problem,
            entrypoint_kind=stage.entrypoint_kind,
            default_until_seconds=stage.default_until_seconds,
            action=stage.action,
            stage_id=stage.stage_id,
        )
        for stage in flat_world._state._declared_stages
    )
    loaded = LoadedProblem(
        problem=flat_world._build_problem(),
        source_path=Path("complete_antenna_authoring.py"),
        script_source="",
        entrypoint_kind="flat_sequence",
        stages=captured,
    )
    rendered = render_loaded_problem_as_script(loaded)
    with TemporaryDirectory() as directory:
        script_path = Path(directory) / "complete_antenna_authoring.py"
        script_path.write_text(rendered, encoding="utf-8")
        reloaded = load_problem_from_script(script_path)
    replayed = reloaded.problem.to_ir(include_geometry_assets=False)
    for collection in (
        "physics_objects",
        "current_modules",
        "field_drives",
        "antenna_port_modes",
        "antenna_field_solve_stages",
        "antenna_spectrum_requests",
        "antenna_target_projections",
        "solved_antenna_drives",
    ):
        assert replayed[collection] == authored[collection]
    assert [node["stage_kind"] for node in reloaded.study_pipeline_document()["nodes"]] == [
        "antenna_field_solve",
        "antenna_source_spectrum",
        "add_solved_antenna_drive",
        "run",
    ]
    scene = build_scene_document_from_builder(export_builder_draft(loaded))
    scene["field_drives"]["drives"][0]["amplitude_B_T"] = 0.002
    edited = render_loaded_problem_as_script(
        loaded, overrides=builder_overrides_from_scene_document(scene)
    )
    with TemporaryDirectory() as directory:
        script_path = Path(directory) / "antenna_with_edited_regional_drive.py"
        script_path.write_text(edited, encoding="utf-8")
        edited_problem = load_problem_from_script(script_path).problem.to_ir(
            include_geometry_assets=False
        )
    assert edited_problem["field_drives"][0]["amplitude_B_T"] == 0.002
    for collection in (
        "antenna_port_modes",
        "antenna_field_solve_stages",
        "antenna_spectrum_requests",
        "antenna_target_projections",
        "solved_antenna_drives",
    ):
        assert edited_problem[collection] == authored[collection]


def test_study_registers_port_mode_in_canonical_problem() -> None:
    fm.reset()
    study = _configure_study()
    port_mode = fm.AntennaPortMode(
        id="port_1",
        source_object_id="antenna_1",
        current_transport_id="transport_1",
        branches=(
            fm.AntennaPortBranch("signal", "signal_in", "signal_out", 1.0),
            fm.AntennaPortBranch("return", "return_in", "return_out", -1.0),
        ),
    )
    assert study.add_antenna_port_mode(port_mode=port_mode) is port_mode
    assert flat_world._build_problem().to_ir(include_geometry_assets=False)[
        "antenna_port_modes"
    ] == [port_mode.to_ir()]
    loaded = LoadedProblem(
        problem=flat_world._build_problem(),
        source_path=Path("antenna_port_workflow.py"),
        script_source="",
        entrypoint_kind="flat_sequence",
        default_until_seconds=1e-12,
    )
    rendered = render_loaded_problem_as_script(loaded)
    assert "study.add_antenna_port_mode(" in rendered
    compile(rendered, "antenna_port_export.py", "exec")
    fm.reset()
    exec(rendered, {})
    assert flat_world._build_problem().to_ir(include_geometry_assets=False)[
        "antenna_port_modes"
    ] == [port_mode.to_ir()]
    try:
        study.add_antenna_port_mode(port_mode=port_mode)
    except ValueError as exc:
        assert "duplicate antenna port mode id" in str(exc)
    else:
        raise AssertionError("duplicate port mode must be rejected")


def test_solved_drives_share_matching_projection_and_reject_conflicting_projection() -> None:
    fm.reset()
    study = _configure_study()
    basis = study.stages.add_antenna_field_solve(
        id="solve_antenna_1", definition=_field_solve_definition()
    )
    projection = fm.AntennaTargetProjection(
        id="projection_1", solution=basis,
        target=fm.FieldTarget.object("magnet_1"), output_id="projected",
    )
    drive = fm.SolvedAntennaDrive(
        id="drive_1", name="First antenna drive", projection_ref=projection.id,
        port_mode_id="port_1", peak_current_a=0.01,
        waveform=fm.Sinusoidal(frequency_hz=1e9),
    )
    study.add_solved_antenna_drive(drive=drive, projection=projection)
    second = replace(drive, id="drive_2", name="Second antenna drive")
    study.add_solved_antenna_drive(drive=second, projection=projection)
    problem = flat_world._build_problem()
    assert problem.antenna_target_projections == (projection,)
    assert problem.solved_antenna_drives == (drive, second)
    actions_before_conflict = len(flat_world._state._declared_stages)
    try:
        study.add_solved_antenna_drive(
            drive=replace(drive, id="drive_3"),
            projection=replace(projection, output_id="conflicting_output"),
        )
    except ValueError as exc:
        assert "conflicting antenna projection id" in str(exc)
    else:
        raise AssertionError("conflicting projection must be rejected")
    assert flat_world._build_problem().antenna_target_projections == (projection,)
    assert flat_world._build_problem().solved_antenna_drives == (drive, second)
    assert len(flat_world._state._declared_stages) == actions_before_conflict


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
    scene = build_scene_document_from_builder(
        {"antenna_target_projections": payload["antenna_target_projections"]}
    )
    rebuilt = build_builder_from_scene_document(scene)
    assert rebuilt["antenna_target_projections"][0]["solution"] == {
        "kind": "stage_output",
        "stage_id": "solve_antenna_1",
        "output_id": "basis",
    }
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
        problem=flat_world._build_problem(),
        source_path=Path("antenna_drive_workflow.py"),
        script_source="",
        entrypoint_kind="flat_sequence",
        stages=captured,
    )
    assert [node["stage_kind"] for node in loaded.study_pipeline_document()["nodes"]] == [
        "antenna_field_solve",
        "add_solved_antenna_drive",
    ]
    base_ir = loaded.pipeline_base_problem().to_ir(include_geometry_assets=False)
    assert base_ir["antenna_target_projections"] == []
    assert base_ir["solved_antenna_drives"] == []
    draft = export_builder_draft(loaded)
    assert draft["antenna_target_projections"] == payload["antenna_target_projections"]
    assert draft["solved_antenna_drives"] == payload["solved_antenna_drives"]
    rendered = render_loaded_problem_as_script(loaded)
    compile(rendered, "antenna_drive_export.py", "exec")
    fm.reset()
    exec(rendered, {})
    round_trip = flat_world._build_problem().to_ir(include_geometry_assets=False)
    assert round_trip["antenna_target_projections"] == payload["antenna_target_projections"]
    assert round_trip["solved_antenna_drives"] == payload["solved_antenna_drives"]
    with TemporaryDirectory() as directory:
        script_path = Path(directory) / "antenna_drive_round_trip.py"
        script_path.write_text(rendered, encoding="utf-8")
        reloaded = load_problem_from_script(script_path)
        assert [node["stage_kind"] for node in reloaded.study_pipeline_document()["nodes"]] == [
            "antenna_field_solve",
            "add_solved_antenna_drive",
        ]
        assert reloaded.pipeline_base_problem().antenna_target_projections == ()
        lowered = reloaded.to_ir(
            requested_backend="fdm",
            execution_mode="strict",
            execution_precision="double",
            include_geometry_assets=False,
        )
        assert lowered["antenna_target_projections"] == []
        assert lowered["solved_antenna_drives"] == []
        assert [
            node["stage_kind"]
            for node in lowered["problem_meta"]["runtime_metadata"]["study_pipeline"]["nodes"]
        ] == [
            "antenna_field_solve",
            "add_solved_antenna_drive",
        ]


def test_relax_then_solved_antenna_drive_preserves_stage_order() -> None:
    fm.reset()
    study = _configure_study()
    output = study.stages.add_antenna_field_solve(
        id="solve_antenna_1", definition=_field_solve_definition()
    )
    study.stages.add_relax(stage_id="relax", dt=1e-13)
    projection = fm.AntennaTargetProjection(
        id="projection_1",
        solution=output,
        target=fm.FieldTarget.object("magnet_1"),
        output_id="projected",
    )
    drive = fm.SolvedAntennaDrive(
        id="drive_1",
        name="RF after relaxation",
        projection_ref=projection.id,
        port_mode_id="port_1",
        peak_current_a=0.01,
        waveform=fm.Sinusoidal(frequency_hz=1e9),
    )
    study.add_solved_antenna_drive(drive=drive, projection=projection)
    study.stages.add_run(1e-12, stage_id="run")
    captured = tuple(
        LoadedStage(
            problem=stage.problem,
            entrypoint_kind=stage.entrypoint_kind,
            default_until_seconds=stage.default_until_seconds,
            action=stage.action,
            stage_id=stage.stage_id,
        )
        for stage in flat_world._state._declared_stages
    )
    loaded = LoadedProblem(
        problem=flat_world._build_problem(),
        source_path=Path("antenna_relax_run.py"),
        script_source="",
        entrypoint_kind="flat_sequence",
        stages=captured,
    )
    expected = ["antenna_field_solve", "relax", "add_solved_antenna_drive", "run"]
    assert [node["stage_kind"] for node in loaded.study_pipeline_document()["nodes"]] == expected
    assert captured[1].problem.solved_antenna_drives == ()
    assert loaded.pipeline_base_problem().solved_antenna_drives == ()
    rendered = render_loaded_problem_as_script(loaded)
    with TemporaryDirectory() as directory:
        script_path = Path(directory) / "antenna_relax_run_round_trip.py"
        script_path.write_text(rendered, encoding="utf-8")
        reloaded = load_problem_from_script(script_path)
        assert [
            node["stage_kind"] for node in reloaded.study_pipeline_document()["nodes"]
        ] == expected
        assert reloaded.stages[1].problem.solved_antenna_drives == ()
        lowered = reloaded.to_ir(
            requested_backend="fdm",
            execution_mode="strict",
            execution_precision="double",
            include_geometry_assets=False,
        )
        assert lowered["solved_antenna_drives"] == []
        assert [
            node["stage_kind"]
            for node in lowered["problem_meta"]["runtime_metadata"]["study_pipeline"]["nodes"]
        ] == expected


def test_relax_before_antenna_solve_does_not_require_future_drive() -> None:
    fm.reset()
    study = _configure_study()
    study.stages.add_relax(stage_id="relax", dt=1e-13)
    output = study.stages.add_antenna_field_solve(
        id="solve_antenna_1", definition=_field_solve_definition()
    )
    projection = fm.AntennaTargetProjection(
        id="projection_1",
        solution=output,
        target=fm.FieldTarget.object("magnet_1"),
        output_id="projected",
    )
    drive = fm.SolvedAntennaDrive(
        id="drive_1",
        name="RF after precompute",
        projection_ref=projection.id,
        port_mode_id="port_1",
        peak_current_a=0.01,
        waveform=fm.Sinusoidal(frequency_hz=1e9),
    )
    study.add_solved_antenna_drive(drive=drive, projection=projection)
    study.stages.add_run(1e-12, stage_id="run")
    captured = tuple(
        LoadedStage(
            problem=stage.problem,
            entrypoint_kind=stage.entrypoint_kind,
            default_until_seconds=stage.default_until_seconds,
            action=stage.action,
            stage_id=stage.stage_id,
        )
        for stage in flat_world._state._declared_stages
    )
    loaded = LoadedProblem(
        problem=flat_world._build_problem(),
        source_path=Path("antenna_relax_first.py"),
        script_source="",
        entrypoint_kind="flat_sequence",
        stages=captured,
    )
    expected = ["relax", "antenna_field_solve", "add_solved_antenna_drive", "run"]
    assert [node["stage_kind"] for node in loaded.study_pipeline_document()["nodes"]] == expected
    assert captured[0].problem.solved_antenna_drives == ()
    assert captured[0].problem.antenna_field_solve_stages == ()
    with TemporaryDirectory() as directory:
        script_path = Path(directory) / "antenna_relax_first_round_trip.py"
        script_path.write_text(render_loaded_problem_as_script(loaded), encoding="utf-8")
        reloaded = load_problem_from_script(script_path)
        assert [
            node["stage_kind"] for node in reloaded.study_pipeline_document()["nodes"]
        ] == expected
        assert reloaded.stages[0].problem.solved_antenna_drives == ()
        assert reloaded.stages[0].problem.antenna_field_solve_stages == ()
        lowered = reloaded.to_ir(
            requested_backend="fdm",
            execution_mode="strict",
            execution_precision="double",
            include_geometry_assets=False,
        )
        assert lowered["solved_antenna_drives"] == []
        assert [
            node["stage_kind"]
            for node in lowered["problem_meta"]["runtime_metadata"]["study_pipeline"]["nodes"]
        ] == expected


def test_imported_antenna_asset_keeps_explicit_reference_kind_in_scene() -> None:
    projection = fm.AntennaTargetProjection(
        id="imported_projection",
        solution=fm.AntennaFieldSolutionRef(
            stage_id="solve_antenna_1",
            output_id="basis",
            asset_id="asset-1",
            content_digest="sha256:valid",
        ),
        target=fm.FieldTarget.global_domain(),
        output_id="projected",
    )
    scene = build_scene_document_from_builder(
        {"antenna_target_projections": [projection.to_ir()]}
    )
    rebuilt = build_builder_from_scene_document(scene)
    assert rebuilt["antenna_target_projections"][0]["solution"] == {
        "kind": "resolved_asset",
        "stage_id": "solve_antenna_1",
        "output_id": "basis",
        "asset_id": "asset-1",
        "content_digest": "sha256:valid",
    }


def test_imported_antenna_asset_keeps_digest_through_script_round_trip() -> None:
    fm.reset()
    study = _configure_study()
    study.stages.add_antenna_field_solve(
        id="solve_antenna_1", definition=_field_solve_definition()
    )
    projection = fm.AntennaTargetProjection(
        id="projection_1",
        solution=fm.AntennaFieldSolutionRef(
            stage_id="solve_antenna_1",
            output_id="basis",
            asset_id="asset-1",
            content_digest="sha256:valid",
        ),
        target=fm.FieldTarget.object("magnet_1"),
        output_id="projected",
    )
    drive = fm.SolvedAntennaDrive(
        id="drive_1",
        name="Imported antenna basis",
        projection_ref=projection.id,
        port_mode_id="port_1",
        peak_current_a=0.01,
        waveform=fm.Sinusoidal(frequency_hz=1e9),
    )
    study.add_solved_antenna_drive(drive=drive, projection=projection)
    request = fm.AntennaSpectrumRequest(
        id="imported_source_k",
        solution_ref=projection.solution,
        target=fm.FieldTarget.global_domain(),
        transform="spatial_fft",
        sampling_plane=fm.AntennaSpectrumSamplingPlane(
            origin_m=(0.0, 0.0, 0.0),
            axis_u=(1.0, 0.0, 0.0),
            axis_v=(0.0, 1.0, 0.0),
            extent_u_m=1e-6,
            extent_v_m=1e-6,
            sample_count_u=8,
            sample_count_v=8,
        ),
        window="rectangular",
        normalization="integral_si",
        component="x",
        output_id="imported_spectrum",
    )
    study.add_antenna_spectrum_request(request=request)
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
        problem=flat_world._build_problem(),
        source_path=Path("imported_antenna_basis.py"),
        script_source="",
        entrypoint_kind="flat_sequence",
        stages=captured,
    )
    expected = projection.to_ir()["solution"]
    assert expected["kind"] == "resolved_asset"
    with TemporaryDirectory() as directory:
        script_path = Path(directory) / "imported_antenna_basis_round_trip.py"
        script_path.write_text(render_loaded_problem_as_script(loaded), encoding="utf-8")
        reloaded = load_problem_from_script(script_path)
        actual = reloaded.problem.to_ir(include_geometry_assets=False)[
            "antenna_target_projections"
        ][0]["solution"]
        assert actual == expected
        assert reloaded.problem.to_ir(include_geometry_assets=False)[
            "antenna_spectrum_requests"
        ][0]["solution_ref"] == expected


def test_antenna_spectrum_can_reference_a_future_stage_output() -> None:
    fm.reset()
    study = _configure_study()
    output_ref = study.stages.add_antenna_field_solve(
        id="solve_antenna_1", definition=_field_solve_definition()
    )
    request = fm.AntennaSpectrumRequest(
        id="source_k",
        solution_ref=output_ref,
        target=fm.FieldTarget.global_domain(),
        transform="spatial_fft",
        sampling_plane=fm.AntennaSpectrumSamplingPlane(
            origin_m=(0.0, 0.0, 0.0),
            axis_u=(1.0, 0.0, 0.0),
            axis_v=(0.0, 1.0, 0.0),
            extent_u_m=1e-6,
            extent_v_m=1e-6,
            sample_count_u=8,
            sample_count_v=8,
        ),
        window="rectangular",
        normalization="integral_si",
        component="x",
        output_id="spectrum",
    )
    assert request.to_ir()["solution_ref"] == {
        "kind": "stage_output",
        "stage_id": "solve_antenna_1",
        "output_id": "basis",
    }
    assert study.add_antenna_spectrum_request(request=request) is request
    payload = flat_world._build_problem().to_ir(include_geometry_assets=False)
    scene = build_scene_document_from_builder(
        {"antenna_spectrum_requests": payload["antenna_spectrum_requests"]}
    )
    rebuilt = build_builder_from_scene_document(scene)
    assert rebuilt["antenna_spectrum_requests"][0]["solution_ref"] == request.to_ir()[
        "solution_ref"
    ]
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
        problem=flat_world._build_problem(),
        source_path=Path("antenna_spectrum_workflow.py"),
        script_source="",
        entrypoint_kind="flat_sequence",
        stages=captured,
    )
    nodes = loaded.study_pipeline_document()["nodes"]
    assert [node["stage_kind"] for node in nodes] == [
        "antenna_field_solve",
        "antenna_source_spectrum",
    ]
    assert nodes[1]["payload"]["request"] == request.to_ir()
    assert export_builder_draft(loaded)["antenna_spectrum_requests"][0] == request.to_ir()
    assert loaded.pipeline_base_problem().to_ir(include_geometry_assets=False)[
        "antenna_spectrum_requests"
    ] == []
    rendered = render_loaded_problem_as_script(loaded)
    assert "study.add_antenna_spectrum_request(" in rendered
    compile(rendered, "antenna_spectrum_export.py", "exec")
    try:
        study.add_antenna_spectrum_request(request=request)
    except ValueError as exc:
        assert "duplicate antenna spectrum request id" in str(exc)
    else:
        raise AssertionError("duplicate spectrum request must be rejected")
    fm.reset()
    exec(rendered, {})
    assert flat_world._build_problem().to_ir(include_geometry_assets=False)[
        "antenna_spectrum_requests"
    ] == [request.to_ir()]
    with TemporaryDirectory() as directory:
        script_path = Path(directory) / "antenna_spectrum_round_trip.py"
        script_path.write_text(rendered, encoding="utf-8")
        reloaded = load_problem_from_script(script_path)
        assert [node["stage_kind"] for node in reloaded.study_pipeline_document()["nodes"]] == [
            "antenna_field_solve",
            "antenna_source_spectrum",
        ]
        assert reloaded.pipeline_base_problem().antenna_spectrum_requests == ()
        lowered = reloaded.to_ir(
            requested_backend="fdm",
            execution_mode="strict",
            execution_precision="double",
            include_geometry_assets=False,
        )
        assert lowered["antenna_spectrum_requests"] == []
        lowered_nodes = lowered["problem_meta"]["runtime_metadata"]["study_pipeline"]["nodes"]
        assert [node["stage_kind"] for node in lowered_nodes] == [
            "antenna_field_solve",
            "antenna_source_spectrum",
        ]
        assert lowered_nodes[1]["payload"]["request"] == request.to_ir()


def test_antenna_spectrum_rejects_non_basis_solve_output() -> None:
    fm.reset()
    study = _configure_study()
    definition = replace(
        _field_solve_definition(),
        outputs=(
            fm.AntennaNamedOutput("basis", "H_ant_basis"),
            fm.AntennaNamedOutput("diagnostic", "H_ant"),
        ),
    )
    study.stages.add_antenna_field_solve(id="solve_antenna_1", definition=definition)
    request = fm.AntennaSpectrumRequest(
        id="source_k",
        solution_ref=fm.AntennaStageOutputRef(
            stage_id="solve_antenna_1", output_id="diagnostic"
        ),
        target=fm.FieldTarget.global_domain(),
        transform="spatial_fft",
        sampling_plane=fm.AntennaSpectrumSamplingPlane(
            origin_m=(0.0, 0.0, 0.0),
            axis_u=(1.0, 0.0, 0.0),
            axis_v=(0.0, 1.0, 0.0),
            extent_u_m=1e-6,
            extent_v_m=1e-6,
            sample_count_u=8,
            sample_count_v=8,
        ),
        window="rectangular",
        normalization="integral_si",
        component="x",
        output_id="spectrum",
    )
    try:
        study.add_antenna_spectrum_request(request=request)
    except ValueError as exc:
        assert "H_ant_basis solve output" in str(exc)
    else:
        raise AssertionError("source spectrum must not consume a non-basis output")
    assert flat_world._build_problem().antenna_spectrum_requests == ()


def test_antenna_drive_rejects_non_basis_solve_output() -> None:
    fm.reset()
    study = _configure_study()
    definition = replace(
        _field_solve_definition(),
        outputs=(
            fm.AntennaNamedOutput("basis", "H_ant_basis"),
            fm.AntennaNamedOutput("diagnostic", "H_ant"),
        ),
    )
    study.stages.add_antenna_field_solve(id="solve_antenna_1", definition=definition)
    projection = fm.AntennaTargetProjection(
        id="projection_1",
        solution=fm.AntennaStageOutputRef(
            stage_id="solve_antenna_1", output_id="diagnostic"
        ),
        target=fm.FieldTarget.object("magnet_1"),
        output_id="projected",
    )
    drive = fm.SolvedAntennaDrive(
        id="drive_1",
        name="Wrong basis output",
        projection_ref=projection.id,
        port_mode_id="port_1",
        peak_current_a=0.01,
        waveform=fm.Sinusoidal(frequency_hz=1e9),
    )
    try:
        study.add_solved_antenna_drive(drive=drive, projection=projection)
    except ValueError as exc:
        assert "must reference an H_ant_basis output" in str(exc)
    else:
        raise AssertionError("solved drive must not consume a non-basis output")
    assert flat_world._build_problem().antenna_target_projections == ()
    assert flat_world._build_problem().solved_antenna_drives == ()


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
    assert node["payload"] == {
        "kind": "antenna_field_solve",
        "entrypoint_kind": "flat_antenna_field_solve",
        "stage_id": "solve_antenna_1",
        "port_mode_ids": ["port_1"],
    }
    draft = export_builder_draft(loaded)
    assert draft["antenna_field_solve_stages"][0]["id"] == "solve_antenna_1"
    assert draft["antenna_field_solve_stages"][0]["port_mode_ids"] == ["port_1"]
    assert loaded.pipeline_base_problem().to_ir(include_geometry_assets=False)[
        "antenna_field_solve_stages"
    ][0]["id"] == node["payload"]["stage_id"]
    rendered = render_loaded_problem_as_script(loaded)
    assert "study.stages.add_antenna_field_solve(" in rendered
    compile(rendered, "antenna_field_solve_export.py", "exec")
    fm.reset()
    exec(rendered, {})
    assert flat_world._build_problem().to_ir(include_geometry_assets=False)[
        "antenna_field_solve_stages"
    ][0]["id"] == "solve_antenna_1"


def test_current_source_stage_omits_legacy_selector_from_script_export() -> None:
    fm.reset()
    study = _configure_study()
    study.stages.add_antenna_field_solve(
        id="solve_antenna_1",
        definition=replace(
            _field_solve_definition(), conservative_current_view_ref=None
        ),
    )
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
        problem=flat_world._build_problem(),
        source_path=Path("antenna_current_source_stage.py"),
        script_source="",
        entrypoint_kind="flat_sequence",
        stages=captured,
    )

    draft = export_builder_draft(loaded)
    assert "conservative_current_view_ref" not in draft[
        "antenna_field_solve_stages"
    ][0]
    rendered = render_loaded_problem_as_script(loaded)
    assert "conservative_current_view_ref=" not in rendered
    compile(rendered, "antenna_current_source_stage_export.py", "exec")
    fm.reset()
    exec(rendered, {})
    replayed = flat_world._build_problem().to_ir(include_geometry_assets=False)
    assert "conservative_current_view_ref" not in replayed[
        "antenna_field_solve_stages"
    ][0]


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


def test_antenna_drive_rejects_port_not_in_symbolic_solve() -> None:
    fm.reset()
    study = _configure_study()
    output = study.stages.add_antenna_field_solve(
        id="solve_antenna_1", definition=_field_solve_definition()
    )
    projection = fm.AntennaTargetProjection(
        id="projection_1",
        solution=output,
        target=fm.FieldTarget.object("magnet_1"),
        output_id="projected",
    )
    drive = fm.SolvedAntennaDrive(
        id="drive_1",
        name="Wrong port",
        projection_ref=projection.id,
        port_mode_id="port_2",
        peak_current_a=0.01,
        waveform=fm.Sinusoidal(frequency_hz=1e9),
    )
    try:
        study.add_solved_antenna_drive(drive=drive, projection=projection)
    except ValueError as exc:
        assert "drive.port_mode_id 'port_2' is not in antenna field solve" in str(exc)
    else:
        raise AssertionError("drive with a port outside its solve must be rejected")
    problem = flat_world._build_problem()
    assert problem.antenna_target_projections == ()
    assert problem.solved_antenna_drives == ()


def test_imported_antenna_drive_rejects_port_not_in_declared_solve() -> None:
    fm.reset()
    study = _configure_study()
    study.stages.add_antenna_field_solve(
        id="solve_antenna_1", definition=_field_solve_definition()
    )
    projection = fm.AntennaTargetProjection(
        id="projection_1",
        solution=fm.AntennaFieldSolutionRef(
            stage_id="solve_antenna_1",
            output_id="basis",
            asset_id="asset-1",
            content_digest="sha256:valid",
        ),
        target=fm.FieldTarget.object("magnet_1"),
        output_id="projected",
    )
    drive = fm.SolvedAntennaDrive(
        id="drive_1",
        name="Wrong imported port",
        projection_ref=projection.id,
        port_mode_id="port_2",
        peak_current_a=0.01,
        waveform=fm.Sinusoidal(frequency_hz=1e9),
    )
    try:
        study.add_solved_antenna_drive(drive=drive, projection=projection)
    except ValueError as exc:
        assert "drive.port_mode_id 'port_2' is not in antenna field solve" in str(exc)
    else:
        raise AssertionError("imported drive with a port outside its solve must be rejected")
    problem = flat_world._build_problem()
    assert problem.antenna_target_projections == ()
    assert problem.solved_antenna_drives == ()


def test_scene_document_adapters_preserve_all_antenna_collections() -> None:
    builder = {
        "antenna_port_modes": [{"id": "port_1"}],
        "antenna_field_solve_stages": [
            {
                "id": "solve_1",
                "conservative_current_view_ref": "transport_1:rt0",
            },
            {"id": "solve_source"},
        ],
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

    for projection in (scene, rebuilt, overrides):
        stages = projection["antenna_field_solve_stages"]
        assert stages[0]["conservative_current_view_ref"] == "transport_1:rt0"
        assert "conservative_current_view_ref" not in stages[1]


def test_scene_document_round_trip_without_antenna_collections() -> None:
    scene = build_scene_document_from_builder({"stages": []})
    rebuilt = build_builder_from_scene_document(scene)
    overrides = builder_overrides_from_scene_document(scene)

    for collection in (
        "antenna_port_modes",
        "antenna_field_solve_stages",
        "antenna_target_projections",
        "solved_antenna_drives",
        "antenna_spectrum_requests",
    ):
        assert collection not in scene
        assert collection not in rebuilt
        assert collection not in overrides


def test_scene_document_preserves_regional_drive_without_antenna() -> None:
    regional_drive = fm.RegionalFieldDrive(
        id="regional-drive-1",
        name="Existing regional drive",
        target=fm.FieldTarget.global_domain(),
        amplitude_B_T=0.001,
        direction=(0, 1, 0),
        spatial_profile=fm.UniformFieldProfile(),
        waveform=fm.Constant(),
    ).to_ir()
    scene = build_scene_document_from_builder({"field_drives": [regional_drive]})
    rebuilt = build_builder_from_scene_document(scene)
    overrides = builder_overrides_from_scene_document(scene)

    assert scene["field_drives"]["drives"] == [regional_drive]
    assert rebuilt["field_drives"] == [regional_drive]
    assert overrides["field_drives"] == [regional_drive]
    assert "solved_antenna_drives" not in scene


def test_scene_regional_drive_edit_survives_python_export_and_reload(tmp_path: Path) -> None:
    source = tmp_path / "regional_drive.py"
    source.write_text(
        """import fullmag as fm
study = fm.study("regional-drive-roundtrip")
film = study.geometry(fm.Box(100e-9, 40e-9, 5e-9), name="film")
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.01
study.field_drives.add(fm.RegionalFieldDrive(
    id="regional-1", name="Regional", target=fm.FieldTarget.global_domain(),
    amplitude_B_T=0.001, direction=(0, 1, 0),
    spatial_profile=fm.UniformFieldProfile(), waveform=fm.Constant(),
))
study.stages.add_run(stage_id="run", until=1e-12)
""",
        encoding="utf-8",
    )
    loaded = load_problem_from_script(source, lightweight_assets=True)
    scene = build_scene_document_from_builder(export_builder_draft(loaded))
    scene["field_drives"]["drives"][0]["amplitude_B_T"] = 0.002
    rendered = render_loaded_problem_as_script(
        loaded, overrides=builder_overrides_from_scene_document(scene)
    )
    exported = tmp_path / "regional_drive_export.py"
    exported.write_text(rendered, encoding="utf-8")
    reloaded = load_problem_from_script(exported, lightweight_assets=True)

    assert reloaded.problem.field_drives[0].amplitude_B_T == 0.002
    assert reloaded.problem.antenna_field_solve_stages == ()

    scene["field_drives"]["drives"] = []
    cleared = render_loaded_problem_as_script(
        loaded, overrides=builder_overrides_from_scene_document(scene)
    )
    cleared_path = tmp_path / "regional_drive_cleared.py"
    cleared_path.write_text(cleared, encoding="utf-8")
    assert load_problem_from_script(
        cleared_path, lightweight_assets=True
    ).problem.field_drives == ()
