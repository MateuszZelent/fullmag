#!/usr/bin/env python3
"""Compare 1x1 periodic-airbox FMR artifacts with Gamma-like supercell artifacts."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path


DEFAULT_RESPONSE_REL_TOL = 2.5e-1
DEFAULT_RESPONSE_ABS_TOL = 0.0
DEFAULT_FREQUENCY_ABS_TOL_HZ = 1.0e-6
DEFAULT_FREQUENCY_REL_TOL = 1.0e-12


def fail(message: str) -> None:
    raise SystemExit("invalid FEM frequency-domain supercell artifacts:\n" + message)


def load_json(path: Path) -> dict:
    if not path.is_file():
        fail(f"missing required artifact: {path}")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        fail(f"artifact is not valid JSON: {path}: {exc}")
    if not isinstance(payload, dict):
        fail(f"artifact must contain a JSON object: {path}")
    return payload


def finite_number(value: object, name: str) -> float:
    if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        fail(f"{name} must be a finite number")
    return float(value)


def object_list(value: object, name: str) -> list[dict]:
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        fail(f"{name} must be a list of objects")
    return value


def string_list(value: object, name: str) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        fail(f"{name} must be a list of strings")
    return value


def compare_numeric(
    actual: object,
    expected: object,
    name: str,
    *,
    abs_tol: float,
    rel_tol: float,
) -> None:
    if isinstance(actual, list) or isinstance(expected, list):
        if not isinstance(actual, list) or not isinstance(expected, list):
            fail(f"{name} type mismatch: supercell={actual!r}, unit={expected!r}")
        if len(actual) != len(expected):
            fail(f"{name} length mismatch: supercell={len(actual)}, unit={len(expected)}")
        for index, (actual_item, expected_item) in enumerate(zip(actual, expected)):
            compare_numeric(
                actual_item,
                expected_item,
                f"{name}[{index}]",
                abs_tol=abs_tol,
                rel_tol=rel_tol,
            )
        return

    actual_number = finite_number(actual, f"supercell {name}")
    expected_number = finite_number(expected, f"unit-cell {name}")
    tolerance = max(abs_tol, rel_tol * max(abs(actual_number), abs(expected_number), 1.0))
    if abs(actual_number - expected_number) > tolerance:
        fail(
            f"{name} mismatch: supercell={actual_number:.17g}, "
            f"unit_cell={expected_number:.17g}, diff={abs(actual_number - expected_number):.17g}, "
            f"tolA={tolerance:.17g}"
        )


class RuntimeBundle:
    def __init__(self, root: Path, label: str) -> None:
        self.root = root
        self.label = label
        self.progress = load_json(root / "response/progress.v1.json")
        self.diagnostics = load_json(root / "response/diagnostics/solver.v1.json")
        self.manifest = load_json(root / "frequency_domain/manifest.v1.json")
        self.sweep = load_json(root / "response/magnetic_response_sweep.v2.json")
        self.points = self._load_points()

    def _load_points(self) -> list[dict]:
        paths = string_list(
            self.sweep.get("frequency_point_artifact_paths"),
            f"{self.label}.sweep.frequency_point_artifact_paths",
        )
        if not paths:
            fail(f"{self.label} sweep must contain at least one frequency point path")
        return [load_json(self.root / path) for path in paths]


def require_periodic_airbox_cpu_demag_bundle(bundle: RuntimeBundle) -> None:
    label = bundle.label
    if bundle.manifest.get("status") != "ready" or bundle.manifest.get("complete") is not True:
        fail(f"{label} manifest must be ready and complete")
    if bundle.progress.get("complete") is not True:
        fail(f"{label} progress must be complete")
    if bundle.diagnostics.get("validation_fallback_used") is not False:
        fail(f"{label} diagnostics.validation_fallback_used must be false")
    resolved_execution = bundle.manifest.get("resolved_execution")
    if not isinstance(resolved_execution, dict):
        fail(f"{label} manifest.resolved_execution must be an object")
    if resolved_execution.get("requested_execution_lane") != "production_cpu":
        fail(f"{label} must use requested production_cpu execution lane")
    physics = bundle.manifest.get("physics")
    if not isinstance(physics, dict):
        fail(f"{label} manifest.physics must be an object")
    for source_name, source in (
        (f"{label} manifest.physics", physics),
        (f"{label} diagnostics", bundle.diagnostics),
    ):
        if source.get("resolved_magnetostatic_bc") != "periodic_airbox_k0":
            fail(f"{source_name}.resolved_magnetostatic_bc must be periodic_airbox_k0")
        if source.get("resolved_magnetic_bc") != "periodic":
            fail(f"{source_name}.resolved_magnetic_bc must be periodic")
    terms = string_list(
        bundle.diagnostics.get("operator_terms_included"),
        f"{label}.diagnostics.operator_terms_included",
    )
    if "demag" not in terms:
        fail(f"{label} diagnostics.operator_terms_included must include demag")
    if bundle.sweep.get("completed_frequency_point_count") != len(bundle.points):
        fail(f"{label} sweep completed count must match frequency point paths")
    for index, point in enumerate(bundle.points):
        demag = point.get("demag_contribution")
        if not isinstance(demag, dict):
            fail(f"{label}.frequency[{index}].demag_contribution must be an object")
        if demag.get("status") != "solved":
            fail(f"{label}.frequency[{index}].demag_contribution.status must be solved")
        finite_number(point.get("frequency_hz"), f"{label}.frequency[{index}].frequency_hz")
        finite_number(
            point.get("response_amplitude"),
            f"{label}.frequency[{index}].response_amplitude",
        )


def peak_index(points: list[dict]) -> int:
    amplitudes = [
        finite_number(point.get("response_amplitude"), f"frequency[{index}].response_amplitude")
        for index, point in enumerate(points)
    ]
    return max(range(len(amplitudes)), key=lambda index: amplitudes[index])


def compare_supercell_to_unit_cell(
    unit: RuntimeBundle,
    supercell: RuntimeBundle,
    *,
    repeat_x: int,
    repeat_y: int,
    response_abs_tol: float,
    response_rel_tol: float,
    frequency_abs_tol_hz: float,
    frequency_rel_tol: float,
) -> dict[str, object]:
    if repeat_x <= 0 or repeat_y <= 0 or repeat_x * repeat_y <= 1:
        fail("supercell repeat_x * repeat_y must be greater than one")
    require_periodic_airbox_cpu_demag_bundle(unit)
    require_periodic_airbox_cpu_demag_bundle(supercell)

    if len(unit.points) != len(supercell.points):
        fail(
            f"frequency point count mismatch: supercell={len(supercell.points)}, "
            f"unit_cell={len(unit.points)}"
        )
    for index, (unit_point, supercell_point) in enumerate(zip(unit.points, supercell.points)):
        compare_numeric(
            supercell_point.get("frequency_hz"),
            unit_point.get("frequency_hz"),
            f"frequency[{index}].frequency_hz",
            abs_tol=frequency_abs_tol_hz,
            rel_tol=frequency_rel_tol,
        )
        for key in ("response_amplitude", "component_response_amplitude"):
            compare_numeric(
                supercell_point.get(key),
                unit_point.get(key),
                f"frequency[{index}].{key}",
                abs_tol=response_abs_tol,
                rel_tol=response_rel_tol,
            )

    unit_peak = peak_index(unit.points)
    supercell_peak = peak_index(supercell.points)
    if unit_peak != supercell_peak:
        fail(f"peak index mismatch: supercell={supercell_peak}, unit_cell={unit_peak}")

    return {
        "schema_version": "frequency_domain_supercell_validation.v1",
        "status": "ok",
        "unit_cell_artifacts": str(unit.root),
        "supercell_artifacts": str(supercell.root),
        "repeat_x": repeat_x,
        "repeat_y": repeat_y,
        "cell_count": repeat_x * repeat_y,
        "frequency_point_count": len(unit.points),
        "peak_index": unit_peak,
        "peak_frequency_hz": unit.points[unit_peak].get("frequency_hz"),
        "response_abs_tol": response_abs_tol,
        "response_rel_tol": response_rel_tol,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--unit-cell", type=Path, required=True, help="1x1 artifact root.")
    parser.add_argument("--supercell", type=Path, required=True, help="Supercell artifact root.")
    parser.add_argument("--repeat-x", type=int, required=True, help="Supercell repeats along x.")
    parser.add_argument("--repeat-y", type=int, required=True, help="Supercell repeats along y.")
    parser.add_argument(
        "--response-abs-tol",
        type=float,
        default=DEFAULT_RESPONSE_ABS_TOL,
        help="Absolute tolerance for response observable comparison.",
    )
    parser.add_argument(
        "--response-rel-tol",
        type=float,
        default=DEFAULT_RESPONSE_REL_TOL,
        help="Relative tolerance for response observable comparison.",
    )
    parser.add_argument(
        "--frequency-abs-tol-hz",
        type=float,
        default=DEFAULT_FREQUENCY_ABS_TOL_HZ,
        help="Absolute frequency matching tolerance in Hz.",
    )
    parser.add_argument(
        "--frequency-rel-tol",
        type=float,
        default=DEFAULT_FREQUENCY_REL_TOL,
        help="Relative frequency matching tolerance.",
    )
    parser.add_argument("--write-report", type=Path, default=None, help="Optional report path.")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    report = compare_supercell_to_unit_cell(
        RuntimeBundle(args.unit_cell, "unit-cell"),
        RuntimeBundle(args.supercell, "supercell"),
        repeat_x=args.repeat_x,
        repeat_y=args.repeat_y,
        response_abs_tol=args.response_abs_tol,
        response_rel_tol=args.response_rel_tol,
        frequency_abs_tol_hz=args.frequency_abs_tol_hz,
        frequency_rel_tol=args.frequency_rel_tol,
    )
    if args.write_report is not None:
        args.write_report.parent.mkdir(parents=True, exist_ok=True)
        args.write_report.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    else:
        print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
