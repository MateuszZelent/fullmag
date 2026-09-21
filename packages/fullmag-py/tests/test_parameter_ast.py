from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
import textwrap

import pytest

import fullmag as fm
from fullmag.runtime.script_builder import rewrite_loaded_problem_script


def test_parameter_expression_normalizes_si_and_roundtrips() -> None:
    width = fm.ParameterExpression.constant(250.0, unit="nm")
    assert width.dimension == "length"
    assert width.to_ir()["value_si"] == pytest.approx(250e-9)

    library = fm.ParameterLibrary()
    library.define("width", width, display_unit="nm", description="film width")
    library.define(
        "double_width",
        2.0 * fm.ParameterExpression.reference("width"),
        display_unit="nm",
    )

    assert library.resolve("double_width").value_si == pytest.approx(500e-9)
    restored = fm.ParameterLibrary.from_ir(library.to_ir())
    assert restored.resolve_all() == library.resolve_all()
    assert restored.to_ir() == library.to_ir()


def test_parameter_dimensions_are_checked_before_lowering() -> None:
    length = fm.ParameterExpression.constant(1.0, unit="m")
    duration = fm.ParameterExpression.constant(1.0, unit="s")
    with pytest.raises(ValueError, match="parameter_dimension_mismatch"):
        _ = length + duration

    with pytest.raises(ValueError, match="parameter_display_unit_mismatch"):
        fm.ParameterLibrary().define(
            "length",
            length,
            display_unit="s",
        )


def test_parameter_library_rejects_cycles_and_unknown_references() -> None:
    library = fm.ParameterLibrary()
    library.define("a", fm.ParameterExpression.reference("b"))
    library.define("b", fm.ParameterExpression.reference("a"))
    with pytest.raises(ValueError, match="parameter_reference_cycle: a -> b -> a"):
        library.resolve("a")

    unknown = fm.ParameterLibrary()
    unknown.define("a", fm.ParameterExpression.reference("missing"))
    with pytest.raises(ValueError, match="parameter_unknown_reference"):
        unknown.resolve("a")


def test_display_metadata_is_outside_numerical_parameter_identity() -> None:
    first = fm.ParameterLibrary()
    first.define("width", fm.ParameterExpression.constant(1.0, unit="um"), display_unit="nm")
    second = fm.ParameterLibrary()
    second.define("width", fm.ParameterExpression.constant(1.0, unit="um"), display_unit="um")

    assert first.numerical_ir() == second.numerical_ir()
    assert first.numerical_sha256() == second.numerical_sha256()
    assert first.to_ir() != second.to_ir()


def test_problem_lowers_parameter_library_without_making_it_runtime_state() -> None:
    parameters = fm.ParameterLibrary()
    parameters.define(
        "film_width",
        fm.ParameterExpression.constant(250.0, unit="nm"),
        display_unit="nm",
    )
    problem = fm.Problem(
        name="parameterized-film",
        magnets=[
            fm.Ferromagnet(
                name="film",
                geometry=fm.Box(size=(250e-9, 50e-9, 5e-9), name="film"),
                material=fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.01),
            )
        ],
        energy=[fm.Exchange()],
        study=fm.TimeEvolution(
            dynamics=fm.LLG(),
            outputs=[fm.SaveScalar("E_total", every=1e-12)],
        ),
        parameters=parameters,
    )

    ir = problem.to_ir(include_geometry_assets=False)
    assert ir["parameters"] == parameters.to_ir()
    assert ir["parameters"]["schema_version"] == "parameter_library.v1"
    parameters.define(
        "later_edit",
        fm.ParameterExpression.constant(1.0),
    )
    assert "later_edit" not in problem.parameters.names  # type: ignore[union-attr]


def test_flat_parameter_facade_is_context_bound() -> None:
    with fm.execution_context() as context:
        width = fm.parameter("width", 250.0, unit="nm", display_unit="nm")
        fm.parameter(
            "double_width",
            2.0 * fm.ParameterExpression.reference(width.name),
            display_unit="nm",
        )
        handle = fm.geometry(fm.Box(250e-9, 50e-9, 5e-9), name="film")
        handle.Ms = 800e3
        handle.Aex = 13e-12
        problem = context.materialize_problem()

    assert problem.parameters is not None
    assert problem.parameters.names == ("double_width", "width")


def test_parameter_library_survives_generated_python_roundtrip() -> None:
    source = """
    import fullmag as fm

    study = fm.study("parameter-roundtrip")
    study.parameter("width", 250.0, unit="nm", display_unit="nm", description="film width")
    study.parameter("double_width", 2.0 * fm.ParameterExpression.reference("width"), display_unit="nm")
    body = study.geometry(fm.Box(250e-9, 50e-9, 5e-9), name="film")
    body.Ms = 800e3
    body.Aex = 13e-12
    body.alpha = 0.01
    study.stages.add_run(stage_id="run", until=1e-12)
    """
    with TemporaryDirectory() as temporary:
        root = Path(temporary)
        original_path = root / "source.py"
        original_path.write_text(textwrap.dedent(source), encoding="utf-8")
        loaded = fm.load_problem_from_script(original_path, lightweight_assets=True)
        rendered = rewrite_loaded_problem_script(loaded)["rendered_source"]
        rendered_path = root / "rendered.py"
        rendered_path.write_text(str(rendered), encoding="utf-8")
        reloaded = fm.load_problem_from_script(rendered_path, lightweight_assets=True)

    assert loaded.problem.parameters is not None
    assert reloaded.problem.parameters is not None
    assert reloaded.problem.parameters.to_ir() == loaded.problem.parameters.to_ir()
