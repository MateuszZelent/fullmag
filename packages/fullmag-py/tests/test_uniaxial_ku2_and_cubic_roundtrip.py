from __future__ import annotations

from pathlib import Path

import pytest

import fullmag as fm
from fullmag.runtime.loader import LoadedProblem, load_problem_from_script
from fullmag.runtime.scene_document import (
    build_builder_from_scene_document,
    build_scene_document_from_builder,
)
from fullmag.runtime.script_builder import (
    export_builder_draft,
    render_scene_document_as_script,
)


def _loaded_from_problem(problem: fm.Problem, path: Path) -> LoadedProblem:
    return LoadedProblem(
        problem=problem,
        source_path=path,
        entrypoint_kind="problem",
        script_source="",
        stages=(),
        workspace_problem=problem,
    )


def test_material_ku2_and_cubic_anisotropy_survive_scene_and_script_roundtrip(
    tmp_path: Path,
) -> None:
    material = fm.Material(
        name="hcp_co",
        Ms=1.44e6,
        A=3.0e-11,
        alpha=0.01,
        Ku1=4.5e5,
        Ku2=1.5e5,
        anisU=(0.0, 0.0, 1.0),
    )
    magnet = fm.Ferromagnet(
        name="hcp_co_film",
        geometry=fm.Box(size=(100e-9, 100e-9, 10e-9)),
        material=material,
    )
    problem = fm.Problem(
        name="ku2_cubic_dmi_roundtrip",
        magnets=[magnet],
        energy=[
            fm.Exchange(),
            fm.Demag(),
            fm.CubicAnisotropy(
                kc1=4.8e4,
                kc2=5.0e3,
                kc3=0.0,
                axis1=(1.0, 0.0, 0.0),
                axis2=(0.0, 1.0, 0.0),
            ),
            fm.InterfacialDMI(D=1.2e-3, interface_normal=(0.0, 1.0, 0.0)),
        ],
        study=fm.Relaxation(outputs=[], dynamics=fm.LLG(fixed_timestep=1e-13)),
        discretization=fm.DiscretizationHints(fdm=fm.FDM(cell=(5e-9, 5e-9, 5e-9))),
    )

    loaded = _loaded_from_problem(problem, tmp_path / "source.py")
    builder = export_builder_draft(loaded)
    scene = build_scene_document_from_builder(builder)

    stack = {
        entry["kind"]: entry
        for entry in scene["objects"][0]["physics_stack"]
    }
    assert "uniaxial_anisotropy" in stack
    assert stack["uniaxial_anisotropy"]["params"]["ku1"] == pytest.approx(4.5e5)
    assert stack["uniaxial_anisotropy"]["params"]["ku2"] == pytest.approx(1.5e5)
    assert stack["uniaxial_anisotropy"]["params"]["axis"] == pytest.approx([0.0, 0.0, 1.0])

    assert "cubic_anisotropy" in stack
    assert stack["cubic_anisotropy"]["params"]["kc1"] == pytest.approx(4.8e4)
    assert stack["cubic_anisotropy"]["params"]["kc2"] == pytest.approx(5.0e3)
    assert stack["cubic_anisotropy"]["params"]["kc3"] == pytest.approx(0.0)
    assert stack["cubic_anisotropy"]["params"]["axis1"] == pytest.approx([1.0, 0.0, 0.0])
    assert stack["cubic_anisotropy"]["params"]["axis2"] == pytest.approx([0.0, 1.0, 0.0])

    assert "interfacial_dmi" in stack
    assert stack["interfacial_dmi"]["params"]["dind"] == pytest.approx(1.2e-3)
    assert stack["interfacial_dmi"]["params"]["interface_normal"] == pytest.approx(
        [0.0, 1.0, 0.0]
    )

    rendered_script = render_scene_document_as_script(scene)
    assert ".Ku2 = 150000.0" in rendered_script
    assert ".Kc1 = 48000.0" in rendered_script
    assert ".Kc2 = 5000.0" in rendered_script
    assert ".anisC1 = (1.0, 0.0, 0.0)" in rendered_script
    assert ".anisC2 = (0.0, 1.0, 0.0)" in rendered_script
    assert ".dmi_interface_normal = (0.0, 1.0, 0.0)" in rendered_script

    roundtrip_path = tmp_path / "roundtrip.py"
    roundtrip_path.write_text(rendered_script, encoding="utf-8")
    reloaded = load_problem_from_script(roundtrip_path, lightweight_assets=True)
    reloaded_mat = reloaded.problem.magnets[0].material
    assert reloaded_mat.Ku1 == pytest.approx(4.5e5)
    assert reloaded_mat.Ku2 == pytest.approx(1.5e5)
    assert reloaded_mat.anisU == pytest.approx((0.0, 0.0, 1.0))
    assert reloaded_mat.Kc1 == pytest.approx(4.8e4)
    assert reloaded_mat.Kc2 == pytest.approx(5.0e3)
    assert reloaded_mat.Kc3 == pytest.approx(0.0)
    assert reloaded_mat.anisC1 == pytest.approx((1.0, 0.0, 0.0))
    assert reloaded_mat.anisC2 == pytest.approx((0.0, 1.0, 0.0))

    dmi_terms = [
        term
        for term in reloaded.problem.energy
        if isinstance(term, fm.InterfacialDMI)
    ]
    assert len(dmi_terms) == 1
    assert dmi_terms[0].D == pytest.approx(1.2e-3)
    assert dmi_terms[0].interface_normal == pytest.approx((0.0, 1.0, 0.0))


