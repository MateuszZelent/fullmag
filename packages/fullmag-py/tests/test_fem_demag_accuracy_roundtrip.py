from __future__ import annotations

from pathlib import Path

import pytest

from fullmag.model import BackendTarget, ExecutionMode, ExecutionPrecision
from fullmag.runtime.loader import load_problem_from_script
from fullmag.runtime.scene_document import (
    build_builder_from_scene_document,
    build_scene_document_from_builder,
    builder_overrides_from_scene_document,
)
from fullmag.runtime.scene_document_ir import scene_document_to_problem_ir
from fullmag.runtime.script_builder import (
    export_builder_draft,
    render_loaded_problem_as_script,
    render_scene_document_as_script,
)


CONTRACT = {
    "schema_version": "fullmag.fem.demag_accuracy.v1",
    "profile": " SP4 canonical compatibility ",
    "required_potential_order": 2,
    "required_topology": "all_tet",
}


def _load_fem_study(
    tmp_path: Path,
    *,
    device: str = "cpu",
    extra_metadata: str = "",
):
    source = tmp_path / "fem_accuracy_authoring.py"
    source.write_text(
        f"""import fullmag as fm
study = fm.study('fem-accuracy-contract-roundtrip')
study.engine('fem')
study.device({device!r}, precision='double')
film = study.geometry(fm.Box(20e-9, 10e-9, 2e-9, name='film'), name='film', object_id='film')
film.Ms = 800000
film.Aex = 13e-12
film.m = fm.texture.uniform(1, 0, 0)
fm.runtime_metadata('fem_demag_accuracy_contract', {{
    'schema_version': 'fullmag.fem.demag_accuracy.v1',
    'profile': ' SP4 canonical compatibility ',
    'required_potential_order': 2,
    'required_topology': 'all_tet',
}})
"""
        + extra_metadata,
        encoding="utf-8",
    )
    return load_problem_from_script(source, lightweight_assets=True)


def _problem_ir(
    loaded,
    tmp_path: Path,
    *,
    device: str = "cpu",
) -> dict[str, object]:
    return loaded.to_ir(
        requested_backend=BackendTarget.FEM,
        execution_mode=ExecutionMode.STRICT,
        execution_precision=ExecutionPrecision.DOUBLE,
        include_geometry_assets=False,
        runtime_device_override=device,
        source_root=tmp_path,
    )


def _runtime(ir: dict[str, object]) -> dict[str, object]:
    return ir["problem_meta"]["runtime_metadata"]


@pytest.mark.parametrize("device", ["cpu", "gpu"])
def test_fem_demag_accuracy_contract_survives_builder_scene_script_and_ir(
    tmp_path: Path,
    device: str,
) -> None:
    loaded = _load_fem_study(
        tmp_path,
        device=device,
        extra_metadata="fm.runtime_metadata('unrelated_marker', {'must_not_copy': True})\n",
    )

    draft = export_builder_draft(loaded)
    assert draft["fem_demag_accuracy_contract"] == CONTRACT
    assert draft["requested_device"] == device
    assert "unrelated_marker" not in draft

    scene = build_scene_document_from_builder(draft)
    assert scene["study"]["fem_demag_accuracy_contract"] == CONTRACT
    assert scene["study"]["requested_device"] == device
    rebuilt = build_builder_from_scene_document(scene)
    assert rebuilt["fem_demag_accuracy_contract"] == CONTRACT

    scene_ir = scene_document_to_problem_ir(
        scene,
        requested_backend="fem",
        requested_device=device,
        requested_precision="double",
        requested_mode="strict",
        source_root=tmp_path,
    )
    scene_runtime = _runtime(scene_ir)
    assert scene_runtime["fem_demag_accuracy_contract"] == CONTRACT
    assert scene_runtime["runtime_selection"]["device"] == device
    assert "unrelated_marker" not in _runtime(scene_ir)

    canonical_source = render_scene_document_as_script(scene)
    assert "fm.runtime_metadata('fem_demag_accuracy_contract'" in canonical_source
    canonical_path = tmp_path / "fem_accuracy_canonical.py"
    canonical_path.write_text(canonical_source, encoding="utf-8")
    canonical_loaded = load_problem_from_script(
        canonical_path,
        lightweight_assets=True,
    )
    canonical_runtime = _runtime(
        _problem_ir(canonical_loaded, tmp_path, device=device)
    )
    assert canonical_runtime["fem_demag_accuracy_contract"] == CONTRACT
    assert canonical_runtime["runtime_selection"]["device"] == device
    assert "unrelated_marker" not in _runtime(
        _problem_ir(canonical_loaded, tmp_path, device=device)
    )

    direct_source = render_loaded_problem_as_script(loaded)
    direct_path = tmp_path / "fem_accuracy_direct_canonical.py"
    direct_path.write_text(direct_source, encoding="utf-8")
    direct_loaded = load_problem_from_script(direct_path, lightweight_assets=True)
    direct_runtime = _runtime(
        _problem_ir(direct_loaded, tmp_path, device=device)
    )
    assert direct_runtime["fem_demag_accuracy_contract"] == CONTRACT
    assert direct_runtime["runtime_selection"]["device"] == device


