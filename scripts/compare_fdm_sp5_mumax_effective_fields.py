#!/usr/bin/env python3
"""Compare Fullmag H_demag/H_ex artifacts with MuMax3 B-field OVFs."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Sequence

try:
    from scripts.compare_fdm_sp5_mumax_fields import (
        Vector,
        read_fullmag_field,
        read_ovf2_binary4,
        vector_metrics,
    )
except ModuleNotFoundError:
    from compare_fdm_sp5_mumax_fields import (  # type: ignore[no-redef]
        Vector,
        read_fullmag_field,
        read_ovf2_binary4,
        vector_metrics,
    )


MU0 = 4.0e-7 * math.pi


def _b_to_h(values: Sequence[Vector]) -> list[Vector]:
    return [tuple(component / MU0 for component in vector) for vector in values]


def _metrics_with_relative_error(
    candidate: Sequence[Vector], reference: Sequence[Vector]
) -> dict[str, object]:
    metrics = vector_metrics(candidate, reference)
    scale = float(metrics["reference_rms_component"])
    if scale == 0.0:
        raise ValueError("reference field RMS must be nonzero")
    metrics["relative_rms_error"] = float(metrics["rms_component_error"]) / scale
    return metrics


def compare_effective_fields(
    *,
    mumax_b_demag: Sequence[Vector],
    mumax_b_exchange: Sequence[Vector],
    fullmag_h_demag: Sequence[Vector],
    fullmag_h_exchange: Sequence[Vector],
) -> dict[str, object]:
    lengths = {
        len(mumax_b_demag),
        len(mumax_b_exchange),
        len(fullmag_h_demag),
        len(fullmag_h_exchange),
    }
    if len(lengths) != 1:
        raise ValueError(f"field length mismatch across inputs: {sorted(lengths)}")
    return {
        "schema_version": "FULLMAG-SP5-EFFECTIVE-FIELD-COMPARISON-V1",
        "cell_count": len(mumax_b_demag),
        "conversion": "H_A_per_m = B_T / mu0",
        "mu0_T_m_per_A": MU0,
        "H_demag": _metrics_with_relative_error(
            fullmag_h_demag, _b_to_h(mumax_b_demag)
        ),
        "H_ex": _metrics_with_relative_error(
            fullmag_h_exchange, _b_to_h(mumax_b_exchange)
        ),
    }


def compare_demag_sweep(
    *,
    fullmag_h_demag: Sequence[Vector],
    mumax_b_by_accuracy: dict[int, Sequence[Vector]],
) -> dict[str, dict[str, object]]:
    if not mumax_b_by_accuracy:
        raise ValueError("demag accuracy sweep must not be empty")
    return {
        str(accuracy): _metrics_with_relative_error(
            fullmag_h_demag, _b_to_h(mumax_b_by_accuracy[accuracy])
        )
        for accuracy in sorted(mumax_b_by_accuracy)
    }


def _accuracy_path(value: str) -> tuple[int, Path]:
    accuracy_text, separator, path_text = value.partition("=")
    if not separator:
        raise argparse.ArgumentTypeError("expected ACCURACY=PATH")
    try:
        accuracy = int(accuracy_text)
    except ValueError as error:
        raise argparse.ArgumentTypeError("accuracy must be an integer") from error
    if accuracy <= 0 or not path_text:
        raise argparse.ArgumentTypeError("accuracy and path must be nonempty and positive")
    return accuracy, Path(path_text)


def _single_snapshot(run_root: Path, quantity: str) -> Path:
    candidates = sorted((run_root / "fields" / quantity).glob("step_*.json"))
    if len(candidates) != 1:
        raise ValueError(
            f"expected exactly one {quantity} snapshot in {run_root}, found {len(candidates)}"
        )
    return candidates[0]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mumax-b-demag", type=Path, required=True)
    parser.add_argument("--mumax-b-exchange", type=Path, required=True)
    parser.add_argument("--fullmag-run", type=Path, required=True)
    parser.add_argument(
        "--mumax-b-demag-sweep",
        type=_accuracy_path,
        action="append",
        default=[],
        metavar="ACCURACY=PATH",
    )
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    demag = read_ovf2_binary4(args.mumax_b_demag)
    exchange = read_ovf2_binary4(args.mumax_b_exchange)
    if demag.shape != exchange.shape:
        raise ValueError(f"OVF shape mismatch: demag={demag.shape}, exchange={exchange.shape}")
    fullmag_demag = _single_snapshot(args.fullmag_run, "H_demag")
    fullmag_exchange = _single_snapshot(args.fullmag_run, "H_ex")
    report = compare_effective_fields(
        mumax_b_demag=demag.values,
        mumax_b_exchange=exchange.values,
        fullmag_h_demag=read_fullmag_field(
            fullmag_demag.parent,
            fullmag_demag.name,
        ),
        fullmag_h_exchange=read_fullmag_field(
            fullmag_exchange.parent,
            fullmag_exchange.name,
        ),
    )
    if args.mumax_b_demag_sweep:
        sweep_fields: dict[int, Sequence[Vector]] = {}
        sweep_inputs: dict[str, str] = {}
        for accuracy, path in args.mumax_b_demag_sweep:
            if accuracy in sweep_fields:
                raise ValueError(f"duplicate DemagAccuracy={accuracy}")
            field = read_ovf2_binary4(path)
            if field.shape != demag.shape:
                raise ValueError(
                    f"DemagAccuracy={accuracy} shape {field.shape} does not match {demag.shape}"
                )
            sweep_fields[accuracy] = field.values
            sweep_inputs[str(accuracy)] = str(path)
        report["H_demag_accuracy_sweep"] = compare_demag_sweep(
            fullmag_h_demag=read_fullmag_field(fullmag_demag.parent, fullmag_demag.name),
            mumax_b_by_accuracy=sweep_fields,
        )
        report["demag_accuracy_sweep_inputs"] = sweep_inputs
    report["grid"] = list(demag.shape)
    report["inputs"] = {
        "mumax_b_demag": str(args.mumax_b_demag),
        "mumax_b_exchange": str(args.mumax_b_exchange),
        "fullmag_run": str(args.fullmag_run),
    }
    serialized = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(serialized, encoding="utf-8")
    print(serialized, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