def test_ku2_only_material_activates_uniaxial_anisotropy_in_scene(tmp_path: Path) -> None:
    material = fm.Material(
        name="ku2_only",
        Ms=1.0e6,
        A=1.5e-11,
        alpha=0.01,
        Ku2=7.5e4,
    )
    problem = fm.Problem(
        name="ku2_only_roundtrip",
        magnets=[
            fm.Ferromagnet(
                name="film",
                geometry=fm.Box(size=(50e-9, 50e-9, 5e-9)),
                material=material,
            )
        ],
        energy=[fm.Exchange(), fm.Demag()],
        study=fm.Relaxation(outputs=[], dynamics=fm.LLG(fixed_timestep=1e-13)),
        discretization=fm.DiscretizationHints(fdm=fm.FDM(cell=(5e-9, 5e-9, 5e-9))),
    )

    builder = export_builder_draft(_loaded_from_problem(problem, tmp_path / "ku2_only.py"))
    scene = build_scene_document_from_builder(builder)
    stack = {
        entry["kind"]: entry
        for entry in scene["objects"][0]["physics_stack"]
    }
    assert "uniaxial_anisotropy" in stack
    assert stack["uniaxial_anisotropy"]["params"]["ku1"] == pytest.approx(0.0)
    assert stack["uniaxial_anisotropy"]["params"]["ku2"] == pytest.approx(7.5e4)

    rebuilt = build_builder_from_scene_document(scene)
    rebuilt_stack = {
        entry["kind"]: entry
        for entry in rebuilt["geometries"][0]["physics_stack"]
    }
    assert rebuilt_stack["uniaxial_anisotropy"]["params"]["ku2"] == pytest.approx(7.5e4)


def test_cubic_anisotropy_rejects_non_orthogonal_axes_in_scene() -> None:
    scene = {
        "version": "scene.v2",
        "revision": 1,
        "materials": [
            {
                "id": "mat:fe",
                "name": "Iron",
                "properties": {"Ms": 1.71e6, "Aex": 2.1e-11, "alpha": 0.01},
            }
        ],
        "magnetization_assets": [
            {
                "id": "mag:fe",
                "name": "Uniform",
                "kind": "uniform",
                "value": [1.0, 0.0, 0.0],
            }
        ],
        "objects": [
            {
                "id": "fe",
                "name": "fe",
                "role": "magnet",
                "geometry": {
                    "geometry_kind": "Box",
                    "geometry_params": {"size": [40e-9, 40e-9, 10e-9]},
                },
                "transform": {
                    "translation": [0.0, 0.0, 0.0],
                    "rotation_quat": [0.0, 0.0, 0.0, 1.0],
                    "scale": [1.0, 1.0, 1.0],
                    "pivot": [0.0, 0.0, 0.0],
                },
                "material_ref": "mat:fe",
                "magnetization_ref": "mag:fe",
                "physics_stack": [
                    {"kind": "exchange", "enabled": True, "params": None},
                    {"kind": "demag", "enabled": True, "params": None},
                    {
                        "kind": "cubic_anisotropy",
                        "enabled": True,
                        "params": {
                            "kc1": 4.8e4,
                            "kc2": 0.0,
                            "kc3": 0.0,
                            "axis1": [1.0, 0.0, 0.0],
                            "axis2": [1.0, 1.0, 0.0],
                        },
                    },
                ],
            }
        ],
        "study": {"backend": "fdm"},
    }
    with pytest.raises(ValueError, match="orthogonal"):
        build_builder_from_scene_document(scene)
