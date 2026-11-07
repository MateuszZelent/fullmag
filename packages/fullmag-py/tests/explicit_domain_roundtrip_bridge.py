"""Test-only stdin/stdout bridge for the real Rust authoring adapters.

No solver, native process or mesh generation is permitted. Fixture files are
immutable inputs, including the unapproved corner25 execution candidate.
"""
from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import io
import json
import math
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "packages/fullmag-py/src"))

import fullmag as fm
from fullmag.runtime.scene_document import build_scene_document_from_builder
from fullmag.runtime.script_builder import (
    export_builder_draft, export_study_pipeline_document,
    render_loaded_problem_as_script, render_scene_document_as_script,
)

FIXTURES = ROOT / "crates/fullmag-authoring/tests/fixtures/explicit_domain_roundtrip"


def differences(a, b, path=""):
    if type(a) is int or type(b) is int:
        return [] if type(a) in (int, float) and type(b) in (int, float) and a == b else [(path, a, b)]
    if type(a) is float and type(b) is float:
        return [] if math.isclose(a, b, rel_tol=5e-12, abs_tol=0) else [(path, a, b)]
    if type(a) is not type(b):
        return [(path, a, b)]
    if isinstance(a, dict):
        result = []
        for key in sorted(a.keys() | b.keys()):
            pointer = path + "/" + key.replace("~", "~0").replace("/", "~1")
            if key not in a or key not in b:
                result.append((pointer, a.get(key, "<ABSENT>"), b.get(key, "<ABSENT>")))
            else:
                result.extend(differences(a[key], b[key], pointer))
        return result
    if isinstance(a, list):
        if len(a) != len(b):
            return [(path + "/length", len(a), len(b))]
        return [item for index, (x, y) in enumerate(zip(a, b))
                for item in differences(x, y, path + "/" + str(index))]
    return [] if a == b else [(path, a, b)]


def load(path):
    with fm.execution_context():
        return fm.load_problem_from_script(path, lightweight_assets=True)


def snapshot(loaded, source_root):
    flags = lambda problem: {
        key: problem.runtime_metadata.get(key, False)
        for key in ("interactive_session_requested", "wait_for_solve")
    }
    return {
        "ir": loaded.problem.to_ir(include_geometry_assets=False, source_root=source_root),
        "stage_ir": [stage.problem.to_ir(include_geometry_assets=False, source_root=source_root)
                     for stage in loaded.stages],
        "stages": [{"id": stage.stage_id, "entrypoint_kind": stage.entrypoint_kind,
                    "until_seconds": stage.default_until_seconds, "action": stage.action,
                    "flags": flags(stage.problem)} for stage in loaded.stages],
        "workspace_flags": flags(loaded.workspace_problem or loaded.problem),
    }


def accepted_additions(before, after, expected_pipeline):
    """Only exact legacy pipeline additions are accepted, never whole subtrees."""
    added = []
    paths = [
        ("problem_meta", "runtime_metadata", "study_pipeline"),
        ("problem_meta", "runtime_metadata", "model_builder", "study_pipeline"),
        ("problem_meta", "runtime_metadata", "script_sync", "study_pipeline_version"),
        ("problem_meta", "runtime_metadata", "script_sync", "study_pipeline_node_count"),
    ]
    expected = [expected_pipeline, expected_pipeline, "study_pipeline.v1", len(expected_pipeline["nodes"])]
    for keys, value in zip(paths, expected):
        old, new = before, after
        for key in keys[:-1]:
            old = old.get(key, {}) if isinstance(old, dict) else {}
            new = new.get(key, {}) if isinstance(new, dict) else {}
        if isinstance(new, dict) and keys[-1] not in old and keys[-1] in new:
            if differences(value, new[keys[-1]]):
                raise AssertionError("unexpected addition at /" + "/".join(keys))
            old[keys[-1]] = new[keys[-1]]
            added.append("/" + "/".join(keys))
    return added


def main(request):
    name = request["fixture"]
    manifest = json.loads((FIXTURES / "manifest.json").read_text())
    if name not in manifest["files"]:
        raise ValueError("unknown pinned fixture")
    path = FIXTURES / name
    pin = manifest["files"][name]["sha256"]
    if hashlib.sha256(path.read_bytes()).hexdigest() != pin:
        raise AssertionError("fixture digest changed")
    with contextlib.ExitStack() as guards:
        process_guard = guards.enter_context(patch("subprocess.Popen", side_effect=AssertionError("native process forbidden")))
        mesh_guard = None
        if importlib.util.find_spec("gmsh") is not None:
            import gmsh
            mesh_guard = guards.enter_context(patch.object(gmsh.model.mesh, "generate", side_effect=AssertionError("mesh generation forbidden")))
        captured_stdout = io.StringIO()
        with contextlib.redirect_stdout(captured_stdout):
            before = load(path)
            original = snapshot(before, path.parent)
            builder = export_builder_draft(before)
            scene = build_scene_document_from_builder(builder)
            pipeline = export_study_pipeline_document(before)
            if request["action"] == "export_builder":
                result = {"scene": scene, "builder": builder, "snapshot": original}
            elif request["action"] == "render_and_reimport":
                routes = [
                    ("rust_overrides", render_loaded_problem_as_script(before, overrides=request["overrides"])),
                    ("rust_scene", render_scene_document_as_script(request["scene"])),
                ]
                results = []
                with tempfile.TemporaryDirectory(prefix="fullmag-domain-roundtrip-") as tmp:
                    for route, script in routes:
                        rendered_path = Path(tmp) / (route + ".py")
                        rendered_path.write_text(script, encoding="utf-8")
                        after = load(rendered_path)
                        actual = snapshot(after, path.parent)
                        expected = json.loads(json.dumps(original))
                        additions = accepted_additions(expected["ir"], actual["ir"], pipeline)
                        for previous, current in zip(expected["stage_ir"], actual["stage_ir"]):
                            additions += accepted_additions(previous, current, pipeline)
                        diff = differences(expected, actual)
                        if diff:
                            raise AssertionError(json.dumps({"fixture": name, "route": route, "differences": diff}, indent=2))
                        results.append({"route": route, "full_ir_equal": True, "stage_count": len(after.stages),
                                        "accepted_exact_additions": additions,
                                        "rendered_sha256": hashlib.sha256(script.encode()).hexdigest()})
                result = {"routes": results}
            else:
                raise ValueError("unknown bridge action")
        if captured_stdout.getvalue():
            raise AssertionError("unexpected output from source-only authoring")
        result.update({"fixture_sha256": pin, "process_guard_calls": process_guard.call_count,
                       "mesh_guard_calls": mesh_guard.call_count if mesh_guard is not None else 0,
                       "meshes_generated": 0, "solves_submitted": 0})
    return result


if __name__ == "__main__":
    print(json.dumps(main(json.load(sys.stdin)), allow_nan=False))
