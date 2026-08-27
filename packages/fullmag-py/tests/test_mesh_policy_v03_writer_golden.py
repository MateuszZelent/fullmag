from __future__ import annotations

import json
import textwrap
from pathlib import Path
from tempfile import TemporaryDirectory

import fullmag as fm


_FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "tests/golden/mesh-policy/v03-python-writer.v1.json"
)


def _load_fixture() -> dict[str, object]:
    return json.loads(_FIXTURE.read_text(encoding="utf-8"))


def _writer_metadata(script: str) -> dict[str, object]:
    with TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "public_mesh_policy_v03.py"
        path.write_text(textwrap.dedent(script), encoding="utf-8")
        loaded = fm.load_problem_from_script(path, lightweight_assets=True)
        ir = loaded.problem.to_ir(
            requested_backend=fm.BackendTarget.FEM,
            include_geometry_assets=False,
        )
    runtime_metadata = ir["problem_meta"]["runtime_metadata"]
    return {
        "mesh_workflow": runtime_metadata.get("mesh_workflow"),
        "study_universe": runtime_metadata.get("study_universe"),
    }


def test_v03_writer_golden_matches_public_python_dsl() -> None:
    fixture = _load_fixture()
    for case in fixture["cases"]:
        actual = _writer_metadata(case["script"])
        assert actual == case["writer_metadata"], case["id"]
