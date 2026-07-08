#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def require_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise SystemExit(f"{label} must be an object")
    return value


def require_list(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise SystemExit(f"{label} must be a list")
    return value


def load_json(path: Path) -> dict[str, Any]:
    try:
        return require_object(json.loads(path.read_text(encoding="utf-8")), str(path))
    except FileNotFoundError:
        raise SystemExit(f"missing input file: {path}") from None
    except json.JSONDecodeError as exc:
        raise SystemExit(f"invalid JSON in {path}: {exc}") from None


def finite_vector3(value: Any, label: str) -> list[float]:
    row = require_list(value, label)
    if len(row) != 3:
        raise SystemExit(f"{label} must have exactly 3 components")
    out: list[float] = []
    for index, component in enumerate(row):
        if not isinstance(component, (int, float)):
            raise SystemExit(f"{label}[{index}] must be numeric")
        number = float(component)
        if not (-float("inf") < number < float("inf")):
            raise SystemExit(f"{label}[{index}] must be finite")
        out.append(number)
    return out


def magnetic_segments(metadata: dict[str, Any]) -> list[dict[str, Any]]:
    execution_plan = require_object(metadata.get("execution_plan"), "metadata.execution_plan")
    backend_plan = require_object(
        execution_plan.get("backend_plan"),
        "metadata.execution_plan.backend_plan",
    )
    segments = require_list(
        backend_plan.get("object_segments"),
        "metadata.execution_plan.backend_plan.object_segments",
    )
    magnetic = [
        require_object(segment, f"object_segments[{index}]")
        for index, segment in enumerate(segments)
        if require_object(segment, f"object_segments[{index}]").get("object_id")
        != "__air__"
    ]
    if not magnetic:
        raise SystemExit("metadata does not contain magnetic object segments")
    return magnetic


def extract_magnetic_values(
    values: list[Any],
    segments: list[dict[str, Any]],
) -> list[list[float]]:
    out: list[list[float]] = []
    for segment_index, segment in enumerate(segments):
        start = segment.get("node_start")
        count = segment.get("node_count")
        if not isinstance(start, int) or start < 0:
            raise SystemExit(f"magnetic segment {segment_index} node_start must be non-negative")
        if not isinstance(count, int) or count < 0:
            raise SystemExit(f"magnetic segment {segment_index} node_count must be non-negative")
        end = start + count
        if end > len(values):
            raise SystemExit(
                f"magnetic segment {segment_index} range {start}:{end} exceeds m_final values"
            )
        for node_index in range(start, end):
            out.append(finite_vector3(values[node_index], f"m_final.values[{node_index}]"))
    if not out:
        raise SystemExit("magnetic object segments selected zero vectors")
    return out


def write_magnetic_initial_state(input_dir: Path, output_path: Path) -> None:
    metadata = load_json(input_dir / "metadata.json")
    final_state = load_json(input_dir / "m_final.json")
    values = require_list(final_state.get("values"), "m_final.values")
    segments = magnetic_segments(metadata)
    magnetic_values = extract_magnetic_values(values, segments)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(
            {
                "kind": "magnetization_state",
                "observable": "m",
                "format": "json",
                "unit": "dimensionless",
                "source": {
                    "kind": "shared_domain_m_final_magnetic_slice",
                    "input_dir": str(input_dir),
                    "source_vector_count": len(values),
                    "magnetic_segment_count": len(segments),
                    "source_step": final_state.get("step"),
                    "source_time": final_state.get("time"),
                },
                "vector_count": len(magnetic_values),
                "values": magnetic_values,
            },
            indent=2,
        ),
        encoding="utf-8",
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Extract a magnetic-node initial state from a shared-domain FEM m_final artifact."
        )
    )
    parser.add_argument("input_dir", type=Path)
    parser.add_argument("output_path", type=Path)
    args = parser.parse_args()

    write_magnetic_initial_state(args.input_dir, args.output_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
