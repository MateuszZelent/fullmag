#!/usr/bin/env python3
"""Fail closed before the managed viewport-2D FDM science/browser smoke."""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


EXPECTED_NATIVE_CELL_COUNTS = {
    "base": {"planar_film": 768, "isolation_neighbor": 192},
    "mesh-refined": {"planar_film": 6144, "isolation_neighbor": 1536},
}
MATERIAL_ARRAY_KEYS = ("ms_field", "a_field", "alpha_field")


class PreflightError(ValueError):
    """The canonical fixture or execution plan is not qualification-ready."""


def _require_mapping(value: Any, label: str, errors: list[str]) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    errors.append(f"{label} must be an object")
    return {}


def _require_vector3(value: Any, label: str, errors: list[str]) -> list[float]:
    if not isinstance(value, list) or len(value) != 3:
        errors.append(f"{label} must contain exactly three values")
        return [0.0, 0.0, 0.0]
    try:
        vector = [float(component) for component in value]
    except (TypeError, ValueError):
        errors.append(f"{label} must contain finite numeric values")
        return [0.0, 0.0, 0.0]
    if not all(math.isfinite(component) for component in vector):
        errors.append(f"{label} must contain finite numeric values")
    return vector


def _native_cell_count(layer: dict[str, Any], label: str, errors: list[str]) -> int:
    raw = layer.get("native_grid")
    if (
        not isinstance(raw, list)
        or len(raw) != 3
        or any(not isinstance(value, int) or isinstance(value, bool) or value <= 0 for value in raw)
    ):
        errors.append(f"{label} native_grid must contain three positive integers")
        return 0
    return math.prod(raw)


def _validate_material_arrays(
    layers: dict[str, dict[str, Any]], native_counts: dict[str, int], errors: list[str]
) -> dict[str, list[str]]:
    owners: dict[str, list[str]] = {}
    for object_id, layer in layers.items():
        material = _require_mapping(layer.get("material"), f"{object_id} material", errors)
        for field in MATERIAL_ARRAY_KEYS:
            values = material.get(field)
            if values is None:
                continue
            owners.setdefault(field, []).append(object_id)
            if not isinstance(values, list):
                errors.append(f"{object_id} {field} must be an array or canonical scalar fallback")
                continue
            if len(values) != native_counts.get(object_id, 0):
                errors.append(
                    f"{object_id} {field} length {len(values)}, expected native length "
                    f"{native_counts.get(object_id, 0)}"
                )
            if any(
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(float(value))
                for value in values
            ):
                errors.append(f"{object_id} {field} contains a non-finite or non-numeric value")

    film_material = _require_mapping(
        layers.get("planar_film", {}).get("material"), "planar_film material", errors
    )
    film_ms = film_material.get("ms_field")
    if not isinstance(film_ms, list):
        errors.append("planar_film ms_field is required; scalarization would hide the linear Ms oracle")
    else:
        film = layers["planar_film"]
        grid = film.get("native_grid")
        origin = _require_vector3(film.get("native_origin"), "planar_film native_origin", errors)
        cell = _require_vector3(
            film.get("native_cell_size"), "planar_film native_cell_size", errors
        )
        if isinstance(grid, list) and len(grid) == 3 and len(film_ms) == native_counts.get("planar_film"):
            nx, ny, _ = grid
            for index, raw_value in enumerate(film_ms):
                if not isinstance(raw_value, (int, float)) or isinstance(raw_value, bool):
                    continue
                x = index % nx
                z = index // (nx * ny)
                object_x = origin[0] + (x + 0.5) * cell[0]
                object_z = origin[2] + (z + 0.5) * cell[2]
                expected = 800e3 + 1e12 * object_x + 2e12 * object_z
                if not math.isclose(float(raw_value), expected, rel_tol=1e-12, abs_tol=1e-6):
                    errors.append(
                        "planar_film ms_field does not match the authored linear "
                        f"Ms oracle at native index {index}: got {raw_value}, expected {expected}"
                    )
                    break
            if len({float(value) for value in film_ms if isinstance(value, (int, float))}) <= 1:
                errors.append("planar_film ms_field must remain non-uniform")

    neighbor_material = _require_mapping(
        layers.get("isolation_neighbor", {}).get("material"),
        "isolation_neighbor material",
        errors,
    )
    if neighbor_material.get("ms_field") is not None:
        errors.append(
            "isolation_neighbor ms_field must use canonical scalar fallback; only planar_film owns linear mat_ms"
        )
    for object_id in ("planar_film", "isolation_neighbor"):
        material = _require_mapping(layers.get(object_id, {}).get("material"), f"{object_id} material", errors)
        for field in ("a_field", "alpha_field"):
            if material.get(field) is not None:
                errors.append(
                    f"{object_id} {field} must use canonical scalar fallback for this fixture"
                )
    return {field: sorted(field_owners) for field, field_owners in sorted(owners.items())}


