from __future__ import annotations

from pathlib import Path
import re

import fullmag as fm
import pytest
from fullmag.model.canonical import canonical_json_bytes
from fullmag.model import BackendTarget, ExecutionMode, ExecutionPrecision
from fullmag.runtime.loader import load_problem_from_script
from fullmag.runtime.scene_document import (
    build_scene_document_from_builder,
)
from fullmag.runtime.scene_document_ir import scene_document_to_problem_ir
from fullmag.runtime.script_builder import (
    export_builder_draft,
    render_loaded_problem_as_script,
)


def _without_source_identity(problem_ir: dict[str, object]) -> dict[str, object]:
    comparable = dict(problem_ir)
    problem_meta = dict(comparable["problem_meta"])
    problem_meta.pop("script_source", None)
    problem_meta.pop("source_hash", None)
    comparable["problem_meta"] = problem_meta
    return comparable


def test_scene_document_lowers_to_canonical_ir_with_runtime_and_scene_semantics(
    tmp_path: Path,
) -> None:
    source = tmp_path / "scene_ir_source.py"
    source.write_text(
        """import fullmag as fm
study = fm.study('scene-lowering-study')
study.engine('fdm')
study.device('cpu', precision='double')
film = study.geometry(fm.Box(200e-9, 20e-9, 6e-9, name='film').translate((10e-9, 0.0, 0.0)), name='film', object_id='film')
film.Ms = 800000
film.Aex = 13e-12
film.m = fm.texture.uniform(0, 0, 1)
film.alpha.absorbing_boundary(total_width=40e-9, ramp_width=20e-9, max_damping=0.35, faces=('x+',))
""",
        encoding="utf-8",
    )
    loaded = load_problem_from_script(source, lightweight_assets=True)
    scene = build_scene_document_from_builder(export_builder_draft(loaded))
    object_id = scene["objects"][0]["id"]
    selection = fm.SelectionDefinition(
        selection_id="whole-film",
        expression=fm.select.in_object(object_id),
        name="Whole film",
    )
    constraint = fm.FrozenSpins(
        id="freeze-film",
        selector=fm.select.in_object(object_id),
    )
    scene["selections"] = [selection.to_ir()]
    scene["magnetization_constraints"] = [
        constraint.to_ir(selections=[selection])
    ]

    problem_ir = scene_document_to_problem_ir(
        scene,
        requested_backend="fdm",
        requested_device="cpu",
        requested_precision="double",
        requested_mode="strict",
        source_root=tmp_path,
    )

    canonical_source = tmp_path / "canonical_reference.py"
    canonical_source.write_text(render_loaded_problem_as_script(loaded), encoding="utf-8")
    reference_loaded = load_problem_from_script(
        canonical_source,
        lightweight_assets=True,
    )
    cleared_drives_source = render_loaded_problem_as_script(
        loaded,
        overrides={"field_drives": []},
    )
    assert "# Regional field drives" not in cleared_drives_source
    reference_ir = reference_loaded.to_ir(
        requested_backend=BackendTarget.FDM,
        execution_mode=ExecutionMode.STRICT,
        execution_precision=ExecutionPrecision.DOUBLE,
        include_geometry_assets=False,
        runtime_device_override="cpu",
        source_root=tmp_path,
    )
    reference_ir["selections"] = scene["selections"]
    reference_ir["magnetization_constraints"] = scene["magnetization_constraints"]

    assert problem_ir["problem_meta"]["name"] == "scene-lowering-study"
    assert problem_ir["problem_meta"]["runtime_metadata"]["runtime_selection"] == (
        reference_ir["problem_meta"]["runtime_metadata"]["runtime_selection"]
    )
    assert problem_ir["backend_policy"]["discretization_hints"] == (
        reference_ir["backend_policy"]["discretization_hints"]
    )
    assert problem_ir["problem_meta"]["runtime_metadata"].get("mesh_workflow") == (
        reference_ir["problem_meta"]["runtime_metadata"].get("mesh_workflow")
    )
    assert canonical_json_bytes(_without_source_identity(problem_ir)) == (
        canonical_json_bytes(_without_source_identity(reference_ir))
    )
    assert problem_ir["backend_policy"]["requested_backend"] == (
        reference_ir["backend_policy"]["requested_backend"]
    )
    assert problem_ir["backend_policy"]["execution_precision"] == (
        reference_ir["backend_policy"]["execution_precision"]
    )
    assert problem_ir["backend_policy"]["discretization_hints"] is None
    assert problem_ir["backend_policy"]["requested_backend"] == "fdm"
    assert problem_ir["backend_policy"]["execution_precision"] == "double"
    assert problem_ir["validation_profile"]["execution_mode"] == "strict"
    assert (
        problem_ir["problem_meta"]["runtime_metadata"]["runtime_selection"]["device"]
        == "cpu"
    )
    assert problem_ir["selections"] == scene["selections"]
    assert problem_ir["magnetization_constraints"][0]["id"] == "freeze-film"
    assert problem_ir["magnets"][0]["absorbing_boundary"]["max_damping"] == 0.35
    assert problem_ir["geometry"]["entries"][0]["kind"] == "translate"
    assert problem_ir["geometry"]["entries"][0]["by"] == [10e-9, 0.0, 0.0]
    assert problem_ir["geometry_assets"] is None


