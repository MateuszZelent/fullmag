#!/usr/bin/env python3
"""Smoke benchmark for real Gmsh FEM mesh generation cases."""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
PY_SRC = REPO_ROOT / "packages" / "fullmag-py" / "src"
if str(PY_SRC) not in sys.path:
    sys.path.insert(0, str(PY_SRC))

import fullmag as fm  # noqa: E402
from fullmag.meshing.gmsh_bridge import (  # noqa: E402
    AirboxOptions,
    MeshOptions,
    generate_mesh,
)


@dataclass(frozen=True)
class GmshGenerationCase:
    name: str
    geometry_kind: str
    scale: str
    hmax: float
    airbox_padding: float | None = None


CASE_CONFIGS: dict[str, GmshGenerationCase] = {
    "medium_box": GmshGenerationCase(
        name="medium_box",
        geometry_kind="box",
        scale="medium",
        hmax=25e-9,
    ),
    "large_box": GmshGenerationCase(
        name="large_box",
        geometry_kind="box",
        scale="large",
        hmax=18e-9,
    ),
    "medium_cylinder_airbox": GmshGenerationCase(
        name="medium_cylinder_airbox",
        geometry_kind="cylinder",
        scale="medium",
        hmax=30e-9,
        airbox_padding=0.75,
    ),
}

RELEASE_BUDGET_PROFILES = {
    "release-smoke": {
        "medium_box": 10.0,
        "medium_cylinder_airbox": 15.0,
        "large_box": 30.0,
    },
}


def gmsh_available() -> bool:
    return importlib.util.find_spec("gmsh") is not None


def _gmsh_version() -> str | None:
    try:
        import gmsh  # type: ignore
    except ImportError:
        return None
    return getattr(gmsh, "__version__", None)


def _geometry_for_case(case: GmshGenerationCase) -> Any:
    if case.name == "medium_box":
        return fm.Box(size=(180e-9, 90e-9, 18e-9), name="medium_box")
    if case.name == "large_box":
        return fm.Box(size=(360e-9, 180e-9, 36e-9), name="large_box")
    if case.name == "medium_cylinder_airbox":
        return fm.Cylinder(radius=70e-9, height=18e-9, name="medium_cylinder")
    raise KeyError(f"unknown Gmsh generation case {case.name!r}")


def run_case(
    case_name: str,
    *,
    hmax: float | None = None,
    compute_quality: bool = True,
) -> dict[str, Any]:
    if not gmsh_available():
        raise RuntimeError("gmsh is not available")
    case = CASE_CONFIGS[case_name]
    options = MeshOptions(
        compute_quality=compute_quality,
        per_element_quality=compute_quality,
        smoothing_steps=1,
    )
    started = time.perf_counter()
    mesh = generate_mesh(
        _geometry_for_case(case),
        hmax=hmax if hmax is not None else case.hmax,
        order=1,
        airbox=(
            AirboxOptions(padding_factor=case.airbox_padding)
            if case.airbox_padding is not None
            else None
        ),
        options=options,
    )
    generation_seconds = time.perf_counter() - started

    stats_started = time.perf_counter()
    mesh_ir = mesh.to_ir(case.name)
    statistics_seconds = time.perf_counter() - stats_started
    statistics = mesh_ir["mesh_statistics"]["global"]

    return {
        "case": case.name,
        "scale": case.scale,
        "geometry_kind": case.geometry_kind,
        "gmsh_version": _gmsh_version(),
        "generation_seconds": generation_seconds,
        "statistics_seconds": statistics_seconds,
        "nodes": mesh.n_nodes,
        "elements": mesh.n_elements,
        "boundary_faces": mesh.n_boundary_faces,
        "quality_available": mesh.quality is not None,
        "edge_length_mean": statistics["edge_length"]["mean"],
        "volume_ratio": statistics["volume"]["ratio"],
    }


def resolve_case_budgets(
    cases: list[str],
    *,
    budget_profile: str | None,
    max_case_seconds: float | None,
) -> dict[str, float]:
    if budget_profile is not None:
        profile = RELEASE_BUDGET_PROFILES[budget_profile]
        budgets = {case: float(profile[case]) for case in cases if case in profile}
    else:
        budgets = {}
    if max_case_seconds is not None:
        budgets.update({case: float(max_case_seconds) for case in cases})
    return budgets


def budget_failures(
    results: list[dict[str, Any]],
    budgets: dict[str, float],
    *,
    duration_key: str,
) -> list[dict[str, Any]]:
    failures: list[dict[str, Any]] = []
    for result in results:
        case = str(result["case"])
        budget = budgets.get(case)
        duration = float(result[duration_key])
        if budget is not None and duration > budget:
            failure = dict(result)
            failure["budget_seconds"] = budget
            failure["duration_key"] = duration_key
            failures.append(failure)
    return failures


def run_smoke(
    cases: list[str],
    *,
    max_case_seconds: float | None,
    require_gmsh: bool,
    compute_quality: bool,
    budget_profile: str | None = None,
) -> dict[str, Any]:
    if not gmsh_available():
        payload = {
            "budget_profile": budget_profile,
            "case_budgets_seconds": {},
            "skipped": True,
            "reason": "gmsh is not available",
            "cases": [],
            "failed": require_gmsh,
        }
        return payload

    results = [
        run_case(case, compute_quality=compute_quality)
        for case in cases
    ]
    budgets = resolve_case_budgets(
        cases,
        budget_profile=budget_profile,
        max_case_seconds=max_case_seconds,
    )
    failures = budget_failures(results, budgets, duration_key="generation_seconds")
    return {
        "budget_profile": budget_profile,
        "case_budgets_seconds": budgets,
        "skipped": False,
        "cases": results,
        "failed": len(failures) > 0,
        "failures": failures,
        "max_case_seconds": max_case_seconds,
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--case",
        action="append",
        choices=sorted(CASE_CONFIGS),
        dest="cases",
        help="Case to run. Defaults to medium_box and medium_cylinder_airbox.",
    )
    parser.add_argument(
        "--include-large",
        action="store_true",
        help="Also run the large_box generation case.",
    )
    parser.add_argument(
        "--max-case-seconds",
        type=float,
        default=None,
        help="Override and fail if any case exceeds this generation wall-time budget.",
    )
    parser.add_argument(
        "--budget-profile",
        choices=sorted(RELEASE_BUDGET_PROFILES),
        default=None,
        help="Named release budget profile to apply per generation case.",
    )
    parser.add_argument(
        "--require-gmsh",
        action="store_true",
        help="Return failure when gmsh is not importable.",
    )
    parser.add_argument(
        "--skip-quality",
        action="store_true",
        help="Disable Gmsh quality extraction for generation-only timing.",
    )
    return parser.parse_args(argv)


def _default_cases(include_large: bool) -> list[str]:
    cases = ["medium_box", "medium_cylinder_airbox"]
    if include_large:
        cases.append("large_box")
    return cases


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    payload = run_smoke(
        args.cases or _default_cases(args.include_large),
        max_case_seconds=args.max_case_seconds,
        require_gmsh=args.require_gmsh,
        compute_quality=not args.skip_quality,
        budget_profile=args.budget_profile,
    )
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 1 if payload["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
