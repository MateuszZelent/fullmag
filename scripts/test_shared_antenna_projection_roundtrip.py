"""Interpreted public-DSL regression; never execute a numerical stage."""
from __future__ import annotations

import argparse
import ast
from dataclasses import replace
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--temp-root", required=True, type=Path)
    parser.add_argument("--baseline-ref", help="Optional Git ref for a controlled RED check")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    temporary_root = args.temp_root.resolve(strict=True)
    if not temporary_root.is_dir():
        raise ValueError("--temp-root must name an existing project-storage directory")
    tempfile.tempdir = str(temporary_root)
    sys.path.insert(0, str(root / "packages/fullmag-py/src"))
    import fullmag as fm
    import fullmag.world as world
    from fullmag.runtime.loader import load_problem_from_script
    from fullmag.runtime.script_builder import render_loaded_problem_as_script

    spec = importlib.util.spec_from_file_location(
        "shared_projection_fixture", root / "packages/fullmag-py/tests/test_antenna_stage_workflow.py"
    )
    assert spec is not None and spec.loader is not None
    fixture = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixture)
    fixture.load_problem_from_script = lambda path: load_problem_from_script(path, lightweight_assets=True)
    captured = []
    original_renderer = fixture.render_loaded_problem_as_script

    def record(loaded, **kwargs):
        captured.append(loaded)
        return original_renderer(loaded, **kwargs)

    fixture.render_loaded_problem_as_script = record
    world.begin_script_capture(temporary_root)
    world.set_script_capture_lightweight_assets(True)
    fixture.test_complete_antenna_authoring_round_trips_through_stage_script()
    loaded = captured[0]
    source = render_loaded_problem_as_script(loaded)
    projection = loaded.problem.antenna_target_projections[0]
    first = loaded.problem.solved_antenna_drives[0]
    second = replace(first, id="drive_2", name="Second antenna drive")

    def begin_authoring():
        world.begin_script_capture(temporary_root)
        world.set_script_capture_lightweight_assets(True)
        exec(source, {"__name__": "shared_projection_authoring"})
        return fm.StudyBuilder()

    current_method = fm.StudyBuilder.add_solved_antenna_drive
    if args.baseline_ref is not None:
        baseline_ref = subprocess.run(
            ["git", "rev-parse", args.baseline_ref], cwd=root,
            capture_output=True, text=True, check=True,
        ).stdout.strip()
        baseline = subprocess.run(
            ["git", "show", f"{baseline_ref}:packages/fullmag-py/src/fullmag/world.py"],
            cwd=root, capture_output=True, text=True, encoding="utf-8", check=True,
        ).stdout
        tree = ast.parse(baseline)
        cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "StudyBuilder")
        method = next(node for node in cls.body if isinstance(node, ast.FunctionDef) and node.name == "add_solved_antenna_drive")
        namespace = dict(vars(world))
        exec(ast.unparse(method), namespace)
        study = begin_authoring()
        fm.StudyBuilder.add_solved_antenna_drive = namespace["add_solved_antenna_drive"]
        try:
            study.add_solved_antenna_drive(drive=second, projection=projection)
        except ValueError as exc:
            assert "duplicate antenna projection id" in str(exc)
            print(f"RED {baseline_ref}: matching shared projection rejected")
        else:
            raise AssertionError("baseline did not reproduce the shared-projection failure")
        finally:
            fm.StudyBuilder.add_solved_antenna_drive = current_method
            world.finish_script_capture()

    study = begin_authoring()
    try:
        before = len(world._state._declared_stages)
        study.add_solved_antenna_drive(drive=second, projection=projection)
        problem = world._build_problem()
        assert problem.antenna_target_projections == (projection,)
        assert problem.solved_antenna_drives == (first, second)
        assert len(world._state._declared_stages) == before + 1
        try:
            study.add_solved_antenna_drive(
                drive=replace(first, id="drive_3"),
                projection=replace(projection, output_id="conflicting_output"),
            )
        except ValueError as exc:
            assert "conflicting antenna projection id" in str(exc)
        else:
            raise AssertionError("conflicting projection accepted")
        assert world._build_problem() == problem
        assert len(world._state._declared_stages) == before + 1
        occupied_stage_id = world._state._declared_stages[0].stage_id
        assert occupied_stage_id is not None
        for rejected_drive, message in (
            (second, "duplicate solved antenna drive id"),
            (replace(first, id=occupied_stage_id), "duplicate stage_id"),
        ):
            try:
                study.add_solved_antenna_drive(drive=rejected_drive, projection=projection)
            except ValueError as exc:
                assert message in str(exc)
            else:
                raise AssertionError(f"accepted {message}")
            assert world._build_problem() == problem
            assert len(world._state._declared_stages) == before + 1
        from fullmag.runtime.loader import LoadedProblem, LoadedStage
        authored = LoadedProblem(
            problem=problem, source_path=Path("shared_projection.py"), script_source="",
            entrypoint_kind="flat_workspace", auto_execute_stages=False,
            stages=tuple(LoadedStage(
                problem=item.problem, entrypoint_kind=item.entrypoint_kind,
                default_until_seconds=item.default_until_seconds, action=item.action,
                stage_id=item.stage_id,
            ) for item in world._state._declared_stages),
        )
        rendered = render_loaded_problem_as_script(authored)
    finally:
        world.finish_script_capture()
    with tempfile.TemporaryDirectory(prefix="shared-antenna-projection-", dir=temporary_root) as directory:
        path = Path(directory) / "shared_projection.py"
        path.write_text(rendered, encoding="utf-8")
        replayed = load_problem_from_script(path, lightweight_assets=True)
    assert replayed.auto_execute_stages is False
    ir = replayed.problem.to_ir(include_geometry_assets=False)
    expected = problem.to_ir(include_geometry_assets=False)
    for collection in ("antenna_target_projections", "solved_antenna_drives"):
        assert ir[collection] == expected[collection]
    assert len(ir["antenna_target_projections"]) == 1
    assert len(ir["solved_antenna_drives"]) == 2
    print("GREEN: two drives share one projection; conflicting payload is atomic; DSL capture round-trip preserved")


if __name__ == "__main__":
    main()
