from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .state_io import FieldState, load_field_state, save_field_state


def _read(path: Path, *, format: str, dataset: str | None, sample: int) -> int:
    try:
        state = load_field_state(
            path,
            format=format,
            dataset=dataset,
            sample=sample,
        )
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 2

    payload = {
        "fullmag_kind": "field_state",
        "schema_version": 1,
        "quantity_id": state.quantity_id,
        "target": {
            "kind": state.target_kind,
            "id": state.target_id,
        },
        "component_count": state.component_count,
        "values": state.values,
        "source_step": None,
        "source_time_s": None,
        "units": state.units,
        "source_path": state.source_path,
        "source_format": state.source_format,
        "dataset": state.dataset,
        "sample_index": state.sample_index,
    }
    print(json.dumps(payload, allow_nan=False))
    return 0


def _write(
    output_path: Path,
    *,
    input_json: Path,
    format: str,
    dataset: str | None,
) -> int:
    try:
        payload = json.loads(input_json.read_text())
        target = payload["target"]
        state = FieldState(
            values=payload["values"],
            quantity_id=payload["quantity_id"],
            target_kind=target["kind"],
            target_id=target["id"],
            units=payload.get("units"),
            source_path=None,
            source_format=None,
            dataset=None,
            sample_index=None,
        )
        save_field_state(
            output_path,
            state,
            format=format,
            dataset=dataset or "fields/m",
        )
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 2
    return 0


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv[:1] == ["write"]:
        parser = argparse.ArgumentParser(
            prog="python -m fullmag.init.field_state_cli write",
            description="Write a Fullmag field-state file from normalized JSON.",
        )
        parser.add_argument("output_path", type=Path)
        parser.add_argument("--input-json", required=True, type=Path)
        parser.add_argument("--format", default="auto")
        parser.add_argument("--dataset", default=None)
        args = parser.parse_args(argv[1:])
        return _write(
            args.output_path,
            input_json=args.input_json,
            format=args.format,
            dataset=args.dataset,
        )

    parser = argparse.ArgumentParser(
        prog="python -m fullmag.init.field_state_cli",
        description="Read a Fullmag field-state file and print a normalized JSON payload.",
    )
    parser.add_argument("path", type=Path)
    parser.add_argument("--format", default="auto")
    parser.add_argument("--dataset", default=None)
    parser.add_argument("--sample", default=-1, type=int)
    args = parser.parse_args(argv)

    return _read(
        args.path,
        format=args.format,
        dataset=args.dataset,
        sample=args.sample,
    )


if __name__ == "__main__":
    raise SystemExit(main())