def test_scene_document_problem_ir_preserves_auxiliary_conductor_geometry(
    tmp_path: Path,
) -> None:
    source = tmp_path / "scene_auxiliary_source.py"
    source.write_text(
        """import fullmag as fm
study = fm.study('scene-auxiliary-study')
study.engine('fdm')
film = study.geometry(fm.Box(200e-9, 20e-9, 6e-9, name='film'), name='film', object_id='film')
film.Ms = 800000
film.Aex = 13e-12
film.m = fm.texture.uniform(0, 0, 1)
study.geometry_object(fm.Box(20e-9, 10e-9, 5e-9, name='lead').translate((4e-9, 0.0, 0.0)), name='lead', type='conductor')
""",
        encoding="utf-8",
    )
    loaded = load_problem_from_script(source, lightweight_assets=True)
    scene = build_scene_document_from_builder(export_builder_draft(loaded))

    problem_ir = scene_document_to_problem_ir(
        scene,
        requested_backend="fdm",
        requested_device="cpu",
        requested_precision="double",
        requested_mode="strict",
        source_root=tmp_path,
    )
    reference_ir = loaded.to_ir(
        requested_backend=BackendTarget.FDM,
        execution_mode=ExecutionMode.STRICT,
        execution_precision=ExecutionPrecision.DOUBLE,
        include_geometry_assets=False,
        runtime_device_override="cpu",
        source_root=tmp_path,
    )

    assert problem_ir["geometry"] == reference_ir["geometry"]
    assert problem_ir["regions"] == reference_ir["regions"]
    assert problem_ir["object_regions"] == reference_ir["object_regions"]


def test_scene_document_problem_ir_rejects_unrepresented_auxiliary_object_id(
    tmp_path: Path,
) -> None:
    source = tmp_path / "scene_auxiliary_identity_source.py"
    source.write_text(
        """import fullmag as fm
study = fm.study('scene-auxiliary-identity-study')
study.engine('fdm')
film = study.geometry(fm.Box(200e-9, 20e-9, 6e-9), name='film', object_id='film')
film.Ms = 800000
film.Aex = 13e-12
study.geometry_object(fm.Box(20e-9, 10e-9, 5e-9), name='lead', type='conductor')
""",
        encoding="utf-8",
    )
    loaded = load_problem_from_script(source, lightweight_assets=True)
    scene = build_scene_document_from_builder(export_builder_draft(loaded))
    auxiliary = next(obj for obj in scene["objects"] if obj["role"] == "conductor")
    auxiliary["id"] = "stable-lead-id"

    with pytest.raises(
        ValueError,
        match="scene_document_auxiliary_object_id_unsupported",
    ):
        scene_document_to_problem_ir(
            scene,
            requested_backend="fdm",
            requested_device="cpu",
            requested_precision="double",
            requested_mode="strict",
            source_root=tmp_path,
        )