def test_authored_null_fem_demag_accuracy_contract_is_rejected(tmp_path: Path) -> None:
    source = tmp_path / "fem_accuracy_authored_null.py"
    source.write_text(
        """import fullmag as fm
study = fm.study('fem-accuracy-authored-null')
study.engine('fem')
study.device('cpu', precision='double')
film = study.geometry(fm.Box(20e-9, 10e-9, 2e-9, name='film'), name='film', object_id='film')
film.Ms = 800000
film.Aex = 13e-12
film.m = fm.texture.uniform(1, 0, 0)
fm.runtime_metadata('fem_demag_accuracy_contract', None)
""",
        encoding="utf-8",
    )
    loaded = load_problem_from_script(source, lightweight_assets=True)

    with pytest.raises(ValueError, match="fem_demag_accuracy_contract"):
        export_builder_draft(loaded)
    with pytest.raises(ValueError, match="fem_demag_accuracy_contract"):
        render_loaded_problem_as_script(loaded)


def test_fem_demag_accuracy_contract_null_override_clears_loaded_value(
    tmp_path: Path,
) -> None:
    loaded = _load_fem_study(tmp_path)
    cleared_source = render_loaded_problem_as_script(
        loaded,
        overrides={"runtime_selection": {"fem_demag_accuracy_contract": None}},
    )
    cleared_path = tmp_path / "fem_accuracy_cleared.py"
    cleared_path.write_text(cleared_source, encoding="utf-8")
    cleared = load_problem_from_script(cleared_path, lightweight_assets=True)
    assert "fem_demag_accuracy_contract" not in _runtime(
        _problem_ir(cleared, tmp_path)
    )

    scene = build_scene_document_from_builder(export_builder_draft(loaded))
    scene["study"]["fem_demag_accuracy_contract"] = None
    overrides = builder_overrides_from_scene_document(scene)
    assert overrides["fem_demag_accuracy_contract"] is None
    scene_source = render_scene_document_as_script(scene)
    scene_path = tmp_path / "fem_accuracy_scene_cleared.py"
    scene_path.write_text(scene_source, encoding="utf-8")
    scene_cleared = load_problem_from_script(scene_path, lightweight_assets=True)
    assert "fem_demag_accuracy_contract" not in _runtime(
        _problem_ir(scene_cleared, tmp_path)
    )


def test_scene_ir_rejects_invalid_fem_demag_accuracy_contract(
    tmp_path: Path,
) -> None:
    scene = build_scene_document_from_builder({"geometries": []})
    scene["study"]["fem_demag_accuracy_contract"] = {
        **CONTRACT,
        "required_potential_order": True,
    }
    with pytest.raises(ValueError, match="fem_demag_accuracy_contract"):
        scene_document_to_problem_ir(
            scene,
            requested_backend="fem",
            requested_device="cpu",
            requested_precision="double",
            requested_mode="strict",
            source_root=tmp_path,
        )


def test_nested_runtime_selection_contract_override_takes_precedence(
    tmp_path: Path,
) -> None:
    loaded = _load_fem_study(tmp_path)
    nested = {**CONTRACT, "profile": "nested Rust Scene override"}
    top_level = {**CONTRACT, "profile": "top-level Python Scene override"}
    source = render_loaded_problem_as_script(
        loaded,
        overrides={
            "runtime_selection": {"fem_demag_accuracy_contract": nested},
            "fem_demag_accuracy_contract": top_level,
        },
    )
    canonical_path = tmp_path / "fem_accuracy_nested_override.py"
    canonical_path.write_text(source, encoding="utf-8")
    canonical = load_problem_from_script(canonical_path, lightweight_assets=True)
    canonical_runtime = _runtime(_problem_ir(canonical, tmp_path))
    assert canonical_runtime["fem_demag_accuracy_contract"] == nested


@pytest.mark.parametrize(
    "invalid",
    [
        pytest.param("not-an-object", id="wrong-container"),
        pytest.param({}, id="missing-fields"),
        pytest.param({**CONTRACT, "extra": True}, id="unknown-field"),
        pytest.param({**CONTRACT, "schema_version": "future.v2"}, id="schema-version"),
        pytest.param({**CONTRACT, "profile": ""}, id="empty-profile"),
        pytest.param({**CONTRACT, "profile": "  "}, id="blank-profile"),
        pytest.param({**CONTRACT, "profile": 7}, id="profile-type"),
        pytest.param({**CONTRACT, "required_potential_order": True}, id="boolean-order"),
        pytest.param({**CONTRACT, "required_potential_order": 1}, id="wrong-order"),
        pytest.param({**CONTRACT, "required_potential_order": 2.0}, id="float-order"),
        pytest.param({**CONTRACT, "required_topology": "mixed"}, id="wrong-topology"),
    ],
)
def test_fem_demag_accuracy_contract_rejects_invalid_values(invalid: object) -> None:
    with pytest.raises(ValueError, match="fem_demag_accuracy_contract"):
        build_scene_document_from_builder(
            {
                "geometries": [],
                "fem_demag_accuracy_contract": invalid,
            }
        )
