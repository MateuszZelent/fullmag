from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "write_fem_magnetic_initial_state_from_shared_domain.py"


def write_relax_artifacts(root: Path) -> None:
    root.mkdir(parents=True)
    (root / "metadata.json").write_text(
        json.dumps(
            {
                "execution_plan": {
                    "backend_plan": {
                        "object_segments": [
                            {
                                "object_id": "film",
                                "node_start": 0,
                                "node_count": 2,
                            },
                            {
                                "object_id": "film",
                                "node_start": 2,
                                "node_count": 1,
                            },
                            {
                                "object_id": "__air__",
                                "node_start": 3,
                                "node_count": 2,
                            },
                        ]
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    (root / "m_final.json").write_text(
        json.dumps(
            {
                "step": 40,
                "time": 0.0,
                "values": [
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [9.0, 9.0, 9.0],
                    [8.0, 8.0, 8.0],
                ],
            }
        ),
        encoding="utf-8",
    )


def test_writer_extracts_non_air_object_segments(tmp_path: Path) -> None:
    input_dir = tmp_path / "relax"
    output_path = tmp_path / "magnetic.json"
    write_relax_artifacts(input_dir)

    result = subprocess.run(
        [sys.executable, str(SCRIPT), str(input_dir), str(output_path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    payload = json.loads(output_path.read_text(encoding="utf-8"))
    assert payload["kind"] == "magnetization_state"
    assert payload["vector_count"] == 3
    assert payload["source"]["source_vector_count"] == 5
    assert payload["source"]["magnetic_segment_count"] == 2
    assert payload["values"] == [
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
    ]