@pytest.mark.parametrize(
    "transform_patch",
    [
        {"rotation_quat": [0.0, 0.0, 0.7071067811865476, 0.7071067811865476]},
        {"scale": [2.0, 1.0, 1.0]},
    ],
)
def test_scene_document_problem_ir_rejects_unrepresented_owner_transform(
    tmp_path: Path,
    transform_patch: dict[str, list[float]],
) -> None:
    source = tmp_path / "scene_transform_source.py"
    source.write_text(
        """import fullmag as fm
study = fm.study('scene-transform-study')
study.engine('fdm')
film = study.geometry(fm.Box(200e-9, 20e-9, 6e-9), name='film')
film.Ms = 800e3
film.Aex = 13e-12
film.m = fm.texture.uniform(0, 0, 1)
""",
        encoding="utf-8",
    )
    loaded = load_problem_from_script(source, lightweight_assets=True)
    scene = build_scene_document_from_builder(export_builder_draft(loaded))
    scene["objects"][0]["transform"].update(transform_patch)

    with pytest.raises(
        ValueError,
        match="owner_transform_rotation_scale_unsupported",
    ):
        scene_document_to_problem_ir(
            scene,
            requested_backend="fdm",
            requested_device="cpu",
            requested_precision="double",
            requested_mode="strict",
            source_root=tmp_path,
        )


