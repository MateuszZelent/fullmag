from __future__ import annotations

import io
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fullmag.runtime import cli as runtime_cli


class _Stage:
    def __init__(self, entrypoint_kind: str) -> None:
        self.problem = SimpleNamespace(study=object())
        self.default_until_seconds = 1e-12
        self.entrypoint_kind = entrypoint_kind

    def to_ir(self, **_kwargs) -> dict[str, object]:
        return {
            "problem_meta": {"entrypoint_kind": self.entrypoint_kind},
            "magnets": [{"initial_magnetization": None}],
        }


def test_cli_rejects_fem_to_fdm_transfer_without_canonical_target_grid_identity(
    tmp_path: Path,
) -> None:
    loaded = SimpleNamespace(
        problem=SimpleNamespace(name="state_transfer"),
        source_path=tmp_path / "state_transfer.py",
        script_source="",
        stages=(_Stage("flat_relax"), _Stage("flat_run")),
        auto_execute_stages=True,
        study_pipeline_document=lambda: None,
    )
    simulation = SimpleNamespace(
        backend=SimpleNamespace(value="fdm"),
        mode=SimpleNamespace(value="strict"),
        precision=SimpleNamespace(value="double"),
    )
    run_payload = {
        "status": "completed",
        "steps": [],
        "final_magnetization": [[1.0, 0.0, 0.0]],
    }
    transfer_without_grid_identity = {
        "values": [[1.0, 0.0, 0.0]],
        "n_located": 1,
        "n_outside": 0,
        "n_total": 1,
    }
    stderr = io.StringIO()

    with (
        patch("fullmag.runtime.cli.load_problem_from_script", return_value=loaded),
        patch("fullmag.runtime.cli.Simulation", return_value=simulation),
        patch("fullmag.runtime.cli.run_problem_json", return_value=run_payload),
        patch(
            "fullmag.runtime.cli.extract_fem_mesh_ir",
            side_effect=[{"mesh_name": "source"}, None],
        ),
        patch(
            "fullmag.runtime.cli.resample_fem_to_fdm_grid",
            return_value=transfer_without_grid_identity,
        ),
        patch(
            "fullmag.runtime.cli.result_from_run_payload",
            return_value=SimpleNamespace(
                status="completed",
                steps=[],
                backend=simulation.backend,
                mode=simulation.mode,
                precision=simulation.precision,
                output_dir=str(tmp_path),
                notes=[],
            ),
        ),
        patch("sys.stderr", stderr),
    ):
        exit_code = runtime_cli.main(
            [str(loaded.source_path), "--json", "--output-dir", str(tmp_path)]
        )

    assert exit_code == 1
    assert "canonical target grid identity" in stderr.getvalue()