def _validate_membership(
    layers: dict[str, dict[str, Any]], native_counts: dict[str, int], errors: list[str]
) -> bool:
    film = layers.get("planar_film", {})
    mask = film.get("native_region_mask")
    legend = film.get("native_region_legend")
    if not isinstance(mask, list) or len(mask) != native_counts.get("planar_film", 0):
        errors.append("planar_film native_region_mask must match its native cell count")
        mask = []
    if not isinstance(legend, list):
        errors.append("planar_film native_region_legend must be an array")
        legend = []
    entry = next(
        (
            item
            for item in legend
            if isinstance(item, dict)
            and item.get("object_id") == "planar_film"
            and item.get("region_id") == "qualification_core"
            and item.get("priority") == 10
            and isinstance(item.get("numeric_id"), int)
            and item.get("numeric_id") > 0
        ),
        None,
    )
    if entry is None:
        errors.append(
            "planar_film qualification_core legend entry is missing or has unstable identity/priority"
        )
        return False
    if entry["numeric_id"] not in mask:
        errors.append("planar_film qualification_core numeric_id is absent from native_region_mask")
        return False

    neighbor = layers.get("isolation_neighbor", {})
    neighbor_mask = neighbor.get("native_region_mask")
    neighbor_legend = neighbor.get("native_region_legend")
    if (
        not isinstance(neighbor_mask, list)
        or len(neighbor_mask) != native_counts.get("isolation_neighbor", 0)
        or any(value != 0 for value in neighbor_mask)
    ):
        errors.append("isolation_neighbor must retain an all-zero native region mask")
    if neighbor_legend not in (None, []):
        errors.append("isolation_neighbor must not inherit planar_film region legend entries")
    return True


def _validate_disjoint_coplanar(
    layers: dict[str, dict[str, Any]], errors: list[str]
) -> bool:
    bounds: dict[str, tuple[list[float], list[float]]] = {}
    for object_id in ("planar_film", "isolation_neighbor"):
        layer = layers.get(object_id, {})
        origin = _require_vector3(layer.get("native_origin"), f"{object_id} native_origin", errors)
        cell = _require_vector3(layer.get("native_cell_size"), f"{object_id} native_cell_size", errors)
        grid = layer.get("native_grid")
        if not isinstance(grid, list) or len(grid) != 3:
            return False
        upper = [origin[axis] + float(grid[axis]) * cell[axis] for axis in range(3)]
        bounds[object_id] = (origin, upper)
    film, neighbor = bounds["planar_film"], bounds["isolation_neighbor"]
    z_overlap = min(film[1][2], neighbor[1][2]) - max(film[0][2], neighbor[0][2])
    xy_disjoint = any(
        film[1][axis] <= neighbor[0][axis] or neighbor[1][axis] <= film[0][axis]
        for axis in (0, 1)
    )
    if z_overlap <= 0.0:
        errors.append("fixture layers must be coplanar with a positive shared z interval")
    if not xy_disjoint:
        errors.append("fixture objects must have disjoint XY projections")
    return z_overlap > 0.0 and xy_disjoint


def validate_execution_plan(
    plan: dict[str, Any], *, qualification_profile: str
) -> dict[str, Any]:
    errors: list[str] = []
    expected = EXPECTED_NATIVE_CELL_COUNTS.get(qualification_profile)
    if expected is None:
        raise PreflightError(f"unsupported qualification profile: {qualification_profile}")
    common = _require_mapping(plan.get("common"), "execution plan common", errors)
    if common.get("resolved_backend") != "fdm":
        errors.append("execution plan must resolve backend fdm")
    backend_plan = _require_mapping(plan.get("backend_plan"), "execution plan backend_plan", errors)
    if backend_plan.get("kind") != "fdm_multilayer":
        errors.append("execution plan backend_plan.kind must be fdm_multilayer")
    raw_layers = backend_plan.get("layers")
    if not isinstance(raw_layers, list):
        errors.append("execution plan must contain FDM multilayer layers")
        raw_layers = []
    layers = {
        layer.get("object_id"): layer
        for layer in raw_layers
        if isinstance(layer, dict) and isinstance(layer.get("object_id"), str)
    }
    required_ids = {"planar_film", "isolation_neighbor"}
    if len(raw_layers) != 2 or set(layers) != required_ids:
        errors.append(
            "execution plan must contain exactly planar_film and isolation_neighbor native layers"
        )

    native_counts: dict[str, int] = {}
    for object_id in sorted(required_ids):
        layer = layers.get(object_id)
        if layer is None:
            native_counts[object_id] = 0
            continue
        count = _native_cell_count(layer, object_id, errors)
        native_counts[object_id] = count
        if count != expected[object_id]:
            errors.append(
                f"{object_id} native cell count {count}, expected {expected[object_id]} "
                f"for profile {qualification_profile}"
            )

    material_owners = _validate_material_arrays(layers, native_counts, errors)
    membership = _validate_membership(layers, native_counts, errors)
    disjoint_coplanar = _validate_disjoint_coplanar(layers, errors)
    if errors:
        raise PreflightError("\n".join(f"- {reason}" for reason in errors))
    return {
        "schema_version": "viewport-2d-fdm-plan-preflight.v1",
        "pass": True,
        "qualification_profile": qualification_profile,
        "resolved_backend": "fdm",
        "backend_plan_kind": "fdm_multilayer",
        "native_cell_counts": native_counts,
        "material_array_owners": material_owners,
        "scalar_fallbacks": {
            "planar_film": ["a_field", "alpha_field"],
            "isolation_neighbor": ["ms_field", "a_field", "alpha_field"],
        },
        "qualification_core_membership": membership,
        "coplanar_disjoint_objects": disjoint_coplanar,
        "fdm_cuda_heterogeneous_material_status": "no_go",
    }