def test_scene_document_problem_ir_preserves_sampled_field_magnetization(
    tmp_path: Path,
) -> None:
    source = tmp_path / "scene_sampled_source.py"
    state_path = tmp_path / "initial_magnetization.json"
    source.write_text(
        """import fullmag as fm
study = fm.study('scene-sampled-study')
study.engine('fdm')
film = study.geometry(fm.Box(200e-9, 20e-9, 6e-9), name='film')
film.Ms = 800e3
film.Aex = 13e-12
film.m = fm.texture.uniform(0, 0, 1)
""",
        encoding="utf-8",
    )
    fm.save_magnetization(state_path, [[0.0, 1.0, 0.0], [0.0, 0.0, 1.0]])
    loaded = load_problem_from_script(source, lightweight_assets=True)
    scene = build_scene_document_from_builder(export_builder_draft(loaded))
    magnetization = scene["magnetization_assets"][0]
    magnetization.update(
        {
            "kind": "sampled_field",
            "value": None,
            "source_path": str(state_path),
            "source_format": "json",
        }
    )

    problem_ir = scene_document_to_problem_ir(
        scene,
        requested_backend="fdm",
        requested_device="cpu",
        requested_precision="double",
        requested_mode="strict",
        source_root=tmp_path,
    )

    initial = problem_ir["magnets"][0]["initial_magnetization"]
    assert initial["kind"] == "sampled_field"
    assert initial["values"] == [[0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]


def test_scene_document_problem_ir_rejects_sampled_field_without_source(
    tmp_path: Path,
) -> None:
    source = tmp_path / "scene_missing_sampled_source.py"
    source.write_text(
        """import fullmag as fm
study = fm.study('scene-missing-sampled-source-study')
study.engine('fdm')
film = study.geometry(fm.Box(200e-9, 20e-9, 6e-9), name='film')
film.Ms = 800e3
film.Aex = 13e-12
film.m = fm.texture.uniform(0, 0, 1)
""",
        encoding="utf-8",
    )
    loaded = load_problem_from_script(source, lightweight_assets=True)
    scene = build_scene_document_from_builder(export_builder_draft(loaded))
    scene["magnetization_assets"][0].update(
        {
            "kind": "sampled_field",
            "value": None,
            "source_path": None,
            "source_format": None,
        }
    )

    with pytest.raises(
        ValueError,
        match="scene_document_sampled_magnetization_missing_source_path",
    ):
        scene_document_to_problem_ir(
            scene,
            requested_backend="fdm",
            requested_device="cpu",
            requested_precision="double",
            requested_mode="strict",
            source_root=tmp_path,
        )


def test_scene_document_problem_ir_matches_fem_authoring_surface(
    tmp_path: Path,
) -> None:
    source = tmp_path / "scene_fem_authoring_surface.py"
    source.write_text(
        """import fullmag as fm
study = fm.study('scene-fem-authoring-surface')
study.engine('fem')
study.device('cpu', precision='double')
film = study.geometry(fm.Box(120e-9, 40e-9, 5e-9, name='film'), name='film', object_id='film')
film.Ms = 800000
film.Aex = 13e-12
film.alpha = 0.01
film.m = fm.texture.uniform(1, 0, 0)
core = film.add_region('core', fm.Cylinder(radius=18e-9, height=5e-9))
shell = film.add_region('shell', fm.Box(70e-9, 30e-9, 5e-9))
film.set_material_field(
    'Ms',
    fm.fields.linear(base=800000, gradient=(0.0, 1e11, 0.0)),
    assignment_id='core-ms',
    region='core',
)
study.couplings.exchange(core, shell, coupling_id='core-shell-exchange')
study.objects.mesh.defaults(maximum_element_size=12e-9, order=2)
study.monitors.add_planar(
    monitor_id='midplane',
    name='Midplane',
    target=fm.MonitorTarget.object('film'),
    frame=fm.PlanarFrame.xy(
        position=0.0,
        extent=fm.PlanarExtent.target_bounds(padding=1e-9),
    ),
    operator=fm.PlaneSample(),
)
antenna = fm.GaussianPlaneWaveAntenna(
    id='drive',
    amplitude_B_T=3e-3,
    frequency_hz=4.5e9,
    wavelength_m=196e-9,
    sigma_x_m=196e-9,
    fwhm_y_m=440e-9,
    center_x_m=-1e-6,
    carrier_origin_x_m=0.0,
    t0_s=2e-9,
    activation=fm.DriveActivation.stage_ids(['run']),
)
for drive in antenna.to_drives():
    study.field_drives.add(drive)
study.stages.add_run(stage_id='run', until=1e-12)
""",
        encoding="utf-8",
    )
    loaded = load_problem_from_script(source, lightweight_assets=True)
    scene = build_scene_document_from_builder(export_builder_draft(loaded))

    problem_ir = scene_document_to_problem_ir(
        scene,
        requested_backend="fem",
        requested_device="cpu",
        requested_precision="double",
        requested_mode="strict",
        source_root=tmp_path,
    )
    canonical_source = tmp_path / "scene_fem_canonical.py"
    canonical_source.write_text(render_loaded_problem_as_script(loaded), encoding="utf-8")
    reference_loaded = load_problem_from_script(
        canonical_source,
        lightweight_assets=True,
    )
    reference_ir = reference_loaded.to_ir(
        requested_backend=BackendTarget.FEM,
        execution_mode=ExecutionMode.STRICT,
        execution_precision=ExecutionPrecision.DOUBLE,
        include_geometry_assets=False,
        runtime_device_override="cpu",
        source_root=tmp_path,
    )

    assert canonical_json_bytes(_without_source_identity(problem_ir)) == (
        canonical_json_bytes(_without_source_identity(reference_ir))
    )
    runtime_metadata = problem_ir["problem_meta"]["runtime_metadata"]
    assert runtime_metadata["study_pipeline"] == scene["study"]["study_pipeline"]
    assert runtime_metadata["wait_for_solve"] is True

    physical_problem_ir = {
        key: value
        for key, value in problem_ir.items()
        if key not in {"problem_meta", "backend_policy"}
    }
    physical_reference_ir = {
        key: value
        for key, value in reference_ir.items()
        if key not in {"problem_meta", "backend_policy"}
    }
    assert physical_problem_ir.keys() == physical_reference_ir.keys()
    for key in physical_problem_ir:
        assert canonical_json_bytes(physical_problem_ir[key]) == canonical_json_bytes(
            physical_reference_ir[key]
        ), key
    assert canonical_json_bytes(physical_problem_ir) == canonical_json_bytes(
        physical_reference_ir
    )
    assert problem_ir["backend_policy"]["discretization_hints"] == (
        reference_ir["backend_policy"]["discretization_hints"]
    )
    # SceneDocument carries editor mesh defaults absent from this DSL source;
    # their normalization remains a separate full-parity gap.
    assert problem_ir["backend_policy"]["requested_backend"] == "fem"
    assert problem_ir["backend_policy"]["execution_precision"] == "double"
    assert problem_ir["problem_meta"]["runtime_metadata"]["runtime_selection"][
        "device"
    ] == "cpu"
    assert problem_ir["couplings"][0]["coupling_id"] == "core-shell-exchange"
    assert problem_ir["material_parameter_fields"][0]["assignment_id"] == "core-ms"
    assert problem_ir["planar_monitors"][0]["id"] == "midplane"
    assert [drive["id"] for drive in problem_ir["field_drives"]] == [
        "drive_x",
        "drive_z",
    ]
    assert [
        node["stage_kind"] for node in scene["study"]["study_pipeline"]["nodes"]
    ] == ["run"]

    malformed_scene = {
        **scene,
        "field_drives": {"drives": [None]},
    }
    with pytest.raises(
        ValueError,
        match=r"SceneDocument\.field_drives\.drives\[0\] must be an object",
    ):
        scene_document_to_problem_ir(
            malformed_scene,
            requested_backend="fem",
            requested_device="cpu",
            requested_precision="double",
            requested_mode="strict",
            source_root=tmp_path,
        )


@pytest.mark.parametrize("invalid_drives", [None, {}, "not-a-list", [None]])
def test_script_builder_rejects_malformed_field_drive_overrides(
    tmp_path: Path,
    invalid_drives: object,
) -> None:
    source = tmp_path / "field_drive_override_validation.py"
    source.write_text(
        """import fullmag as fm
study = fm.study('field-drive-override-validation')
study.engine('fdm')
film = study.geometry(fm.Box(20e-9, 10e-9, 5e-9), name='film')
film.Ms = 800000
film.Aex = 13e-12
""",
        encoding="utf-8",
    )
    loaded = load_problem_from_script(source, lightweight_assets=True)

    expected_error = (
        "each field_drives override entry must be an object"
        if isinstance(invalid_drives, list)
        else "field_drives override must be a list"
    )
    with pytest.raises(ValueError, match=expected_error):
        render_loaded_problem_as_script(
            loaded,
            overrides={"field_drives": invalid_drives},
        )


def test_scene_document_problem_ir_preserves_study_table_autosave(tmp_path: Path) -> None:
    scene = _minimal_scene_document(tmp_path)
    autosave = fm.TableAutosave(
        every_steps=3,
        quantities=("step", "mx"),
        expressions=("mx+my",),
        table_id="scene-table",
    ).to_ir()
    scene["study"]["table_autosave"] = autosave

    problem_ir = _lower_scene_document(scene, tmp_path)

    assert problem_ir["study"]["sampling"]["table_autosave"] == autosave


def test_scene_document_problem_ir_accepts_default_empty_field_drive_state(
    tmp_path: Path,
) -> None:
    scene = _minimal_scene_document(tmp_path)
    # Rust SceneDocument serializes its default field-drive state as an empty
    # object because the empty `drives` vector is omitted by serde.
    scene["field_drives"] = {}

    problem_ir = _lower_scene_document(scene, tmp_path)

    assert problem_ir["field_drives"] == []


@pytest.mark.parametrize(
    ("field_drives", "message"),
    [
        (None, "SceneDocument.field_drives must be an object"),
        ([], "SceneDocument.field_drives must be an object"),
        (
            {"drives": None},
            "SceneDocument.field_drives.drives must be a list",
        ),
        (
            {"future": []},
            "SceneDocument.field_drives has unsupported fields: future",
        ),
    ],
)
def test_scene_document_problem_ir_rejects_malformed_field_drive_state(
    tmp_path: Path,
    field_drives: object,
    message: str,
) -> None:
    scene = _minimal_scene_document(tmp_path)
    scene["field_drives"] = field_drives

    with pytest.raises(ValueError, match=message.replace(".", r"\.")):
        _lower_scene_document(scene, tmp_path)


def test_scene_document_problem_ir_accepts_default_empty_monitor_state(
    tmp_path: Path,
) -> None:
    scene = _minimal_scene_document(tmp_path)
    scene["monitors"] = {}

    problem_ir = _lower_scene_document(scene, tmp_path)

    assert problem_ir["planar_monitors"] == []


@pytest.mark.parametrize(
    ("monitors", "message"),
    [
        (None, "SceneDocument.monitors must be an object"),
        ([], "SceneDocument.monitors must be an object"),
        (
            {"planar": None},
            "SceneDocument.monitors.planar must be a list",
        ),
        (
            {"planar": "not-a-list"},
            "SceneDocument.monitors.planar must be a list",
        ),
        (
            {"future": []},
            "SceneDocument.monitors has unsupported fields: future",
        ),
        (
            {"planar": [None]},
            "SceneDocument.monitors.planar[0] must be an object",
        ),
    ],
)
def test_scene_document_problem_ir_rejects_malformed_monitor_state(
    tmp_path: Path,
    monitors: object,
    message: str,
) -> None:
    scene = _minimal_scene_document(tmp_path)
    scene["monitors"] = monitors

    with pytest.raises(ValueError, match=re.escape(message)):
        _lower_scene_document(scene, tmp_path)


def test_scene_document_problem_ir_accepts_default_empty_current_module_state(
    tmp_path: Path,
) -> None:
    scene = _minimal_scene_document(tmp_path)
    scene["current_modules"] = {}

    problem_ir = _lower_scene_document(scene, tmp_path)

    assert problem_ir["current_modules"] == []
    assert problem_ir["excitation_analysis"] is None


@pytest.mark.parametrize("transport_location", ["current_modules", "current_transports"])
def test_scene_document_problem_ir_rejects_unknown_current_transport_fields(
    tmp_path: Path,
    transport_location: str,
) -> None:
    scene = _minimal_scene_document(tmp_path)
    transport = {
        "kind": "current_transport",
        "name": "legacy-drive",
        "model": "prescribed_density",
        "current_density": [0.0, 0.0, 1e10],
        "future_policy": "new",
    }
    if transport_location == "current_modules":
        scene["current_modules"] = {"modules": [transport]}
    else:
        scene["current_transports"] = [transport]

    with pytest.raises(
        ValueError,
        match="current_transport has unsupported fields: future_policy",
    ):
        _lower_scene_document(scene, tmp_path)


@pytest.mark.parametrize(
    ("transport_patch", "message"),
    [
        (
            {"domain": [{"object_id": "film", "future_policy": "new"}]},
            "current_transport.domain[0] has unsupported fields: future_policy",
        ),
        (
            {
                "time_envelope": {
                    "kind": "constant",
                    "value": 1.0,
                    "future_policy": "new",
                }
            },
            "current_transport.time_envelope has unsupported fields: future_policy",
        ),
    ],
)
def test_scene_document_problem_ir_rejects_unknown_nested_current_transport_fields(
    tmp_path: Path,
    transport_patch: dict[str, object],
    message: str,
) -> None:
    scene = _minimal_scene_document(tmp_path)
    transport: dict[str, object] = {
        "kind": "current_transport",
        "name": "legacy-drive",
        "model": "prescribed_density",
        "current_density": [0.0, 0.0, 1e10],
    }
    transport.update(transport_patch)
    scene["current_transports"] = [transport]

    with pytest.raises(ValueError, match=re.escape(message)):
        _lower_scene_document(scene, tmp_path)


@pytest.mark.parametrize(
    ("current_modules", "message"),
    [
        (None, "SceneDocument.current_modules must be an object"),
        ([], "SceneDocument.current_modules must be an object"),
        (
            {"modules": None},
            "SceneDocument.current_modules.modules must be a list",
        ),
        (
            {"modules": [None]},
            "SceneDocument.current_modules.modules[0] must be an object",
        ),
        (
            {"future_policy": "new"},
            "SceneDocument.current_modules has unsupported fields: future_policy",
        ),
        (
            {"modules": [{"future_policy": "new"}]},
            "SceneDocument.current_modules.modules[0] has unsupported fields: future_policy",
        ),
        (
            {
                "modules": [
                    {
                        "kind": "antenna_field_source",
                        "name": "drive",
                        "solver": "mqs_2p5d_az",
                        "air_box_factor": 0.0,
                        "antenna_kind": "MicrostripAntenna",
                        "drive": {"current_a": 0.0, "future_policy": "new"},
                    }
                ]
            },
            "SceneDocument.current_modules.modules[0].drive has unsupported fields: future_policy",
        ),
        (
            {
                "modules": [
                    {
                        "kind": "antenna_field_source",
                        "name": "drive",
                        "solver": "mqs_2p5d_az",
                        "air_box_factor": 0.0,
                        "antenna_kind": "MicrostripAntenna",
                        "drive": None,
                    }
                ]
            },
            "SceneDocument.current_modules.modules[0].drive must be an object",
        ),
        (
            {"excitation_analysis": {"future_policy": "new"}},
            "SceneDocument.current_modules.excitation_analysis has unsupported "
            "fields: future_policy",
        ),
        (
            {"excitation_analysis": []},
            "SceneDocument.current_modules.excitation_analysis must be an object",
        ),
    ],
)
def test_scene_document_problem_ir_rejects_malformed_current_module_state(
    tmp_path: Path,
    current_modules: object,
    message: str,
) -> None:
    scene = _minimal_scene_document(tmp_path)
    scene["current_modules"] = current_modules

    with pytest.raises(ValueError, match=re.escape(message)):
        _lower_scene_document(scene, tmp_path)


@pytest.mark.parametrize(
    ("patch", "message"),
    [
        ({"unexpected_physics": {"D": 1.0}}, "scene_document_unlowered_fields"),
        (
            {"study": {"future_solver_policy": "new-policy"}},
            "scene_document_unlowered_study_fields",
        ),
        ({"outputs": "not-an-object"}, r"SceneDocument\.outputs must be an object"),
        (
            {"outputs": {"items": "not-a-list"}},
            r"SceneDocument\.outputs\.items must be a list",
        ),
        (
            {"study": {"mesh_interfaces": [{"id": "unlowered-interface"}]}},
            "scene_document_mesh_interfaces_not_supported",
        ),
    ],
)
def test_scene_document_problem_ir_rejects_unlowered_semantics(
    tmp_path: Path,
    patch: dict[str, object],
    message: str,
) -> None:
    scene = _minimal_scene_document(tmp_path)
    if "study" in patch:
        scene["study"].update(patch["study"])
    else:
        scene.update(patch)

    with pytest.raises(ValueError, match=message):
        _lower_scene_document(scene, tmp_path)


def _minimal_scene_document(tmp_path: Path) -> dict[str, object]:
    source = tmp_path / "scene_projection_source.py"
    source.write_text(
        """import fullmag as fm
study = fm.study('scene-projection-study')
study.engine('fdm')
film = study.geometry(fm.Box(20e-9, 10e-9, 5e-9), name='film', object_id='film')
film.Ms = 800000
film.Aex = 13e-12
film.m = fm.texture.uniform(0, 0, 1)
""",
        encoding="utf-8",
    )
    loaded = load_problem_from_script(source, lightweight_assets=True)
    return build_scene_document_from_builder(export_builder_draft(loaded))


def _lower_scene_document(
    scene: dict[str, object],
    source_root: Path,
) -> dict[str, object]:
    return scene_document_to_problem_ir(
        scene,
        requested_backend="fdm",
        requested_device="cpu",
        requested_precision="double",
        requested_mode="strict",
        source_root=source_root,
    )
