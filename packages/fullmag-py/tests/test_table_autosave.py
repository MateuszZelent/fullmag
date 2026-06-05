import textwrap
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest

import fullmag as fm
from fullmag.runtime.loader import load_problem_from_script
from fullmag.runtime.scene_document import (
    build_builder_from_scene_document,
    builder_overrides_from_scene_document,
    build_scene_document_from_builder,
)
from fullmag.runtime.script_builder import export_builder_draft
from fullmag.runtime.script_builder import rewrite_loaded_problem_script


def test_table_autosave_lowers_default_columns_to_sampling_ir() -> None:
    study = fm.Relaxation(
        outputs=[fm.SaveScalar("E_total", every=1e-12)],
        table_autosave=fm.TableAutosave(t_sampl=2e-12),
    )

    assert study.to_ir()["sampling"]["table_autosave"] == {
        "kind": "table_autosave",
        "table_id": "default",
        "sample_period_s": 2e-12,
        "quantities": ["step", "t", "mx", "my", "mz", "e_total", "max_torque"],
    }


def test_table_autosave_accepts_custom_quantities_and_rejects_empty_lists() -> None:
    autosave = fm.TableAutosave(
        t_sampl=5e-13,
        quantities=["step", "t", "mx"],
        extra_quantities=["e_demag"],
    )

    assert autosave.to_ir()["quantities"] == ["step", "t", "mx", "e_demag"]

    with pytest.raises(ValueError, match="quantities must not be empty"):
        fm.TableAutosave(t_sampl=1e-12, quantities=[])


def test_time_evolution_accepts_study_table_autosave_helper() -> None:
    study = fm.TimeEvolution(
        dynamics=fm.LLG(),
        outputs=[fm.SaveScalar("E_total", every=1e-12)],
    ).table_autosave(t_sampl=1e-12, quantities=["step", "t"])

    assert study.to_ir()["sampling"]["table_autosave"]["quantities"] == ["step", "t"]


def test_table_autosave_rejects_non_positive_sample_period() -> None:
    with pytest.raises(ValueError, match="t_sampl must be positive"):
        fm.TableAutosave(t_sampl=0.0)


def test_table_autosave_rejects_unsupported_quantity_ids() -> None:
    with pytest.raises(ValueError, match="unsupported table_autosave quantity 'not_a_quantity'"):
        fm.TableAutosave(t_sampl=1e-12, quantities=["step", "not_a_quantity"])

    with pytest.raises(ValueError, match="unsupported table_autosave quantity 'not_extra'"):
        fm.TableAutosave(t_sampl=1e-12, extra_quantities=["not_extra"])


def test_flat_tableautosave_round_trips_as_sampling_table_autosave() -> None:
    script = textwrap.dedent(
        """
        import fullmag as fm

        fm.name("table_roundtrip")
        fm.engine("fdm")
        fm.cell(2e-9, 2e-9, 2e-9)

        body = fm.geometry(fm.Box(20e-9, 10e-9, 2e-9), name="body")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.alpha = 0.1
        body.m = fm.texture.uniform(1.0, 0.0, 0.0)

        fm.tableautosave(5e-12, quantities=["step", "t", "mx", "e_total"])
        fm.run(10e-12)
        """
    )

    with TemporaryDirectory() as tmpdir:
        script_path = Path(tmpdir) / "table_roundtrip.py"
        script_path.write_text(script, encoding="utf-8")

        loaded = load_problem_from_script(script_path, lightweight_assets=True)
        table_autosave = loaded.problem.to_ir()["study"]["sampling"]["table_autosave"]
        assert table_autosave == {
            "kind": "table_autosave",
            "table_id": "default",
            "sample_period_s": 5e-12,
            "quantities": ["step", "t", "mx", "e_total"],
        }

        rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
        assert 'fm.tableautosave(5e-12, quantities=["step", "t", "mx", "e_total"])' in rewritten

        rewritten_path = Path(tmpdir) / "table_roundtrip_rewritten.py"
        rewritten_path.write_text(rewritten, encoding="utf-8")
        reloaded = load_problem_from_script(rewritten_path, lightweight_assets=True)

    assert (
        reloaded.problem.to_ir()["study"]["sampling"]["table_autosave"]
        == table_autosave
    )


def test_table_autosave_survives_builder_scene_document_round_trip() -> None:
    script = textwrap.dedent(
        """
        import fullmag as fm

        fm.name("table_scene_roundtrip")
        fm.engine("fdm")
        fm.cell(2e-9, 2e-9, 2e-9)

        body = fm.geometry(fm.Box(20e-9, 10e-9, 2e-9), name="body")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.m = fm.texture.uniform(1.0, 0.0, 0.0)

        fm.tableautosave(2e-12, quantities=["step", "mx"])
        fm.run(10e-12)
        """
    )

    with TemporaryDirectory() as tmpdir:
        script_path = Path(tmpdir) / "table_scene_roundtrip.py"
        script_path.write_text(script, encoding="utf-8")
        loaded = load_problem_from_script(script_path, lightweight_assets=True)

        draft = export_builder_draft(loaded)
        scene = build_scene_document_from_builder(draft)
        rebuilt = build_builder_from_scene_document(scene)

    expected = {
        "kind": "table_autosave",
        "table_id": "default",
        "sample_period_s": 2e-12,
        "quantities": ["step", "mx"],
    }
    assert draft["table_autosave"] == expected
    assert scene["study"]["table_autosave"] == expected
    assert rebuilt["table_autosave"] == expected


def test_scene_document_table_autosave_override_rewrites_script() -> None:
    script = textwrap.dedent(
        """
        import fullmag as fm

        fm.name("table_scene_override")
        fm.engine("fdm")
        fm.cell(2e-9, 2e-9, 2e-9)

        body = fm.geometry(fm.Box(20e-9, 10e-9, 2e-9), name="body")
        body.Ms = 800e3
        body.Aex = 13e-12
        body.m = fm.texture.uniform(1.0, 0.0, 0.0)

        fm.tableautosave(2e-12, quantities=["step", "mx"])
        fm.run(10e-12)
        """
    )

    with TemporaryDirectory() as tmpdir:
        script_path = Path(tmpdir) / "table_scene_override.py"
        script_path.write_text(script, encoding="utf-8")
        loaded = load_problem_from_script(script_path, lightweight_assets=True)

        draft = export_builder_draft(loaded)
        scene = build_scene_document_from_builder(draft)
        scene["study"]["table_autosave"] = {
            "kind": "table_autosave",
            "table_id": "default",
            "sample_period_s": 4e-12,
            "quantities": ["step", "t", "e_total"],
        }
        rewritten = rewrite_loaded_problem_script(
            loaded,
            overrides=builder_overrides_from_scene_document(scene),
        )["rendered_source"]

    assert 'fm.tableautosave(4e-12, quantities=["step", "t", "e_total"])' in rewritten
    assert 'fm.tableautosave(2e-12, quantities=["step", "mx"])' not in rewritten