def run_execution_planner(fullmag_bin: Path, problem_ir_path: Path) -> dict[str, Any]:
    completed = subprocess.run(
        [
            str(fullmag_bin),
            "plan-json",
            str(problem_ir_path),
            "--backend",
            "fdm",
            "--execution-plan",
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        raise PreflightError(
            "canonical planner rejected the fixture\n"
            f"--- planner stdout ---\n{completed.stdout or '<empty>'}\n"
            f"--- planner stderr ---\n{completed.stderr or '<empty>'}"
        )
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise PreflightError(
            "canonical planner returned invalid execution-plan JSON\n"
            f"--- planner stdout ---\n{completed.stdout or '<empty>'}\n"
            f"--- planner stderr ---\n{completed.stderr or '<empty>'}"
        ) from error
    if not isinstance(payload, dict):
        raise PreflightError("canonical planner output must be a JSON object")
    return payload


def materialize_fixture_ir(
    fixture: Path, *, qualification_profile: str, device: str
) -> dict[str, Any]:
    if device != "cpu":
        raise PreflightError(
            "heterogeneous multilayer FDM CUDA remains no-go; use the qualified CPU preflight lane"
        )
    previous_profile = os.environ.get("FULLMAG_PLANAR_QUALIFICATION_PROFILE")
    previous_device = os.environ.get("FULLMAG_PLANAR_DEVICE")
    os.environ["FULLMAG_PLANAR_QUALIFICATION_PROFILE"] = qualification_profile
    os.environ["FULLMAG_PLANAR_DEVICE"] = device
    try:
        from fullmag import Simulation, load_problem_from_script

        loaded = load_problem_from_script(fixture)
        simulation = Simulation(loaded.problem, backend="fdm")
        return simulation.to_ir(
            script_source=loaded.script_source,
            entrypoint_kind=loaded.entrypoint_kind,
        )
    finally:
        if previous_profile is None:
            os.environ.pop("FULLMAG_PLANAR_QUALIFICATION_PROFILE", None)
        else:
            os.environ["FULLMAG_PLANAR_QUALIFICATION_PROFILE"] = previous_profile
        if previous_device is None:
            os.environ.pop("FULLMAG_PLANAR_DEVICE", None)
        else:
            os.environ["FULLMAG_PLANAR_DEVICE"] = previous_device


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--fullmag-bin", type=Path, required=True)
    parser.add_argument("--qualification-profile", choices=sorted(EXPECTED_NATIVE_CELL_COUNTS), default="base")
    parser.add_argument("--device", choices=("cpu", "gpu"), default="cpu")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    try:
        problem_ir = materialize_fixture_ir(
            args.fixture,
            qualification_profile=args.qualification_profile,
            device=args.device,
        )
        with tempfile.TemporaryDirectory(prefix="fullmag-planar-preflight-") as temp_dir:
            problem_ir_path = Path(temp_dir) / "problem-ir.json"
            problem_ir_path.write_text(
                json.dumps(problem_ir, indent=2, sort_keys=True, allow_nan=False) + "\n",
                encoding="utf-8",
            )
            plan = run_execution_planner(args.fullmag_bin, problem_ir_path)
        report = validate_execution_plan(
            plan, qualification_profile=args.qualification_profile
        )
    except (OSError, PreflightError, RuntimeError, ValueError) as error:
        print(f"viewport 2D FDM plan preflight failed:\n{error}", file=sys.stderr)
        return 1

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, indent=2, sort_keys=True, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    print(f"viewport 2D FDM plan preflight passed: {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
